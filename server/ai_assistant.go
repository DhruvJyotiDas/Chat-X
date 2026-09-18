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
	"log"
	"regexp"
	"strings"
	"time"
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
	`(?i)\b(schedule|book|set\s*up|arrange|create|add)\b[^.!?\n]{0,80}\b(meeting|call|appointment|sync|catch[\s-]?up|event|calendar)\b`)
var rescheduleRequestRe = regexp.MustCompile(
	`(?i)\b(reschedule|move|change|push|postpone)\b[^.!?\n]{0,120}(\b(meeting|event|appointment|call|sync)\b|\b(to|until|for)\b[^.!?\n]{0,40}\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)`)

func looksLikeScheduleRequest(text string) bool {
	return scheduleRequestRe.MatchString(text)
}

func looksLikeCalendarActionRequest(text string) bool {
	return scheduleRequestRe.MatchString(text) || rescheduleRequestRe.MatchString(text)
}

// ─── Context assembly ────────────────────────────────────────────────────────

// buildAIPAContext mirrors ai_brief.go's appendBriefRows/query shapes
// (recent messages, open tasks, open reminders, upcoming meetings) plus the
// caller's own profile — everything AIPA needs to answer "what's my name",
// "what did we agree on in my chat with X", "what am I supposed to do this
// week" without the model ever seeing another user's private data (every
// query below is scoped to threads/tasks/reminders/meetings this specific
// uid is actually a member of or owner of).
type aipaContextSource struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type aipaContextResult struct {
	Text                string              `json:"-"`
	Sources             []aipaContextSource `json:"sources"`
	Unavailable         []string            `json:"unavailable"`
	WebSearchConfigured bool                `json:"webSearchConfigured"`
}

func (result *aipaContextResult) addSource(kind, label string, count int) {
	if count > 0 {
		result.Sources = append(result.Sources, aipaContextSource{Kind: kind, Label: label, Count: count})
	}
}

func (result *aipaContextResult) queryFailed(label string, err error) {
	log.Printf("[AIPA context] %s unavailable: %v", label, err)
	result.Unavailable = append(result.Unavailable, label)
}

func buildAIPAContext(uid string, personalEvents []aipaCalendarEvent, recentCalls []aipaCallRecord) aipaContextResult {
	var b strings.Builder
	result := aipaContextResult{
		Sources:             []aipaContextSource{},
		Unavailable:         []string{},
		WebSearchConfigured: webSearchConfigured(),
	}

	var name, email string
	if err := db.QueryRow(`SELECT display_name, email FROM users WHERE id=?`, uid).Scan(&name, &email); err != nil {
		result.queryFailed("Profile", err)
	}
	if name != "" {
		fmt.Fprintf(&b, "PROFILE\nName: %s\nEmail: %s\n\n", trimBriefText(name, 100), trimBriefText(email, 150))
		result.addSource("profile", "Profile", 1)
	}

	if rows, err := db.Query(`SELECT m.id, t.id, t.name, COALESCE(u.display_name,'Unknown'), m.text,
			DATE_FORMAT(m.created_at,'%Y-%m-%d %H:%i UTC')
		FROM messages m
		JOIN thread_members tm ON tm.thread_id=m.thread_id
		JOIN threads t ON t.id=m.thread_id
		LEFT JOIN users u ON u.id=m.sender_id
		WHERE tm.user_id=? AND m.text<>''
		ORDER BY m.created_at DESC LIMIT 50`, uid); err == nil {
		var lines strings.Builder
		count := 0
		threadIDs := make(map[string]struct{})
		for rows.Next() {
			var messageID, threadID, threadName, sender, text, createdAt string
			if rows.Scan(&messageID, &threadID, &threadName, &sender, &text, &createdAt) != nil {
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
			fmt.Fprintf(&lines, "[message:%s] [%s, %s] %s: %s\n",
				trimBriefText(messageID, 80), trimBriefText(threadName, 100), createdAt,
				trimBriefText(sender, 60), trimBriefText(text, 360))
			threadIDs[threadID] = struct{}{}
			count++
		}
		rows.Close()
		if count > 0 {
			b.WriteString("RECENT CHAT MESSAGES (most recent first; each line includes conversation, time, and speaker)\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
			result.addSource("chats", "Chat messages", count)
			result.addSource("threads", "Conversations", len(threadIDs))
		}
	} else {
		result.queryFailed("Chat messages", err)
	}

	if rows, err := db.Query(`SELECT fact, DATE_FORMAT(created_at,'%Y-%m-%d %H:%i UTC')
		FROM ai_memory WHERE user_id=? ORDER BY created_at DESC LIMIT 20`, uid); err == nil {
		count := 0
		var lines strings.Builder
		for rows.Next() {
			var fact, createdAt string
			if rows.Scan(&fact, &createdAt) == nil {
				fmt.Fprintf(&lines, "- %s (saved %s)\n", trimBriefText(fact, 240), createdAt)
				count++
			}
		}
		rows.Close()
		if count > 0 {
			b.WriteString("AIPA MEMORY\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
			result.addSource("memory", "AIPA memory", count)
		}
	} else {
		result.queryFailed("AIPA memory", err)
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
			result.addSource("tasks", "Open tasks", count)
		}
	} else {
		result.queryFailed("Open tasks", err)
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
			result.addSource("reminders", "Reminders", count)
		}
	} else {
		result.queryFailed("Reminders", err)
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
			result.addSource("appointments", "Scheduled meetings", count)
		}
	} else {
		result.queryFailed("Scheduled meetings", err)
	}

	if rows, err := db.Query(`SELECT am.title, DATE_FORMAT(am.meeting_date,'%Y-%m-%d'),
			TIME_FORMAT(am.start_time,'%H:%i'), am.status, t.name
		FROM ai_meetings am
		JOIN thread_members tm ON tm.thread_id=am.thread_id
		JOIN threads t ON t.id=am.thread_id
		WHERE tm.user_id=? AND am.status='scheduled'
		ORDER BY am.meeting_date, am.start_time LIMIT 15`, uid); err == nil {
		count := 0
		var lines strings.Builder
		for rows.Next() {
			var title, date, start, status, threadName string
			if rows.Scan(&title, &date, &start, &status, &threadName) == nil {
				fmt.Fprintf(&lines, "- %s on %s at %s (detected in %s; %s)\n",
					trimBriefText(title, 140), date, start, trimBriefText(threadName, 100), status)
				count++
			}
		}
		rows.Close()
		if count > 0 {
			b.WriteString("CONVERSATION-DETECTED APPOINTMENTS\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
			result.addSource("detected-appointments", "Detected appointments", count)
		}
	} else {
		result.queryFailed("Detected appointments", err)
	}

	serverCalendarCount := 0
	if calendarEvents, err := queryCalendarEvents(uid, time.Now().AddDate(0, -1, 0), time.Now().AddDate(1, 0, 0), "", ""); err == nil {
		if len(calendarEvents) > 0 {
			b.WriteString("SYNCED CALENDAR\n")
			for i, event := range calendarEvents {
				if i >= 50 {
					break
				}
				fmt.Fprintf(&b, "- %s on %s", trimBriefText(event.Title, 140), event.Date)
				if event.AllDay {
					b.WriteString(" (all day)")
				} else {
					fmt.Fprintf(&b, " at %s–%s", event.StartTime, event.EndTime)
				}
				if event.Location != "" {
					fmt.Fprintf(&b, " at %s", trimBriefText(event.Location, 160))
				}
				if event.Recurrence != "" {
					fmt.Fprintf(&b, " (repeats %s)", strings.ToLower(event.Recurrence))
				}
				if len(event.Attendees) > 0 {
					names := []string{}
					for _, attendee := range event.Attendees {
						names = append(names, attendee.DisplayName+" ["+attendee.Response+"]")
					}
					fmt.Fprintf(&b, " — attendees: %s", strings.Join(names, ", "))
				}
				if event.Description != "" {
					fmt.Fprintf(&b, " — %s", trimBriefText(event.Description, 220))
				}
				b.WriteString("\n")
				serverCalendarCount++
			}
			b.WriteString("\n")
			result.addSource("calendar", "Synced calendar", serverCalendarCount)
		}
	} else {
		result.queryFailed("Synced calendar", err)
	}

	if serverCalendarCount == 0 && len(personalEvents) > 0 {
		b.WriteString("PERSONAL CALENDAR (client-provided from this browser)\n")
		for i, e := range personalEvents {
			if i >= 50 {
				break
			}
			fmt.Fprintf(&b, "- %s on %s", trimBriefText(e.Title, 140), trimBriefText(e.Date, 20))
			if e.AllDay {
				b.WriteString(" (all day)")
			} else {
				fmt.Fprintf(&b, " at %s", trimBriefText(e.StartTime, 20))
			}
			if !e.AllDay && e.EndTime != "" {
				fmt.Fprintf(&b, "–%s", trimBriefText(e.EndTime, 20))
			}
			if e.Location != "" {
				fmt.Fprintf(&b, " at %s", trimBriefText(e.Location, 160))
			}
			if e.Description != "" {
				fmt.Fprintf(&b, " — %s", trimBriefText(e.Description, 220))
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
		result.addSource("calendar", "Personal calendar", min(len(personalEvents), 50))
	}

	if rows, err := db.Query(`SELECT mt.room_id, mt.speaker_name, mt.text,
			DATE_FORMAT(mt.created_at,'%Y-%m-%d %H:%i UTC')
		FROM meeting_transcripts mt
		JOIN meeting_participants mp ON mp.room_id=mt.room_id
		WHERE mp.user_id=?
		ORDER BY mt.created_at DESC LIMIT 30`, uid); err == nil {
		count := 0
		var lines strings.Builder
		for rows.Next() {
			var roomID, speaker, text, createdAt string
			if rows.Scan(&roomID, &speaker, &text, &createdAt) == nil {
				fmt.Fprintf(&lines, "[meeting:%s, %s] %s: %s\n", trimBriefText(roomID, 80), createdAt,
					trimBriefText(speaker, 80), trimBriefText(text, 300))
				count++
			}
		}
		rows.Close()
		if count > 0 {
			b.WriteString("RECENT MEETING TRANSCRIPT LINES (most recent first)\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
			result.addSource("transcripts", "Meeting transcript lines", count)
		}
	} else {
		result.queryFailed("Meeting transcripts", err)
	}

	if rows, err := db.Query(`SELECT ad.file_name, COALESCE(ad.summary,''), t.name,
			DATE_FORMAT(ad.created_at,'%Y-%m-%d %H:%i UTC')
		FROM ai_documents ad
		JOIN thread_members tm ON tm.thread_id=ad.thread_id
		JOIN threads t ON t.id=ad.thread_id
		WHERE tm.user_id=?
		ORDER BY ad.created_at DESC LIMIT 10`, uid); err == nil {
		count := 0
		var lines strings.Builder
		for rows.Next() {
			var fileName, summary, threadName, createdAt string
			if rows.Scan(&fileName, &summary, &threadName, &createdAt) == nil {
				fmt.Fprintf(&lines, "- %s in %s (%s): %s\n", trimBriefText(fileName, 140),
					trimBriefText(threadName, 100), createdAt, trimBriefText(summary, 500))
				count++
			}
		}
		rows.Close()
		if count > 0 {
			b.WriteString("RECENT SHARED DOCUMENTS\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
			result.addSource("documents", "Documents", count)
		}
	} else {
		result.queryFailed("Documents", err)
	}

	if rows, err := db.Query(`SELECT role, seniority, kind, status,
			COALESCE(CAST(overall_score AS CHAR),'not scored'),
			DATE_FORMAT(created_at,'%Y-%m-%d %H:%i UTC')
		FROM interview_sessions WHERE user_id=?
		ORDER BY created_at DESC LIMIT 5`, uid); err == nil {
		count := 0
		var lines strings.Builder
		for rows.Next() {
			var role, seniority, kind, status, score, createdAt string
			if rows.Scan(&role, &seniority, &kind, &status, &score, &createdAt) == nil {
				fmt.Fprintf(&lines, "- %s %s interview for %s: %s, score %s (%s)\n",
					seniority, kind, trimBriefText(role, 120), status, score, createdAt)
				count++
			}
		}
		rows.Close()
		if count > 0 {
			b.WriteString("RECENT VIRTUAL INTERVIEWS\n")
			b.WriteString(lines.String())
			b.WriteString("\n")
			result.addSource("interviews", "Interviews", count)
		}
	} else {
		result.queryFailed("Interviews", err)
	}

	if len(recentCalls) > 0 {
		b.WriteString("RECENT CALL HISTORY (client-provided from this browser)\n")
		for i, call := range recentCalls {
			if i >= 20 {
				break
			}
			fmt.Fprintf(&b, "- %s %s call with %s at %s", call.Type, call.CallType,
				trimBriefText(call.ParticipantName, 100), trimBriefText(call.OccurredAt, 50))
			if call.Duration != "" {
				fmt.Fprintf(&b, " (%s)", trimBriefText(call.Duration, 40))
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
		result.addSource("calls", "Recent calls", min(len(recentCalls), 20))
	}

	// This is a bounded snapshot, not an unbounded data dump into the model.
	// Individual values are already trimmed; this final guard protects the
	// model context if many categories are simultaneously full.
	result.Text = trimBriefText(b.String(), 36000)
	return result
}

type aipaCalendarEvent struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Date        string `json:"date"`
	StartTime   string `json:"startTime"`
	EndTime     string `json:"endTime"`
	AllDay      bool   `json:"allDay"`
	Description string `json:"description"`
	Location    string `json:"location"`
}

type aipaCallRecord struct {
	Type            string `json:"type"`
	CallType        string `json:"callType"`
	ParticipantName string `json:"participantName"`
	Duration        string `json:"duration"`
	OccurredAt      string `json:"occurredAt"`
}

// ─── Schedule-meeting intent: classify, then act only if confident ──────────

type scheduleIntent struct {
	Action              string   `json:"action"`
	EventQuery          string   `json:"eventQuery"`
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
	system := "You detect whether a message is asking to create or reschedule a calendar meeting/event. " +
		"and if so extract its details. Today's date is " + todayISO + " — resolve relative phrases like " +
		"\"tomorrow\" or \"next Monday\" into a real YYYY-MM-DD date yourself. The message is from " + callerName + ". " +
		"Set action to create or update. For update, eventQuery must identify the existing event by its title or subject; attendees are optional. " +
		"For create, attendees are optional for a personal event. Only set isSchedulingRequest true for an actual requested calendar change. " +
		"Only set confident true when date, time and the action-specific identifying details are explicit; never guess. " +
		"Your final answer must be ONLY a single JSON object, no other text: " +
		`{"action":"create|update","eventQuery":"existing event subject for update","isSchedulingRequest":true/false,"title":"a short meeting title","attendeeNames":["names mentioned, exactly as written"],"date":"YYYY-MM-DD","time":"HH:MM","confident":true/false}`
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
	if intent.Action == "update" {
		if strings.TrimSpace(intent.EventQuery) == "" && strings.TrimSpace(intent.Title) == "" {
			missing = append(missing, "which event")
		}
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

// proposeCalendarAction prepares a reviewable action and stores a short-lived,
// single-use token. No calendar mutation happens until the user presses the
// explicit Confirm button in Ask AIPA.
func proposeCalendarAction(uid string, intent *scheduleIntent, timezone string) (string, string, CalendarActionProposal, error) {
	timezone = validTimeZone(timezone)
	proposal := CalendarActionProposal{Action: intent.Action, Title: strings.TrimSpace(intent.Title), Date: intent.Date,
		StartTime: intent.Time, TimeZone: timezone, AttendeeNames: intent.AttendeeNames}
	if proposal.Action == "" {
		proposal.Action = "create"
	}
	start, err := parseLocalDateTime(proposal.Date, proposal.StartTime, timezone)
	if err != nil {
		return "", "", proposal, fmt.Errorf("invalid proposed date or time")
	}
	proposal.EndTime = start.Add(time.Hour).In(start.Location()).Format("15:04")
	if proposal.Action == "update" {
		query := strings.TrimSpace(intent.EventQuery)
		if query == "" {
			query = strings.TrimSpace(intent.Title)
		}
		if query == "" {
			return "", "I need the event title or subject before I can reschedule it.", proposal, nil
		}
		events, qerr := queryCalendarEvents(uid, time.Now().AddDate(0, -1, 0), time.Now().AddDate(1, 0, 0), query, "")
		if qerr != nil || len(events) == 0 {
			return "", "I couldn't find an editable upcoming event matching \"" + query + "\".", proposal, nil
		}
		var selected *CalendarEventRecord
		for i := range events {
			if events[i].CanEdit {
				selected = &events[i]
				break
			}
		}
		if selected == nil {
			return "", "I found the event, but you don't have permission to reschedule it.", proposal, nil
		}
		proposal.EventID = selected.SeriesID
		if proposal.EventID == "" {
			proposal.EventID = selected.ID
		}
		proposal.Title = selected.Title
		duration := eventDurationMinutes(*selected)
		proposal.EndTime = start.Add(time.Duration(duration) * time.Minute).In(start.Location()).Format("15:04")
	} else {
		var unresolved []string
		for _, name := range intent.AttendeeNames {
			id, resolvedName := resolveContactByName(uid, name)
			if id == "" {
				unresolved = append(unresolved, name)
				continue
			}
			proposal.AttendeeIDs = append(proposal.AttendeeIDs, id)
			for i, original := range proposal.AttendeeNames {
				if original == name {
					proposal.AttendeeNames[i] = resolvedName
				}
			}
		}
		if len(intent.AttendeeNames) > 0 && len(proposal.AttendeeIDs) == 0 {
			return "", "I couldn't match the requested attendees to your IB Connect contacts, so I haven't prepared an action.", proposal, nil
		}
		if len(unresolved) > 0 {
			return "", "I couldn't find " + strings.Join(unresolved, ", ") + " in your contacts. Please check the names before scheduling.", proposal, nil
		}
		if proposal.Title == "" {
			proposal.Title = "Meeting with " + strings.Join(proposal.AttendeeNames, ", ")
		}
	}
	participantIDs := append([]string{uid}, proposal.AttendeeIDs...)
	proposedEnd, _ := parseLocalDateTime(proposal.Date, proposal.EndTime, timezone)
	if len(busyForUsers(participantIDs, start.UTC(), proposedEnd.UTC(), proposal.EventID)) > 0 {
		proposal.Warning = "This time conflicts with at least one participant's calendar. You can confirm anyway or use Calendar to choose an available suggestion."
	}
	token, err := storeCalendarActionProposal(uid, proposal)
	if err != nil {
		return "", "", proposal, err
	}
	verb := "create"
	if proposal.Action == "update" {
		verb = "reschedule"
	}
	message := fmt.Sprintf("I prepared an action to %s \"%s\" for %s at %s. Review the details below and confirm before I change your calendar.", verb, proposal.Title, proposal.Date, proposal.StartTime)
	return token, message, proposal, nil
}

func eventDurationMinutes(event CalendarEventRecord) int {
	duration := int(event.endUTC.Sub(event.startUTC).Minutes())
	if duration < 15 || duration > 24*60 {
		return 60
	}
	return duration
}
