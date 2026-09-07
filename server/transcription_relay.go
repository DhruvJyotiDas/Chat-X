package main

// Browser-facing WS relay for live captions (/asr), consuming
// gpu/ASR_CONTRACT.md via asr_gpu.go. One connection per active speaker —
// see the O(N) vs O(N²) reasoning in the plan: each browser only ever
// streams its OWN mic here, never a peer's already-decoded remote audio.
//
// This never touches the mesh call's audio/video path — it is a pure side
// channel. Any failure here (GPU down, not configured, translate erroring)
// degrades to a visible "captions unavailable" state and never affects the
// call itself.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type asrHandshake struct {
	RoomID   string `json:"room_id"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
}

func asrUnavailable(conn *websocket.Conn, reason string) {
	_ = conn.WriteJSON(map[string]string{"type": "unavailable", "reason": reason})
}

func reasonForASRErr(err error) string {
	switch err {
	case ErrASRNotConfigured:
		return "not_configured"
	case ErrASRLoading:
		return "loading"
	case ErrASRUnauthorized:
		return "unauthorized"
	default:
		return "unreachable"
	}
}

// activeCaptionLangs snapshots the room's current viewers' caption-language
// choices, deduped and excluding anything equal to the segment's own detected
// language (translating a language into itself is pointless). This is what
// bounds /v1/translate to only languages someone is actually reading — 5
// viewers wanting Spanish costs one NLLB call, not five, and a room where
// nobody has picked a caption language costs zero.
func activeCaptionLangs(room *Room, sourceLang string) []string {
	room.mu.RLock()
	defer room.mu.RUnlock()
	seen := map[string]bool{}
	var out []string
	for _, c := range room.clients {
		lang := c.captionLang
		if lang == "" || lang == sourceLang || seen[lang] {
			continue
		}
		seen[lang] = true
		out = append(out, lang)
	}
	return out
}

func handleASRRelay(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(10 * time.Second)) //nolint
	_, data, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var hs asrHandshake
	if json.Unmarshal(data, &hs) != nil || hs.RoomID == "" || hs.UserID == "" {
		asrUnavailable(conn, "bad_handshake")
		return
	}
	// Reset the deadline the handshake read imposed — audio can legitimately
	// pause for a while (someone stays muted, or just isn't talking).
	conn.SetReadDeadline(time.Time{}) //nolint

	roomsMu.RLock()
	room, found := rooms[hs.RoomID]
	roomsMu.RUnlock()
	if !found {
		asrUnavailable(conn, "room_not_found")
		return
	}
	room.mu.RLock()
	_, isMember := room.clients[hs.UserID]
	room.mu.RUnlock()
	if !isMember {
		// Tighter than the chat/reaction trust model on purpose: those ride
		// an already-joined signalling socket, this is a fresh connection
		// that could otherwise caption into a room it was never part of.
		asrUnavailable(conn, "not_in_room")
		return
	}

	if !asrConfigured() {
		asrUnavailable(conn, "not_configured")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// browser -> GPU: pump binary audio frames through as-is. Runs for the
	// lifetime of the browser connection regardless of GPU reconnects below.
	audioCh := make(chan []byte, 8)
	go func() {
		defer close(audioCh)
		defer cancel()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mt != websocket.BinaryMessage {
				continue
			}
			select {
			case audioCh <- data:
			case <-ctx.Done():
				return
			}
		}
	}()

	log.Printf("[ASR] stream requested: room=%s user=%s (%s)", hs.RoomID, hs.UserID, hs.UserName)
	runASRSession(ctx, conn, room, hs, audioCh)
}

// runASRSession owns one speaker's GPU connection for the lifetime of their
// browser connection, redialing with brief backoff if the GPU VM drops mid-
// stream. Gives up and reports "unreachable" only after a few attempts, not
// on the first blip — a GPU VM under load is expected to hiccup sometimes.
func runASRSession(ctx context.Context, conn *websocket.Conn, room *Room, hs asrHandshake, audioCh <-chan []byte) {
	backoffs := []time.Duration{0, 1 * time.Second, 3 * time.Second, 6 * time.Second}
	for attempt, wait := range backoffs {
		if wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return
			}
		}
		gpuConn, err := asrDialStream(ctx, hs.RoomID, hs.UserID)
		if err != nil {
			if attempt == len(backoffs)-1 {
				asrUnavailable(conn, reasonForASRErr(err))
				return
			}
			continue
		}

		if attempt > 0 {
			log.Printf("[ASR] reconnected to GPU VM: room=%s user=%s (attempt %d)", hs.RoomID, hs.UserID, attempt+1)
		} else {
			// Told the browser BEFORE any audio is read from audioCh — its mic
			// capture is gated on seeing this, per ASR_CONTRACT.md's "never
			// opens a mic when not configured/unreachable" promise. A later
			// mid-stream drop and redial (attempt > 0) does not repeat this:
			// the browser is already recording by then, redialing is meant to
			// be invisible to it.
			_ = conn.WriteJSON(map[string]string{"type": "ready"})
		}
		dropped := pumpASRSession(ctx, gpuConn, room, hs, audioCh)
		gpuConn.Close()
		if !dropped {
			return // browser hung up — session ended cleanly, not a GPU failure
		}
		// GPU side dropped mid-stream: loop around and try the next backoff.
	}
}

// pumpASRSession relays audio in and partial/final events out for one live
// GPU connection. Returns true if the GPU side dropped (caller may redial),
// false if the browser side ended the session.
func pumpASRSession(ctx context.Context, gpuConn *websocket.Conn, room *Room, hs asrHandshake, audioCh <-chan []byte) bool {
	gpuDone := make(chan struct{})
	go func() {
		defer close(gpuDone)
		for {
			select {
			case data, ok := <-audioCh:
				if !ok {
					gpuConn.Close() // browser hung up — unblock the read loop below
					return
				}
				gpuConn.SetWriteDeadline(time.Now().Add(5 * time.Second)) //nolint
				if err := gpuConn.WriteMessage(websocket.BinaryMessage, data); err != nil {
					return
				}
			case <-ctx.Done():
				gpuConn.Close()
				return
			}
		}
	}()

	for {
		_, data, err := gpuConn.ReadMessage()
		if err != nil {
			<-gpuDone
			select {
			case <-ctx.Done():
				return false // browser side ended it
			default:
				return true // GPU side dropped — eligible for redial
			}
		}
		var evt struct {
			Type       string  `json:"type"`
			Text       string  `json:"text"`
			Lang       string  `json:"language"`
			Confidence float64 `json:"confidence"`
			Code       string  `json:"code"`
			Message    string  `json:"message"`
		}
		if json.Unmarshal(data, &evt) != nil {
			continue
		}
		if evt.Type == "error" {
			// Non-fatal per CONTRACT.md — one utterance failed to decode, the
			// connection stays open. Log and keep pumping.
			log.Printf("[ASR] GPU-side error event: room=%s user=%s code=%s msg=%s", hs.RoomID, hs.UserID, evt.Code, evt.Message)
			continue
		}
		handleASREvent(ctx, room, hs, evt.Type, evt.Text, evt.Lang, evt.Confidence)
	}
}

func handleASREvent(ctx context.Context, room *Room, hs asrHandshake, evtType, text, lang string, confidence float64) {
	switch evtType {
	case "partial":
		if text == "" {
			return
		}
		room.broadcastAll("caption", map[string]any{
			"peer_id": hs.UserID, "peer_name": hs.UserName,
			"text": text, "lang": lang, "is_final": false,
		})
	case "final":
		if text == "" {
			return
		}
		// capID correlates this final with whatever translation follows it —
		// see the broadcast split below for why the two are no longer one
		// synchronous step.
		capID := newID()
		saveTranscriptLine(hs.RoomID, hs.UserID, hs.UserName, text, lang)
		room.broadcastAll("caption", map[string]any{
			"peer_id": hs.UserID, "peer_name": hs.UserName,
			"text": text, "lang": lang, "is_final": true,
			"confidence": confidence, "cap_id": capID,
		})

		targets := activeCaptionLangs(room, lang)
		if len(targets) == 0 {
			return
		}
		// Translation now runs AFTER the original final has already been
		// broadcast, not before it, and in its own goroutine rather than
		// blocking this one — load-bearing, not a style choice. Before this
		// split, a translate call sat in the middle of this function, ahead
		// of the broadcast above: fine when it was the OLD fast NLLB call
		// (well under a second), but asrTranslate now routes through the
		// Qwen chat model (NLLB was removed from the GPU VM along with the
		// other ASR models — see asrTranslate's own comment), where even ONE
		// target language can take anywhere from a few seconds to over a
		// minute, and multiple requested languages multiply that
		// sequentially. Leaving the old synchronous order would have delayed
		// the ORIGINAL English caption — which every viewer sees, translating
		// or not — by however long translation happened to take, breaking
		// "live" captions entirely rather than just slowing down the
		// translated line for the (usually smaller) set of viewers reading
		// one. Running it in its own goroutine, after the real-time-critical
		// broadcast, means a slow or failed translation can never hold up
		// the thing every single viewer is waiting on.
		// Deliberately NOT ctx (this speaker's ASR session context) — a real
		// bug, caught by testing, not by inspection: ctx is cancelled the
		// moment this speaker's underlying /v1/stream connection ends or
		// redials (runASRSession/pumpASRSession share it), which happens
		// routinely and has nothing to do with whether a translation that's
		// already in flight should be abandoned. Confirmed directly — a real
		// run showed SIX translate calls all fail with "context canceled" at
		// the exact same instant the session's connection cycled, well
		// before any of them could plausibly have timed out on their own.
		// The text to translate was already fully captured when this
		// goroutine started; it has no remaining dependency on that specific
		// connection staying open. context.Background() here is safe, not a
		// leak risk, because asrTranslate still bounds each language's own
		// call via lightAITimeout internally regardless of what's passed in.
		go func() {
			out, err := asrTranslate(context.Background(), text, lang, targets)
			if err != nil {
				log.Printf("[ASR] translate failed for room=%s: %v", hs.RoomID, err)
				return
			}
			if len(out) == 0 {
				return
			}
			room.broadcastAll("caption_translation", map[string]any{
				"peer_id": hs.UserID, "cap_id": capID, "translations": out,
			})
		}()
	}
}
