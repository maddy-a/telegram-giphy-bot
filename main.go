package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/joho/godotenv"
)

type giphyResponse struct {
	Data []struct {
		Images struct {
			Downsized struct {
				URL string `json:"url"`
			} `json:"downsized"`
			Original struct {
				URL string `json:"url"`
			} `json:"original"`
		} `json:"images"`
	} `json:"data"`
}

type webAppPayload struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	Title     string `json:"title,omitempty"`
	URL       string `json:"url,omitempty"`
	Downsized string `json:"downsized,omitempty"` // not used now
}

var startedAt = time.Now()

func handleHealth(appName string, configOK bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"app":        appName,
			"uptime_sec": int(time.Since(startedAt).Seconds()),
			"config_ok":  configOK, // true if required envs were present at startup
			"time_utc":   time.Now().UTC().Format(time.RFC3339),
		})
	}
}

func main() {
	_ = godotenv.Load() // OK if .env is missing in prod

	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	apiKey := os.Getenv("GIPHY_API_KEY")
	webAppURL := os.Getenv("WEBAPP_URL")
	allowedOrigin := os.Getenv("ALLOWED_ORIGIN")
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	if token == "" || apiKey == "" || webAppURL == "" {
		log.Fatal("TELEGRAM_BOT_TOKEN, GIPHY_API_KEY and WEBAPP_URL must be set")
	}

	appName := os.Getenv("APP_NAME")
	if appName == "" {
		appName = "telegram-giphy-bot"
	}

	configOK := (token != "" && apiKey != "")

	http.HandleFunc("/health", handleHealth(appName, configOK))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	b, err := bot.New(token, bot.WithDefaultHandler(func(ctx context.Context, b *bot.Bot, update *models.Update) {
		if update.Message == nil || update.Message.Text == "" {
			return
		}

		if update.Message != nil && update.Message.WebAppData != nil {
			var p webAppPayload
			if err := json.Unmarshal([]byte(update.Message.WebAppData.Data), &p); err == nil && p.Type == "gif" && p.URL != "" {
				_, _ = b.SendAnimation(ctx, &bot.SendAnimationParams{
					ChatID:    update.Message.Chat.ID,
					Animation: &models.InputFileString{Data: p.URL},
				})
				return
			}
		}

		if update.Message != nil && update.Message.Text == "/open" {
			if webAppURL == "" {
				_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: "WEBAPP_URL not set"})
				return
			}
			kb := &models.ReplyKeyboardMarkup{
				Keyboard: [][]models.KeyboardButton{
					{
						{Text: "Open GIF Mini App", WebApp: &models.WebAppInfo{URL: webAppURL}},
					},
				},
				ResizeKeyboard:  true,
				OneTimeKeyboard: true,
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
				ChatID:      update.Message.Chat.ID,
				Text:        "Tap below to open:",
				ReplyMarkup: kb,
			})
			return
		}

		if update.Message != nil && update.Message.Text == "/app" {
			if webAppURL == "" {
				_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
					ChatID: update.Message.Chat.ID,
					Text:   "WEBAPP_URL not set in .env",
				})
				return
			}
			kb := &models.InlineKeyboardMarkup{
				InlineKeyboard: [][]models.InlineKeyboardButton{
					{
						{
							Text:   "Open GIF Mini App",
							WebApp: &models.WebAppInfo{URL: webAppURL},
						},
					},
				},
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
				ChatID:      update.Message.Chat.ID,
				Text:        "Tap to open the Mini App:",
				ReplyMarkup: kb,
			})
			return
		}

		query := update.Message.Text
		gifURL, err := searchGIF(ctx, apiKey, query)
		if err != nil {
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
				ChatID: update.Message.Chat.ID,
				Text:   "No GIF found 😕",
			})
			return
		}

		_, _ = b.SendAnimation(ctx, &bot.SendAnimationParams{
			ChatID:    update.Message.Chat.ID,
			Animation: &models.InputFileString{Data: gifURL},
		})
	}))
	if err != nil {
		log.Fatal(err)
	}

	//b.Start(ctx)

	// register HTTP route(s)
	http.HandleFunc("/search", handleSearch(apiKey, allowedOrigin))

	// run both: bot (long polling) + HTTP server
	go func() {
		b.Start(ctx) // existing bot loop
	}()

	log.Printf("HTTP server listening on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func searchGIF(ctx context.Context, apiKey, q string) (string, error) {
	u := "https://api.giphy.com/v1/gifs/search?api_key=" +
		url.QueryEscape(apiKey) +
		"&q=" + url.QueryEscape(q) +
		"&limit=1&rating=g"

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("giphy status %d", resp.StatusCode)
	}

	var gr giphyResponse
	if err := json.NewDecoder(resp.Body).Decode(&gr); err != nil {
		return "", err
	}
	if len(gr.Data) == 0 {
		return "", fmt.Errorf("no results")
	}
	if u := gr.Data[0].Images.Downsized.URL; u != "" {
		return u, nil
	}
	if u := gr.Data[0].Images.Original.URL; u != "" {
		return u, nil
	}
	return "", fmt.Errorf("no url in result")
}

func handleSearch(apiKey, allowedOrigin string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// CORS
		if allowedOrigin == "" {
			allowedOrigin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		q := r.URL.Query().Get("q")
		if q == "" {
			http.Error(w, "missing q", http.StatusBadRequest)
			return
		}

		u := "https://api.giphy.com/v1/gifs/search?api_key=" +
			url.QueryEscape(apiKey) + "&q=" + url.QueryEscape(q) +
			"&limit=12&rating=g"

		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body) // pass GIPHY JSON straight through
	}
}
