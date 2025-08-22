package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
)

// ---------- GIPHY wire types ----------
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

// WebApp payload (Mini App -> bot)
type webAppPayload struct {
	Type  string `json:"type"`
	ID    string `json:"id,omitempty"`
	Title string `json:"title,omitempty"`
	URL   string `json:"url,omitempty"`
}

// ---------- WS Hub types ----------
type AgentConn struct {
	SessionID string
	AppID     string
	Conn      *websocket.Conn
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // demo-friendly
}

var (
	adminConns = map[*websocket.Conn]struct{}{}
	agentConns = map[string]*AgentConn{} // sessionId -> conn
	mu         sync.Mutex
)

// ---------- Utilities ----------
var startedAt = time.Now()

func broadcastToAdmins(v any) {
	b, _ := json.Marshal(v)
	mu.Lock()
	defer mu.Unlock()
	for c := range adminConns {
		_ = c.WriteMessage(websocket.TextMessage, b)
	}
}

// ---------- Mini App <-> Server: GIPHY search proxy ----------
func handleSearch(apiKey, allowedOrigin string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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

		u := "https://api.giphy.com/v1/gifs/search?api_key=" + url.QueryEscape(apiKey) +
			"&q=" + url.QueryEscape(q) + "&limit=12&rating=g"

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
		io.Copy(w, resp.Body)
	}
}

// ---------- Health ----------
func handleHealth(appName string, configOK bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"app":        appName,
			"uptime_sec": int(time.Since(startedAt).Seconds()),
			"config_ok":  configOK,
			"time_utc":   time.Now().UTC().Format(time.RFC3339),
		})
	}
}

// ---------- Tasks & Proxy ----------
func allowCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

//var proxyAllow = map[string]bool{
//	"example.com":     true,
//	"www.example.com": true,
//	"httpbin.org":     true,
//	"www.httpbin.org": true,
//	"dappier.com":     true,
//	"www.dappier.com": true,
//}

// CIDR blocks we will NEVER allow (SSRF guard)
var blockedCIDRs []*net.IPNet

func init() {
	cidrs := []string{
		// IPv4
		"127.0.0.0/8",    // loopback
		"10.0.0.0/8",     // RFC1918
		"172.16.0.0/12",  // RFC1918
		"192.168.0.0/16", // RFC1918
		"169.254.0.0/16", // link-local
		"100.64.0.0/10",  // carrier-grade NAT
		"0.0.0.0/8",      // "this" network
		"224.0.0.0/4",    // multicast
		"240.0.0.0/4",    // reserved
		// IPv6
		"::1/128",   // loopback
		"fe80::/10", // link-local
		"fc00::/7",  // unique local
		"ff00::/8",  // multicast
		"::/128",    // unspecified
	}
	for _, c := range cidrs {
		_, n, _ := net.ParseCIDR(c)
		blockedCIDRs = append(blockedCIDRs, n)
	}
}

func ipBlocked(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() {
		return true
	}
	for _, n := range blockedCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Resolve host and ensure ALL answers are public routable
func checkHostSafe(ctx context.Context, host string) error {
	if ip := net.ParseIP(host); ip != nil {
		if ipBlocked(ip) {
			return fmt.Errorf("blocked ip %s", ip.String())
		}
		return nil
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return err
	}
	if len(ips) == 0 {
		return fmt.Errorf("no A/AAAA records")
	}
	for _, ip := range ips {
		if ipBlocked(ip) {
			return fmt.Errorf("blocked resolved ip %s", ip.String())
		}
	}
	return nil
}

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		http.Error(w, "missing url", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		http.Error(w, "bad url", http.StatusBadRequest)
		return
	}

	if err := checkHostSafe(r.Context(), u.Hostname()); err != nil {
		http.Error(w, "unsafe host: "+err.Error(), http.StatusForbidden)
		return
	}

	// Transport that re-checks the final dial target (guards DNS rebinding)
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			if err := checkHostSafe(ctx, host); err != nil {
				return nil, err
			}
			d := &net.Dialer{Timeout: 8 * time.Second}
			return d.DialContext(ctx, network, address)
		},
		TLSHandshakeTimeout: 8 * time.Second,
	}

	// 5 redirects max, validate each hop
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("bad scheme")
			}
			return checkHostSafe(req.Context(), req.URL.Hostname())
		},
	}

	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Cap body
	const max = 128 * 1024
	buf := &bytes.Buffer{}
	_, _ = io.CopyN(buf, resp.Body, max)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": resp.StatusCode,
		"size":   buf.Len(),
		"body":   buf.String(),
	})
}

type TaskReq struct {
	SessionID string         `json:"sessionId"`
	Type      string         `json:"type"`    // "cpu" or "fetch"
	Payload   map[string]any `json:"payload"` // e.g., {"n":10000} or {"url":"https://...","where":"client|server|auto"}
}

func tasksHandler(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var tr TaskReq
	if err := json.NewDecoder(r.Body).Decode(&tr); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if tr.SessionID == "" || tr.Type == "" {
		http.Error(w, "sessionId/type required", http.StatusBadRequest)
		return
	}

	mu.Lock()
	ac := agentConns[tr.SessionID]
	mu.Unlock()
	if ac == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	tid := fmt.Sprintf("t-%d", time.Now().UnixNano())
	msg := map[string]any{
		"type": "task",
		"id":   tid,
		"task": map[string]any{
			"type":    tr.Type,
			"payload": tr.Payload,
		},
	}
	if err := ac.Conn.WriteJSON(msg); err != nil {
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}

	broadcastToAdmins(map[string]any{"type": "task_enqueued", "sessionId": tr.SessionID, "taskId": tid, "taskType": tr.Type, "ts": time.Now().UnixMilli()})

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "taskId": tid})
}

// ---------- WS: /ws (admin|agent) ----------
func wsHandler(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	session := r.URL.Query().Get("session")
	appID := r.URL.Query().Get("appId")

	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	switch role {
	case "admin":
		mu.Lock()
		adminConns[c] = struct{}{}
		mu.Unlock()
		log.Printf("admin connected (%d total)", len(adminConns))

		go func() {
			defer func() {
				mu.Lock()
				delete(adminConns, c)
				mu.Unlock()
				c.Close()
				log.Printf("admin disconnected (%d total)", len(adminConns))
			}()
			for {
				if _, _, err := c.ReadMessage(); err != nil {
					return
				}
			}
		}()

	case "agent":
		if session == "" {
			session = "unknown-" + time.Now().Format("150405.000")
		}
		ac := &AgentConn{SessionID: session, AppID: appID, Conn: c}

		mu.Lock()
		agentConns[session] = ac
		mu.Unlock()
		log.Printf("agent %s connected (total %d)", session, len(agentConns))
		broadcastToAdmins(map[string]any{"type": "session_join", "sessionId": session, "appId": appID, "ts": time.Now().UnixMilli()})

		go func() {
			defer func() {
				mu.Lock()
				delete(agentConns, session)
				mu.Unlock()
				c.Close()
				log.Printf("agent %s disconnected", session)
				broadcastToAdmins(map[string]any{"type": "session_leave", "sessionId": session, "ts": time.Now().UnixMilli()})
			}()
			for {
				_, data, err := c.ReadMessage()
				if err != nil {
					return
				}
				var msg map[string]any
				if err := json.Unmarshal(data, &msg); err == nil {
					if _, ok := msg["sessionId"]; !ok {
						msg["sessionId"] = session
					}
					if _, ok := msg["appId"]; !ok {
						msg["appId"] = appID
					}
					broadcastToAdmins(msg)
				}
			}
		}()

	default:
		_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","msg":"role must be admin or agent"}`))
		c.Close()
	}
}

// ---------- Bot helpers ----------
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

// ---------- main ----------
func main() {
	_ = godotenv.Load()

	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	apiKey := os.Getenv("GIPHY_API_KEY")
	webAppURL := os.Getenv("WEBAPP_URL")
	allowedOrigin := os.Getenv("ALLOWED_ORIGIN")
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if token == "" || apiKey == "" {
		log.Fatal("TELEGRAM_BOT_TOKEN and GIPHY_API_KEY must be set")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	// Setup bot (long polling)
	b, err := bot.New(token, bot.WithDefaultHandler(func(ctx context.Context, b *bot.Bot, update *models.Update) {
		if update.Message == nil {
			return
		}

		// Open Mini App via reply keyboard
		if update.Message.Text == "/open" {
			if webAppURL == "" {
				_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: "WEBAPP_URL not set"})
				return
			}
			kb := &models.ReplyKeyboardMarkup{
				Keyboard:        [][]models.KeyboardButton{{{Text: "Open GIF Mini App", WebApp: &models.WebAppInfo{URL: webAppURL}}}},
				ResizeKeyboard:  true,
				OneTimeKeyboard: true,
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: "Tap below to open:", ReplyMarkup: kb})
			return
		}

		// Inline button to open Mini App
		if update.Message.Text == "/app" {
			if webAppURL == "" {
				_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: "WEBAPP_URL not set"})
				return
			}
			kb := &models.InlineKeyboardMarkup{
				InlineKeyboard: [][]models.InlineKeyboardButton{{{Text: "Open GIF Mini App", WebApp: &models.WebAppInfo{URL: webAppURL}}}},
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: "Tap to open the Mini App:", ReplyMarkup: kb})
			return
		}

		// Incoming data from Mini App (send selected GIF)
		if update.Message.WebAppData != nil {
			var p webAppPayload
			if err := json.Unmarshal([]byte(update.Message.WebAppData.Data), &p); err == nil && p.Type == "gif" && p.URL != "" {
				_, _ = b.SendAnimation(ctx, &bot.SendAnimationParams{
					ChatID:    update.Message.Chat.ID,
					Animation: &models.InputFileString{Data: p.URL},
				})
				return
			}
		}

		// Fallback: any text -> search GIPHY and send a GIF
		if t := update.Message.Text; t != "" {
			if gifURL, err := searchGIF(ctx, apiKey, t); err == nil {
				_, _ = b.SendAnimation(ctx, &bot.SendAnimationParams{
					ChatID:    update.Message.Chat.ID,
					Animation: &models.InputFileString{Data: gifURL},
				})
				return
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: "No GIF found 😕"})
		}
	}))
	if err != nil {
		log.Fatal(err)
	}

	// HTTP routes
	http.HandleFunc("/search", handleSearch(apiKey, allowedOrigin))
	http.HandleFunc("/healthz", handleHealth("telegram-giphy-bot", token != "" && apiKey != ""))
	http.HandleFunc("/proxy", proxyHandler)
	http.HandleFunc("/tasks", tasksHandler)
	http.HandleFunc("/ws", wsHandler)

	// Run bot + HTTP
	go func() { b.Start(ctx) }()
	log.Printf("HTTP server listening on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
