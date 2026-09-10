package main

// Client for the AI chat/writing/understanding service defined in
// gpu/AI_CONTRACT.md. Same rule as asr_gpu.go/interview_gpu.go: this is the
// only file in the backend that knows the GPU VM exists, and the browser
// never talks to it directly.
//
// UPDATE: the GPU side fixed /v1/chat/completions the same day this file was
// first written against a guessed contract — real behavior, confirmed
// directly against 10.1.1.4:8000, differs from that guess in two load-bearing
// ways this file now handles:
//
//  1. It is a REASONING model — every response is
//     "<think>...reasoning...</think>\n\nACTUAL ANSWER", unconditionally.
//     Tried "enable_thinking: false" (a real param on some Qwen3 deployments);
//     this service ignores it and thinks anyway. stripThinking() below is
//     therefore not optional cleanup, it's required on every call, and a
//     response with no closing "</think>" means generation was cut off
//     mid-thought (max_tokens too low) — treated as a failure, not shown to
//     a user as if it were the real answer.
//  2. There is no json_schema/structured-output support of any kind — passing
//     one is silently ignored (confirmed: asking for a schema-constrained
//     extraction still returns free-form reasoning text, truncated, with no
//     attempt at the requested shape). Structured output is achieved by
//     asking for JSON in the prompt and extracting the first balanced
//     {...} substring from the answer after stripping thinking — see
//     extractJSONObject() — not by any server-side guarantee.
//
// Because thinking alone can run 100-250+ tokens before the real answer even
// starts, aiChatMaxTokens is deliberately generous (not the small default a
// non-reasoning model would need) — too low a budget doesn't shorten the
// answer, it truncates it entirely inside the thinking block.

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
	"regexp"
	"strings"
	"time"
)

var (
	aiGPUURL   = strings.TrimSuffix(os.Getenv("AI_GPU_URL"), "/")
	aiGPUToken = os.Getenv("AI_GPU_TOKEN")
	// 60s was tried first and measurably too low for the heavier prompts
	// (analyze-thread's transcript + 5-field structured extraction): a real
	// call hit this timeout at exactly 60.06s, confirmed via the backend's own
	// log ("context deadline exceeded"), not a token-budget failure — the
	// model was still generating, not stuck. This doesn't cost anything on a
	// lightweight call that finishes in ~15-30s regardless of where the
	// ceiling sits; it only changes how long a genuinely broken request takes
	// to fail, which is the right tradeoff over truncating legitimate work.
	aiGPUTimeout = func() time.Duration {
		if d, err := time.ParseDuration(getenvOr("AI_GPU_TIMEOUT", "120s")); err == nil {
			return d
		}
		return 120 * time.Second
	}()
	aiGPUHTTP = &http.Client{} // per-request timeouts via context, not here
)

var (
	ErrAIGPUNotConfigured = errors.New("AI features are not configured")
	ErrAIGPUUnreachable   = errors.New("AI service is unreachable")
	ErrAIGPUUnauthorized  = errors.New("AI service rejected our credentials")
)

func aiGPUConfigured() bool { return aiGPUURL != "" }

// aiGPUPost mirrors interview_gpu.go's gpuPost — one JSON POST, decoded into
// out, one retry on a transport error or 5xx, using the shared default
// per-attempt timeout. aiGPUPostTimed below is the same thing with an
// explicit timeout for callers whose expected latency is well outside that
// default (analyze-thread — see its own comment).
func aiGPUPost(ctx context.Context, path string, in any, out any) error {
	return aiGPUPostTimed(ctx, path, in, out, aiGPUTimeout)
}

// aiGPUPostTimed is aiGPUPost with an explicit per-attempt timeout. Also
// fixes a real bug found by testing, not by inspection: the original retry
// loop retried unconditionally on ANY failure, including OUR OWN context
// deadline expiring. For a slow-but-working model, hitting our timeout means
// "still thinking, needs more time" — retrying with the IDENTICAL time
// budget can only ever fail again the same way, so all a retry accomplished
// there was doubling the wait before an equally-certain failure (confirmed:
// a real analyze-thread call took 2m30s and still came back empty, having
// silently retried once against a budget it had already proven insufficient
// for). Retries are now reserved for what they actually help with — a
// transient connection failure or a 5xx — not our own timeout.
func aiGPUPostTimed(ctx context.Context, path string, in any, out any, timeout time.Duration) error {
	if !aiGPUConfigured() {
		return ErrAIGPUNotConfigured
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
		rctx, cancel := context.WithTimeout(ctx, timeout)
		req, _ := http.NewRequestWithContext(rctx, "POST", aiGPUURL+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if aiGPUToken != "" {
			req.Header.Set("Authorization", "Bearer "+aiGPUToken)
		}

		res, err := aiGPUHTTP.Do(req)
		if err != nil {
			timedOut := rctx.Err() == context.DeadlineExceeded
			cancel()
			lastErr = ErrAIGPUUnreachable
			log.Printf("[AI] POST %s attempt %d failed after %s: %v",
				path, attempt+1, time.Since(started).Round(time.Millisecond), err)
			if timedOut {
				lastErr = errors.New("AI service took too long to respond")
				break // don't retry our own timeout against the same budget — see this function's header
			}
			continue
		}

		payload, readErr := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024))
		res.Body.Close()
		cancel()
		elapsed := time.Since(started).Round(time.Millisecond)

		switch {
		case res.StatusCode == 401 || res.StatusCode == 403:
			log.Printf("[AI] POST %s -> %d (auth) in %s", path, res.StatusCode, elapsed)
			return ErrAIGPUUnauthorized
		case res.StatusCode >= 500:
			lastErr = fmt.Errorf("AI service error (%d)", res.StatusCode)
			log.Printf("[AI] POST %s -> %d in %s, retrying", path, res.StatusCode, elapsed)
			continue
		case res.StatusCode >= 400:
			var e struct {
				Detail any `json:"detail"`
			}
			_ = json.Unmarshal(payload, &e)
			log.Printf("[AI] POST %s -> %d in %s: %v", path, res.StatusCode, elapsed, e.Detail)
			return fmt.Errorf("AI service rejected the request (%d)", res.StatusCode)
		}

		if readErr != nil {
			lastErr = ErrAIGPUUnreachable
			continue
		}
		if err := json.Unmarshal(payload, out); err != nil {
			log.Printf("[AI] POST %s -> unparseable reply in %s: %v", path, elapsed, err)
			return fmt.Errorf("AI service returned an unreadable reply")
		}
		log.Printf("[AI] POST %s -> 200 in %s (%d bytes)", path, elapsed, len(payload))
		return nil
	}
	return lastErr
}

// ─── Typed wrappers ──────────────────────────────────────────────────────────

// Public shape callers use — kept exactly as it was before the real contract
// was confirmed, so ai.go's handlers didn't need to change at all when this
// file's internals were corrected. Mapped to the real wire format
// (wireMessage, role+content) inside aiChat below.
type aiChatMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type wireMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type wireChatReq struct {
	Messages  []wireMessage `json:"messages"`
	MaxTokens int           `json:"max_tokens"`
}

// Thinking alone regularly runs 100-250+ tokens on this model before the real
// answer starts — see this file's header. Too low a budget here doesn't
// shorten the answer, it truncates it entirely inside the reasoning block,
// which is why this is generous rather than the small default a non-reasoning
// chat model would need.
// 700 was tried first and measurably too low: a real "summarize this one-line
// message" rewrite call still ran out of budget mid-<think> (confirmed via
// the truncation error above, not guessed) — reasoning length doesn't track
// task complexity in any way that's safe to budget tightly for.
const aiChatMaxTokens = 1200

var thinkBlockRe = regexp.MustCompile(`(?s)<think>.*?</think>\s*`)

// stripThinking removes the model's reasoning trace and returns the real
// answer. ok=false means a "<think>" was opened but never closed — generation
// was truncated mid-thought (max_tokens too low) — and the raw text must not
// be shown to a user as if it were the real answer.
func stripThinking(raw string) (answer string, ok bool) {
	if !strings.Contains(raw, "</think>") {
		if strings.Contains(raw, "<think>") {
			return "", false
		}
		return strings.TrimSpace(raw), true // this call genuinely didn't think — allowed, not an error
	}
	return strings.TrimSpace(thinkBlockRe.ReplaceAllString(raw, "")), true
}

// echoMarkerRe finds the point where this model starts hallucinating a FAKE
// continuation of the conversation instead of stopping after its real
// answer — confirmed directly, not guessed: given a short factual question,
// the real answer ("1:30 pm") consistently arrives FIRST, immediately
// followed by the model re-emitting "\nUser: <the entire prompt again>\n...
// \nAssistant: 1:30 pm" on a loop until max_tokens cuts it off. This is not
// the documented <think> reasoning behavior (that's already stripped above)
// — it is a separate failure mode: this service has no working stop-sequence
// support (a "stop" parameter was tried and confirmed silently ignored, same
// as "enable_thinking" per gpu/AI_CONTRACT.md), so nothing tells generation
// to halt at the natural end of the answer, and it free-runs into echoing
// its own prompt-formatting convention as if it were a new turn. Measured
// directly: this is what actually made reply-suggestions and Ask AIPA "feel
// stuck" — not slow reasoning, but ~4000 tokens of pure repetition after the
// real (short) answer had already been produced, every single call.
// Trimming at the first such marker fixes the user-visible symptom (a
// contaminated answer full of "User:"/"Assistant:" junk) regardless of
// budget; the max_tokens reduction alongside this fixes the actual latency,
// since the model still has to generate through however much budget it's
// given before this function ever sees the bytes — there is no streaming
// API to cut in early (confirmed: even "stream": true returns zero bytes
// until the entire generation finishes).
var echoMarkerRe = regexp.MustCompile(`(?i)\n\s*(user|assistant|question)\s*:`)

// trimEcho cuts a model answer off at the first sign it has started
// hallucinating a repeated turn, keeping only what came before. Searched
// from offset 1, not 0 — the real answer itself is allowed to start with
// "Assistant:" style text in the rare case that's genuinely part of it; only
// a marker appearing AFTER some real content is treated as the echo loop
// starting.
func trimEcho(s string) string {
	if loc := echoMarkerRe.FindStringIndex(s); loc != nil && loc[0] > 0 {
		return strings.TrimSpace(s[:loc[0]])
	}
	return s
}

// extractJSONObject finds the first balanced {...} substring in s. There is
// no server-side structured-output guarantee on this model (confirmed — see
// this file's header), so a caller asking for JSON gets it by instructing the
// model in the prompt and then pulling it back out here, tolerating whatever
// stray text the model adds around it despite being asked not to.
func extractJSONObject(s string) (string, bool) {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return "", false
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(s); i++ {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch s[i] {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch s[i] {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1], true
			}
		}
	}
	return "", false
}

// aiChat is the one entry point for most text features (chat assistant,
// reply suggestions, rewrite/writing tools). `schema` is repurposed as a
// plain "the caller wants a JSON object back" flag now that the real service
// has no structured-output support to pass it to — kept as a parameter
// (rather than a new bool, which would have meant touching every call site)
// so callers built against the original design didn't need to change when
// this internal correction happened.
func aiChat(ctx context.Context, system string, history []aiChatMessage, text string, schema json.RawMessage) (string, error) {
	return aiChatBudgeted(ctx, system, history, text, schema, aiChatMaxTokens)
}

// aiChatBudgeted is the same call with an explicit max_tokens override, for
// callers whose expected output is bigger than a rewrite/reply-suggestion —
// analyze-thread's 5-field structured report is the reason this exists:
// confirmed directly that its heavier prompt needs more headroom than the
// default (see aiChatMaxTokens' own comment for the truncation this default
// was already raised once to fix). Uses the shared default per-attempt
// timeout; aiChatBudgetedTimed below adds an explicit timeout on top for
// prompts heavy enough to need one too.
func aiChatBudgeted(ctx context.Context, system string, history []aiChatMessage, text string, schema json.RawMessage, maxTokens int) (string, error) {
	return aiChatBudgetedTimed(ctx, system, history, text, schema, maxTokens, aiGPUTimeout)
}

// aiChatBudgetedTimed adds an explicit per-attempt timeout on top of
// aiChatBudgeted. analyze-thread needs this: its heavier prompt (a full
// transcript plus a 6-field structured report, now with explicit instructions
// to reconcile corrections across messages) measured needing MORE than the
// standard 120s ceiling in direct testing (a real call hit that timeout with
// the model still generating, not stuck) — a bigger max_tokens alone doesn't
// help if the wall-clock ceiling cuts the call off first.
// UPDATE, 2026-09: the GPU VM rebuilt its Qwen server (previously a hand-
// rolled loop around a raw model.generate() call with no real chat template
// — see the file-level notes above and gpu/AI_CONTRACT.md for the full
// history of what that caused) and, in the process, switched the response
// envelope from this service's original custom {"result": "..."} shape to
// the standard OpenAI chat-completions shape
// ({"choices":[{"message":{"content":...},"finish_reason":...}]}) — reported
// to us as "no breaking changes", which was not accurate; confirmed directly
// against the real service that /v1/chat/completions now returns the new
// shape, and confirmed the OLD parsing left every single AI feature in this
// app silently returning an empty string in production until this was
// caught and fixed. wireChatResp below matches what's actually live, not
// what was claimed.
//
// The underlying fix is real and substantial, independently verified against
// the real service (not just taken on their word): a trivial question that
// previously took 30-90s due to a free-running echo-loop (the model failing
// to recognize <|im_end|> and continuing to generate a fake "User: ...
// Assistant: ..." continuation of the conversation until max_tokens was
// hit — see this file's still-relevant trimEcho/stripThinking, kept as a
// defensive no-op backstop, not because they're expected to fire routinely
// any more) now completes in 1-5s. stop sequences and real token-by-token
// SSE streaming (not used by this client yet, but confirmed genuinely
// working, not just accepted-and-ignored) both work correctly now too.
//
// One real, disclosed limitation surfaced by testing, not by their report:
// the model identifies itself as "Qwen/Qwen3.5-2B-Base" — a BASE (non-
// instruction-tuned) model. It handles ordinary multi-turn assistant chat
// correctly (confirmed: recalled a fact stated two turns earlier), but
// unreliably follows a system-prompt instruction to analyze/transform a
// conversation when that conversation is framed as literal multi-turn role
// history (confirmed: given reply-suggestions' original role-mapped-history
// shape, it just echoed the input back instead of attempting the task) —
// it tends to continue participating in a conversation shaped like one,
// rather than stepping outside it to complete a meta-task. This app's own
// prompts for exactly that category (reply-suggestions, ask-thread) already
// use a single-turn, transcript-embedded-as-plain-text shape rather than
// role-mapped history (fixed for a different reason earlier — see
// replyLineRe's comment in ai.go) and were confirmed, directly, to still
// work correctly against the new server. Only a caller that starts sending
// a real analyze-a-conversation task as multi-turn role history would hit
// this.
type wireChatResp struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
}

func aiChatBudgetedTimed(ctx context.Context, system string, history []aiChatMessage, text string, schema json.RawMessage, maxTokens int, timeout time.Duration) (string, error) {
	msgs := make([]wireMessage, 0, len(history)+2)
	if system != "" {
		msgs = append(msgs, wireMessage{Role: "system", Content: system})
	}
	for _, m := range history {
		msgs = append(msgs, wireMessage{Role: m.Role, Content: m.Text})
	}
	msgs = append(msgs, wireMessage{Role: "user", Content: text})

	var out wireChatResp
	if err := aiGPUPostTimed(ctx, "/v1/chat/completions", wireChatReq{Messages: msgs, MaxTokens: maxTokens}, &out, timeout); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", errors.New("AI service returned no response")
	}
	raw := out.Choices[0].Message.Content
	if out.Choices[0].FinishReason == "length" {
		// Genuinely truncated by max_tokens, not a stylistic choice — the old
		// stripThinking() caught this via an unclosed <think> tag; the new
		// server reports it explicitly instead, which is more reliable, so
		// this checks first and stripThinking's own check stays as a backstop
		// for the (now rare) case where thinking is still present.
		return "", errors.New("AI service response was cut off before it finished — try again")
	}
	answer, ok := stripThinking(raw)
	if !ok {
		return "", errors.New("AI service response was cut off before it finished reasoning — try again")
	}
	answer = trimEcho(answer)
	if schema != nil {
		if obj, found := extractJSONObject(answer); found {
			return obj, nil
		}
		return "", errors.New("AI service did not return a JSON object as requested")
	}
	return answer, nil
}

// aiVision backs the vision/OCR features via /query — see gpu/AI_CONTRACT.md
// for why this is currently unusable against the real service (a different,
// still-unresolved error as of the /chat fix: "mm_token_type_ids" rejected by
// the model's generate() call — a GPU-side multimodal processing bug, not a
// client-side usage mistake).
func aiVision(ctx context.Context, imageURL, text string) (string, error) {
	var out struct {
		Result string `json:"result"`
	}
	if err := aiGPUPost(ctx, "/query", map[string]string{
		"image_url": imageURL,
		"text":      text,
	}, &out); err != nil {
		return "", err
	}
	answer, ok := stripThinking(out.Result)
	if !ok {
		return "", errors.New("AI service response was cut off before it finished reasoning — try again")
	}
	return answer, nil
}
