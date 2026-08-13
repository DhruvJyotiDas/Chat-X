package main

// Client for the interview inference service defined in gpu/CONTRACT.md.
//
// The model runs on a SEPARATE GPU VM. This file is the only thing in the
// backend that knows that machine exists, and the browser never talks to it at
// all — which keeps the shared token server-side and puts rate limiting in one
// place.
//
// With INTERVIEW_GPU_URL unset (the state until the GPU box exists) every call
// fails fast with a clear, user-facing reason and never touches the network.
// Everything that does NOT need the model — CV upload, parsing, GitHub
// enrichment, session history — keeps working.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	gpuURL     = strings.TrimSuffix(os.Getenv("INTERVIEW_GPU_URL"), "/")
	gpuToken   = os.Getenv("INTERVIEW_GPU_TOKEN")
	gpuTimeout = func() time.Duration {
		if d, err := time.ParseDuration(getenvOr("INTERVIEW_GPU_TIMEOUT", "120s")); err == nil {
			return d
		}
		return 120 * time.Second
	}()
	gpuHTTP = &http.Client{} // per-request timeouts via context, not here
)

// Errors the HTTP layer maps to user-facing messages. Distinguishing these is
// the whole point: "not configured", "unreachable" and "still starting up" need
// three different responses from the UI, and lumping them into one opaque
// failure is what makes an outage undiagnosable.
var (
	ErrGPUNotConfigured = errors.New("interview engine is not configured")
	ErrGPUUnreachable   = errors.New("interview engine is unreachable")
	ErrGPULoading       = errors.New("interview engine is still starting up")
	ErrGPUUnauthorized  = errors.New("interview engine rejected our credentials")
	ErrGPUSpeechUnavail = errors.New("interview engine has no speech synthesis")
)

func gpuConfigured() bool { return gpuURL != "" }

// ─── Health, with a short cache ──────────────────────────────────────────────
//
// A 30B model takes minutes to load, so readiness is gated on /healthz rather
// than assumed. Cached briefly so starting an interview does not fire a health
// check per question.

type gpuHealth struct {
	Status     string `json:"status"`
	Model      string `json:"model"`
	VRAMUsedMB int    `json:"vram_used_mb"`
}

var (
	healthMu     sync.Mutex
	healthCached gpuHealth
	healthAt     time.Time
	healthErr    error
)

const healthTTL = 10 * time.Second

func gpuCheckHealth(ctx context.Context) (gpuHealth, error) {
	if !gpuConfigured() {
		return gpuHealth{}, ErrGPUNotConfigured
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	if time.Since(healthAt) < healthTTL {
		return healthCached, healthErr
	}

	hctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(hctx, "GET", gpuURL+"/healthz", nil)
	if gpuToken != "" {
		req.Header.Set("Authorization", "Bearer "+gpuToken)
	}

	healthAt = time.Now()
	res, err := gpuHTTP.Do(req)
	if err != nil {
		healthCached, healthErr = gpuHealth{}, ErrGPUUnreachable
		log.Printf("[Interview] health check failed: %v", err)
		return healthCached, healthErr
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		healthCached, healthErr = gpuHealth{}, ErrGPUUnauthorized
		return healthCached, healthErr
	}
	var h gpuHealth
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&h); err != nil {
		healthCached, healthErr = gpuHealth{}, ErrGPUUnreachable
		return healthCached, healthErr
	}
	healthCached, healthErr = h, nil
	if h.Status != "ready" {
		healthErr = ErrGPULoading
	}
	return healthCached, healthErr
}

// ─── Core request ────────────────────────────────────────────────────────────

// gpuPost sends one JSON request and decodes the reply into out.
//
// Retries ONCE on a transport error or 5xx. Deliberately not more: inference
// requests are expensive and slow, and hammering a struggling GPU makes an
// overload worse rather than better.
func gpuPost(ctx context.Context, path string, in any, out any) error {
	if !gpuConfigured() {
		return ErrGPUNotConfigured
	}
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("encoding request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(1500 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		started := time.Now()
		rctx, cancel := context.WithTimeout(ctx, gpuTimeout)
		req, _ := http.NewRequestWithContext(rctx, "POST", gpuURL+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if gpuToken != "" {
			req.Header.Set("Authorization", "Bearer "+gpuToken)
		}

		res, err := gpuHTTP.Do(req)
		if err != nil {
			cancel()
			lastErr = ErrGPUUnreachable
			log.Printf("[Interview] POST %s attempt %d failed after %s: %v",
				path, attempt+1, time.Since(started).Round(time.Millisecond), err)
			continue
		}

		payload, readErr := io.ReadAll(io.LimitReader(res.Body, 32*1024*1024))
		res.Body.Close()
		cancel()
		elapsed := time.Since(started).Round(time.Millisecond)

		switch {
		case res.StatusCode == 401 || res.StatusCode == 403:
			log.Printf("[Interview] POST %s -> %d (auth) in %s", path, res.StatusCode, elapsed)
			return ErrGPUUnauthorized
		case res.StatusCode == 501:
			return ErrGPUSpeechUnavail
		case res.StatusCode >= 500:
			lastErr = fmt.Errorf("interview engine error (%d)", res.StatusCode)
			log.Printf("[Interview] POST %s -> %d in %s, retrying", path, res.StatusCode, elapsed)
			continue
		case res.StatusCode >= 400:
			var e struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(payload, &e)
			log.Printf("[Interview] POST %s -> %d in %s: %s", path, res.StatusCode, elapsed, e.Error)
			if e.Error == "" {
				e.Error = fmt.Sprintf("interview engine rejected the request (%d)", res.StatusCode)
			}
			return errors.New(e.Error)
		}

		if readErr != nil {
			lastErr = ErrGPUUnreachable
			continue
		}
		if err := json.Unmarshal(payload, out); err != nil {
			log.Printf("[Interview] POST %s -> unparseable reply in %s: %v", path, elapsed, err)
			return fmt.Errorf("interview engine returned an unreadable reply")
		}
		log.Printf("[Interview] POST %s -> 200 in %s (%d bytes)", path, elapsed, len(payload))
		return nil
	}
	return lastErr
}

// ─── Typed wrappers ──────────────────────────────────────────────────────────

type GPUQuestion struct {
	Text           string   `json:"text"`
	Category       string   `json:"category"`
	Rationale      string   `json:"rationale"`
	ExpectedPoints []string `json:"expected_points"`
}

type gpuPlanReq struct {
	Profile   map[string]any `json:"profile"`
	Role      string         `json:"role"`
	Seniority string         `json:"seniority"`
	Kind      string         `json:"kind"`
	Count     int            `json:"count"`
}

func gpuPlan(ctx context.Context, profile map[string]any, role, seniority, kind string, count int) ([]GPUQuestion, error) {
	if _, err := gpuCheckHealth(ctx); err != nil {
		return nil, err
	}
	var out struct {
		Questions []GPUQuestion `json:"questions"`
	}
	if err := gpuPost(ctx, "/v1/plan", gpuPlanReq{profile, role, seniority, kind, count}, &out); err != nil {
		return nil, err
	}
	if len(out.Questions) == 0 {
		return nil, errors.New("interview engine returned no questions")
	}
	return out.Questions, nil
}

type GPUTranscript struct {
	Text        string  `json:"text"`
	DurationSec float64 `json:"duration_sec"`
}

func gpuTranscribe(ctx context.Context, wavB64 string) (GPUTranscript, error) {
	var out GPUTranscript
	err := gpuPost(ctx, "/v1/transcribe", map[string]any{"audio_wav_b64": wavB64}, &out)
	return out, err
}

type GPUEvaluation struct {
	Scores          map[string]float64 `json:"scores"`
	Overall         float64            `json:"overall"`
	Strengths       []string           `json:"strengths"`
	Improvements    []string           `json:"improvements"`
	Feedback        string             `json:"feedback"`
	FillerWordCount int                `json:"filler_word_count"`
	WordsPerMinute  int                `json:"words_per_minute"`
}

func gpuEvaluate(ctx context.Context, req map[string]any) (GPUEvaluation, error) {
	var out GPUEvaluation
	err := gpuPost(ctx, "/v1/evaluate", req, &out)
	return out, err
}

type GPUReport struct {
	Overall      float64            `json:"overall"`
	Scores       map[string]float64 `json:"scores"`
	Verdict      string             `json:"verdict"`
	Summary      string             `json:"summary"`
	Strengths    []string           `json:"strengths"`
	Improvements []string           `json:"improvements"`
	FocusAreas   []string           `json:"focus_areas"`
}

func gpuReport(ctx context.Context, role, seniority string, answers []map[string]any) (GPUReport, error) {
	var out GPUReport
	err := gpuPost(ctx, "/v1/report", map[string]any{
		"role": role, "seniority": seniority, "answers": answers,
	}, &out)
	return out, err
}

// gpuSpeak is optional. ErrGPUSpeechUnavail is the normal answer until the
// Talker path works on the GPU side; the client then uses browser TTS.
func gpuSpeak(ctx context.Context, text, voice string) (string, error) {
	var out struct {
		AudioWavB64 string `json:"audio_wav_b64"`
	}
	err := gpuPost(ctx, "/v1/speak", map[string]any{"text": text, "voice": voice}, &out)
	return out.AudioWavB64, err
}
