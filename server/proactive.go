package main

// Durable, permission-scoped proactive opportunities.
//
// Detection never performs a consequential action. It records a reviewable
// opportunity for one user; calendar mutations still flow through the
// existing single-use confirmation-token path. This makes AIPA proactive in
// what it notices without making it autonomous in what it changes.

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type proactivePreferences struct {
	Enabled            bool   `json:"enabled"`
	MeetingSuggestions bool   `json:"meetingSuggestions"`
	DailyPlanning      bool   `json:"dailyPlanning"`
	TaskSignals        bool   `json:"taskSignals"`
	ReplySignals       bool   `json:"replySignals"`
	MeetingPrep        bool   `json:"meetingPrep"`
	PostMeeting        bool   `json:"postMeeting"`
	QuietStart         string `json:"quietStart"`
	QuietEnd           string `json:"quietEnd"`
	TimeZone           string `json:"timeZone"`
	DailyLimit         int    `json:"dailyLimit"`
}

type proactiveOpportunity struct {
	ID                string                  `json:"id"`
	Kind              string                  `json:"kind"`
	Title             string                  `json:"title"`
	Summary           string                  `json:"summary"`
	SourceType        string                  `json:"sourceType"`
	SourceID          string                  `json:"sourceId"`
	Confidence        float64                 `json:"confidence"`
	Priority          int                     `json:"priority"`
	ActionLabel       string                  `json:"actionLabel,omitempty"`
	ConfirmationToken string                  `json:"confirmationToken,omitempty"`
	ProposedAction    *CalendarActionProposal `json:"proposedAction,omitempty"`
	Status            string                  `json:"status"`
	ResultRef         string                  `json:"resultRef,omitempty"`
	Feedback          string                  `json:"feedback,omitempty"`
	CreatedAt         string                  `json:"createdAt"`
	UpdatedAt         string                  `json:"updatedAt"`
}

type proactiveOpportunityState struct {
	ID          string
	Fingerprint string
	Status      string
	ResultRef   string
}

func migrateProactive() {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS aipa_proactive_preferences (
			user_id VARCHAR(255) PRIMARY KEY,
			enabled TINYINT(1) NOT NULL DEFAULT 1,
			meeting_suggestions TINYINT(1) NOT NULL DEFAULT 1,
			daily_planning TINYINT(1) NOT NULL DEFAULT 1,
			updated_at DATETIME(6) DEFAULT NOW(6) ON UPDATE NOW(6),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS aipa_opportunities (
			id VARCHAR(80) PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			kind VARCHAR(48) NOT NULL,
			title VARCHAR(255) NOT NULL,
			summary TEXT NOT NULL,
			source_type VARCHAR(48) NOT NULL DEFAULT '',
			source_id VARCHAR(255) NOT NULL DEFAULT '',
			confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
			priority INT NOT NULL DEFAULT 0,
			action_label VARCHAR(100) NOT NULL DEFAULT '',
			action_token VARCHAR(80) NULL,
			metadata JSON NULL,
			fingerprint CHAR(64) NOT NULL,
			dedupe_key VARCHAR(191) NOT NULL,
			status VARCHAR(24) NOT NULL DEFAULT 'pending',
			snoozed_until DATETIME(6) NULL,
			expires_at DATETIME(6) NULL,
			result_ref VARCHAR(255) NOT NULL DEFAULT '',
			created_at DATETIME(6) DEFAULT NOW(6),
			updated_at DATETIME(6) DEFAULT NOW(6) ON UPDATE NOW(6),
			UNIQUE KEY uq_aipa_opportunity_user_dedupe(user_id,dedupe_key),
			INDEX idx_aipa_opportunity_inbox(user_id,status,snoozed_until,priority),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS task_signals TINYINT(1) NOT NULL DEFAULT 1`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS reply_signals TINYINT(1) NOT NULL DEFAULT 1`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS meeting_prep TINYINT(1) NOT NULL DEFAULT 1`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS post_meeting TINYINT(1) NOT NULL DEFAULT 1`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS quiet_start VARCHAR(5) NOT NULL DEFAULT '21:00'`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS quiet_end VARCHAR(5) NOT NULL DEFAULT '08:00'`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata'`,
		`ALTER TABLE aipa_proactive_preferences ADD COLUMN IF NOT EXISTS daily_limit INT NOT NULL DEFAULT 6`,
		`CREATE TABLE IF NOT EXISTS aipa_opportunity_feedback (
			opportunity_id VARCHAR(80) NOT NULL,
			user_id VARCHAR(255) NOT NULL,
			value VARCHAR(24) NOT NULL,
			created_at DATETIME(6) DEFAULT NOW(6),
			updated_at DATETIME(6) DEFAULT NOW(6) ON UPDATE NOW(6),
			PRIMARY KEY(opportunity_id,user_id),
			FOREIGN KEY (opportunity_id) REFERENCES aipa_opportunities(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS aipa_opportunity_deliveries (
			opportunity_id VARCHAR(80) PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			delivered_at DATETIME(6) DEFAULT NOW(6),
			INDEX idx_aipa_delivery_user_time(user_id,delivered_at),
			FOREIGN KEY (opportunity_id) REFERENCES aipa_opportunities(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS aipa_daily_briefs (
			user_id VARCHAR(255) NOT NULL,
			local_date DATE NOT NULL,
			brief_json JSON NOT NULL,
			generated_at DATETIME(6) DEFAULT NOW(6),
			PRIMARY KEY(user_id,local_date),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			panic(fmt.Sprintf("proactive migration: %v", err))
		}
	}
}

func defaultProactivePreferences() proactivePreferences {
	return proactivePreferences{
		Enabled: true, MeetingSuggestions: true, DailyPlanning: true,
		TaskSignals: true, ReplySignals: true, MeetingPrep: true, PostMeeting: true,
		QuietStart: "21:00", QuietEnd: "08:00", TimeZone: "Asia/Kolkata", DailyLimit: 6,
	}
}

func loadProactivePreferences(uid string) proactivePreferences {
	prefs := defaultProactivePreferences()
	var enabled, meetings, planning, tasks, replies, meetingPrep, postMeeting bool
	if err := db.QueryRow(`SELECT enabled,meeting_suggestions,daily_planning,task_signals,reply_signals,meeting_prep,post_meeting,
		quiet_start,quiet_end,timezone,daily_limit FROM aipa_proactive_preferences WHERE user_id=?`, uid).
		Scan(&enabled, &meetings, &planning, &tasks, &replies, &meetingPrep, &postMeeting,
			&prefs.QuietStart, &prefs.QuietEnd, &prefs.TimeZone, &prefs.DailyLimit); err == nil {
		prefs.Enabled = enabled
		prefs.MeetingSuggestions = meetings
		prefs.DailyPlanning = planning
		prefs.TaskSignals = tasks
		prefs.ReplySignals = replies
		prefs.MeetingPrep = meetingPrep
		prefs.PostMeeting = postMeeting
	}
	return prefs
}

func validClock(value string) bool {
	_, err := time.Parse("15:04", value)
	return err == nil
}

func proactiveMeetingSuggestionsEnabled(uid string) bool {
	prefs := loadProactivePreferences(uid)
	return prefs.Enabled && prefs.MeetingSuggestions
}

func handleProactivePreferences(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	switch r.Method {
	case http.MethodGet:
		ok(w, loadProactivePreferences(uid))
	case http.MethodPut:
		var prefs proactivePreferences
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&prefs) != nil {
			fail(w, "invalid proactive preferences", 400)
			return
		}
		if !validClock(prefs.QuietStart) || !validClock(prefs.QuietEnd) || prefs.DailyLimit < 1 || prefs.DailyLimit > 20 {
			fail(w, "quiet hours or daily limit are invalid", 400)
			return
		}
		prefs.TimeZone = validTimeZone(prefs.TimeZone)
		_, err := db.Exec(`INSERT INTO aipa_proactive_preferences
			(user_id,enabled,meeting_suggestions,daily_planning,task_signals,reply_signals,meeting_prep,post_meeting,quiet_start,quiet_end,timezone,daily_limit)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),meeting_suggestions=VALUES(meeting_suggestions),
			daily_planning=VALUES(daily_planning),task_signals=VALUES(task_signals),reply_signals=VALUES(reply_signals),
			meeting_prep=VALUES(meeting_prep),post_meeting=VALUES(post_meeting),quiet_start=VALUES(quiet_start),
			quiet_end=VALUES(quiet_end),timezone=VALUES(timezone),daily_limit=VALUES(daily_limit)`,
			uid, prefs.Enabled, prefs.MeetingSuggestions, prefs.DailyPlanning, prefs.TaskSignals, prefs.ReplySignals,
			prefs.MeetingPrep, prefs.PostMeeting, prefs.QuietStart, prefs.QuietEnd, prefs.TimeZone, prefs.DailyLimit)
		if err != nil {
			fail(w, "could not save proactive preferences", 500)
			return
		}
		if !prefs.MeetingSuggestions {
			_, _ = db.Exec(`UPDATE aipa_opportunities SET status='dismissed',action_token=NULL,updated_at=NOW(6)
				WHERE user_id=? AND status IN ('pending','snoozed') AND kind IN ('meeting_proposal','meeting_cancellation')`, uid)
		}
		if !prefs.DailyPlanning {
			_, _ = db.Exec(`UPDATE aipa_opportunities SET status='dismissed',updated_at=NOW(6)
				WHERE user_id=? AND status IN ('pending','snoozed') AND kind IN ('meeting_prep','calendar_invitation')`, uid)
		}
		if !prefs.TaskSignals {
			_, _ = db.Exec(`UPDATE aipa_opportunities SET status='dismissed',updated_at=NOW(6)
				WHERE user_id=? AND status IN ('pending','snoozed') AND kind IN ('task_due','reminder_due','task_proposal','reminder_proposal')`, uid)
		}
		if !prefs.ReplySignals {
			_, _ = db.Exec(`UPDATE aipa_opportunities SET status='dismissed',updated_at=NOW(6)
				WHERE user_id=? AND status IN ('pending','snoozed') AND kind='reply_needed'`, uid)
		}
		if !prefs.PostMeeting {
			_, _ = db.Exec(`UPDATE aipa_opportunities SET status='dismissed',updated_at=NOW(6)
				WHERE user_id=? AND status IN ('pending','snoozed') AND kind='meeting_followup'`, uid)
		}
		ok(w, prefs)
	default:
		fail(w, "method not allowed", 405)
	}
}

func opportunityFingerprint(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return hex.EncodeToString(sum[:])
}

func findOpportunityState(uid, dedupeKey string) (proactiveOpportunityState, error) {
	var state proactiveOpportunityState
	err := db.QueryRow(`SELECT id,fingerprint,status,result_ref FROM aipa_opportunities WHERE user_id=? AND dedupe_key=?`, uid, dedupeKey).
		Scan(&state.ID, &state.Fingerprint, &state.Status, &state.ResultRef)
	return state, err
}

// saveProactiveOpportunity returns changed=false when the same opportunity was
// already shown, completed, or dismissed. A materially changed signal (for
// example a newly proposed meeting time) reopens the same card instead of
// creating duplicates.
func saveProactiveOpportunity(uid, kind, title, summary, sourceType, sourceID, dedupeKey, fingerprint, actionLabel, actionToken string, confidence float64, priority int, metadata any, expiresAt time.Time) (proactiveOpportunityState, bool, error) {
	state, stateErr := findOpportunityState(uid, dedupeKey)
	if stateErr == nil && state.Fingerprint == fingerprint {
		return state, false, nil
	}
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return state, false, err
	}
	var expiry any
	if !expiresAt.IsZero() {
		expiry = expiresAt.UTC()
	}
	if stateErr == sql.ErrNoRows {
		state.ID = "opp-" + newID()
		_, err = db.Exec(`INSERT INTO aipa_opportunities
			(id,user_id,kind,title,summary,source_type,source_id,confidence,priority,action_label,action_token,metadata,fingerprint,dedupe_key,expires_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, state.ID, uid, kind, title, summary, sourceType, sourceID,
			confidence, priority, actionLabel, nullableString(actionToken), nullableJSON(metadataJSON), fingerprint, dedupeKey, expiry)
	} else if stateErr == nil {
		_, err = db.Exec(`UPDATE aipa_opportunities SET kind=?,title=?,summary=?,source_type=?,source_id=?,confidence=?,priority=?,
			action_label=?,action_token=?,metadata=?,fingerprint=?,status='pending',snoozed_until=NULL,expires_at=?,updated_at=NOW(6)
			WHERE id=? AND user_id=?`, kind, title, summary, sourceType, sourceID, confidence, priority, actionLabel,
			nullableString(actionToken), nullableJSON(metadataJSON), fingerprint, expiry, state.ID, uid)
	} else {
		return state, false, stateErr
	}
	if err != nil {
		return state, false, err
	}
	state.Fingerprint = fingerprint
	state.Status = "pending"
	return state, true, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableJSON(value []byte) any {
	if len(value) == 0 || string(value) == "null" {
		return nil
	}
	return string(value)
}

func queryProactiveOpportunities(uid string, limit int) ([]proactiveOpportunity, error) {
	if limit < 1 || limit > 50 {
		limit = 20
	}
	_, _ = db.Exec(`UPDATE aipa_opportunities SET status='pending',snoozed_until=NULL
		WHERE user_id=? AND status='snoozed' AND snoozed_until<=UTC_TIMESTAMP(6)`, uid)
	rows, err := db.Query(`SELECT o.id,o.kind,o.title,o.summary,o.source_type,o.source_id,o.confidence,o.priority,o.action_label,
		COALESCE(o.action_token,''),o.metadata,o.status,o.result_ref,COALESCE(f.value,''),
		DATE_FORMAT(o.created_at,'%Y-%m-%dT%H:%i:%sZ'),DATE_FORMAT(o.updated_at,'%Y-%m-%dT%H:%i:%sZ')
		FROM aipa_opportunities o LEFT JOIN aipa_opportunity_feedback f ON f.opportunity_id=o.id AND f.user_id=o.user_id
		WHERE o.user_id=? AND o.status='pending'
		AND (o.expires_at IS NULL OR o.expires_at>UTC_TIMESTAMP(6))
		ORDER BY o.priority DESC,o.updated_at DESC LIMIT ?`, uid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []proactiveOpportunity{}
	for rows.Next() {
		var item proactiveOpportunity
		var metadata sql.NullString
		if rows.Scan(&item.ID, &item.Kind, &item.Title, &item.Summary, &item.SourceType, &item.SourceID,
			&item.Confidence, &item.Priority, &item.ActionLabel, &item.ConfirmationToken, &metadata, &item.Status,
			&item.ResultRef, &item.Feedback, &item.CreatedAt, &item.UpdatedAt) != nil {
			continue
		}
		if metadata.Valid && metadata.String != "" && metadata.String != "null" {
			var proposal CalendarActionProposal
			if json.Unmarshal([]byte(metadata.String), &proposal) == nil && proposal.Action != "" {
				item.ProposedAction = &proposal
			}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func handleProactiveOpportunities(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	if r.Method != http.MethodGet {
		fail(w, "method not allowed", 405)
		return
	}
	prefs := loadProactivePreferences(uid)
	if !prefs.Enabled {
		ok(w, map[string]any{"opportunities": []proactiveOpportunity{}})
		return
	}
	if prefs.DailyPlanning {
		refreshCalendarOpportunities(uid)
	}
	refreshWorkOpportunities(uid, prefs)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := queryProactiveOpportunities(uid, limit)
	if err != nil {
		fail(w, "could not load proactive opportunities", 500)
		return
	}
	ok(w, map[string]any{"opportunities": items})
}

func handleProactiveOpportunityAction(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	if r.Method != http.MethodPost {
		fail(w, "method not allowed", 405)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/ai/opportunities/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" {
		fail(w, "not found", 404)
		return
	}
	id, action := parts[0], parts[1]
	var result sql.Result
	switch action {
	case "dismiss":
		result, err = db.Exec(`UPDATE aipa_opportunities SET status='dismissed',action_token=NULL,updated_at=NOW(6) WHERE id=? AND user_id=? AND status IN ('pending','snoozed')`, id, uid)
	case "snooze":
		var input struct {
			Minutes int `json:"minutes"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input) != nil {
			input.Minutes = 60
		}
		if input.Minutes < 15 || input.Minutes > 7*24*60 {
			fail(w, "snooze must be between 15 minutes and 7 days", 400)
			return
		}
		until := time.Now().UTC().Add(time.Duration(input.Minutes) * time.Minute)
		result, err = db.Exec(`UPDATE aipa_opportunities SET status='snoozed',snoozed_until=?,updated_at=NOW(6) WHERE id=? AND user_id=? AND status='pending'`, until, id, uid)
	case "complete":
		result, err = db.Exec(`UPDATE aipa_opportunities SET status='completed',action_token=NULL,updated_at=NOW(6) WHERE id=? AND user_id=? AND status IN ('pending','snoozed')`, id, uid)
	case "accept":
		if err := acceptProactiveOpportunity(uid, id); err != nil {
			if err == sql.ErrNoRows {
				fail(w, "opportunity not found", 404)
			} else {
				fail(w, err.Error(), 400)
			}
			return
		}
		ok(w, map[string]bool{"ok": true})
		return
	case "feedback":
		var input struct {
			Value string `json:"value"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input) != nil ||
			(input.Value != "helpful" && input.Value != "not_relevant") {
			fail(w, "feedback must be helpful or not_relevant", 400)
			return
		}
		var exists int
		if db.QueryRow(`SELECT 1 FROM aipa_opportunities WHERE id=? AND user_id=?`, id, uid).Scan(&exists) != nil {
			fail(w, "opportunity not found", 404)
			return
		}
		_, err = db.Exec(`INSERT INTO aipa_opportunity_feedback(opportunity_id,user_id,value) VALUES(?,?,?)
			ON DUPLICATE KEY UPDATE value=VALUES(value),updated_at=NOW(6)`, id, uid, input.Value)
		if err != nil {
			fail(w, "could not save feedback", 500)
			return
		}
		ok(w, map[string]bool{"ok": true})
		return
	default:
		fail(w, "unsupported opportunity action", 400)
		return
	}
	if err != nil {
		fail(w, "could not update opportunity", 500)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		fail(w, "opportunity not found", 404)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

type taskProposalMetadata struct {
	ThreadID        string `json:"threadId"`
	SourceMessageID string `json:"sourceMessageId"`
	Description     string `json:"description"`
	OwnerUserID     string `json:"ownerUserId,omitempty"`
	CreatedBy       string `json:"createdBy"`
}

type reminderProposalMetadata struct {
	ThreadID string `json:"threadId"`
	Text     string `json:"text"`
}

func acceptProactiveOpportunity(uid, opportunityID string) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("could not begin confirmation")
	}
	defer tx.Rollback() //nolint
	var kind, metadata, status string
	if err := tx.QueryRow(`SELECT kind,COALESCE(metadata,'{}'),status FROM aipa_opportunities
		WHERE id=? AND user_id=? FOR UPDATE`, opportunityID, uid).Scan(&kind, &metadata, &status); err != nil {
		return err
	}
	if status != "pending" && status != "snoozed" {
		return fmt.Errorf("opportunity is no longer actionable")
	}
	resultRef := ""
	switch kind {
	case "task_proposal":
		var proposal taskProposalMetadata
		if json.Unmarshal([]byte(metadata), &proposal) != nil || proposal.ThreadID == "" || strings.TrimSpace(proposal.Description) == "" || proposal.CreatedBy != uid {
			return fmt.Errorf("task proposal is invalid")
		}
		var member int
		if tx.QueryRow(`SELECT 1 FROM thread_members WHERE thread_id=? AND user_id=?`, proposal.ThreadID, uid).Scan(&member) != nil {
			return fmt.Errorf("you no longer have access to this conversation")
		}
		resultRef = newID()
		var owner any
		if proposal.OwnerUserID != "" {
			owner = proposal.OwnerUserID
		}
		if _, err := tx.Exec(`INSERT INTO ai_tasks(id,thread_id,source_message_id,description,owner_user_id,created_by)
			VALUES(?,?,?,?,?,?)`, resultRef, proposal.ThreadID, nullableString(proposal.SourceMessageID), proposal.Description, owner, uid); err != nil {
			return fmt.Errorf("could not create task")
		}
	case "reminder_proposal":
		var proposal reminderProposalMetadata
		if json.Unmarshal([]byte(metadata), &proposal) != nil || proposal.ThreadID == "" || strings.TrimSpace(proposal.Text) == "" {
			return fmt.Errorf("reminder proposal is invalid")
		}
		var member int
		if tx.QueryRow(`SELECT 1 FROM thread_members WHERE thread_id=? AND user_id=?`, proposal.ThreadID, uid).Scan(&member) != nil {
			return fmt.Errorf("you no longer have access to this conversation")
		}
		resultRef = newID()
		if _, err := tx.Exec(`INSERT INTO ai_reminders(id,user_id,thread_id,text) VALUES(?,?,?,?)`, resultRef, uid, proposal.ThreadID, proposal.Text); err != nil {
			return fmt.Errorf("could not create reminder")
		}
	default:
		return fmt.Errorf("this suggestion does not have a confirmable action")
	}
	if _, err := tx.Exec(`UPDATE aipa_opportunities SET status='completed',result_ref=?,action_token=NULL,updated_at=NOW(6)
		WHERE id=? AND user_id=?`, resultRef, opportunityID, uid); err != nil {
		return fmt.Errorf("could not complete confirmation")
	}
	return tx.Commit()
}

func createTaskProposal(uid, threadID, sourceMessageID, description, ownerUserID string) {
	prefs := loadProactivePreferences(uid)
	if !prefs.Enabled || !prefs.TaskSignals || strings.TrimSpace(description) == "" {
		return
	}
	metadata := taskProposalMetadata{ThreadID: threadID, SourceMessageID: sourceMessageID, Description: description, OwnerUserID: ownerUserID, CreatedBy: uid}
	dedupeKey := "task-proposal:" + threadID + ":" + sourceMessageID + ":" + opportunityFingerprint(description)
	fingerprint := opportunityFingerprint(dedupeKey, ownerUserID)
	state, changed, err := saveProactiveOpportunity(uid, "task_proposal", "Review a task AIPA found", description,
		"thread", threadID, dedupeKey, fingerprint, "Add task", "", 0.88, 70, metadata, time.Now().Add(14*24*time.Hour))
	if err == nil && changed {
		deliverProactiveOpportunity(uid, state.ID, "task_proposal", "AIPA found a task to review")
	}
}

func createReminderProposal(uid, threadID, sourceMessageID, text string) {
	prefs := loadProactivePreferences(uid)
	if !prefs.Enabled || !prefs.TaskSignals || strings.TrimSpace(text) == "" {
		return
	}
	metadata := reminderProposalMetadata{ThreadID: threadID, Text: text}
	dedupeKey := "reminder-proposal:" + threadID + ":" + sourceMessageID + ":" + opportunityFingerprint(text)
	fingerprint := opportunityFingerprint(dedupeKey)
	state, changed, err := saveProactiveOpportunity(uid, "reminder_proposal", "Review a reminder AIPA found", text,
		"thread", threadID, dedupeKey, fingerprint, "Add reminder", "", 0.88, 68, metadata, time.Now().Add(14*24*time.Hour))
	if err == nil && changed {
		deliverProactiveOpportunity(uid, state.ID, "reminder_proposal", "AIPA found a reminder to review")
	}
}

func inQuietHours(prefs proactivePreferences, now time.Time) bool {
	location, err := time.LoadLocation(validTimeZone(prefs.TimeZone))
	if err != nil {
		location = time.UTC
	}
	localClock := now.In(location).Format("15:04")
	if prefs.QuietStart == prefs.QuietEnd {
		return false
	}
	if prefs.QuietStart < prefs.QuietEnd {
		return localClock >= prefs.QuietStart && localClock < prefs.QuietEnd
	}
	return localClock >= prefs.QuietStart || localClock < prefs.QuietEnd
}

// deliverProactiveOpportunity controls realtime interruption only. The durable
// card is always available in AIPA Now, including during quiet hours.
func deliverProactiveOpportunity(uid, opportunityID, kind, title string) {
	prefs := loadProactivePreferences(uid)
	if !prefs.Enabled || inQuietHours(prefs, time.Now()) {
		return
	}
	location, err := time.LoadLocation(validTimeZone(prefs.TimeZone))
	if err != nil {
		location = time.UTC
	}
	localNow := time.Now().In(location)
	startLocal := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	var delivered int
	_ = db.QueryRow(`SELECT COUNT(*) FROM aipa_opportunity_deliveries WHERE user_id=? AND delivered_at>=?`, uid, startLocal.UTC()).Scan(&delivered)
	if delivered >= prefs.DailyLimit {
		return
	}
	result, err := db.Exec(`INSERT IGNORE INTO aipa_opportunity_deliveries(opportunity_id,user_id) VALUES(?,?)`, opportunityID, uid)
	if err != nil {
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return
	}
	pushTo([]string{uid}, "aipa_opportunity", map[string]any{"id": opportunityID, "kind": kind, "title": title})
}

func completeOpportunityForCalendarToken(uid, token, resultRef, status string) {
	if status == "" {
		status = "completed"
	}
	_, _ = db.Exec(`UPDATE aipa_opportunities SET status=?,result_ref=?,action_token=NULL,updated_at=NOW(6)
		WHERE user_id=? AND action_token=?`, status, resultRef, uid, token)
}

func proactiveUserTimeZone(uid string) string {
	var timezone string
	if db.QueryRow(`SELECT timezone FROM calendar_working_hours WHERE user_id=?`, uid).Scan(&timezone) == nil {
		return validTimeZone(timezone)
	}
	if db.QueryRow(`SELECT timezone FROM calendars WHERE owner_id=? AND is_default=1 LIMIT 1`, uid).Scan(&timezone) == nil {
		return validTimeZone(timezone)
	}
	return "Asia/Kolkata"
}

func refreshCalendarOpportunities(uid string) {
	prefs := loadProactivePreferences(uid)
	now := time.Now()
	events, err := queryCalendarEvents(uid, now.Add(-15*time.Minute), now.Add(24*time.Hour), "", "")
	if err != nil {
		return
	}
	created := 0
	for _, event := range events {
		if created >= 4 || event.AllDay || (event.MeetingCode == "" && len(event.Attendees) == 0) {
			continue
		}
		kind := "meeting_prep"
		title := "Prepare for " + event.Title
		summary := fmt.Sprintf("Starts %s at %s", event.Date, event.StartTime)
		if len(event.Attendees) > 0 {
			names := make([]string, 0, len(event.Attendees))
			for _, attendee := range event.Attendees {
				if attendee.UserID != uid && attendee.DisplayName != "" {
					names = append(names, attendee.DisplayName)
				}
				if len(names) == 3 {
					break
				}
			}
			if len(names) > 0 {
				summary += " · with " + strings.Join(names, ", ")
			}
		}
		if event.Location != "" {
			summary += " · " + trimBriefText(event.Location, 80)
		}
		priority := 55
		if event.ResponseStatus == "needs_action" {
			kind = "calendar_invitation"
			title = "Respond to " + event.Title
			summary = fmt.Sprintf("Your response is needed before %s at %s", event.Date, event.StartTime)
			priority = 75
		} else if !prefs.MeetingPrep {
			continue
		}
		fingerprint := opportunityFingerprint(kind, event.ID, event.Date, event.StartTime, strconv.Itoa(event.Version))
		dedupeKey := kind + ":" + event.ID
		state, changed, saveErr := saveProactiveOpportunity(uid, kind, title, summary, "calendar_event", event.ID,
			dedupeKey, fingerprint, "Open calendar", "", 1, priority, map[string]string{"eventId": event.ID}, event.endUTC)
		if saveErr == nil && changed {
			deliverProactiveOpportunity(uid, state.ID, kind, title)
		}
		created++
	}
}

func refreshWorkOpportunities(uid string, prefs proactivePreferences) {
	if prefs.TaskSignals {
		refreshTaskOpportunities(uid)
		refreshReminderOpportunities(uid)
	}
	if prefs.ReplySignals {
		refreshReplyOpportunities(uid)
	}
}

func refreshTaskOpportunities(uid string) {
	rows, err := db.Query(`SELECT id,thread_id,description,due_at,created_at FROM ai_tasks
		WHERE status='pending' AND (owner_user_id=? OR created_by=?)
		AND ((due_at IS NOT NULL AND due_at<=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 24 HOUR))
			OR (due_at IS NULL AND created_at<=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 3 DAY)))
		ORDER BY COALESCE(due_at,created_at) LIMIT 8`, uid, uid)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, threadID, description string
		var due sql.NullTime
		var created time.Time
		if rows.Scan(&id, &threadID, &description, &due, &created) != nil {
			continue
		}
		title := "Review an open task"
		summary := trimBriefText(description, 240)
		priority := 45
		if due.Valid {
			if due.Time.Before(time.Now().UTC()) {
				title = "Task is overdue"
				priority = 90
			} else {
				title = "Task is due soon"
				priority = 80
			}
			summary = fmt.Sprintf("%s · due %s", summary, due.Time.UTC().Format("2 Jan, 15:04 UTC"))
		} else {
			summary = fmt.Sprintf("%s · open since %s", summary, created.UTC().Format("2 Jan"))
		}
		fingerprint := opportunityFingerprint(id, description, title)
		state, changed, saveErr := saveProactiveOpportunity(uid, "task_due", title, summary, "thread", threadID,
			"task-due:"+id, fingerprint, "Open conversation", "", 1, priority, map[string]string{"taskId": id}, time.Now().Add(7*24*time.Hour))
		if saveErr == nil && changed {
			deliverProactiveOpportunity(uid, state.ID, "task_due", title)
		}
	}
}

func refreshReminderOpportunities(uid string) {
	rows, err := db.Query(`SELECT id,COALESCE(thread_id,''),text,remind_at,created_at FROM ai_reminders
		WHERE user_id=? AND status='pending'
		AND ((remind_at IS NOT NULL AND remind_at<=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 24 HOUR))
			OR (remind_at IS NULL AND created_at<=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 3 DAY)))
		ORDER BY COALESCE(remind_at,created_at) LIMIT 8`, uid)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, threadID, reminderText string
		var remindAt sql.NullTime
		var created time.Time
		if rows.Scan(&id, &threadID, &reminderText, &remindAt, &created) != nil {
			continue
		}
		title := "A reminder is waiting"
		priority := 50
		if remindAt.Valid {
			if remindAt.Time.Before(time.Now().UTC()) {
				title = "Reminder is overdue"
				priority = 85
			} else {
				title = "Reminder is due soon"
				priority = 78
			}
		}
		fingerprint := opportunityFingerprint(id, reminderText, title)
		state, changed, saveErr := saveProactiveOpportunity(uid, "reminder_due", title, trimBriefText(reminderText, 260), "thread", threadID,
			"reminder-due:"+id, fingerprint, "Review reminder", "", 1, priority, map[string]string{"reminderId": id}, time.Now().Add(7*24*time.Hour))
		if saveErr == nil && changed {
			deliverProactiveOpportunity(uid, state.ID, "reminder_due", title)
		}
	}
}

func refreshReplyOpportunities(uid string) {
	rows, err := db.Query(`SELECT t.id,t.name,m.id,COALESCE(u.display_name,'Someone'),m.created_at
		FROM thread_members tm JOIN threads t ON t.id=tm.thread_id
		JOIN messages m ON m.thread_id=t.id LEFT JOIN users u ON u.id=m.sender_id
		WHERE tm.user_id=? AND m.sender_id<>? AND m.created_at<=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 4 HOUR)
		AND m.created_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 7 DAY)
		AND (tm.last_read_at IS NULL OR m.created_at>tm.last_read_at)
		AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.thread_id=m.thread_id AND newer.created_at>m.created_at)
		ORDER BY m.created_at ASC LIMIT 5`, uid, uid)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, threadName, messageID, senderName string
		var created time.Time
		if rows.Scan(&threadID, &threadName, &messageID, &senderName, &created) != nil {
			continue
		}
		summary := fmt.Sprintf("%s sent the latest unread message in %s on %s.", senderName, threadName, created.UTC().Format("2 Jan at 15:04 UTC"))
		state, changed, saveErr := saveProactiveOpportunity(uid, "reply_needed", "A reply may be waiting", summary, "thread", threadID,
			"reply-needed:"+threadID+":"+messageID, opportunityFingerprint(messageID), "Reply now", "", 1, 65,
			map[string]string{"messageId": messageID}, created.Add(8*24*time.Hour))
		if saveErr == nil && changed {
			deliverProactiveOpportunity(uid, state.ID, "reply_needed", "A reply may be waiting")
		}
	}
}

// createPostMeetingOpportunities is called after the empty-room grace period,
// so reconnects do not produce false "meeting ended" cards.
func createPostMeetingOpportunities(roomID string) {
	var transcriptCount int
	_ = db.QueryRow(`SELECT COUNT(*) FROM meeting_transcripts WHERE room_id=?`, roomID).Scan(&transcriptCount)
	rows, err := db.Query(`SELECT DISTINCT mp.user_id FROM meeting_participants mp JOIN users u ON u.id=mp.user_id WHERE mp.room_id=?`, roomID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var uid string
		if rows.Scan(&uid) != nil {
			continue
		}
		prefs := loadProactivePreferences(uid)
		if !prefs.Enabled || !prefs.PostMeeting {
			continue
		}
		summary := "Review participants and meeting details while they are still fresh."
		if transcriptCount > 0 {
			summary = fmt.Sprintf("%d transcript lines are ready for minutes, decisions, and follow-ups.", transcriptCount)
		}
		state, changed, saveErr := saveProactiveOpportunity(uid, "meeting_followup", "Turn the meeting into action", summary,
			"meeting", roomID, "meeting-followup:"+roomID, opportunityFingerprint(roomID, strconv.Itoa(transcriptCount)),
			"Review meeting", "", 1, 72, map[string]string{"roomId": roomID}, time.Now().Add(14*24*time.Hour))
		if saveErr == nil && changed {
			deliverProactiveOpportunity(uid, state.ID, "meeting_followup", "Your meeting follow-up is ready")
		}
	}
}

func refreshProactiveUsers() {
	rows, err := db.Query(`SELECT id FROM users ORDER BY id`)
	if err != nil {
		return
	}
	var userIDs []string
	for rows.Next() {
		var uid string
		if rows.Scan(&uid) == nil {
			userIDs = append(userIDs, uid)
		}
	}
	rows.Close()
	for _, uid := range userIDs {
		prefs := loadProactivePreferences(uid)
		if !prefs.Enabled {
			continue
		}
		if prefs.DailyPlanning {
			refreshCalendarOpportunities(uid)
		}
		refreshWorkOpportunities(uid, prefs)
	}
}

func startProactiveTicker() {
	go func() {
		timer := time.NewTimer(30 * time.Second)
		defer timer.Stop()
		<-timer.C
		refreshProactiveUsers()
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			refreshProactiveUsers()
		}
	}()
}
