package main

import (
	"context"
	"encoding/json"
	"fmt"
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

func main() {
	_ = godotenv.Load() // OK if .env is missing in prod

	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	apiKey := os.Getenv("GIPHY_API_KEY")
	if token == "" || apiKey == "" {
		log.Fatal("TELEGRAM_BOT_TOKEN and GIPHY_API_KEY must be set")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	b, err := bot.New(token, bot.WithDefaultHandler(func(ctx context.Context, b *bot.Bot, update *models.Update) {
		if update.Message == nil || update.Message.Text == "" {
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

	b.Start(ctx)
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

