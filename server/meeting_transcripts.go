package main

// Live-caption transcript persistence + a Minutes-of-Meeting (MOM) summary
// built from it. Requested directly: save every meeting's spoken transcript
// to durable storage (not just the in-memory Room.clients/liveCaptions the
// call itself uses, which vanishes the moment the room is reaped) so it can
// be downloaded afterward or summarized into a MOM, the same way chat
// threads already get "Summarize this conversation".
//
// Every FINAL caption event (never partials — same rule translation already
// follows) is saved here as it's broadcast, in handleASREvent
// (transcription_relay.go) — server-side, unconditionally, regardless of
// whether anyone has the Live Captions panel open or even has a browser tab
// focused. This is deliberate: a transcript that only existed in whichever
// client happened to be watching would be lost the moment that person's tab
// closed, which defeats the entire point of being able to generate a MOM
// after the fact.
//
// Saved as the ORIGINAL spoken text only (always English now — see
// gpu/ASR_CONTRACT.md's 2026-09 update), not per-viewer translations: a
// transcript is the room's single shared record, and translations are a
// per-viewer display preference computed on demand, not something to
// multiply storage for by however many languages people happened to have
// selected during the call.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func migrateMeetingTranscripts() {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS meeting_transcripts (
		id VARCHAR(64) PRIMARY KEY,
		room_id VARCHAR(255) NOT NULL,
		speaker_id VARCHAR(255) NOT NULL,
		speaker_name VARCHAR(255) NOT NULL,
		text TEXT NOT NULL,
		lang VARCHAR(16) NOT NULL DEFAULT 'en',
		created_at DATETIME(6) DEFAULT NOW(6),
		INDEX idx_room_time (room_id, created_at)
	)`)
	if err != nil {
		panic(err)
	}
	// Durable membership is the authorization source for transcript access.
	// The in-memory signaling roster disappears on restart, while a room code is
	// an identifier rather than a capability.
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS meeting_participants (
		room_id VARCHAR(255) NOT NULL,
		user_id VARCHAR(255) NOT NULL,
		user_name VARCHAR(255) NOT NULL,
		joined_at DATETIME(6) DEFAULT NOW(6),
		last_seen_at DATETIME(6) DEFAULT NOW(6),
		left_at DATETIME(6),
		PRIMARY KEY (room_id, user_id),
		INDEX idx_meeting_participant_user (user_id, room_id)
	)`)
	if err != nil {
		panic(err)
	}
}

// meetingParticipantAccess deliberately permits a participant who has already
// left: post-call transcript review is part of the meeting experience. It does
// not permit arbitrary signed-in users who only know the room code. Scheduled
// meetings are checked as a compatibility path for rooms created before the
// durable participant table existed.
func meetingParticipantAccess(roomID, userID string) bool {
	var found int
	if err := db.QueryRow(`SELECT 1 FROM meeting_participants WHERE room_id=? AND user_id=? LIMIT 1`, roomID, userID).Scan(&found); err == nil {
		return true
	}
	if err := db.QueryRow(`SELECT 1 FROM scheduled_meetings WHERE code=? AND (creator_id=? OR JSON_CONTAINS(COALESCE(invitee_ids, JSON_ARRAY()), JSON_QUOTE(?))) LIMIT 1`, roomID, userID, userID).Scan(&found); err == nil {
		return true
	}
	return false
}

// saveTranscriptLine is best-effort and never blocks a caption from
// reaching the room over it — a DB hiccup here degrades "the MOM feature
// works" not "captions work", and those must stay independent failure
// domains the same way every other GPU-adjacent feature in this codebase
// does (see e.g. transcription_relay.go's own header).
func saveTranscriptLine(roomID, speakerID, speakerName, text, lang string) {
	if _, err := db.Exec(
		`INSERT INTO meeting_transcripts (id, room_id, speaker_id, speaker_name, text, lang) VALUES (?,?,?,?,?,?)`,
		newID(), roomID, speakerID, speakerName, text, lang,
	); err != nil {
		// Not logged via log.Printf("[ASR]...") — this isn't an ASR-pipeline
		// failure, it's a separate persistence concern; tagged distinctly so
		// the two are never confused when reading logs later.
		fmt.Printf("[Transcript] save failed for room=%s: %v\n", roomID, err)
	}
}

type transcriptLineRow struct {
	SpeakerID   string `json:"speakerId"`
	SpeakerName string `json:"speakerName"`
	Text        string `json:"text"`
	Lang        string `json:"lang"`
	CreatedAt   string `json:"createdAt"`
}

func fetchTranscriptLines(roomID string) ([]transcriptLineRow, error) {
	rows, err := db.Query(
		`SELECT speaker_id, speaker_name, text, lang, created_at FROM meeting_transcripts WHERE room_id=? ORDER BY created_at ASC`,
		roomID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lines []transcriptLineRow
	for rows.Next() {
		var l transcriptLineRow
		var createdAt time.Time
		if err := rows.Scan(&l.SpeakerID, &l.SpeakerName, &l.Text, &l.Lang, &createdAt); err != nil {
			continue
		}
		l.CreatedAt = createdAt.Format(time.RFC3339)
		lines = append(lines, l)
	}
	return lines, nil
}

// ─── GET /api/meetings/{roomId}/transcript ───────────────────────────────────
func handleMeetingTranscript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	roomID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/meetings/"), "/transcript")
	if roomID == "" {
		fail(w, "not found", 404)
		return
	}
	if !meetingParticipantAccess(roomID, uid) {
		fail(w, "not a participant in this meeting", http.StatusForbidden)
		return
	}
	lines, err := fetchTranscriptLines(roomID)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	ok(w, map[string]any{"roomId": roomID, "lines": lines})
}

// ─── POST /api/meetings/{roomId}/summary ─────────────────────────────────────
//
// A Minutes-of-Meeting summary generated from the saved transcript — the
// call-transcript equivalent of chat's "Summarize this conversation"
// (handleAIAnalyzeThread), and built the same proven way: a single system +
// single user turn with the whole transcript embedded as plain text (never
// a role-mapped multi-turn history — see replyLineRe's comment in ai.go for
// the exact, reproduced failure that pattern causes on this model), asking
// for one strict JSON object. Uses analyzeMaxTokens/analyzeTimeout (the
// heavier of this app's two AI budgets, not lightAIMaxTokens) because a real
// MOM — summary, attendees, decisions, action items — is comparable in
// scope to analyze-thread's own 7-field report, not a short single-sentence
// answer like ask-thread's questions; this is a deliberate, one-time,
// after-the-call action, not something read on a hot path, so the same
// "can take a couple of minutes" UX analyze-thread already uses applies here
// too.
type momActionItem struct {
	Description string `json:"description"`
	Owner       string `json:"owner"`
}
type meetingSummary struct {
	Summary     string          `json:"summary"`
	Attendees   []string        `json:"attendees"`
	KeyPoints   []string        `json:"keyPoints"`
	Decisions   []string        `json:"decisions"`
	ActionItems []momActionItem `json:"actionItems"`
}

func handleMeetingSummary(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if r.Method != http.MethodPost {
		fail(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	roomID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/meetings/"), "/summary")
	if roomID == "" {
		fail(w, "not found", 404)
		return
	}
	if !meetingParticipantAccess(roomID, uid) {
		fail(w, "not a participant in this meeting", http.StatusForbidden)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	lines, err := fetchTranscriptLines(roomID)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	if len(lines) == 0 {
		fail(w, "no transcript saved for this meeting yet — turn on captions during the call to record one", 400)
		return
	}

	var transcript strings.Builder
	seen := map[string]bool{}
	var attendeeOrder []string
	for _, l := range lines {
		fmt.Fprintf(&transcript, "%s: %s\n", l.SpeakerName, l.Text)
		if !seen[l.SpeakerName] {
			seen[l.SpeakerName] = true
			attendeeOrder = append(attendeeOrder, l.SpeakerName)
		}
	}

	system := "You write Minutes of Meeting (MOM) from a call transcript. Be concise and strictly factual — only " +
		"include what is actually present in the transcript, never invent names, numbers, or facts not said. If a " +
		"category has nothing, use an empty array. " +
		"Your final answer must be ONLY a single JSON object, no other text, no markdown, in exactly this shape: " +
		`{"summary":"2-4 sentence overview of what the meeting covered","attendees":["names of everyone who spoke"],` +
		`"keyPoints":["notable points raised"],"decisions":["things the group agreed or decided on"],` +
		`"actionItems":[{"description":"a task someone committed to","owner":"who committed to it, or unclear"}]}`
	prompt := "Meeting transcript (oldest first):\n" + transcript.String() + "\nProduce the JSON MOM described."

	wantJSON := json.RawMessage(`{"required":["summary","attendees","keyPoints","decisions","actionItems"]}`)
	result, err := aiChatBudgetedTimed(r.Context(), system, nil, prompt, wantJSON, analyzeMaxTokens, analyzeTimeout)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	var summary meetingSummary
	if err := json.Unmarshal([]byte(result), &summary); err != nil {
		// Graceful degradation, not a hard failure: a MOM that's just an
		// unstructured block of prose is still genuinely usable, and this
		// model does not reliably comply with a strict JSON shape 100% of
		// the time (see ai.go's own notes throughout on this). Falls back to
		// the raw text plus the attendee list this file can already compute
		// itself from speaker names, without needing the model's cooperation.
		summary = meetingSummary{Summary: strings.TrimSpace(result), Attendees: attendeeOrder}
	}
	if len(summary.Attendees) == 0 {
		summary.Attendees = attendeeOrder
	}
	ok(w, summary)
}
