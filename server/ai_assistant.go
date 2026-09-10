package main

// Ask AIPA, upgraded from a stateless general chat to a context-aware
// assistant that can see the caller's own IB Connect activity and take one
// concrete real-world action: scheduling a meeting, notifying the invited
// people, and syncing it to calendars — end to end, not a suggestion the
// user still has to go do by hand.
//
// Two deliberate design choices, both load-bearing given what this session
// already learned the hard way about this GPU model:
//
//  1. Context is assembled by plain Go queries (reusing ai_brief.go's own
//     query shapes), not by giving the model open-ended "tool calls" to
//     fetch its own data. A base (non-instruction-tuned) model calling
//     tools reliably is a much harder, much less proven capability than one
//     answering a question given the right context already in the prompt —
//     see ai_gpu.go's own notes on this exact model's unreliability at
//     stepping outside a conversation to perform a meta-task.
//  2. Scheduling is NOT open-ended function calling either. It's a two-step
//     pipeline: a narrow, single-turn, JSON-only CLASSIFICATION call decides
//     whether this message is a scheduling request and extracts its fields
//     (the same proven-reliable shape as reply-suggestions/ask-thread — see
//     replyLineRe's comment in ai.go for why single-turn beats multi-turn
//     history for this model on exactly this kind of task); if — and only
//     if — that comes back confident, plain deterministic Go code does the
//     actual work (creating the row, resolving names against real contacts,
//     sending messages). The model never directly causes a side effect; it
//     only ever proposes one, which this file validates before acting on.

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// looksLikeScheduleRequest is a cheap, deterministic PRE-gate, checked before
// ever asking the model anything. Reproduced directly during verification:
// the model's own isSchedulingRequest classification is not reliable enough
// to be the only thing standing between "please book time with someone" and
// the general chat path improvising a fake confirmation — a message as
// explicit as "Schedule a meeting with <name> tomorrow at 9am" was
// classified not-a-scheduling-request at least once in testing. This regex
// doesn't have to be precise (a false positive just costs one extra
// classification call, or a clarifying question instead of a direct answer);
// it exists so that anything phrased like a scheduling command NEVER reaches
// the free-form general-chat call regardless of what the classifier says —
// worst case is a clarifying question, never a hallucinated "done".
var scheduleRequestRe = regexp.MustCompile(
	`(?i)\b(schedule|book|set\s*up|arrange)\b[^.!?\n]{0,60}\b(meeting|call|appointment|sync|catch[\s-]?up)\b[^.!?\n]{0,40}\bwith\b`)

func looksLikeScheduleRequest(text string) bool {
	return scheduleRequestRe.MatchString(text)
}

// ─── Context assembly ────────────────────────────────────────────────────────

// buildAIPAContext mirrors ai_brief.go's appendBriefRows/query shapes
// (recent messages, open tasks, open reminders, upcoming meetings) plus the
// caller's own profile — everything AIPA needs to answer "what's my name",
// "what did we agree on in my chat with X", "what am I supposed to do this
// week" without the model ever seeing another user's private data (every
// query below is scoped to threads/tasks/reminders/meetings this specific
// uid is actually a member of or owner of).
func buildAIPAContext(uid string, personalEvents []aipaCalendarEvent) string {
	var b strings.Builder

	var name, email string
	db.QueryRow(`SELECT display_name, email FROM users WHERE id=?`, uid).Scan(&name, &email) //nolint
	if name != "" {
		fmt.Fprintf(&b, "PROFILE\nName: %s\nEmail: %s\n\n", trimBriefText(name, 100), trimBriefText(email, 150))
	}

	if rows, err := db.Query(`SELECT COALESCE(u.display_name,'Unknown'), m.text
		FROM messages m
		JOIN thread_members tm ON tm.thread_id=m.thread_id
		LEFT JOIN users u ON u.id=m.sender_id
		WHERE tm.user_id=? AND m.text<>''
		ORDER BY m.created_at DESC LIMIT 30`, uid); err == nil {
		var lines strings.Builder
		count := 0
		for rows.Next() {
			var sender, text string
			if rows.Scan(&sender, &text) != nil {
				continue
			}
			// Skip raw \x01MEETING\x01{...} calendar-sync cards (ai_meetings.go)
			// — control-character-prefixed JSON fed as if it were a normal chat
			// line reliably confused the model into believing a meeting request
			// had already been fulfilled (reproduced directly: it started
			// claiming "I've scheduled it" for messages that never asked for
			// anything, apparently reasoning from this exact JSON in context).
			// The chat client already renders these as a card; there is
			// nothing here worth summarizing in plain text anyway.
			if strings.HasPrefix(text, meetingCardPrefix) {
				continue
			}
			fmt.Fprintf(&lines, "%s: %s\n", trimBriefText(sender, 60), trimBriefText(text, 300))
			count++
		}
		rows.Close()
		if count > 0 {
			b.WriteString("RECENT MESSAGES ACROSS YOUR CONVERSATIONS (most recent first)\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
		}
	}

	if rows, err := db.Query(`SELECT description, COALESCE(DATE_FORMAT(due_at,'%Y-%m-%d %H:%i UTC'),'no due date')
		FROM ai_tasks WHERE status='pending' AND (owner_user_id=? OR created_by=?)
		ORDER BY COALESCE(due_at, created_at) LIMIT 15`, uid, uid); err == nil {
		var lines strings.Builder
		count := 0
		for rows.Next() {
			var desc, due string
			if rows.Scan(&desc, &due) != nil {
				continue
			}
			fmt.Fprintf(&lines, "- %s (%s)\n", trimBriefText(desc, 160), due)
			count++
		}
		rows.Close()
		if count > 0 {
			b.WriteString("OPEN TASKS\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
		}
	}

	if rows, err := db.Query(`SELECT text, COALESCE(DATE_FORMAT(remind_at,'%Y-%m-%d %H:%i UTC'),'no reminder time')
		FROM ai_reminders WHERE user_id=? AND status='pending'
		ORDER BY COALESCE(remind_at, created_at) LIMIT 15`, uid); err == nil {
		var lines strings.Builder
		count := 0
		for rows.Next() {
			var text, when string
			if rows.Scan(&text, &when) != nil {
				continue
			}
			fmt.Fprintf(&lines, "- %s (%s)\n", trimBriefText(text, 160), when)
			count++
		}
		rows.Close()
		if count > 0 {
			b.WriteString("OPEN REMINDERS\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
		}
	}

	if rows, err := db.Query(`SELECT title, date, time, code FROM scheduled_meetings
		WHERE date>=DATE_FORMAT(UTC_DATE(),'%Y-%m-%d') AND (creator_id=? OR JSON_CONTAINS(invitee_ids, JSON_QUOTE(?)))
		ORDER BY date, time LIMIT 10`, uid, uid); err == nil {
		var lines strings.Builder
		count := 0
		for rows.Next() {
			var title, date, tm, code string
			if rows.Scan(&title, &date, &tm, &code) != nil {
				continue
			}
			fmt.Fprintf(&lines, "- %s on %s at %s (join link code: %s)\n", trimBriefText(title, 120), date, tm, code)
			count++
		}
		rows.Close()
		if count > 0 {
			b.WriteString("UPCOMING SCHEDULED MEETINGS\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
		}
	}

	if len(personalEvents) > 0 {
		b.WriteString("YOUR PERSONAL CALENDAR (client-provided — this app's calendar is stored in the browser, not server-side)\n")
		for i, e := range personalEvents {
			if i >= 15 {
				break
			}
			fmt.Fprintf(&b, "- %s on %s at %s\n", trimBriefText(e.Title, 120), trimBriefText(e.Date, 20), trimBriefText(e.StartTime, 20))
		}
		b.WriteString("\n")
	}

	return b.String()
}

type aipaCalendarEvent struct {
	Title     string `json:"title"`
	Date      string `json:"date"`
	StartTime string `json:"startTime"`
}

// ─── Schedule-meeting intent: classify, then act only if confident ──────────

type scheduleIntent struct {
	IsSchedulingRequest bool     `json:"isSchedulingRequest"`
	Title               string   `json:"title"`
	AttendeeNames       []string `json:"attendeeNames"`
	Date                string   `json:"date"` // YYYY-MM-DD, resolved from relative phrases like "tomorrow"
	Time                string   `json:"time"` // HH:MM, 24h
	Confident           bool     `json:"confident"`
}

// detectScheduleIntent is a narrow, single-turn, JSON-only extraction call —
// the same shape proven reliable for reply-suggestions/ask-thread, not the
// multi-turn role-history shape confirmed unreliable for this model (see
// this file's header). Deliberately asked to resolve relative dates itself
// (given "today") rather than this file hand-rolling a natural-language date
// parser — the same approach analyze-thread already uses successfully for
// resolving corrected meeting times in a conversation.
func detectScheduleIntent(ctx context.Context, userMessage, todayISO, callerName string) (*scheduleIntent, error) {
	system := "You detect whether a message is asking to schedule/book a meeting or appointment with named people, " +
		"and if so extract its details. Today's date is " + todayISO + " — resolve relative phrases like " +
		"\"tomorrow\" or \"next Monday\" into a real YYYY-MM-DD date yourself. The message is from " + callerName + ". " +
		"Only set isSchedulingRequest true if it clearly names who to meet with and roughly when. Only set " +
		"confident true if you were able to extract a specific date AND time AND at least one attendee name — if " +
		"anything important is missing or ambiguous, set confident false rather than guessing. " +
		"Your final answer must be ONLY a single JSON object, no other text: " +
		`{"isSchedulingRequest":true/false,"title":"a short meeting title","attendeeNames":["names mentioned, exactly as written"],"date":"YYYY-MM-DD","time":"HH:MM","confident":true/false}`
	wantJSON := json.RawMessage(`{"required":["isSchedulingRequest","confident"]}`)
	result, err := aiChatBudgetedTimed(ctx, system, nil, userMessage, wantJSON, lightAIMaxTokens, lightAITimeout)
	if err != nil {
		return nil, err
	}
	var intent scheduleIntent
	if err := json.Unmarshal([]byte(result), &intent); err != nil {
		return nil, err
	}
	return &intent, nil
}

// clarifyScheduleRequest builds a deterministic follow-up question when the
// classifier recognized a scheduling request but couldn't extract it
// confidently — used INSTEAD of routing to the general chat model for this
// turn. This matters, not just tidiness: reproduced directly, the general
// assistant will sometimes improvise a fake "I've scheduled it, here's your
// confirmed meeting" reply for exactly this kind of half-specified request,
// which is the one thing aiAssistantSystemPrompt explicitly forbids and the
// model still does anyway. A plain, honest "what am I missing" question has
// zero chance of that failure mode because no model call happens at all.
func clarifyScheduleRequest(intent *scheduleIntent) string {
	var missing []string
	if len(intent.AttendeeNames) == 0 {
		missing = append(missing, "who to invite")
	}
	if strings.TrimSpace(intent.Date) == "" {
		missing = append(missing, "what date")
	}
	if strings.TrimSpace(intent.Time) == "" {
		missing = append(missing, "what time")
	}
	if len(missing) == 0 {
		// Confident was false for some other reason (e.g. an unclear name) —
		// give a generic nudge rather than an empty list.
		return "I can schedule that for you — could you confirm exactly who you want to meet with and the date and time?"
	}
	return "I can schedule that for you — I just need " + strings.Join(missing, " and ") + " to lock it in."
}

// falseActionClaimPatterns catches the general assistant improvising that it
// already performed an action it never actually took. This is a real,
// reproduced failure of this base model, not a hypothetical: asked something
// that merely mentions scheduling without a clear target, it has been
// observed inventing "Okay, I've scheduled a meeting for you" / "it's now
// confirmed" out of nothing. Every message this codebase legitimately sends
// after a REAL schedule action goes through executeScheduleMeeting, whose own
// text is the "action":"schedule_meeting" response — never this general-chat
// path — so any of these phrases showing up here is unambiguously false and
// safe to intercept.
var falseActionClaimPatterns = []string{
	"i've scheduled", "i have scheduled", "i's scheduled", "successfully scheduled",
	"meeting is now confirmed", "it's now confirmed", "sent the link", "sent them the link",
	"added it to the calendar", "added to your calendar", "invite sent", "invitation sent",
}

func looksLikeFalseActionClaim(text string) bool {
	lower := strings.ToLower(text)
	for _, phrase := range falseActionClaimPatterns {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	return false
}

// resolveContactByName matches against people the caller has actually
// messaged before (shares a thread with) — not the whole user directory —
// so a common name can't accidentally resolve to an unrelated account
// nobody involved has ever spoken to. Case-insensitive substring match, same
// pattern as resolveAssignee in ai.go; first-name-only ("guy1" -> "Guy One
// Sharma") is intentionally supported since that's how people actually
// refer to contacts in a chat message.
func resolveContactByName(uid, name string) (id, displayName string) {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" {
		return "", ""
	}
	rows, err := db.Query(`
		SELECT DISTINCT u.id, u.display_name FROM thread_members tm1
		JOIN thread_members tm2 ON tm2.thread_id=tm1.thread_id AND tm2.user_id<>tm1.user_id
		JOIN users u ON u.id=tm2.user_id
		WHERE tm1.user_id=?`, uid)
	if err != nil {
		return "", ""
	}
	defer rows.Close()
	for rows.Next() {
		var candID, candName string
		if rows.Scan(&candID, &candName) != nil {
			continue
		}
		dn := strings.ToLower(candName)
		if dn == name || strings.Contains(name, dn) || strings.Contains(dn, name) {
			return candID, candName
		}
	}
	return "", ""
}

// executeScheduleMeeting is the deterministic side-effect step — the model
// never calls this directly, ai.go's handler does, only once
// detectScheduleIntent has already come back confident. Creates a real,
// joinable scheduled meeting (the same row/code handleScheduleMeeting
// creates), resolves each named attendee against the caller's real
// contacts, and for every one it could resolve: sends them a chat message
// with the real join link, AND posts the existing AI-meeting calendar card
// (ai_meetings + postMeetingCard — the same mechanism chat-detected
// meetings already use) so it syncs to their calendar the same proven way.
// Returns a plain-text confirmation to show the caller, naming exactly who
// was and wasn't successfully notified rather than claiming full success
// when it wasn't.
func executeScheduleMeeting(uid, callerName string, intent *scheduleIntent) string {
	code := "SCHED-" + strings.ToUpper(newID()[:4])
	meetingID := "sm-" + newID()
	var resolvedIDs []string
	var resolvedNames []string
	var unresolved []string
	for _, raw := range intent.AttendeeNames {
		id, name := resolveContactByName(uid, raw)
		if id == "" {
			unresolved = append(unresolved, raw)
			continue
		}
		resolvedIDs = append(resolvedIDs, id)
		resolvedNames = append(resolvedNames, name)
	}
	if len(resolvedIDs) == 0 {
		if len(unresolved) > 0 {
			return fmt.Sprintf("I couldn't find %s among your contacts, so I didn't schedule anything — could you double check the name (or start a chat with them first so I can find them)?",
				strings.Join(unresolved, ", "))
		}
		return "I didn't find anyone to invite, so I didn't schedule anything."
	}

	title := strings.TrimSpace(intent.Title)
	if title == "" {
		title = "Meeting with " + strings.Join(resolvedNames, ", ")
	}
	invJSON, _ := json.Marshal(resolvedIDs)
	if _, err := db.Exec(
		`INSERT INTO scheduled_meetings(id, code, title, date, time, creator_id, invitee_ids) VALUES(?,?,?,?,?,?,?)`,
		meetingID, code, title, intent.Date, intent.Time, uid, string(invJSON),
	); err != nil {
		return "I worked out the details but couldn't actually save the meeting — please try scheduling it from the Calendar page instead."
	}

	joinLink := "https://meet.icebrkr.space/" + code

	var notified []string
	for i, attendeeID := range resolvedIDs {
		threadID := dmThreadID(uid, attendeeID)
		ensureDMThread(threadID, uid, attendeeID, callerName)
		text := fmt.Sprintf("📅 %s scheduled \"%s\" for %s at %s. Join here: %s", callerName, title, intent.Date, intent.Time, joinLink)
		if postPlainMessage(threadID, uid, text) {
			// One ai_meetings row per real DM thread (its FOREIGN KEY requires
			// a genuine threads.id — there is no single thread that "owns" a
			// multi-attendee AIPA-scheduled meeting, so each attendee's own DM
			// gets its own row, same as detectAndSyncMeeting already does per
			// thread for a chat-detected meeting).
			aiMeetingID := newID()
			db.Exec(`INSERT INTO ai_meetings(id, thread_id, title, meeting_date, start_time) VALUES (?,?,?,?,?)`, //nolint
				aiMeetingID, threadID, title, intent.Date, intent.Time)
			postMeetingCard(threadID, []string{uid, attendeeID}, meetingCardPayload{
				MeetingID: aiMeetingID, Title: title, Date: intent.Date, Time: intent.Time, Action: "created",
			})
			notified = append(notified, resolvedNames[i])
		}
	}

	var summary strings.Builder
	fmt.Fprintf(&summary, "Done — I've scheduled \"%s\" for %s at %s and sent the join link to %s.",
		title, intent.Date, intent.Time, strings.Join(notified, ", "))
	if len(unresolved) > 0 {
		fmt.Fprintf(&summary, " I couldn't find %s in your contacts, so they weren't invited — you may need to message them directly.", strings.Join(unresolved, ", "))
	}
	fmt.Fprintf(&summary, " Meeting link: %s", joinLink)
	return summary.String()
}

// dmThreadID mirrors handleThreads' own deterministic id (lower id first) so
// this reuses the exact same thread a normal "new DM" from either party
// would already be using, rather than creating a duplicate.
func dmThreadID(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return "dm_" + a + "_" + b
}

// ensureDMThread mirrors handleThreads' "dm" case — extracted so this file
// and handleThreads share one real implementation rather than two that could
// drift apart, but kept here since handleThreads' own case is HTTP-response-
// shaped and this needs a plain side-effect-only version.
func ensureDMThread(threadID, uid, otherID, callerName string) {
	var exists int
	db.QueryRow(`SELECT COUNT(*) FROM threads WHERE id=?`, threadID).Scan(&exists) //nolint
	if exists > 0 {
		return
	}
	var otherName, otherAvatar string
	db.QueryRow(`SELECT display_name, COALESCE(avatar,'') FROM users WHERE id=?`, otherID).Scan(&otherName, &otherAvatar) //nolint
	tx, err := db.Begin()
	if err != nil {
		return
	}
	tx.Exec(`INSERT INTO threads(id,type,name,avatar,created_by) VALUES(?,'dm',?,?,?)`, threadID, otherName, otherAvatar, uid) //nolint
	tx.Exec(`INSERT IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)`, threadID, uid)                                 //nolint
	tx.Exec(`INSERT IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)`, threadID, otherID)                             //nolint
	tx.Commit()                                                                                                                //nolint
	if mt, e := loadThread(threadID, otherID); e == nil {
		pushTo([]string{otherID}, "thread_created", mt)
	}
}

// postPlainMessage is handleMessages' POST body, minus the HTTP shell —
// returns false (logged, not fatal) on a DB error so the caller can still
// report a partial success accurately instead of claiming full success.
func postPlainMessage(threadID, senderID, text string) bool {
	msgID := "msg-" + newID()
	if _, err := db.Exec(`INSERT INTO messages(id,thread_id,sender_id,text) VALUES(?,?,?,?)`, msgID, threadID, senderID, text); err != nil {
		return false
	}
	var m Message
	var ts float64
	db.QueryRow(`
		SELECT m.id, m.thread_id, COALESCE(m.sender_id,''), COALESCE(u.display_name,'IB Connect'), COALESCE(u.avatar,''),
			m.text, DATE_FORMAT(m.created_at,'%h:%i %p'), UNIX_TIMESTAMP(m.created_at)*1000
		FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.id=?
	`, msgID).Scan(&m.ID, &m.ThreadID, &m.SenderID, &m.SenderName, &m.SenderAvatar, &m.Text, &m.Time, &ts) //nolint
	m.Timestamp = int64(ts)
	pushTo(threadMembers(threadID), "new_message", map[string]any{"threadId": threadID, "message": m})
	return true
}
