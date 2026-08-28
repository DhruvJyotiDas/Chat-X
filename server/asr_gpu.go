package main

// Client for the live-captions inference service defined in
// gpu/ASR_CONTRACT.md.
//
// The model runs on a SEPARATE GPU VM. This file is the only thing in the
// backend that knows that machine exists — the browser never talks to it at
// all, same reasoning as interview_gpu.go: keeps the token server-side and
// rate limiting in one place (transcription_relay.go).
//
// With ASR_GPU_URL unset (the state until the GPU box exists) every call
// fails fast with a clear, user-facing reason and never touches the network
// or opens a microphone client-side.
//
// This is a separate, parallel implementation to interview_gpu.go rather than
// a shared generic HTTP-POST helper: the two contracts have different error
// vocabularies (ErrASR* vs ErrGPU*) and interview_gpu.go is live in
// production — duplicating ~80 lines here is a smaller risk than threading
// both feature's error semantics through one shared function.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var (
	asrURL     = strings.TrimSuffix(os.Getenv("ASR_GPU_URL"), "/")
	asrToken   = os.Getenv("ASR_GPU_TOKEN")
	asrTimeout = func() time.Duration {
		if d, err := time.ParseDuration(getenvOr("ASR_GPU_TIMEOUT", "15s")); err == nil {
			return d
		}
		return 15 * time.Second
	}()
	// ASR_GPU_PIN: base64 SHA-256 of the GPU VM's certificate's SubjectPublicKeyInfo
	// (same format as HPKP pin-sha256, e.g. from `openssl x509 -pubkey ... |
	// openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`).
	//
	// The GPU VM is on a different cloud provider with no private network path
	// (see gpu/ASR_CONTRACT.md's Networking section) — the floor security model
	// is TLS + bearer token + IP allowlist, and its cert is self-signed (no DNS
	// name to get a CA-signed one against). InsecureSkipVerify alone would trust
	// ANY cert presented by anything at that IP, which defeats TLS's actual
	// purpose here (confidentiality against interception on the path to it) —
	// pinning the exact expected public key gives real MITM protection without
	// needing a CA. Leave ASR_GPU_PIN unset once the GPU VM gets a real
	// CA-signed cert (e.g. Let's Encrypt on a subdomain) and this reverts to
	// normal default TLS verification with no code change.
	asrPin        = os.Getenv("ASR_GPU_PIN")
	asrTLSCfg     = buildASRTLSConfig()
	asrHTTPClient = &http.Client{Transport: &http.Transport{TLSClientConfig: asrTLSCfg}}
)

func buildASRTLSConfig() *tls.Config {
	if asrPin == "" {
		return nil // normal default verification (real CA-signed cert)
	}
	pin := asrPin
	return &tls.Config{
		// The standard chain/hostname checks can't pass a self-signed cert with
		// no matching CA anyway — verification is replaced entirely by the pin
		// check below, not weakened alongside it.
		InsecureSkipVerify: true, //nolint:gosec
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("captions engine presented no certificate")
			}
			cert, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return fmt.Errorf("captions engine certificate unparsable: %w", err)
			}
			spki, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
			if err != nil {
				return fmt.Errorf("captions engine certificate has an unreadable public key: %w", err)
			}
			sum := sha256.Sum256(spki)
			got := base64.StdEncoding.EncodeToString(sum[:])
			if got != pin {
				return fmt.Errorf("captions engine certificate pin mismatch (got %s, want %s) — refusing to connect", got, pin)
			}
			return nil
		},
	}
}

var (
	ErrASRNotConfigured = errors.New("captions aren't set up yet")
	ErrASRUnreachable   = errors.New("captions temporarily unavailable")
	ErrASRLoading       = errors.New("captions are starting up")
	ErrASRUnauthorized  = errors.New("captions engine rejected our credentials")
)

func asrConfigured() bool { return asrURL != "" }

// ─── Health, with a short cache ──────────────────────────────────────────────
//
// Four models on one VM load at different speeds, so readiness is gated on
// /healthz rather than assumed the moment ASR_GPU_URL is set.

type asrHealthResp struct {
	Status             string            `json:"status"`
	Models             map[string]string `json:"models"`
	SupportedLanguages []string          `json:"supported_languages"`
}

var (
	asrHealthMu     sync.Mutex
	asrHealthCached asrHealthResp
	asrHealthAt     time.Time
	asrHealthErr    error
)

const asrHealthTTL = 10 * time.Second

func asrCheckHealth(ctx context.Context) (asrHealthResp, error) {
	if !asrConfigured() {
		return asrHealthResp{}, ErrASRNotConfigured
	}
	asrHealthMu.Lock()
	if time.Since(asrHealthAt) < asrHealthTTL {
		h, err := asrHealthCached, asrHealthErr
		asrHealthMu.Unlock()
		return h, err
	}
	asrHealthMu.Unlock()

	hctx, cancel := context.WithTimeout(ctx, asrTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(hctx, "GET", asrURL+"/healthz", nil)
	if asrToken != "" {
		req.Header.Set("Authorization", "Bearer "+asrToken)
	}

	asrHealthMu.Lock()
	defer asrHealthMu.Unlock()

	res, err := asrHTTPClient.Do(req)
	if err != nil {
		asrHealthCached, asrHealthErr = asrHealthResp{}, ErrASRUnreachable
		return asrHealthCached, asrHealthErr
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		asrHealthCached, asrHealthErr = asrHealthResp{}, ErrASRUnauthorized
		return asrHealthCached, asrHealthErr
	}
	var h asrHealthResp
	if err := json.NewDecoder(res.Body).Decode(&h); err != nil {
		asrHealthCached, asrHealthErr = asrHealthResp{}, ErrASRUnreachable
		return asrHealthCached, asrHealthErr
	}
	asrHealthAt = time.Now()
	asrHealthCached = h
	if h.Status == "loading" {
		asrHealthErr = ErrASRLoading
	} else {
		asrHealthErr = nil
	}
	return asrHealthCached, asrHealthErr
}

// ─── Streaming ASR dial ──────────────────────────────────────────────────────
//
// One WS connection per active speaker (not per listener — see
// transcription_relay.go). Server-to-server, so the bearer token goes in a
// normal header; no browser-side header restriction applies here.

func asrDialStream(ctx context.Context, roomID, userID string) (*websocket.Conn, error) {
	if !asrConfigured() {
		return nil, ErrASRNotConfigured
	}
	u, err := url.Parse(asrURL)
	if err != nil {
		return nil, fmt.Errorf("invalid ASR_GPU_URL: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/v1/stream"

	header := http.Header{}
	if asrToken != "" {
		header.Set("Authorization", "Bearer "+asrToken)
	}
	dialer := websocket.Dialer{HandshakeTimeout: asrTimeout, TLSClientConfig: asrTLSCfg}
	conn, res, err := dialer.DialContext(ctx, u.String(), header)
	if err != nil {
		if res != nil && (res.StatusCode == 401 || res.StatusCode == 403) {
			return nil, ErrASRUnauthorized
		}
		log.Printf("[ASR] dial %s failed: %v", u.String(), err)
		return nil, ErrASRUnreachable
	}

	handshake, _ := json.Marshal(map[string]string{"room_id": roomID, "user_id": userID})
	if err := conn.WriteMessage(websocket.TextMessage, handshake); err != nil {
		conn.Close()
		return nil, ErrASRUnreachable
	}

	// The GPU service acks the handshake with {"type":"ready",...} before any
	// audio should flow, or closes with 4400 (bad handshake) / 4401
	// (unauthorized — the token can only be validated post-upgrade for a WS
	// dial, per CONTRACT.md's auth section) instead of a normal error. Wait
	// briefly for that before handing the connection back.
	conn.SetReadDeadline(time.Now().Add(asrTimeout)) //nolint
	_, ackData, err := conn.ReadMessage()
	conn.SetReadDeadline(time.Time{}) //nolint
	if err != nil {
		conn.Close()
		if websocket.IsCloseError(err, 4401) {
			return nil, ErrASRUnauthorized
		}
		return nil, ErrASRUnreachable
	}
	var ack struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(ackData, &ack) != nil || ack.Type != "ready" {
		conn.Close()
		return nil, ErrASRUnreachable
	}
	return conn, nil
}

// ─── Translation ─────────────────────────────────────────────────────────────
//
// Stateless, called only for a final segment's distinct set of currently-
// requested viewer languages (never for partials — see transcription_relay.go).
// Retries once on a transport error or 5xx, same "don't hammer a struggling
// GPU" reasoning as interview_gpu.go's gpuPost.

func asrTranslate(ctx context.Context, text, sourceLang string, targetLangs []string) (map[string]string, error) {
	if !asrConfigured() {
		return nil, ErrASRNotConfigured
	}
	if len(targetLangs) == 0 {
		return map[string]string{}, nil
	}
	body, _ := json.Marshal(map[string]any{
		"text": text, "source_language": sourceLang, "target_languages": targetLangs,
	})

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(750 * time.Millisecond):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		rctx, cancel := context.WithTimeout(ctx, asrTimeout)
		req, _ := http.NewRequestWithContext(rctx, "POST", asrURL+"/v1/translate", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if asrToken != "" {
			req.Header.Set("Authorization", "Bearer "+asrToken)
		}
		res, err := asrHTTPClient.Do(req)
		if err != nil {
			cancel()
			lastErr = ErrASRUnreachable
			continue
		}
		payload, readErr := io.ReadAll(io.LimitReader(res.Body, 1*1024*1024))
		res.Body.Close()
		cancel()
		switch {
		case res.StatusCode == 401 || res.StatusCode == 403:
			return nil, ErrASRUnauthorized
		case res.StatusCode >= 500:
			lastErr = ErrASRUnreachable
			continue
		case res.StatusCode >= 400:
			return nil, fmt.Errorf("captions engine rejected the translate request (%d)", res.StatusCode)
		}
		if readErr != nil {
			lastErr = ErrASRUnreachable
			continue
		}
		var out struct {
			Translations map[string]string `json:"translations"`
			Errors       map[string]string `json:"errors"`
		}
		if err := json.Unmarshal(payload, &out); err != nil {
			return nil, fmt.Errorf("captions engine returned an unreadable reply")
		}
		if len(out.Errors) > 0 {
			// Per-language failures (e.g. one target lang errored) — log and
			// still return whatever DID translate rather than losing the
			// whole final over one bad target.
			log.Printf("[ASR] translate partial failure: %v", out.Errors)
		}
		return out.Translations, nil
	}
	return nil, lastErr
}
