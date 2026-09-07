package main

// AI Calendar Intelligence, made live: automatic meeting detection from chat,
// posted back into the conversation as a card both participants see, kept in
// sync as the time is revised mid-conversation, plus a 5-minutes-before
// reminder to both participants.
//
// HONEST LATENCY NOTE, load-bearing for anyone touching this: the model this
// runs on measures 60-200+ seconds per call (see gpu/AI_CONTRACT.md's own
// Latency section) — "automatic" here means the meeting card appears roughly
// a minute or two after the message that prompted it, not instantly. There is
// no way to make detection itself faster without a different (or additional)
// model; what this file optimizes instead is not calling that slow model more
// than necessary (a cheap local keyword check gates almost everything out
// before it ever reaches the GPU) and never blocking the message-send request
// on it (always fired as its own goroutine).
//
// The calendar itself is still per-user localStorage (calendarLocal.ts) —
// this file does NOT move that server-side. What IS server-side is exactly
// one row per thread's currently-active AI-detected meeting (ai_meetings),
// which both participants' clients read the SAME resolved date/time from (via
// the meeting-card message embedded in the thread) and use to create/update/
// cancel their own local calendar event with a shared, deterministic id. That
// row is also what the reminder ticker below queries — a real per-thread
// source of truth is what makes "notify both people once, at the right time"
// possible at all when the display store is otherwise per-user.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
)

func migrateAIMeetings() {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS ai_meetings (
		id VARCHAR(64) PRIMARY KEY,
		thread_id VARCHAR(255) NOT NULL,
		title VARCHAR(255) NOT NULL,
		meeting_date DATE NOT NULL,
		start_time TIME NOT NULL,
		status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
		notified_5min TINYINT(1) NOT NULL DEFAULT 0,
		created_at DATETIME(6) DEFAULT NOW(6),
		updated_at DATETIME(6) DEFAULT NOW(6),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
	)`)
	if err != nil {
		panic(err)
	}
}

// ─── The message-card format ──────────────────────────────────────────────────
//
// A control-character prefix, not a plain string like "MEETING:" — a real
// human message starting with the word "meeting" must never be misread as a
// card. Self-contained (the full resolved title/date/time lives IN the
// message text, not just in a transient ws event) so reloading the thread
// and re-fetching history via plain GET reconstructs the exact same card —
// no separate "did you miss the live event" problem.
const meetingCardPrefix = "\x01MEETING\x01"

type meetingCardPayload struct {
	MeetingID string `json:"meetingId"`
	Title     string `json:"title"`
	Date      string `json:"date"`   // YYYY-MM-DD
	Time      string `json:"time"`   // HH:MM, 24h
	Action    string `json:"action"` // "created" | "updated" | "cancelled"
}

func encodeMeetingCard(p meetingCardPayload) string {
	b, _ := json.Marshal(p)
	return meetingCardPrefix + string(b)
}

// friendlyMessagePreview is what a thread-list row shows for its last
// message — the raw card text (control-character prefix + JSON) is correct
// for the client's own message-list parsing but would look like broken
// garbage as a one-line preview, so this is the one other place besides the
// full message rendering that needs to know the card format exists.
func friendlyMessagePreview(text string) string {
	if !strings.HasPrefix(text, meetingCardPrefix) {
		return text
	}
	var p meetingCardPayload
	if err := json.Unmarshal([]byte(strings.TrimPrefix(text, meetingCardPrefix)), &p); err != nil {
		return "📅 Meeting update"
	}
	switch p.Action {
	case "cancelled":
		return "📅 Meeting cancelled"
	case "updated":
		return "📅 Meeting updated: " + p.Title
	default:
		return "📅 Meeting scheduled: " + p.Title
	}
}

// ─── Cheap local gate before ever calling the slow model ─────────────────────

// Broadened after a real gap found by testing: "actually can we push it to
// 2:30 instead, running a bit behind" — a completely natural way to revise a
// meeting time in chat — matched NONE of the original keywords (no am/pm, no
// "meet"/"schedule"/etc.) and silently never reached the model at all. Now
// also fires on a bare H:MM time (no am/pm required) and on common revision
// verbs, deliberately erring toward more false positives (each one costs one
// wasted ~60-200s model call that concludes "no meeting", not a wrong
// answer) over the alternative of silently missing a real revision, which
// breaks the actual feature.
var meetingHintRe = regexp.MustCompile(`(?i)\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b|\b(meet\w*|schedul\w*|reschedul\w*|postpone\w*|cancel\w*|push\w*|delay\w*|running late|running behind)\b`)

func looksLikeMeetingMention(text string) bool {
	return meetingHintRe.MatchString(text)
}

// ─── Debounce + concurrency limit ─────────────────────────────────────────────
//
// Debounce: several meeting-ish messages sent in a quick back-and-forth
// ("how about 3?" / "make it 4" / "works") would each independently pass the
// keyword gate — without this, they'd fire 3 overlapping ~2-minute model
// calls for what is really one negotiation, tripling GPU load for no benefit
// (each one only sees the same conversation with one more line appended, and
// the resolution logic already reads the whole thread). One in-flight
// detection per thread; a message arriving mid-detection just waits for the
// next one to naturally pick it up if it's still relevant then.
//
// Concurrency limit: a small fixed number of detections may run at once
// across ALL threads, so a burst of activity across many chats can't queue up
// unbounded slow calls against one shared GPU.
var (
	meetingDetectMu       sync.Mutex
	meetingDetectInFlight = map[string]bool{}
	meetingDetectSlots    = make(chan struct{}, 3)
)

func detectAndSyncMeeting(threadID string) {
	meetingDetectMu.Lock()
	if meetingDetectInFlight[threadID] {
		meetingDetectMu.Unlock()
		return
	}
	meetingDetectInFlight[threadID] = true
	meetingDetectMu.Unlock()
	defer func() {
		meetingDetectMu.Lock()
		delete(meetingDetectInFlight, threadID)
		meetingDetectMu.Unlock()
	}()

	meetingDetectSlots <- struct{}{}
	defer func() { <-meetingDetectSlots }()

	if !aiGPUConfigured() {
		return
	}

	rows, err := db.Query(`
		SELECT COALESCE(u.display_name,'IB Connect'), m.text FROM messages m LEFT JOIN users u ON u.id=m.sender_id
		WHERE m.thread_id=? ORDER BY m.created_at DESC LIMIT 30
	`, threadID)
	if err != nil {
		log.Printf("[AI meetings] thread %s: db error loading context: %v", threadID, err)
		return
	}
	type row struct{ name, text string }
	var recent []row
	for rows.Next() {
		var rr row
		rows.Scan(&rr.name, &rr.text)                       //nolint
		if !strings.HasPrefix(rr.text, meetingCardPrefix) { // don't feed our own cards back in as if a human said them
			recent = append(recent, rr)
		}
	}
	rows.Close()
	if len(recent) == 0 {
		return
	}
	var transcript strings.Builder
	for i := len(recent) - 1; i >= 0; i-- {
		fmt.Fprintf(&transcript, "%s: %s\n", recent[i].name, recent[i].text)
	}

	now := time.Now()
	system := fmt.Sprintf(
		"You detect meeting scheduling in chat conversations. Today's real date is %s (%s), current time %s — use this "+
			"to resolve relative phrases (\"today\", \"tomorrow\", \"Friday\") into real dates yourself; never ask the user "+
			"for clarification, just make the most reasonable reading. "+
			"If a later message revises, corrects, or reschedules a meeting proposed earlier, resolve to the single final "+
			"time only (e.g. a meeting proposed for 12:50pm then pushed back 10 minutes resolves to 1:00pm — compute this "+
			"arithmetic yourself). "+
			"A proposal counts even if phrased as a question (\"can we meet at 4?\") and even if never explicitly confirmed. "+
			"If the conversation explicitly cancels or calls off a previously proposed meeting, report that as a cancellation. "+
			"If there is no meeting proposal of any kind in the conversation, say so plainly. "+
			"Your final answer must be ONLY a single JSON object, no other text, no markdown, in exactly this shape: "+
			`{"hasMeeting":true|false,"cancelled":true|false,"title":"a short meeting title","date":"YYYY-MM-DD","time":"HH:MM in 24-hour time"}`,
		now.Format("2006-01-02"), now.Format("Monday"), now.Format("15:04"))
	prompt := "Conversation (oldest first):\n" + transcript.String() + "\nProduce the JSON report described."

	wantJSON := json.RawMessage(`{"required":["hasMeeting","cancelled","title","date","time"]}`)
	// Smaller task than the full analyze-thread report (one small object, not
	// seven fields) — 2000/150s both have real margin over what this alone
	// tends to need, without the extra size analyze-thread's own heavier
	// prompt required.
	ctx, cancel := context.WithTimeout(context.Background(), 170*time.Second)
	defer cancel()
	result, err := aiChatBudgetedTimed(ctx, system, nil, prompt, wantJSON, 2000, 150*time.Second)
	if err != nil {
		log.Printf("[AI meetings] thread %s: detection call failed: %v", threadID, err)
		return
	}

	var detected struct {
		HasMeeting bool   `json:"hasMeeting"`
		Cancelled  bool   `json:"cancelled"`
		Title      string `json:"title"`
		Date       string `json:"date"`
		Time       string `json:"time"`
	}
	if err := json.Unmarshal([]byte(result), &detected); err != nil {
		log.Printf("[AI meetings] thread %s: unreadable reply: %v", threadID, err)
		return
	}

	var existingID, existingTitle, existingDate, existingTime string
	err = db.QueryRow(`SELECT id, title, meeting_date, start_time FROM ai_meetings WHERE thread_id=? AND status='scheduled'`, threadID).
		Scan(&existingID, &existingTitle, &existingDate, &existingTime)
	hasExisting := err == nil

	members := threadMembers(threadID)

	switch {
	case detected.Cancelled && hasExisting:
		db.Exec(`UPDATE ai_meetings SET status='cancelled', updated_at=NOW(6) WHERE id=?`, existingID) //nolint
		postMeetingCard(threadID, members, meetingCardPayload{MeetingID: existingID, Title: existingTitle, Action: "cancelled"})

	case detected.HasMeeting && detected.Date != "" && detected.Time != "":
		if hasExisting {
			// existingTime comes back from MariaDB's TIME column as HH:MM:SS;
			// compare against the model's HH:MM by trimming seconds, not by
			// reformatting the model's output to match — the DB's format is
			// the implementation detail here, not the model's.
			existingTimeShort := existingTime
			if len(existingTimeShort) >= 5 {
				existingTimeShort = existingTimeShort[:5]
			}
			if existingDate == detected.Date && existingTimeShort == detected.Time {
				return // genuinely unchanged — no card, no notification reset, no spam
			}
			db.Exec(`UPDATE ai_meetings SET title=?, meeting_date=?, start_time=?, notified_5min=0, updated_at=NOW(6) WHERE id=?`, //nolint
				detected.Title, detected.Date, detected.Time, existingID)
			postMeetingCard(threadID, members, meetingCardPayload{MeetingID: existingID, Title: detected.Title, Date: detected.Date, Time: detected.Time, Action: "updated"})
		} else {
			id := newID()
			db.Exec(`INSERT INTO ai_meetings(id, thread_id, title, meeting_date, start_time) VALUES (?,?,?,?,?)`, //nolint
				id, threadID, detected.Title, detected.Date, detected.Time)
			postMeetingCard(threadID, members, meetingCardPayload{MeetingID: id, Title: detected.Title, Date: detected.Date, Time: detected.Time, Action: "created"})
		}
	}
	// hasMeeting:false and no existing row -> genuinely nothing to do, silently.
}

// postMeetingCard writes the card as a real, persisted chat message (sender_id
// NULL — see handleMessages' LEFT JOIN/COALESCE, changed alongside this file)
// and pushes it over the same "new_message" ws event real messages use, so
// the frontend needs no new event type to render it live.
func postMeetingCard(threadID string, members []string, payload meetingCardPayload) {
	msgID := "msg-" + newID()
	text := encodeMeetingCard(payload)
	if _, err := db.Exec(`INSERT INTO messages(id, thread_id, sender_id, text) VALUES (?,?,NULL,?)`, msgID, threadID, text); err != nil {
		log.Printf("[AI meetings] thread %s: failed to post card: %v", threadID, err)
		return
	}
	var m Message
	var ts float64
	db.QueryRow(`
		SELECT m.id, m.thread_id, COALESCE(m.sender_id,''), COALESCE(u.display_name,'IB Connect'), COALESCE(u.avatar,''),
			m.text, DATE_FORMAT(m.created_at,'%h:%i %p'), UNIX_TIMESTAMP(m.created_at)*1000
		FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.id=?
	`, msgID).Scan(&m.ID, &m.ThreadID, &m.SenderID, &m.SenderName, &m.SenderAvatar, &m.Text, &m.Time, &ts) //nolint
	m.Timestamp = int64(ts)
	pushTo(members, "new_message", map[string]any{"threadId": threadID, "message": m})
}

// ─── 5-minutes-before reminder ─────────────────────────────────────────────────
//
// A plain ticker, not a precise scheduler — checked every 30s, which bounds
// how early/late "5 minutes before" can actually land to at most half that on
// either side. Good enough for a chat reminder; a calendar app's own alarm
// this is not. Delivered over the existing chat-ws (pushTo) — this app has no
// push-notification infrastructure (no service worker/VAPID), so this only
// reaches a participant while they have the app open and connected; the
// client falls back to an in-app banner when the OS Notification API isn't
// available or permitted, but neither reaches someone with the tab fully
// closed. A real background push is a separate, considerably bigger piece of
// infrastructure than this file — flagged, not silently pretended away.
const meetingReminderTick = 30 * time.Second

func startMeetingReminderTicker() {
	go func() {
		ticker := time.NewTicker(meetingReminderTick)
		defer ticker.Stop()
		for range ticker.C {
			checkMeetingReminders()
		}
	}()
}

func checkMeetingReminders() {
	// Upper bound (meeting_date/start_time not already in the past) matters:
	// without it, a meeting the ticker missed while the process was down
	// would fire a "5 minutes before" reminder for something already
	// underway or over, which is worse than not reminding at all.
	rows, err := db.Query(`
		SELECT id, thread_id, title, meeting_date, start_time FROM ai_meetings
		WHERE status='scheduled' AND notified_5min=0
		AND TIMESTAMP(meeting_date, start_time) BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 5 MINUTE)
	`)
	if err != nil {
		return
	}
	type due struct{ id, threadID, title, date, startTime string }
	var list []due
	for rows.Next() {
		var d due
		rows.Scan(&d.id, &d.threadID, &d.title, &d.date, &d.startTime) //nolint
		list = append(list, d)
	}
	rows.Close()

	for _, d := range list {
		members := threadMembers(d.threadID)
		timeShort := d.startTime
		if len(timeShort) >= 5 {
			timeShort = timeShort[:5]
		}
		pushTo(members, "meeting_reminder", map[string]any{
			"threadId": d.threadID, "meetingId": d.id, "title": d.title, "date": d.date, "time": timeShort,
		})
		db.Exec(`UPDATE ai_meetings SET notified_5min=1 WHERE id=?`, d.id) //nolint
	}
}
