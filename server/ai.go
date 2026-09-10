package main

// AI features API — foundation pass.
//
// The model lives on a separate GPU VM behind ai_gpu.go, same convention as
// the interview and live-caption features. As found (see gpu/AI_CONTRACT.md),
// the real service there has no text endpoint and its vision endpoint fails
// on every request — AI_GPU_URL should point at gpu/mock_ai_server.py until
// both are fixed, which is what lets everything below be built and verified
// now regardless.
//
// This file is deliberately just the foundation: the GPU client, the tables
// the next stage of features needs (ai_memory, ai_tasks, ai_reminders — all
// unused by any handler yet, added now the same way thread_members supported
// group chat before group chat existed), and one real end-to-end endpoint
// (POST /api/ai/chat) proving the whole path — HTTP -> Go -> GPU client ->
// service -> back — actually works. Reply suggestions, rewrite/writing
// tools, thread summarization, memory, task/reminder extraction all build on
// this same aiChat() call with different prompts; none of that UI wiring is
// in this pass.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

func migrateAI() {
	for _, s := range []string{
		// User-editable, deletable memory — see AI Memory in the feature list.
		// scope='user' -> thread_id NULL (long-term personal memory); scope='thread'
		// -> thread_id set (per-chat/group memory). Both live in one table since the
		// shape and access pattern (list/create/delete for one owner) are identical.
		`CREATE TABLE IF NOT EXISTS ai_memory (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			thread_id VARCHAR(255),
			fact TEXT NOT NULL,
			source_message_id VARCHAR(255),
			created_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE)`,
		// Extracted commitments ("Dhruv, send me the report tomorrow"). owner_user_id
		// is whoever the task is FOR (the assignee the model identified), which is not
		// necessarily the sender — created_by is who was in the conversation when it
		// was extracted, for "what do I owe people" vs "what's owed to me" queries.
		`CREATE TABLE IF NOT EXISTS ai_tasks (
			id VARCHAR(64) PRIMARY KEY,
			thread_id VARCHAR(255) NOT NULL,
			source_message_id VARCHAR(255),
			description TEXT NOT NULL,
			owner_user_id VARCHAR(255),
			created_by VARCHAR(255) NOT NULL,
			due_at DATETIME(6),
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			created_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
			FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE)`,
		// condition_json holds the "remind me if X hasn't happened by Y" shape
		// (e.g. {"kind":"no_reply_from","user_id":"...", "by": "..."}) for reminders
		// that are conditional rather than a plain timer — left as JSON rather than
		// dedicated columns since the condition shapes are still being designed.
		`CREATE TABLE IF NOT EXISTS ai_reminders (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			thread_id VARCHAR(255),
			text TEXT NOT NULL,
			remind_at DATETIME(6),
			condition_json JSON,
			status VARCHAR(32) NOT NULL DEFAULT 'pending',
			created_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE)`,
	} {
		if _, err := db.Exec(s); err != nil {
			panic(err)
		}
	}
}

// ─── GET /api/ai/status ──────────────────────────────────────────────────────
// Same "say something honest before the user invests effort" convention as
// handleInterviewStatus.

func handleAIStatus(w http.ResponseWriter, r *http.Request) {
	if _, err := bearerUID(r); err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	out := map[string]any{"configured": aiGPUConfigured()}
	if !aiGPUConfigured() {
		out["detail"] = "AI features are not connected to a model yet."
	}
	ok(w, out)
}

// ─── POST /api/ai/chat ───────────────────────────────────────────────────────
// The one proof-of-plumbing endpoint for this pass. Takes a single turn, no
// history assembly from the messages table yet (that belongs to the actual
// chat-assistant/reply-suggestion features, not this foundation pass) —
// callers pass their own history if they have any.

type aiChatRequest struct {
	Messages       []aiChatMessage     `json:"messages"`
	Text           string              `json:"text"`
	TimeZone       string              `json:"timeZone"`
	LocalNow       string              `json:"localNow"`       // e.g. "2026-09-08" — the user's own local today, for resolving "tomorrow"/"next Monday"
	PersonalEvents []aipaCalendarEvent `json:"personalEvents"` // client-only calendar (calendarLocal.ts) — server has no other visibility into it
}

// aiAssistantSystemPrompt is used both for the plain contextual chat and
// (with CONTEXT appended below) is the one prompt the "grounded in your own
// IB Connect activity" claim actually rests on — see buildAIPAContext.
const aiAssistantSystemPrompt = "You are AIPA, the productivity assistant built into IB Connect. " +
	"You can see a CONTEXT block below (when present) drawn from the user's own profile, recent messages, " +
	"open tasks/reminders, and upcoming meetings — use it naturally to answer questions like \"what's my name\", " +
	"\"what did we agree on with X\", or \"what's on my calendar\", the same way a human assistant with access to " +
	"that information would. The CONTEXT block is real IB Connect data, not something to second-guess, but it may " +
	"be incomplete (older items are not included) — say so rather than claiming certainty about anything not shown. " +
	"Do not claim to have read anything NOT present in the CONTEXT block. " +
	"Never claim that you completed an external action yourself — actions like scheduling a meeting are handled by " +
	"a separate step outside this chat, not by anything you say here. Be clear when the user must verify important facts. " +
	// This model has no working stop-sequence support (confirmed directly —
	// see lightAIMaxTokens' comment in ai.go and trimEcho in ai_gpu.go): once
	// it finishes a real answer it frequently free-runs into echoing a fake
	// "User: ...\nAssistant: ..." continuation of the conversation for the
	// rest of whatever token budget it's given. Measured directly against
	// this exact endpoint: "What is 2+2?" with no history at all still took
	// ~78s, because the real answer ("4") arrived almost instantly and the
	// remaining ~1200-token budget was spent entirely on that echo loop —
	// invisible to the user (trimEcho strips it from what's returned), but
	// not to the clock, since the model still has to generate through it
	// before the HTTP response can return at all. This explicit instruction
	// measurably reduces how often the loop triggers in the first place
	// (the same fix already applied to Ask AIPA's thread-Q&A prompt); the
	// smaller aiAssistantMaxTokens below (instead of the shared, larger
	// aiChatMaxTokens default other aiChat() callers use) bounds how bad the
	// worst case is even when it still happens.
	"Never output the words \"User\" or \"Assistant\" as part of your reply. Never repeat or continue this " +
	"conversation as if drafting the other side's next turn. Stop generating immediately once your answer is complete."

const (
	aiChatRateWindow = time.Minute
	aiChatRateLimit  = 20
)

var aiChatRate = struct {
	sync.Mutex
	users map[string]aiChatRateEntry
}{users: make(map[string]aiChatRateEntry)}

type aiChatRateEntry struct {
	started time.Time
	count   int
}

// allowAIChat is intentionally process-local for this first guard: it stops a
// single account from monopolizing a GPU immediately, while the durable quota
// service/Redis counter remains a P1 scaling task. Expired entries are removed
// opportunistically so the map cannot grow with one-off account IDs.
func allowAIChat(userID string) bool {
	now := time.Now()
	aiChatRate.Lock()
	defer aiChatRate.Unlock()
	entry, ok := aiChatRate.users[userID]
	if !ok || now.Sub(entry.started) >= aiChatRateWindow {
		aiChatRate.users[userID] = aiChatRateEntry{started: now, count: 1}
		if len(aiChatRate.users) > 10000 {
			for id, candidate := range aiChatRate.users {
				if now.Sub(candidate.started) >= aiChatRateWindow {
					delete(aiChatRate.users, id)
				}
			}
		}
		return true
	}
	if entry.count >= aiChatRateLimit {
		return false
	}
	entry.count++
	aiChatRate.users[userID] = entry
	return true
}

func handleAIChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !allowAIChat(uid) {
		w.Header().Set("Retry-After", "60")
		fail(w, "AI request limit reached; try again in a minute", http.StatusTooManyRequests)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	var req aiChatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil || strings.TrimSpace(req.Text) == "" {
		fail(w, "text is required", 400)
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if len(req.Text) > 4000 {
		fail(w, "text must be 4000 characters or fewer", 400)
		return
	}
	if len(req.Messages) > 12 {
		req.Messages = req.Messages[len(req.Messages)-12:]
	}
	history := make([]aiChatMessage, 0, len(req.Messages))
	for _, message := range req.Messages {
		message.Text = strings.TrimSpace(message.Text)
		if (message.Role != "user" && message.Role != "assistant") || message.Text == "" {
			continue
		}
		if len(message.Text) > 4000 {
			message.Text = message.Text[:4000]
		}
		history = append(history, message)
	}
	// See lightAIMaxTokens' 2026-09 update comment: the GPU-side chat-
	// template/stop-token fix removed the reason this needed to be small.
	// Kept as its own constant (not the shared aiChat()/aiChatMaxTokens
	// default that document-ask/rewrite use) since AIPA is a general chat
	// surface that can legitimately need more room than a single-fact
	// lookup — a deliberately generous budget now costs nothing extra in
	// the common case, since the model stops on its own once it's done.
	const aiAssistantMaxTokens = 2500
	const aiAssistantTimeout = 60 * time.Second

	var callerName string
	db.QueryRow(`SELECT display_name FROM users WHERE id=?`, uid).Scan(&callerName) //nolint
	if callerName == "" {
		callerName = "the user"
	}
	todayISO := strings.TrimSpace(req.LocalNow)
	if todayISO == "" {
		todayISO = time.Now().UTC().Format("2006-01-02")
	} else if len(todayISO) > 10 {
		todayISO = todayISO[:10]
	}

	// Scheduling is checked FIRST, on the raw message alone (no thread
	// history — see this file's header on why single-turn extraction is the
	// reliable shape for this model) — only when it comes back both a
	// scheduling request AND confident does this ever take a real action;
	// anything else falls straight through to the normal contextual answer
	// below, unactioned.
	// looksLikeScheduleRequest is checked FIRST and, if it matches, the
	// classifier's own isSchedulingRequest flag is not trusted to override
	// it — see looksLikeScheduleRequest's comment for the reproduced case
	// that made this necessary. Anything that regex-matches never reaches
	// the free-form general-chat call below.
	if looksLikeScheduleRequest(req.Text) {
		intent, ierr := detectScheduleIntent(r.Context(), req.Text, todayISO, callerName)
		if ierr == nil && intent.Confident {
			summary := executeScheduleMeeting(uid, callerName, intent)
			ok(w, map[string]any{"result": summary, "action": "schedule_meeting"})
			return
		}
		if ierr == nil {
			ok(w, map[string]any{"result": clarifyScheduleRequest(intent)})
			return
		}
		ok(w, map[string]any{"result": "I can schedule that for you — could you confirm exactly who you want to meet with and the date and time?"})
		return
	}

	contextBlock := buildAIPAContext(uid, req.PersonalEvents)
	prompt := req.Text
	if contextBlock != "" {
		prompt = "CONTEXT\n" + contextBlock + "\nUSER MESSAGE\n" + req.Text
	}
	result, err := aiChatBudgetedTimed(r.Context(), aiAssistantSystemPrompt, history, prompt, nil, aiAssistantMaxTokens, aiAssistantTimeout)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	if looksLikeFalseActionClaim(result) {
		// The model claimed to have taken an action it never actually took
		// (see looksLikeFalseActionClaim) — never forward that to the user as
		// if it were true.
		result = "I can help with that — tell me exactly who to invite and the date/time, and I'll actually schedule it, send the link, and add it to the calendar."
	}
	ok(w, map[string]string{"result": result})
}

// ─── POST /api/ai/rewrite ────────────────────────────────────────────────────
//
// AI Writing: grammar/clarity/tone tools on a message before it's sent. `mode`
// is a fixed, server-side allow-list rather than a free-text instruction the
// client sends — same discipline this codebase already applies to the
// reaction emoji allow-list (server/main.go's allowedReactions): the model's
// output goes straight back into the composer, so letting a client smuggle
// an arbitrary instruction through this endpoint would make it a generic
// "run any prompt IB Connect's backend token pays for" hole, not a writing
// tool. Keep this list in sync with REWRITE_MODES in src/lib/aiWriting.ts.
//
// The strict formatting rules live in ONE shared system prompt
// (aiRewriteSystemPrompt), not folded into each mode's task text — tested
// directly against the real model: a per-mode instruction ending in "reply
// with ONLY the rewritten message" was not enough on its own, and the model
// returned three labeled options with markdown headers and commentary
// instead of one plain rewrite. Separating "what to do" (task, as the user
// turn) from "how to format the answer" (system turn) fixed it consistently
// across every mode — confirmed by testing each one, not assumed from one
// success.
const aiRewriteSystemPrompt = "You rewrite chat messages. Output ONLY the single rewritten message text itself. " +
	"Do not output multiple options. Do not use markdown, headers, bullet points, or quotation marks. " +
	"Do not add any explanation, preamble, or commentary before or after it. Your entire response must be " +
	"exactly one rewritten version of the message, nothing else."

var rewriteModeTask = map[string]string{
	"grammar":      "Fix any spelling and grammar mistakes in the message below. Keep the meaning, tone and length as close to the original as possible.",
	"clarity":      "Rewrite the message below to be clearer and easier to understand, without changing its meaning or making it noticeably longer.",
	"professional": "Rewrite the message below in a professional, polished tone suitable for a workplace chat.",
	"casual":       "Rewrite the message below in a relaxed, casual, friendly tone.",
	"polite":       "Rewrite the message below to sound more polite and considerate, without changing its core request or meaning.",
	"confident":    "Rewrite the message below to sound more confident and direct, without becoming rude.",
	"persuasive":   "Rewrite the message below to be more persuasive and compelling, while staying honest to its original point.",
	"humorous":     "Rewrite the message below with a light, humorous tone, without being inappropriate.",
	"shorten":      "Shorten the message below as much as possible while keeping its essential meaning.",
	"expand":       "Expand the message below with a bit more detail and context, without changing its core meaning.",
	"summarize":    "Summarize the message below in one or two short sentences.",
	"simplify":     "Rewrite the message below using simpler words and shorter sentences, so it's easy for anyone to understand.",
}

type aiRewriteRequest struct {
	Text string `json:"text"`
	Mode string `json:"mode"`
}

func handleAIRewrite(w http.ResponseWriter, r *http.Request) {
	if _, err := bearerUID(r); err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	var req aiRewriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" {
		fail(w, "text is required", 400)
		return
	}
	task, known := rewriteModeTask[req.Mode]
	if !known {
		fail(w, "unknown mode", 400)
		return
	}
	prompt := task + "\n\nMessage:\n" + req.Text
	result, err := aiChat(r.Context(), aiRewriteSystemPrompt, nil, prompt, nil)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	ok(w, map[string]string{"result": result})
}

// ─── POST /api/ai/reply-suggestions ──────────────────────────────────────────
//
// AI Reply: context-aware suggested replies to the thread's most recent
// messages, in a few different tones. Real thread history (not a blind
// prompt) is what makes these "context-aware" rather than generic — pulled
// from the same `messages` table handleMessages already reads, capped at 20
// so a long-running thread doesn't balloon the prompt.
const replyContextLimit = 20

type aiReplySuggestion struct {
	Tone string `json:"tone"`
	Text string `json:"text"`
}

// replyLineRe parses the PROFESSIONAL:/CASUAL:/FRIENDLY: labeled-line format
// requested below. Chosen over asking for JSON after a real, reproduced
// failure: role-mapping the caller's own recent messages as "assistant" and
// everyone else's as "user" (the original design) produces a degenerate
// all-one-role history whenever the last several messages happen to be the
// caller's own (an ordinary, common shape — e.g. someone sent several
// messages in a row and hasn't been answered yet, exactly the situation this
// feature exists for). Confirmed directly against the real model, 3/3
// trials: given that exact shape, it never attempts JSON at all — it just
// echoes "Assistant: <the same line>" on a loop until cut off, so
// extractJSONObject legitimately never finds a "{" to work with. Rewording
// the whole conversation into a single plain-text transcript (like ask-
// thread already does) instead of per-message chat roles avoided the
// pathological loop in the same reproduction; asking for 3 labeled lines
// instead of a JSON object removes the "did not return a JSON object"
// failure class entirely regardless, since this format needs no matching
// closing brace to parse successfully.
var replyLineRe = regexp.MustCompile(`(?im)^\s*(professional|casual|friendly)\s*:\s*(.+)$`)

func parseReplySuggestions(text string) []aiReplySuggestion {
	order := []string{"professional", "casual", "friendly"}
	found := map[string]string{}
	for _, m := range replyLineRe.FindAllStringSubmatch(text, -1) {
		tone := strings.ToLower(m[1])
		if _, already := found[tone]; !already { // first occurrence of each label wins — a later one is the echo loop repeating itself
			found[tone] = strings.TrimSpace(m[2])
		}
	}
	suggestions := make([]aiReplySuggestion, 0, 3)
	for _, tone := range order {
		if text, ok := found[tone]; ok && text != "" {
			suggestions = append(suggestions, aiReplySuggestion{Tone: tone, Text: text})
		}
	}
	return suggestions
}

func handleAIReplySuggestions(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	var req struct {
		ThreadID string `json:"threadId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ThreadID == "" {
		fail(w, "threadId is required", 400)
		return
	}
	if !isMember(req.ThreadID, uid) {
		fail(w, "not a member", 403)
		return
	}

	rows, err := db.Query(`
		SELECT m.sender_id, u.display_name, m.text FROM messages m JOIN users u ON u.id=m.sender_id
		WHERE m.thread_id=? ORDER BY m.created_at DESC LIMIT ?
	`, req.ThreadID, replyContextLimit)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	defer rows.Close()
	// Reversed back to chronological order below — the query above is DESC
	// specifically so LIMIT keeps the MOST RECENT messages on a long thread,
	// not the oldest.
	type row struct{ senderID, name, text string }
	var recent []row
	for rows.Next() {
		var rr row
		rows.Scan(&rr.senderID, &rr.name, &rr.text) //nolint
		recent = append(recent, rr)
	}
	if len(recent) == 0 {
		ok(w, map[string]any{"suggestions": []aiReplySuggestion{}})
		return
	}

	// Plain-text transcript, not a role-mapped chat history — see
	// replyLineRe's comment above for why. The caller is labeled "Me" (not
	// their real name) so the model's framing of "what could I send next" is
	// unambiguous regardless of who said the most recent message.
	var transcript strings.Builder
	for i := len(recent) - 1; i >= 0; i-- {
		label := recent[i].name
		if recent[i].senderID == uid {
			label = "Me"
		}
		fmt.Fprintf(&transcript, "%s: %s\n", label, recent[i].text)
	}

	system := "You draft short reply suggestions for a chat app user, based on a conversation transcript. " +
		"Propose exactly 3 short, distinct reply options the user (\"Me\" in the transcript) could send in " +
		"response to the LAST message shown: one professional, one casual, one friendly. Keep each under 25 " +
		"words. Output EXACTLY three lines, nothing else, in this exact format:\n" +
		"PROFESSIONAL: <reply text>\nCASUAL: <reply text>\nFRIENDLY: <reply text>\n" +
		"Never output the word Assistant or User. Never repeat the transcript. Stop after the three lines."
	prompt := fmt.Sprintf("Transcript:\n%s\nWrite 3 reply suggestions for what I could send next, in the format described.", transcript.String())

	// See lightAIMaxTokens' 2026-09 update comment: the GPU-side fix that
	// made these budgets safe to size for real content again (rather than
	// worst-case echo-loop damage control) applies equally here. Kept as its
	// own constant, still somewhat above lightAIMaxTokens, since drafting
	// three distinct replies is a real generation task, not a fact lookup.
	const replyMaxTokens = 2000
	const replyTimeout = 60 * time.Second
	result, err := aiChatBudgetedTimed(r.Context(), system, nil, prompt, nil, replyMaxTokens, replyTimeout)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	suggestions := parseReplySuggestions(result)
	if len(suggestions) == 0 {
		fail(w, "AI service did not return any reply suggestions in the expected format", 502)
		return
	}
	ok(w, map[string]any{"suggestions": suggestions})
}

// ─── POST /api/ai/ask-thread ──────────────────────────────────────────────
//
// "Ask AIPA" — a free-text question about one specific conversation, answered
// from that thread's own recent messages. Deliberately asks for a plain-text
// answer, not JSON: this class of endpoint (a single prose answer, not a
// structured multi-field report) has no real use for the extractJSONObject
// step, and every "AI service did not return a JSON object as requested"
// error on this feature so far has traced back to exactly that step failing
// when the model's reasoning overhead ate the whole token budget before
// producing the requested object — asking for prose instead removes the
// failure mode outright rather than just budgeting around it (see
// handleAIDocumentAsk, the existing plain-text-answer endpoint this mirrors).
const askContextLimit = 40

func handleAIAskThread(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	var req struct {
		ThreadID string `json:"threadId"`
		Question string `json:"question"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ThreadID == "" || strings.TrimSpace(req.Question) == "" {
		fail(w, "threadId and question are required", 400)
		return
	}
	if !isMember(req.ThreadID, uid) {
		fail(w, "not a member", 403)
		return
	}

	rows, err := db.Query(`
		SELECT u.display_name, m.text FROM messages m JOIN users u ON u.id=m.sender_id
		WHERE m.thread_id=? ORDER BY m.created_at DESC LIMIT ?
	`, req.ThreadID, askContextLimit)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	type row struct{ name, text string }
	var recent []row
	for rows.Next() {
		var rr row
		rows.Scan(&rr.name, &rr.text) //nolint
		recent = append(recent, rr)
	}
	rows.Close()
	if len(recent) == 0 {
		fail(w, "nothing to ask about yet — this conversation has no messages", 400)
		return
	}

	var transcript strings.Builder
	for i := len(recent) - 1; i >= 0; i-- {
		fmt.Fprintf(&transcript, "%s: %s\n", recent[i].name, recent[i].text)
	}

	// Wording matters a lot more than it should here — measured directly.
	// The original "Conversation (oldest first):\n<name>: <text>...\n\n
	// Question: ..." shape reliably (3/3 trials) sent this model into the
	// full-budget echo loop described at lightAIMaxTokens' declaration: it
	// answered correctly in the first few tokens and then, every single
	// time, re-emitted "\nUser: <the entire prompt again>\nAssistant:
	// <answer again>" on a loop until cut off. Rewording to look less like a
	// literal chat-turn transcript (no bare "Name: text" lines read as
	// dialogue, no trailing "Question:" that resembles a new turn prompt)
	// plus an explicit, repeated instruction not to roleplay a User/
	// Assistant turn measurably reduced this in direct testing (mostly
	// loop-free or self-terminating after one loop, vs. 3/3 full-budget
	// loops before) — not a guaranteed fix (this service's underlying lack
	// of stop-sequence support isn't something a prompt can fully patch
	// over), which is why lightAIMaxTokens/trimEcho below still exist as the
	// backstop for whenever it does still happen.
	system := "You are a Q&A tool. You are given a chat log and a question. Respond with ONLY the answer text — " +
		"a single short phrase or sentence, using ONLY facts actually present in the chat log below (never invent " +
		"names, dates, or facts). If the answer genuinely isn't in the chat log, say so plainly rather than " +
		"guessing. Never output the words \"User\" or \"Assistant\". Never repeat or restate the chat log. Never " +
		"continue the dialogue or invent further messages. Stop generating immediately after the answer."
	prompt := fmt.Sprintf("Chat log:\n%s\nAnswer this question about the chat log above: %s", transcript.String(), req.Question)

	result, err := aiChatBudgetedTimed(r.Context(), system, nil, prompt, nil, lightAIMaxTokens, lightAITimeout)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	ok(w, map[string]string{"result": result})
}

// ─── POST /api/ai/analyze-thread ─────────────────────────────────────────────
//
// AI Conversation Understanding (summary/key points/decisions/questions/who-
// said-what) AND AI Task Extraction (commitments), in ONE model call rather
// than one per category — deliberate, given the ~15-30s per call this model
// measures at (see gpu/AI_CONTRACT.md's Latency section): a "catch me up"
// button that fired 5 separate calls would take minutes, not seconds.
//
// Decisions are auto-saved to ai_memory (a decision is exactly the kind of
// fact worth remembering long-term, and this is the one place they're ever
// identified) and action items are auto-saved to ai_tasks — both persisted
// before the response is sent, so a page reload doesn't lose an analysis
// that already ran (the caller gets the analysis back either way; re-running
// it is a deliberate user action, this isn't a cache).
const analyzeContextLimit = 60

// analyzeMaxTokens: 2000 was tried first and confirmed too low by direct
// measurement: a real call for a short, 4-message conversation still used
// ~2900 tokens of <think> content alone before reaching its answer —
// reasoning length here tracks how much the prompt asks the model to
// reconcile (a 7-field structured extraction over up to 60 messages), not
// how long the conversation is. 4000 gives real margin above the measured
// figure.
// analyzeTimeout: 300s, not the shared 120s default. Measured directly: the
// same 4-message conversation, given a large enough budget to actually
// finish, took ~195s end to end at ~15 tokens/sec on this model — so 4000
// tokens has a worst case around 270s. 300s leaves real margin above that.
// nginx's location for this endpoint must stay above this (currently 320s —
// see the nginx vhost).
const analyzeMaxTokens = 4000
const analyzeTimeout = 300 * time.Second

// lightAIMaxTokens/lightAITimeout back ask-thread (reply-suggestions has its
// own budget — see replyMaxTokens below).
//
// UPDATE, 2026-09: the GPU VM fixed the root cause these were originally
// tuned defensively around. The model previously had no working chat
// template/stop-token handling (a hand-rolled server built the prompt via
// manual string concatenation instead of the model's real chat template),
// so it couldn't recognize end-of-turn and would routinely free-run into
// echoing a fake "\nUser: ...\nAssistant: ..." continuation for the rest of
// whatever max_tokens budget it was given — confirmed at the time to
// reliably consume the entire budget once triggered, which is why these
// constants were kept small: a bigger budget only meant a longer guaranteed
// wait, never a better answer (trimEcho already recovered the real answer
// from the garbage regardless of budget size). The GPU VM rebuilt the
// server around the model's actual chat template and real stop-token
// handling; confirmed directly against the fixed service, not taken on
// their word: previously-guaranteed-to-loop prompts now complete in 1-8s,
// and a deliberately large budget (3000 tokens) on a genuinely long-answer
// question still returned in 16s because the model now actually stops when
// it's done rather than free-running to the ceiling. With that constraint
// gone, these are sized for real content headroom again rather than worst-
// case damage control — trimEcho/stripThinking stay in place as a cheap,
// harmless backstop in case the new server ever regresses, not because
// they're expected to fire routinely any more.
const lightAIMaxTokens = 2000
const lightAITimeout = 60 * time.Second

type aiActionItem struct {
	Description string `json:"description"`
	Assignee    string `json:"assignee"` // a display name from the conversation, or "unclear" — resolved to a real user_id server-side, see resolveAssignee
	Due         string `json:"due"`      // a free-text date/time phrase the model saw, if any — NOT parsed into a real date (see the file-level note on this being a known simplification)
}

type aiReminderSuggestion struct {
	Text string `json:"text"`
	When string `json:"when"` // free-text phrase ("tomorrow", "next week") — not parsed into a real date, same simplification as aiActionItem.Due
}

type aiMeetingSuggestion struct {
	Title string `json:"title"`
	When  string `json:"when"` // free-text phrase — deliberately NOT written to any calendar server-side; see this file's header on why calendar suggestions stay client-side
}

type aiThreadAnalysis struct {
	Summary            string                 `json:"summary"`
	KeyPoints          []string               `json:"keyPoints"`
	Decisions          []string               `json:"decisions"`
	Questions          []string               `json:"questions"`
	ActionItems        []aiActionItem         `json:"actionItems"`
	Reminders          []aiReminderSuggestion `json:"reminders"`
	MeetingSuggestions []aiMeetingSuggestion  `json:"meetingSuggestions"`
}

// resolveAssignee matches the model's free-text name guess against the
// thread's actual members (by display_name, case-insensitive substring) —
// the model never gets to assert a user_id directly, since that would let a
// hallucinated or ambiguous name silently attach a task to the wrong real
// account. No confident match -> "", meaning the task is saved with no
// resolved owner rather than a guessed one.
func resolveAssignee(threadID, name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" || name == "unclear" || name == "unknown" {
		return ""
	}
	rows, err := db.Query(`
		SELECT u.id, u.display_name FROM thread_members tm JOIN users u ON u.id=tm.user_id
		WHERE tm.thread_id=?
	`, threadID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	for rows.Next() {
		var id, displayName string
		rows.Scan(&id, &displayName) //nolint
		dn := strings.ToLower(displayName)
		if dn == name || strings.Contains(name, dn) || strings.Contains(dn, name) {
			return id
		}
	}
	return ""
}

func handleAIAnalyzeThread(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	var req struct {
		ThreadID string `json:"threadId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ThreadID == "" {
		fail(w, "threadId is required", 400)
		return
	}
	if !isMember(req.ThreadID, uid) {
		fail(w, "not a member", 403)
		return
	}

	rows, err := db.Query(`
		SELECT m.id, u.display_name, m.text FROM messages m JOIN users u ON u.id=m.sender_id
		WHERE m.thread_id=? ORDER BY m.created_at DESC LIMIT ?
	`, req.ThreadID, analyzeContextLimit)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	type row struct{ id, name, text string }
	var recent []row
	for rows.Next() {
		var rr row
		rows.Scan(&rr.id, &rr.name, &rr.text) //nolint
		recent = append(recent, rr)
	}
	rows.Close()
	if len(recent) == 0 {
		fail(w, "nothing to analyze yet", 400)
		return
	}

	// Reversed back to chronological order — the query above is DESC so LIMIT
	// keeps the most recent messages on a long thread, not the oldest. Named
	// speaker lines (not role-tagged turns) are what let the model answer
	// "who said what" — a chat-completions role history has no concept of a
	// third or fourth speaker, only user/assistant.
	var transcript strings.Builder
	var latestMsgID string
	for i := len(recent) - 1; i >= 0; i-- {
		fmt.Fprintf(&transcript, "%s: %s\n", recent[i].name, recent[i].text)
	}
	latestMsgID = recent[0].id

	system := "You analyze chat conversations and produce a structured JSON report. " +
		"Be concise and strictly factual — only include what is actually present in the conversation, " +
		"never invent names, dates, or facts that were not said. If a category has nothing, use an empty array. " +
		"The conversation is given oldest message first, in chronological order — treat later messages as the " +
		"most current state. If a later message changes, corrects, reschedules, cancels or supersedes something " +
		"said earlier (a proposed time being pushed back, a plan being changed, a decision being reversed), your " +
		"report must reflect ONLY the final, resolved outcome — never report the original, superseded version " +
		"alongside the correction as if both were still true, and never list the same underlying event twice " +
		"just because it was mentioned more than once. When a time is adjusted relative to an earlier one " +
		"(e.g. a meeting proposed for 12:50pm is then pushed back by 10 minutes), compute the actual resulting " +
		"time yourself (12:50pm + 10 minutes = 1:00pm) and report that single resolved time, not the raw phrase " +
		"'10 minutes later' on its own. " +
		"Your final answer must be ONLY a single JSON object, no other text, no markdown, in exactly this shape: " +
		`{"summary":"2-3 sentence overview","keyPoints":["..."],"decisions":["..."],"questions":["unanswered questions raised"],` +
		`"actionItems":[{"description":"...","assignee":"a name from the conversation, or unclear","due":"a date/time phrase mentioned, or empty string"}],` +
		`"reminders":[{"text":"something someone said they would do or follow up on later, phrased as a reminder","when":"a date/time phrase mentioned, or empty string"}],` +
		`"meetingSuggestions":[{"title":"a short meeting title based on what was discussed","when":"the single final resolved date/time, after applying any corrections mentioned"}]}` +
		` reminders are for personal follow-ups/commitments phrased as "remind me/I'll do X later" — do not duplicate actionItems here. ` +
		`meetingSuggestions cover any time+intent to meet that was actually proposed or discussed — this includes a PROPOSAL phrased as a question ("can we meet at 4?", "can we keep a meet on 12:50pm today??") just as much as a direct statement ("let's meet Friday at 4"); a proposal does not need to have been explicitly accepted or confirmed by the other person to count, only actually proposed. Do not invent one if no meeting was discussed at all, and emit exactly ONE entry per distinct meeting even if its time was corrected across several messages.`
	prompt := "Conversation (oldest first):\n" + transcript.String() + "\nProduce the JSON report described."

	wantJSON := json.RawMessage(`{"required":["summary","keyPoints","decisions","questions","actionItems","reminders","meetingSuggestions"]}`)
	// analyzeMaxTokens/analyzeTimeout are package-level now — see their
	// declaration above (near analyzeContextLimit) for the measurements
	// behind these numbers.
	result, err := aiChatBudgetedTimed(r.Context(), system, nil, prompt, wantJSON, analyzeMaxTokens, analyzeTimeout)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	var analysis aiThreadAnalysis
	if err := json.Unmarshal([]byte(result), &analysis); err != nil {
		fail(w, fmt.Sprintf("AI service returned an unreadable reply: %v", err), 502)
		return
	}

	// Decisions -> long-term thread memory. Best-effort: a failed insert here
	// doesn't fail the whole analysis, since the caller still gets the
	// analysis they asked for either way.
	for _, d := range analysis.Decisions {
		db.Exec(`INSERT INTO ai_memory(id, user_id, thread_id, fact, source_message_id) VALUES (?,?,?,?,?)`, //nolint
			newID(), uid, req.ThreadID, "Decision: "+d, latestMsgID)
	}
	// Action items -> ai_tasks, assignee resolved against real thread members.
	for _, a := range analysis.ActionItems {
		if strings.TrimSpace(a.Description) == "" {
			continue
		}
		desc := a.Description
		if a.Due != "" {
			desc = fmt.Sprintf("%s (due: %s)", desc, a.Due)
		}
		owner := resolveAssignee(req.ThreadID, a.Assignee)
		var ownerArg any
		if owner != "" {
			ownerArg = owner
		}
		db.Exec(`INSERT INTO ai_tasks(id, thread_id, source_message_id, description, owner_user_id, created_by) VALUES (?,?,?,?,?,?)`, //nolint
			newID(), req.ThreadID, latestMsgID, desc, ownerArg, uid)
	}
	// Reminders -> ai_reminders, for the caller only — a reminder detected while
	// reading someone else's thread is this user's own personal follow-up, not
	// shared state, unlike decisions/tasks which describe the conversation
	// itself. remind_at stays NULL (no real date parsing — see aiReminderSuggestion's
	// own comment); the "when" phrase is folded into the text instead.
	for _, rmd := range analysis.Reminders {
		if strings.TrimSpace(rmd.Text) == "" {
			continue
		}
		text := rmd.Text
		if rmd.When != "" {
			text = fmt.Sprintf("%s (%s)", text, rmd.When)
		}
		db.Exec(`INSERT INTO ai_reminders(id, user_id, thread_id, text) VALUES (?,?,?,?)`, //nolint
			newID(), uid, req.ThreadID, text)
	}
	// Meeting suggestions are deliberately NOT persisted anywhere server-side —
	// this app's calendar is per-user localStorage (calendarLocal.ts), not a
	// server table, so there is nothing here to write to. The frontend turns
	// analysis.meetingSuggestions into a one-tap "Add to calendar" action that
	// writes to the existing local calendar directly.

	ok(w, analysis)
}

// ─── AI Memory: GET/DELETE /api/ai/memory ────────────────────────────────────
//
// User-editable, deletable memory. GET with ?threadId= returns memory scoped
// to that chat; GET with no threadId returns this user's long-term personal
// memory (thread_id IS NULL) — the two are deliberately different queries,
// not one "everything" list, matching the feature's own per-chat vs
// long-term distinction.

type aiMemoryItem struct {
	ID        string `json:"id"`
	Fact      string `json:"fact"`
	ThreadID  string `json:"threadId,omitempty"`
	CreatedAt string `json:"createdAt"`
}

func handleAIMemory(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}

	// DELETE /api/ai/memory/{id}
	if r.Method == "DELETE" {
		id := strings.TrimPrefix(r.URL.Path, "/api/ai/memory/")
		if id == "" || id == r.URL.Path {
			fail(w, "memory id is required", 400)
			return
		}
		res, err := db.Exec(`DELETE FROM ai_memory WHERE id=? AND user_id=?`, id, uid)
		if err != nil {
			fail(w, "db error", 500)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			fail(w, "not found", 404)
			return
		}
		ok(w, map[string]bool{"ok": true})
		return
	}

	if r.Method != "GET" {
		fail(w, "method not allowed", 405)
		return
	}
	threadID := r.URL.Query().Get("threadId")
	var rows *sql.Rows
	if threadID != "" {
		if !isMember(threadID, uid) {
			fail(w, "not a member", 403)
			return
		}
		rows, err = db.Query(`SELECT id, fact, thread_id, DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') FROM ai_memory
			WHERE user_id=? AND thread_id=? ORDER BY created_at DESC`, uid, threadID)
	} else {
		rows, err = db.Query(`SELECT id, fact, thread_id, DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') FROM ai_memory
			WHERE user_id=? AND thread_id IS NULL ORDER BY created_at DESC`, uid)
	}
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	defer rows.Close()
	items := []aiMemoryItem{}
	for rows.Next() {
		var it aiMemoryItem
		var tid sql.NullString
		rows.Scan(&it.ID, &it.Fact, &tid, &it.CreatedAt) //nolint
		it.ThreadID = tid.String
		items = append(items, it)
	}
	ok(w, map[string]any{"memory": items})
}

// ─── GET /api/ai/tasks, POST /api/ai/tasks/{id}/complete ─────────────────────
//
// "What do I owe people?" / "what's owed to me?" — owedByMe is this user as
// the resolved assignee of a pending task; owedToMe is a pending task this
// user's own session extracted where someone ELSE was resolved as the
// assignee (i.e. this user is the one who will end up waiting on it).

type aiTaskItem struct {
	ID          string `json:"id"`
	ThreadID    string `json:"threadId"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
}

func queryTasks(where string, args ...any) []aiTaskItem {
	rows, err := db.Query(`SELECT id, thread_id, description, DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ')
		FROM ai_tasks WHERE status='pending' AND `+where+` ORDER BY created_at DESC LIMIT 100`, args...)
	items := []aiTaskItem{}
	if err != nil {
		return items
	}
	defer rows.Close()
	for rows.Next() {
		var it aiTaskItem
		rows.Scan(&it.ID, &it.ThreadID, &it.Description, &it.CreatedAt) //nolint
		items = append(items, it)
	}
	return items
}

func handleAITasks(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	ok(w, map[string]any{
		"owedByMe": queryTasks("owner_user_id=?", uid),
		"owedToMe": queryTasks("created_by=? AND owner_user_id IS NOT NULL AND owner_user_id<>?", uid, uid),
	})
}

func handleAITaskComplete(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/ai/tasks/"), "/complete")
	if id == "" || r.Method != "POST" {
		fail(w, "not found", 404)
		return
	}
	res, err := db.Exec(`UPDATE ai_tasks SET status='done' WHERE id=? AND (owner_user_id=? OR created_by=?)`, id, uid, uid)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, "not found", 404)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// ─── AI Reminders: GET /api/ai/reminders, POST .../{id}/complete, DELETE .../{id} ──
//
// Reminders are personal (see handleAIAnalyzeThread's own comment on why they
// go to the caller only, not shared like decisions/tasks), so this is always
// scoped to the caller's own user_id — no membership check beyond that, since
// there's no cross-user data here to leak.

type aiReminderItem struct {
	ID        string `json:"id"`
	ThreadID  string `json:"threadId,omitempty"`
	Text      string `json:"text"`
	CreatedAt string `json:"createdAt"`
}

func handleAIReminders(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}

	if r.Method == "DELETE" || (r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/complete")) {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/ai/reminders/"), "/complete")
		if id == "" {
			fail(w, "reminder id is required", 400)
			return
		}
		var res sql.Result
		if r.Method == "DELETE" {
			res, err = db.Exec(`DELETE FROM ai_reminders WHERE id=? AND user_id=?`, id, uid)
		} else {
			res, err = db.Exec(`UPDATE ai_reminders SET status='done' WHERE id=? AND user_id=?`, id, uid)
		}
		if err != nil {
			fail(w, "db error", 500)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			fail(w, "not found", 404)
			return
		}
		ok(w, map[string]bool{"ok": true})
		return
	}

	if r.Method != "GET" {
		fail(w, "method not allowed", 405)
		return
	}
	rows, err := db.Query(`SELECT id, thread_id, text, DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') FROM ai_reminders
		WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 100`, uid)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	defer rows.Close()
	items := []aiReminderItem{}
	for rows.Next() {
		var it aiReminderItem
		var tid sql.NullString
		rows.Scan(&it.ID, &tid, &it.Text, &it.CreatedAt) //nolint
		it.ThreadID = tid.String
		items = append(items, it)
	}
	ok(w, map[string]any{"reminders": items})
}

// ─── POST /api/ai/search ─────────────────────────────────────────────────────
//
// AI Search. Deliberately NOT a model call — a 2B chat model is a poor
// embedder and, per gpu/AI_CONTRACT.md, this one has no embeddings endpoint
// at all; more importantly, search needs to feel instant, and this model
// measures 15-30s per call. Keyword matching over stored messages, scored by
// how many distinct query words matched plus recency, covers the actual
// example in the feature request ("find the conversation where Rahul gave me
// the new server IP") just fine — a natural-language query about a real past
// message almost always contains the actual nouns that were in it. Scoped to
// threads the caller is a member of; never searches across other people's
// private conversations.
const searchResultLimit = 20

type aiSearchResult struct {
	MessageID  string `json:"messageId"`
	ThreadID   string `json:"threadId"`
	ThreadName string `json:"threadName"`
	SenderName string `json:"senderName"`
	Text       string `json:"text"`
	CreatedAt  string `json:"createdAt"`
}

func handleAISearch(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var req struct {
		Query    string `json:"query"`
		ThreadID string `json:"threadId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, "invalid request", 400)
		return
	}
	words := strings.Fields(strings.ToLower(req.Query))
	if len(words) == 0 {
		ok(w, map[string]any{"results": []aiSearchResult{}})
		return
	}
	if len(words) > 8 {
		words = words[:8] // a long query stops adding useful precision and just slows the query down
	}

	args := []any{uid}
	q := `SELECT m.id, m.thread_id, t.name, u.display_name, m.text, DATE_FORMAT(m.created_at,'%Y-%m-%dT%H:%i:%sZ')
		FROM messages m
		JOIN threads t ON t.id = m.thread_id
		JOIN thread_members tm ON tm.thread_id = m.thread_id
		JOIN users u ON u.id = m.sender_id
		WHERE tm.user_id = ?`
	if req.ThreadID != "" {
		if !isMember(req.ThreadID, uid) {
			fail(w, "not a member", 403)
			return
		}
		q += ` AND m.thread_id = ?`
		args = append(args, req.ThreadID)
	}
	q += ` AND (`
	for i, wd := range words {
		if i > 0 {
			q += ` OR `
		}
		q += `m.text LIKE ?`
		args = append(args, "%"+wd+"%")
	}
	q += `) ORDER BY m.created_at DESC LIMIT 300` // over-fetch, then rank in Go below before truncating to searchResultLimit

	rows, err := db.Query(q, args...)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	defer rows.Close()
	type scored struct {
		r     aiSearchResult
		score int
	}
	var candidates []scored
	for rows.Next() {
		var res aiSearchResult
		rows.Scan(&res.MessageID, &res.ThreadID, &res.ThreadName, &res.SenderName, &res.Text, &res.CreatedAt) //nolint
		lower := strings.ToLower(res.Text)
		score := 0
		for _, wd := range words {
			if strings.Contains(lower, wd) {
				score++
			}
		}
		candidates = append(candidates, scored{res, score})
	}
	// Most distinct query words matched wins; DB's own DESC-by-recency order
	// (preserved by a stable sort) breaks ties in favor of the more recent
	// message, not an arbitrary one.
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].score > candidates[j].score })
	results := []aiSearchResult{}
	for i, c := range candidates {
		if i >= searchResultLimit {
			break
		}
		results = append(results, c.r)
	}
	ok(w, map[string]any{"results": results})
}

// ─── POST /api/ai/translate ───────────────────────────────────────────────────
//
// AI Translation. Reuses the NLLB model already running on this same GPU VM
// via the ASR contract's /v1/translate (asr_gpu.go's asrTranslate) — see
// gpu/AI_CONTRACT.md's closing section on why translation is explicitly NOT
// re-implemented against the Qwen chat model. This is a genuinely different
// GPU service/config (ASR_GPU_URL, not AI_GPU_URL) even though it happens to
// be the same physical machine.

func handleAITranslate(w http.ResponseWriter, r *http.Request) {
	if _, err := bearerUID(r); err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !asrConfigured() {
		fail(w, "Translation is not configured", 503)
		return
	}
	var req struct {
		Text       string `json:"text"`
		TargetLang string `json:"targetLang"`
		SourceLang string `json:"sourceLang"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" || req.TargetLang == "" {
		fail(w, "text and targetLang are required", 400)
		return
	}
	source := req.SourceLang
	if source == "" {
		// "auto" was tried first and confirmed wrong: the real service returned
		// {"errors":{"<lang>":"translation_failed"}} for it — per
		// gpu/ASR_CONTRACT.md, source_language must be a real code (its own
		// example uses "en"), there is no auto-detect value. This app's chat is
		// English-first with no language-detection step of its own, so "en" is
		// the honest default until a caller has a real detected source to pass.
		source = "en"
	}
	translations, err := asrTranslate(r.Context(), req.Text, source, []string{req.TargetLang})
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	result, ok2 := translations[req.TargetLang]
	if !ok2 {
		fail(w, "translation failed for that language", 502)
		return
	}
	ok(w, map[string]string{"result": result})
}
