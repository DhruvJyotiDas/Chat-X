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
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
// UPDATE, 2026-09: the GPU VM's own NLLB model (which used to serve
// /v1/translate — the original version of this function POSTed there) was
// removed alongside whisper_lid/indic_conformer when the VM was trimmed down
// to nemotron-only for English-only ASR. Confirmed directly: /v1/translate
// now 404s. There is no fast, purpose-built translation model left on that
// box, so this now routes through the OTHER GPU VM's Qwen chat model
// (AI_GPU_URL, server/ai_gpu.go) instead — the same model reply-suggestions
// and Ask AIPA already use, with the same lessons already learned there
// baked in (lightAIMaxTokens/lightAITimeout, trimEcho, no role-based multi-
// turn history — see ai.go's comments on all three).
//
// REAL, DISCLOSED TRADEOFF: this makes translated captions noticeably
// slower than before. NLLB was a dedicated seq2seq model, sub-second per
// call; Qwen is a full reasoning chat model with the same largely-fixed
// per-call overhead documented throughout ai.go — a single short sentence
// can take anywhere from ~3s to over a minute. The ORIGINAL, untranslated
// caption is completely unaffected (it never went through NLLB or Qwen —
// see handleASREvent in transcription_relay.go, which broadcasts the
// original text immediately and attaches translations only once/if they
// finish); only a viewer who has picked a different caption language sees
// their translated line arrive late. If a genuinely "live" translated-
// caption experience matters, the real fix is restoring a fast translation
// model (NLLB or similar) on the GPU VM — plenty of headroom for it
// (nemotron alone measured using 2.6GB of the box's 23.7GB VRAM).
//
// Called only for a final segment's distinct set of currently-requested
// viewer languages (never for partials — see transcription_relay.go), one
// language at a time — translating N languages for one final costs N
// sequential Qwen calls, not one batched call, since asking Qwen for
// several languages in one structured response is exactly the kind of
// multi-field formatting request that measurably becomes unreliable under
// this model's own echo-loop tendency (see replyLineRe's comment in ai.go).
// One call per language keeps each one small and independently recoverable:
// a failure or slow response for one target language never blocks or
// corrupts another.
var languageNames = map[string]string{
	"en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
	"mr": "Marathi", "es": "Spanish", "fr": "French", "de": "German", "ja": "Japanese",
}

func languageDisplayName(code string) string {
	if name, ok := languageNames[code]; ok {
		return name
	}
	return code
}

// translateConcurrency bounds how many caption-translation calls can be
// in-flight against the shared Qwen GPU at once, system-wide across every
// room. Added after a real incident during this feature's own testing, not
// speculatively: each "final" spawns its own detached goroutine (see
// transcription_relay.go's handleASREvent — deliberately detached from the
// speaker's own connection lifetime), and with enough of those piling up
// concurrently — several rooms translating, or just a stream of finals in
// one active conversation — the shared Qwen GPU (also used by reply-
// suggestions/Ask AIPA/analyze-thread/the chat Translate button) was
// measured going fully unresponsive for several minutes, /health included,
// until the backlog drained on its own. A hard cap here means this
// feature's own translation load can never again be the thing that does
// that, regardless of how many finals arrive close together — excess
// requests wait their turn for a free slot rather than firing all at once.
// 2 was chosen deliberately conservative given this app's real usage
// (~12 users, small rooms) and that the SAME GPU already serves several
// other features; revisit only with real evidence this is too tight.
var translateSem = make(chan struct{}, 2)

func asrTranslate(ctx context.Context, text, sourceLang string, targetLangs []string) (map[string]string, error) {
	if len(targetLangs) == 0 {
		return map[string]string{}, nil
	}
	if !aiGPUConfigured() {
		return nil, ErrASRNotConfigured
	}
	translations := map[string]string{}
	var lastErr error
	for _, lang := range targetLangs {
		select {
		case translateSem <- struct{}{}:
		case <-ctx.Done():
			return translations, ctx.Err()
		}
		system := fmt.Sprintf(
			"You are a translation tool. Translate the given %s text into %s. "+
				"Output ONLY the translated text — no notes, no quotes, no explanation, nothing else.",
			languageDisplayName(sourceLang), languageDisplayName(lang),
		)
		result, err := aiChatBudgetedTimed(ctx, system, nil, text, nil, lightAIMaxTokens, lightAITimeout)
		<-translateSem
		if err != nil {
			log.Printf("[ASR] translate to %s failed: %v", lang, err)
			lastErr = err
			continue
		}
		translations[lang] = result
	}
	if len(translations) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return translations, nil
}
