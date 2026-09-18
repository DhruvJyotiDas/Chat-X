package main

// Server-authoritative calendar domain. Calendar data used to live only in
// localStorage while scheduled meetings lived in an unrelated table. This
// module provides one permission-checked source of truth for personal/shared
// calendars, events, invitations, responses, availability and reminders.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultCalendarColor = "#6ea8ff"

type Calendar struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	TimeZone    string `json:"timeZone"`
	OwnerID     string `json:"ownerId"`
	Role        string `json:"role"`
	IsDefault   bool   `json:"isDefault"`
	MemberCount int    `json:"memberCount"`
}

type CalendarAttendee struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Response    string `json:"response"`
}

type CalendarEventRecord struct {
	ID              string             `json:"id"`
	SeriesID        string             `json:"seriesId,omitempty"`
	CalendarID      string             `json:"calendarId"`
	CalendarName    string             `json:"calendarName"`
	Title           string             `json:"title"`
	Description     string             `json:"description"`
	Location        string             `json:"location"`
	Date            string             `json:"date"`
	StartTime       string             `json:"startTime"`
	EndTime         string             `json:"endTime"`
	AllDay          bool               `json:"allDay"`
	TimeZone        string             `json:"timeZone"`
	Recurrence      string             `json:"recurrence,omitempty"`
	Color           string             `json:"color"`
	CreatorID       string             `json:"creatorId"`
	OrganizerID     string             `json:"organizerId"`
	MeetingCode     string             `json:"meetingCode,omitempty"`
	ReminderMinutes int                `json:"reminderMinutes"`
	ResponseStatus  string             `json:"responseStatus"`
	CanEdit         bool               `json:"canEdit"`
	Version         int                `json:"version"`
	Attendees       []CalendarAttendee `json:"attendees"`
	startUTC        time.Time
	endUTC          time.Time
}

type CalendarEventInput struct {
	CalendarID      string   `json:"calendarId"`
	Title           string   `json:"title"`
	Description     string   `json:"description"`
	Location        string   `json:"location"`
	Date            string   `json:"date"`
	StartTime       string   `json:"startTime"`
	EndTime         string   `json:"endTime"`
	AllDay          bool     `json:"allDay"`
	TimeZone        string   `json:"timeZone"`
	Recurrence      string   `json:"recurrence"`
	AttendeeIDs     []string `json:"attendeeIds"`
	ReminderMinutes int      `json:"reminderMinutes"`
	MeetingCode     string   `json:"meetingCode"`
}

type WorkingHours struct {
	TimeZone  string `json:"timeZone"`
	Days      []int  `json:"days"`
	StartTime string `json:"startTime"`
	EndTime   string `json:"endTime"`
}

type CalendarActionProposal struct {
	Action        string   `json:"action"`
	EventID       string   `json:"eventId,omitempty"`
	Title         string   `json:"title"`
	Date          string   `json:"date"`
	StartTime     string   `json:"startTime"`
	EndTime       string   `json:"endTime"`
	TimeZone      string   `json:"timeZone"`
	AttendeeIDs   []string `json:"attendeeIds,omitempty"`
	AttendeeNames []string `json:"attendeeNames,omitempty"`
	Warning       string   `json:"warning,omitempty"`
}

func migrateCalendar() {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS calendars (
			id VARCHAR(64) PRIMARY KEY, owner_id VARCHAR(255) NOT NULL, name VARCHAR(160) NOT NULL,
			color VARCHAR(16) NOT NULL DEFAULT '#6ea8ff', timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
			is_default TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(6) DEFAULT NOW(6), updated_at DATETIME(6) DEFAULT NOW(6),
			INDEX idx_cal_owner (owner_id), FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS calendar_members (
			calendar_id VARCHAR(64) NOT NULL, user_id VARCHAR(255) NOT NULL, role VARCHAR(16) NOT NULL DEFAULT 'viewer',
			created_at DATETIME(6) DEFAULT NOW(6), PRIMARY KEY(calendar_id,user_id), INDEX idx_cal_member_user(user_id),
			FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS calendar_events (
			id VARCHAR(64) PRIMARY KEY, calendar_id VARCHAR(64) NOT NULL, creator_id VARCHAR(255) NOT NULL,
			organizer_id VARCHAR(255) NOT NULL, title VARCHAR(255) NOT NULL, description TEXT, location VARCHAR(500),
			start_at DATETIME(6) NOT NULL, end_at DATETIME(6) NOT NULL, all_day TINYINT(1) NOT NULL DEFAULT 0,
			timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata', recurrence VARCHAR(120) NOT NULL DEFAULT '',
			meeting_code VARCHAR(255) NOT NULL DEFAULT '', reminder_minutes INT NOT NULL DEFAULT 10,
			status VARCHAR(16) NOT NULL DEFAULT 'confirmed', version INT NOT NULL DEFAULT 1,
			created_at DATETIME(6) DEFAULT NOW(6), updated_at DATETIME(6) DEFAULT NOW(6),
			INDEX idx_cal_event_range(calendar_id,start_at,end_at), INDEX idx_cal_event_organizer(organizer_id,start_at),
			FULLTEXT INDEX ft_cal_event_search(title,description,location),
			FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE,
			FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS calendar_event_attendees (
			event_id VARCHAR(64) NOT NULL, user_id VARCHAR(255) NOT NULL, response VARCHAR(20) NOT NULL DEFAULT 'needs_action',
			invited_at DATETIME(6) DEFAULT NOW(6), responded_at DATETIME(6) NULL,
			PRIMARY KEY(event_id,user_id), INDEX idx_cal_attendee_user(user_id,response),
			FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS calendar_working_hours (
			user_id VARCHAR(255) PRIMARY KEY, timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
			working_days JSON NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL, updated_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS calendar_reminders (
			id VARCHAR(80) PRIMARY KEY, event_id VARCHAR(64) NOT NULL, user_id VARCHAR(255) NOT NULL,
			occurrence_start DATETIME(6) NOT NULL, scheduled_at DATETIME(6) NOT NULL,
			delivered_at DATETIME(6) NULL, read_at DATETIME(6) NULL,
			INDEX idx_cal_reminder_due(scheduled_at,delivered_at), INDEX idx_cal_reminder_user(user_id,read_at),
			FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS calendar_action_proposals (
			id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(255) NOT NULL, action VARCHAR(24) NOT NULL, payload JSON NOT NULL,
			expires_at DATETIME(6) NOT NULL, consumed_at DATETIME(6) NULL, created_at DATETIME(6) DEFAULT NOW(6),
			INDEX idx_cal_action_user(user_id,expires_at), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			log.Fatalf("calendar migration: %v", err)
		}
	}
	// Existing accounts get a private default calendar without requiring a
	// login-time mutation. INSERT IGNORE keeps startup idempotent.
	if _, err := db.Exec(`INSERT IGNORE INTO calendars(id,owner_id,name,color,timezone,is_default)
		SELECT CONCAT('cal-',LEFT(SHA2(CONCAT('personal:',id),256),24)),id,'My calendar','#6ea8ff','Asia/Kolkata',1 FROM users`); err != nil {
		log.Fatalf("calendar defaults: %v", err)
	}
	if _, err := db.Exec(`INSERT IGNORE INTO calendar_members(calendar_id,user_id,role)
		SELECT id,owner_id,'owner' FROM calendars`); err != nil {
		log.Fatalf("calendar owner memberships: %v", err)
	}
	log.Println("[DB] calendar schema OK")
}

func ensureDefaultCalendar(uid, timezone string) (string, error) {
	var id string
	err := db.QueryRow(`SELECT id FROM calendars WHERE owner_id=? AND is_default=1 LIMIT 1`, uid).Scan(&id)
	if err == nil {
		return id, nil
	}
	if timezone == "" {
		timezone = "Asia/Kolkata"
	}
	id = "cal-" + newID()
	tx, err := db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint
	if _, err = tx.Exec(`INSERT INTO calendars(id,owner_id,name,color,timezone,is_default) VALUES(?,?,?,'#6ea8ff',?,1)`, id, uid, "My calendar", timezone); err != nil {
		return "", err
	}
	if _, err = tx.Exec(`INSERT INTO calendar_members(calendar_id,user_id,role) VALUES(?,?,'owner')`, id, uid); err != nil {
		return "", err
	}
	return id, tx.Commit()
}

func validTimeZone(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Asia/Kolkata"
	}
	if _, err := time.LoadLocation(name); err != nil {
		return "Asia/Kolkata"
	}
	return name
}

func parseLocalDateTime(date, clock, timezone string) (time.Time, error) {
	location, err := time.LoadLocation(validTimeZone(timezone))
	if err != nil {
		return time.Time{}, err
	}
	if len(clock) == 5 {
		clock += ":00"
	}
	return time.ParseInLocation("2006-01-02 15:04:05", date+" "+clock, location)
}

func calendarRole(calendarID, uid string) string {
	var role string
	_ = db.QueryRow(`SELECT role FROM calendar_members WHERE calendar_id=? AND user_id=?`, calendarID, uid).Scan(&role)
	return role
}

func canEditCalendar(role string) bool { return role == "owner" || role == "editor" }

func normalizeEventInput(input *CalendarEventInput) error {
	input.Title = strings.TrimSpace(input.Title)
	input.Description = strings.TrimSpace(input.Description)
	input.Location = strings.TrimSpace(input.Location)
	input.TimeZone = validTimeZone(input.TimeZone)
	input.Recurrence = strings.ToUpper(strings.TrimSpace(input.Recurrence))
	if input.Title == "" || len(input.Title) > 255 {
		return fmt.Errorf("title is required and must be 255 characters or fewer")
	}
	if len(input.Description) > 12000 || len(input.Location) > 500 {
		return fmt.Errorf("description or location is too long")
	}
	if input.AllDay {
		input.StartTime, input.EndTime = "00:00", "23:59"
	}
	start, err := parseLocalDateTime(input.Date, input.StartTime, input.TimeZone)
	if err != nil {
		return fmt.Errorf("invalid event date or start time")
	}
	end, err := parseLocalDateTime(input.Date, input.EndTime, input.TimeZone)
	if err != nil || !end.After(start) {
		return fmt.Errorf("end time must be after start time")
	}
	if input.Recurrence != "" && input.Recurrence != "DAILY" && input.Recurrence != "WEEKLY" && input.Recurrence != "WEEKDAYS" && input.Recurrence != "MONTHLY" {
		return fmt.Errorf("unsupported recurrence")
	}
	if input.ReminderMinutes < 0 || input.ReminderMinutes > 10080 {
		return fmt.Errorf("reminder must be between 0 and 10080 minutes")
	}
	return nil
}

func uniqueUserIDs(ids []string, exclude string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || id == exclude || seen[id] {
			continue
		}
		var exists int
		if db.QueryRow(`SELECT COUNT(*) FROM users WHERE id=?`, id).Scan(&exists) == nil && exists == 1 {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func eventOccurrences(start, end, rangeStart, rangeEnd time.Time, recurrence string, limit int) [][2]time.Time {
	var occurrences [][2]time.Time
	duration := end.Sub(start)
	current := start
	// Jump close to the requested range so an old daily series does not spend
	// its expansion budget walking years of invisible occurrences.
	if current.Add(duration).Before(rangeStart) {
		switch recurrence {
		case "DAILY", "WEEKDAYS":
			days := int(rangeStart.Sub(current).Hours()/24) - 2
			if days > 0 {
				current = current.AddDate(0, 0, days)
			}
			for recurrence == "WEEKDAYS" && (current.Weekday() == time.Saturday || current.Weekday() == time.Sunday) {
				current = current.AddDate(0, 0, 1)
			}
		case "WEEKLY":
			weeks := int(rangeStart.Sub(current).Hours()/(24*7)) - 1
			if weeks > 0 {
				current = current.AddDate(0, 0, weeks*7)
			}
		case "MONTHLY":
			for current.Add(duration).Before(rangeStart) {
				current = current.AddDate(0, 1, 0)
			}
		}
	}
	for i := 0; i < limit && current.Before(rangeEnd); i++ {
		currentEnd := current.Add(duration)
		if current.Before(rangeEnd) && currentEnd.After(rangeStart) {
			occurrences = append(occurrences, [2]time.Time{current, currentEnd})
		}
		switch recurrence {
		case "DAILY":
			current = current.AddDate(0, 0, 1)
		case "WEEKLY":
			current = current.AddDate(0, 0, 7)
		case "WEEKDAYS":
			current = current.AddDate(0, 0, 1)
			for current.Weekday() == time.Saturday || current.Weekday() == time.Sunday {
				current = current.AddDate(0, 0, 1)
			}
		case "MONTHLY":
			current = current.AddDate(0, 1, 0)
		default:
			return occurrences
		}
	}
	return occurrences
}

func loadEventAttendees(eventID string) []CalendarAttendee {
	rows, err := db.Query(`SELECT a.user_id,u.display_name,u.email,a.response
		FROM calendar_event_attendees a JOIN users u ON u.id=a.user_id WHERE a.event_id=? ORDER BY u.display_name`, eventID)
	if err != nil {
		return []CalendarAttendee{}
	}
	defer rows.Close()
	out := []CalendarAttendee{}
	for rows.Next() {
		var attendee CalendarAttendee
		if rows.Scan(&attendee.UserID, &attendee.DisplayName, &attendee.Email, &attendee.Response) == nil {
			out = append(out, attendee)
		}
	}
	return out
}

func formatEventOccurrence(base CalendarEventRecord, start, end time.Time, occurrence bool, uid string) CalendarEventRecord {
	location, _ := time.LoadLocation(validTimeZone(base.TimeZone))
	localStart := start.In(location)
	localEnd := end.In(location)
	base.startUTC, base.endUTC = start.UTC(), end.UTC()
	base.Date = localStart.Format("2006-01-02")
	base.StartTime = localStart.Format("15:04")
	base.EndTime = localEnd.Format("15:04")
	if occurrence {
		base.SeriesID = base.ID
		base.ID = base.ID + "@" + localStart.Format("20060102T1504")
	}
	base.Attendees = loadEventAttendees(base.SeriesID)
	if base.SeriesID == "" {
		base.Attendees = loadEventAttendees(base.ID)
	}
	base.ResponseStatus = "accepted"
	for _, attendee := range base.Attendees {
		if attendee.UserID == uid {
			base.ResponseStatus = attendee.Response
		}
	}
	return base
}

func queryCalendarEvents(uid string, rangeStart, rangeEnd time.Time, query, calendarID string) ([]CalendarEventRecord, error) {
	args := []any{uid, uid}
	where := `ce.status='confirmed' AND (cm.user_id=? OR cea.user_id=?) AND (ce.start_at<? OR ce.recurrence<>'')`
	args = append(args, rangeEnd.UTC())
	if calendarID != "" {
		where += ` AND ce.calendar_id=?`
		args = append(args, calendarID)
	}
	if query != "" {
		where += ` AND (ce.title LIKE ? OR ce.description LIKE ? OR ce.location LIKE ?)`
		like := "%" + query + "%"
		args = append(args, like, like, like)
	}
	rows, err := db.Query(`SELECT DISTINCT ce.id,ce.calendar_id,c.name,ce.title,COALESCE(ce.description,''),
		COALESCE(ce.location,''),ce.start_at,ce.end_at,ce.all_day,ce.timezone,ce.recurrence,c.color,
		ce.creator_id,ce.organizer_id,ce.meeting_code,ce.reminder_minutes,ce.version,COALESCE(cm.role,'')
		FROM calendar_events ce JOIN calendars c ON c.id=ce.calendar_id
		LEFT JOIN calendar_members cm ON cm.calendar_id=ce.calendar_id AND cm.user_id=?
		LEFT JOIN calendar_event_attendees cea ON cea.event_id=ce.id AND cea.user_id=?
		WHERE `+where+` ORDER BY ce.start_at LIMIT 1000`, append([]any{uid, uid}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []CalendarEventRecord{}
	for rows.Next() {
		var event CalendarEventRecord
		var role string
		if err := rows.Scan(&event.ID, &event.CalendarID, &event.CalendarName, &event.Title, &event.Description,
			&event.Location, &event.startUTC, &event.endUTC, &event.AllDay, &event.TimeZone, &event.Recurrence,
			&event.Color, &event.CreatorID, &event.OrganizerID, &event.MeetingCode, &event.ReminderMinutes,
			&event.Version, &role); err != nil {
			continue
		}
		event.CanEdit = canEditCalendar(role) || event.OrganizerID == uid
		for _, occurrence := range eventOccurrences(event.startUTC, event.endUTC, rangeStart.UTC(), rangeEnd.UTC(), event.Recurrence, 800) {
			result = append(result, formatEventOccurrence(event, occurrence[0], occurrence[1], event.Recurrence != "", uid))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].startUTC.Before(result[j].startUTC) })
	return result, nil
}

func calendarRange(r *http.Request) (time.Time, time.Time, error) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" {
		from = time.Now().AddDate(0, -1, 0).Format("2006-01-02")
	}
	if to == "" {
		to = time.Now().AddDate(1, 1, 0).Format("2006-01-02")
	}
	start, err := time.Parse("2006-01-02", from)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("invalid from date")
	}
	end, err := time.Parse("2006-01-02", to)
	if err != nil || !end.After(start) || end.Sub(start) > 370*24*time.Hour {
		return time.Time{}, time.Time{}, fmt.Errorf("invalid date range")
	}
	return start, end.Add(24 * time.Hour), nil
}

func handleCalendarEvents(w http.ResponseWriter, r *http.Request, uid string) {
	switch r.Method {
	case http.MethodGet:
		start, end, err := calendarRange(r)
		if err != nil {
			fail(w, err.Error(), 400)
			return
		}
		events, err := queryCalendarEvents(uid, start, end, strings.TrimSpace(r.URL.Query().Get("q")), strings.TrimSpace(r.URL.Query().Get("calendarId")))
		if err != nil {
			log.Printf("calendar events query: %v", err)
			fail(w, "failed to load calendar", 500)
			return
		}
		ok(w, events)
	case http.MethodPost:
		var input CalendarEventInput
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&input); err != nil {
			fail(w, "invalid event", 400)
			return
		}
		if err := normalizeEventInput(&input); err != nil {
			fail(w, err.Error(), 400)
			return
		}
		if input.CalendarID == "" {
			input.CalendarID, _ = ensureDefaultCalendar(uid, input.TimeZone)
		}
		if !canEditCalendar(calendarRole(input.CalendarID, uid)) {
			fail(w, "you cannot add events to this calendar", 403)
			return
		}
		event, err := createCalendarEvent(uid, input)
		if err != nil {
			log.Printf("create calendar event: %v", err)
			fail(w, "failed to create event", 500)
			return
		}
		ok(w, event)
	default:
		fail(w, "method not allowed", 405)
	}
}

func createCalendarEvent(uid string, input CalendarEventInput) (CalendarEventRecord, error) {
	start, _ := parseLocalDateTime(input.Date, input.StartTime, input.TimeZone)
	end, _ := parseLocalDateTime(input.Date, input.EndTime, input.TimeZone)
	id := "evt-" + newID()
	attendees := uniqueUserIDs(input.AttendeeIDs, uid)
	tx, err := db.Begin()
	if err != nil {
		return CalendarEventRecord{}, err
	}
	defer tx.Rollback() //nolint
	_, err = tx.Exec(`INSERT INTO calendar_events(id,calendar_id,creator_id,organizer_id,title,description,location,start_at,end_at,all_day,timezone,recurrence,meeting_code,reminder_minutes)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.CalendarID, uid, uid, input.Title, input.Description, input.Location,
		start.UTC(), end.UTC(), input.AllDay, input.TimeZone, input.Recurrence, input.MeetingCode, input.ReminderMinutes)
	if err != nil {
		return CalendarEventRecord{}, err
	}
	for _, attendeeID := range attendees {
		if _, err = tx.Exec(`INSERT INTO calendar_event_attendees(event_id,user_id) VALUES(?,?)`, id, attendeeID); err != nil {
			return CalendarEventRecord{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return CalendarEventRecord{}, err
	}
	rebuildEventReminders(id)
	pushTo(attendees, "calendar_invitation", map[string]any{"eventId": id, "title": input.Title, "date": input.Date, "time": input.StartTime})
	return getCalendarEvent(uid, id)
}

func baseEventID(id string) string {
	if index := strings.IndexByte(id, '@'); index >= 0 {
		return id[:index]
	}
	return id
}

func getCalendarEvent(uid, eventID string) (CalendarEventRecord, error) {
	eventID = baseEventID(eventID)
	var event CalendarEventRecord
	var role string
	err := db.QueryRow(`SELECT ce.id,ce.calendar_id,c.name,ce.title,COALESCE(ce.description,''),COALESCE(ce.location,''),
		ce.start_at,ce.end_at,ce.all_day,ce.timezone,ce.recurrence,c.color,ce.creator_id,ce.organizer_id,
		ce.meeting_code,ce.reminder_minutes,ce.version,COALESCE(cm.role,'')
		FROM calendar_events ce JOIN calendars c ON c.id=ce.calendar_id
		LEFT JOIN calendar_members cm ON cm.calendar_id=ce.calendar_id AND cm.user_id=?
		LEFT JOIN calendar_event_attendees cea ON cea.event_id=ce.id AND cea.user_id=?
		WHERE ce.id=? AND ce.status='confirmed' AND (cm.user_id IS NOT NULL OR cea.user_id IS NOT NULL) LIMIT 1`, uid, uid, eventID).
		Scan(&event.ID, &event.CalendarID, &event.CalendarName, &event.Title, &event.Description, &event.Location,
			&event.startUTC, &event.endUTC, &event.AllDay, &event.TimeZone, &event.Recurrence, &event.Color,
			&event.CreatorID, &event.OrganizerID, &event.MeetingCode, &event.ReminderMinutes, &event.Version, &role)
	if err != nil {
		return event, err
	}
	event.CanEdit = canEditCalendar(role) || event.OrganizerID == uid
	return formatEventOccurrence(event, event.startUTC, event.endUTC, false, uid), nil
}

func handleCalendarEvent(w http.ResponseWriter, r *http.Request, uid string) {
	path := strings.TrimPrefix(r.URL.Path, "/api/calendar/events/")
	if strings.HasSuffix(path, "/response") {
		eventID := strings.TrimSuffix(path, "/response")
		handleCalendarResponse(w, r, uid, eventID)
		return
	}
	eventID := baseEventID(path)
	event, err := getCalendarEvent(uid, eventID)
	if err != nil {
		fail(w, "event not found", 404)
		return
	}
	switch r.Method {
	case http.MethodGet:
		ok(w, event)
	case http.MethodPut:
		if !event.CanEdit {
			fail(w, "you cannot edit this event", 403)
			return
		}
		var input CalendarEventInput
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&input); err != nil {
			fail(w, "invalid event", 400)
			return
		}
		if input.CalendarID == "" {
			input.CalendarID = event.CalendarID
		}
		if err := normalizeEventInput(&input); err != nil {
			fail(w, err.Error(), 400)
			return
		}
		if !canEditCalendar(calendarRole(input.CalendarID, uid)) {
			fail(w, "you cannot use the selected calendar", 403)
			return
		}
		start, _ := parseLocalDateTime(input.Date, input.StartTime, input.TimeZone)
		end, _ := parseLocalDateTime(input.Date, input.EndTime, input.TimeZone)
		attendees := uniqueUserIDs(input.AttendeeIDs, uid)
		tx, err := db.Begin()
		if err != nil {
			fail(w, "failed to update event", 500)
			return
		}
		defer tx.Rollback() //nolint
		result, err := tx.Exec(`UPDATE calendar_events SET calendar_id=?,title=?,description=?,location=?,start_at=?,end_at=?,all_day=?,timezone=?,recurrence=?,meeting_code=?,reminder_minutes=?,version=version+1,updated_at=NOW(6) WHERE id=? AND version=?`,
			input.CalendarID, input.Title, input.Description, input.Location, start.UTC(), end.UTC(), input.AllDay,
			input.TimeZone, input.Recurrence, input.MeetingCode, input.ReminderMinutes, eventID, event.Version)
		if err != nil {
			fail(w, "failed to update event", 500)
			return
		}
		if changed, _ := result.RowsAffected(); changed == 0 {
			fail(w, "event changed elsewhere; refresh and try again", 409)
			return
		}
		existingAttendees := map[string]bool{}
		if rows, queryErr := tx.Query(`SELECT user_id FROM calendar_event_attendees WHERE event_id=?`, eventID); queryErr == nil {
			for rows.Next() {
				var attendeeID string
				if rows.Scan(&attendeeID) == nil {
					existingAttendees[attendeeID] = true
				}
			}
			rows.Close()
		}
		wanted := map[string]bool{}
		for _, attendeeID := range attendees {
			wanted[attendeeID] = true
			if _, err = tx.Exec(`INSERT IGNORE INTO calendar_event_attendees(event_id,user_id) VALUES(?,?)`, eventID, attendeeID); err != nil {
				fail(w, "failed to update attendees", 500)
				return
			}
		}
		for attendeeID := range existingAttendees {
			if !wanted[attendeeID] {
				_, _ = tx.Exec(`DELETE FROM calendar_event_attendees WHERE event_id=? AND user_id=?`, eventID, attendeeID)
			}
		}
		if err = tx.Commit(); err != nil {
			fail(w, "failed to update event", 500)
			return
		}
		rebuildEventReminders(eventID)
		pushTo(attendees, "calendar_updated", map[string]any{"eventId": eventID, "title": input.Title})
		updated, _ := getCalendarEvent(uid, eventID)
		ok(w, updated)
	case http.MethodDelete:
		if !event.CanEdit {
			fail(w, "you cannot delete this event", 403)
			return
		}
		attendeeIDs := []string{}
		for _, attendee := range event.Attendees {
			attendeeIDs = append(attendeeIDs, attendee.UserID)
		}
		if _, err := db.Exec(`DELETE FROM calendar_events WHERE id=?`, eventID); err != nil {
			fail(w, "failed to delete event", 500)
			return
		}
		pushTo(attendeeIDs, "calendar_cancelled", map[string]any{"eventId": eventID, "title": event.Title})
		ok(w, map[string]bool{"ok": true})
	default:
		fail(w, "method not allowed", 405)
	}
}

func handleCalendarResponse(w http.ResponseWriter, r *http.Request, uid, eventID string) {
	if r.Method != http.MethodPost {
		fail(w, "method not allowed", 405)
		return
	}
	var input struct {
		Response string `json:"response"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input) != nil ||
		(input.Response != "accepted" && input.Response != "declined" && input.Response != "tentative") {
		fail(w, "response must be accepted, declined, or tentative", 400)
		return
	}
	result, err := db.Exec(`UPDATE calendar_event_attendees SET response=?,responded_at=NOW(6) WHERE event_id=? AND user_id=?`, input.Response, baseEventID(eventID), uid)
	if err != nil {
		fail(w, "failed to save response", 500)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		fail(w, "invitation not found", 404)
		return
	}
	event, _ := getCalendarEvent(uid, eventID)
	pushTo([]string{event.OrganizerID}, "calendar_response", map[string]any{"eventId": baseEventID(eventID), "userId": uid, "response": input.Response})
	ok(w, map[string]string{"response": input.Response})
}

func handleCalendars(w http.ResponseWriter, r *http.Request, uid string) {
	switch r.Method {
	case http.MethodGet:
		_, _ = ensureDefaultCalendar(uid, r.URL.Query().Get("timeZone"))
		rows, err := db.Query(`SELECT c.id,c.name,c.color,c.timezone,c.owner_id,cm.role,c.is_default,
			(SELECT COUNT(*) FROM calendar_members x WHERE x.calendar_id=c.id)
			FROM calendars c JOIN calendar_members cm ON cm.calendar_id=c.id WHERE cm.user_id=? ORDER BY c.is_default DESC,c.name`, uid)
		if err != nil {
			fail(w, "failed to load calendars", 500)
			return
		}
		defer rows.Close()
		calendars := []Calendar{}
		for rows.Next() {
			var calendar Calendar
			if rows.Scan(&calendar.ID, &calendar.Name, &calendar.Color, &calendar.TimeZone, &calendar.OwnerID, &calendar.Role, &calendar.IsDefault, &calendar.MemberCount) == nil {
				calendars = append(calendars, calendar)
			}
		}
		ok(w, calendars)
	case http.MethodPost:
		var input struct {
			Name     string `json:"name"`
			Color    string `json:"color"`
			TimeZone string `json:"timeZone"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&input) != nil {
			fail(w, "invalid calendar", 400)
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		if input.Name == "" || len(input.Name) > 160 {
			fail(w, "calendar name is required", 400)
			return
		}
		if input.Color == "" || len(input.Color) > 16 {
			input.Color = defaultCalendarColor
		}
		input.TimeZone = validTimeZone(input.TimeZone)
		id := "cal-" + newID()
		tx, err := db.Begin()
		if err == nil {
			_, err = tx.Exec(`INSERT INTO calendars(id,owner_id,name,color,timezone) VALUES(?,?,?,?,?)`, id, uid, input.Name, input.Color, input.TimeZone)
		}
		if err == nil {
			_, err = tx.Exec(`INSERT INTO calendar_members(calendar_id,user_id,role) VALUES(?,?,'owner')`, id, uid)
		}
		if err != nil || tx.Commit() != nil {
			if tx != nil {
				_ = tx.Rollback()
			}
			fail(w, "failed to create calendar", 500)
			return
		}
		ok(w, Calendar{ID: id, Name: input.Name, Color: input.Color, TimeZone: input.TimeZone, OwnerID: uid, Role: "owner", MemberCount: 1})
	default:
		fail(w, "method not allowed", 405)
	}
}

func handleCalendarMembers(w http.ResponseWriter, r *http.Request, uid, calendarID string) {
	if r.Method != http.MethodPost {
		fail(w, "method not allowed", 405)
		return
	}
	if calendarRole(calendarID, uid) != "owner" {
		fail(w, "only the calendar owner can manage members", 403)
		return
	}
	var input struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input) != nil {
		fail(w, "invalid member", 400)
		return
	}
	if input.Role == "remove" {
		_, _ = db.Exec(`DELETE FROM calendar_members WHERE calendar_id=? AND user_id=? AND role<>'owner'`, calendarID, input.UserID)
		ok(w, map[string]bool{"ok": true})
		return
	}
	if input.Role != "viewer" && input.Role != "editor" {
		fail(w, "role must be viewer or editor", 400)
		return
	}
	if _, err := db.Exec(`INSERT INTO calendar_members(calendar_id,user_id,role) VALUES(?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)`, calendarID, input.UserID, input.Role); err != nil {
		fail(w, "failed to share calendar", 500)
		return
	}
	pushTo([]string{input.UserID}, "calendar_shared", map[string]any{"calendarId": calendarID, "role": input.Role})
	ok(w, map[string]bool{"ok": true})
}

func defaultWorkingHours() WorkingHours {
	return WorkingHours{TimeZone: "Asia/Kolkata", Days: []int{1, 2, 3, 4, 5}, StartTime: "09:00", EndTime: "18:00"}
}

func getWorkingHours(uid string) WorkingHours {
	hours := defaultWorkingHours()
	var daysJSON string
	var start, end string
	if db.QueryRow(`SELECT timezone,working_days,start_time,end_time FROM calendar_working_hours WHERE user_id=?`, uid).
		Scan(&hours.TimeZone, &daysJSON, &start, &end) == nil {
		_ = json.Unmarshal([]byte(daysJSON), &hours.Days)
		if len(start) >= 5 {
			hours.StartTime = start[:5]
		}
		if len(end) >= 5 {
			hours.EndTime = end[:5]
		}
	}
	return hours
}

func handleWorkingHours(w http.ResponseWriter, r *http.Request, uid string) {
	if r.Method == http.MethodGet {
		ok(w, getWorkingHours(uid))
		return
	}
	if r.Method != http.MethodPut {
		fail(w, "method not allowed", 405)
		return
	}
	var input WorkingHours
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&input) != nil {
		fail(w, "invalid working hours", 400)
		return
	}
	input.TimeZone = validTimeZone(input.TimeZone)
	if _, err := time.Parse("15:04", input.StartTime); err != nil {
		fail(w, "invalid start time", 400)
		return
	}
	if _, err := time.Parse("15:04", input.EndTime); err != nil || input.EndTime <= input.StartTime {
		fail(w, "end time must be after start time", 400)
		return
	}
	validDays := []int{}
	seen := map[int]bool{}
	for _, day := range input.Days {
		if day >= 0 && day <= 6 && !seen[day] {
			seen[day] = true
			validDays = append(validDays, day)
		}
	}
	if len(validDays) == 0 {
		fail(w, "select at least one working day", 400)
		return
	}
	daysJSON, _ := json.Marshal(validDays)
	_, err := db.Exec(`INSERT INTO calendar_working_hours(user_id,timezone,working_days,start_time,end_time) VALUES(?,?,?,?,?)
		ON DUPLICATE KEY UPDATE timezone=VALUES(timezone),working_days=VALUES(working_days),start_time=VALUES(start_time),end_time=VALUES(end_time),updated_at=NOW(6)`,
		uid, input.TimeZone, string(daysJSON), input.StartTime, input.EndTime)
	if err != nil {
		fail(w, "failed to save working hours", 500)
		return
	}
	input.Days = validDays
	ok(w, input)
}

type BusyInterval struct {
	UserID string `json:"userId"`
	Start  string `json:"start"`
	End    string `json:"end"`
}

func busyForUsers(userIDs []string, from, to time.Time, excludeEventID string) []BusyInterval {
	result := []BusyInterval{}
	seen := map[string]bool{}
	for _, userID := range userIDs {
		if seen[userID] {
			continue
		}
		seen[userID] = true
		rows, err := db.Query(`SELECT DISTINCT ce.start_at,ce.end_at,ce.recurrence
			FROM calendar_events ce
			LEFT JOIN calendar_event_attendees ca ON ca.event_id=ce.id AND ca.user_id=? AND ca.response<>'declined'
			WHERE ce.status='confirmed' AND (ce.organizer_id=? OR ca.user_id IS NOT NULL)
			AND ce.id<>? AND (ce.start_at<? OR ce.recurrence<>'')`, userID, userID, baseEventID(excludeEventID), to.UTC())
		if err != nil {
			continue
		}
		for rows.Next() {
			var start, end time.Time
			var recurrence string
			if rows.Scan(&start, &end, &recurrence) != nil {
				continue
			}
			for _, occurrence := range eventOccurrences(start, end, from, to, recurrence, 800) {
				result = append(result, BusyInterval{UserID: userID, Start: occurrence[0].UTC().Format(time.RFC3339), End: occurrence[1].UTC().Format(time.RFC3339)})
			}
		}
		rows.Close()
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Start < result[j].Start })
	return result
}

func parseAvailabilityRange(r *http.Request) (time.Time, time.Time, error) {
	from, err := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("from must be RFC3339")
	}
	to, err := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	if err != nil || !to.After(from) || to.Sub(from) > 31*24*time.Hour {
		return time.Time{}, time.Time{}, fmt.Errorf("invalid availability range")
	}
	return from.UTC(), to.UTC(), nil
}

func requestedUsers(uid, raw string) []string {
	ids := []string{uid}
	for _, id := range strings.Split(raw, ",") {
		id = strings.TrimSpace(id)
		if id != "" && id != uid && len(ids) < 25 {
			var connected int
			_ = db.QueryRow(`SELECT COUNT(*) FROM thread_members mine JOIN thread_members theirs ON theirs.thread_id=mine.thread_id WHERE mine.user_id=? AND theirs.user_id=?`, uid, id).Scan(&connected)
			if connected > 0 {
				ids = append(ids, id)
			}
		}
	}
	return uniqueUserIDs(ids, "")
}

func handleAvailability(w http.ResponseWriter, r *http.Request, uid string) {
	if r.Method != http.MethodGet {
		fail(w, "method not allowed", 405)
		return
	}
	from, to, err := parseAvailabilityRange(r)
	if err != nil {
		fail(w, err.Error(), 400)
		return
	}
	users := requestedUsers(uid, r.URL.Query().Get("userIds"))
	busy := busyForUsers(users, from, to, r.URL.Query().Get("excludeEventId"))
	duration, _ := strconv.Atoi(r.URL.Query().Get("duration"))
	if duration < 15 || duration > 480 {
		duration = 60
	}
	timezone := validTimeZone(r.URL.Query().Get("timeZone"))
	location, _ := time.LoadLocation(timezone)
	busyOverlap := func(start, end time.Time) bool {
		for _, interval := range busy {
			bs, _ := time.Parse(time.RFC3339, interval.Start)
			be, _ := time.Parse(time.RFC3339, interval.End)
			if start.Before(be) && end.After(bs) {
				return true
			}
		}
		return false
	}
	suggestions := []map[string]string{}
	for cursor := from.In(location); cursor.Before(to.In(location)) && len(suggestions) < 8; cursor = cursor.Add(30 * time.Minute) {
		candidateEnd := cursor.Add(time.Duration(duration) * time.Minute)
		insideAll := true
		for _, userID := range users {
			hours := getWorkingHours(userID)
			userLocation, _ := time.LoadLocation(validTimeZone(hours.TimeZone))
			localStart, localEnd := cursor.In(userLocation), candidateEnd.In(userLocation)
			allowedDay := false
			for _, day := range hours.Days {
				if day == int(localStart.Weekday()) {
					allowedDay = true
					break
				}
			}
			clockStart, clockEnd := localStart.Format("15:04"), localEnd.Format("15:04")
			if !allowedDay || clockStart < hours.StartTime || clockEnd > hours.EndTime || localStart.Format("2006-01-02") != localEnd.Format("2006-01-02") {
				insideAll = false
				break
			}
		}
		if insideAll && !busyOverlap(cursor.UTC(), candidateEnd.UTC()) {
			suggestions = append(suggestions, map[string]string{"start": cursor.UTC().Format(time.RFC3339), "end": candidateEnd.UTC().Format(time.RFC3339)})
		}
	}
	ok(w, map[string]any{"busy": busy, "suggestions": suggestions, "timeZone": timezone})
}

func handleConflicts(w http.ResponseWriter, r *http.Request, uid string) {
	if r.Method != http.MethodGet {
		fail(w, "method not allowed", 405)
		return
	}
	from, to, err := parseAvailabilityRange(r)
	if err != nil {
		fail(w, err.Error(), 400)
		return
	}
	users := requestedUsers(uid, r.URL.Query().Get("userIds"))
	busy := busyForUsers(users, from, to, r.URL.Query().Get("excludeEventId"))
	conflicts := []BusyInterval{}
	for _, interval := range busy {
		start, _ := time.Parse(time.RFC3339, interval.Start)
		end, _ := time.Parse(time.RFC3339, interval.End)
		if from.Before(end) && to.After(start) {
			conflicts = append(conflicts, interval)
		}
	}
	// Reuse availability's suggestion engine over the following seven days.
	query := r.URL.Query()
	query.Set("from", from.Format(time.RFC3339))
	query.Set("to", from.AddDate(0, 0, 7).Format(time.RFC3339))
	r.URL.RawQuery = query.Encode()
	if len(conflicts) == 0 {
		ok(w, map[string]any{"hasConflict": false, "conflicts": conflicts, "suggestions": []any{}})
		return
	}
	// Compute directly so the response remains one JSON document.
	duration := int(to.Sub(from).Minutes())
	allBusy := busyForUsers(users, from, from.AddDate(0, 0, 7), r.URL.Query().Get("excludeEventId"))
	suggestions := []map[string]string{}
	for candidate := from.Add(30 * time.Minute).Truncate(30 * time.Minute); candidate.Before(from.AddDate(0, 0, 7)) && len(suggestions) < 5; candidate = candidate.Add(30 * time.Minute) {
		candidateEnd := candidate.Add(time.Duration(duration) * time.Minute)
		insideAll := true
		for _, userID := range users {
			hours := getWorkingHours(userID)
			location, _ := time.LoadLocation(validTimeZone(hours.TimeZone))
			localStart, localEnd := candidate.In(location), candidateEnd.In(location)
			allowed := false
			for _, day := range hours.Days {
				if day == int(localStart.Weekday()) {
					allowed = true
					break
				}
			}
			if !allowed || localStart.Format("15:04") < hours.StartTime || localEnd.Format("15:04") > hours.EndTime || localStart.Format("2006-01-02") != localEnd.Format("2006-01-02") {
				insideAll = false
				break
			}
		}
		if !insideAll {
			continue
		}
		overlaps := false
		for _, interval := range allBusy {
			bs, _ := time.Parse(time.RFC3339, interval.Start)
			be, _ := time.Parse(time.RFC3339, interval.End)
			if candidate.Before(be) && candidateEnd.After(bs) {
				overlaps = true
				break
			}
		}
		if !overlaps {
			suggestions = append(suggestions, map[string]string{"start": candidate.Format(time.RFC3339), "end": candidateEnd.Format(time.RFC3339)})
		}
	}
	ok(w, map[string]any{"hasConflict": true, "conflicts": conflicts, "suggestions": suggestions})
}

func rebuildEventReminders(eventID string) {
	var start, end time.Time
	var recurrence string
	var minutes int
	if db.QueryRow(`SELECT start_at,end_at,recurrence,reminder_minutes FROM calendar_events WHERE id=?`, eventID).
		Scan(&start, &end, &recurrence, &minutes) != nil {
		return
	}
	_, _ = db.Exec(`DELETE FROM calendar_reminders WHERE event_id=? AND delivered_at IS NULL`, eventID)
	users := []string{}
	var organizer string
	_ = db.QueryRow(`SELECT organizer_id FROM calendar_events WHERE id=?`, eventID).Scan(&organizer)
	if organizer != "" {
		users = append(users, organizer)
	}
	rows, _ := db.Query(`SELECT user_id FROM calendar_event_attendees WHERE event_id=? AND response<>'declined'`, eventID)
	if rows != nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				users = append(users, id)
			}
		}
		rows.Close()
	}
	occurrences := eventOccurrences(start, end, time.Now().Add(-24*time.Hour), time.Now().AddDate(1, 0, 0), recurrence, 800)
	for _, occurrence := range occurrences {
		for _, userID := range uniqueUserIDs(users, "") {
			digest := sha256.Sum256([]byte(eventID + "|" + occurrence[0].UTC().Format(time.RFC3339) + "|" + userID))
			id := fmt.Sprintf("rem-%x", digest)
			_, _ = db.Exec(`INSERT IGNORE INTO calendar_reminders(id,event_id,user_id,occurrence_start,scheduled_at) VALUES(?,?,?,?,?)`,
				id, eventID, userID, occurrence[0].UTC(), occurrence[0].UTC().Add(-time.Duration(minutes)*time.Minute))
		}
	}
}

var calendarReminderOnce sync.Once

func startCalendarReminderTicker() {
	calendarReminderOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				deliverCalendarReminders()
			}
		}()
	})
}

func deliverCalendarReminders() {
	rows, err := db.Query(`SELECT cr.id,cr.user_id,cr.event_id,ce.title,cr.occurrence_start,ce.timezone,ce.location
		FROM calendar_reminders cr JOIN calendar_events ce ON ce.id=cr.event_id
		WHERE cr.delivered_at IS NULL AND cr.scheduled_at<=UTC_TIMESTAMP(6) AND cr.occurrence_start>UTC_TIMESTAMP(6)-INTERVAL 1 HOUR
		ORDER BY cr.scheduled_at LIMIT 100`)
	if err != nil {
		return
	}
	type due struct {
		id, userID, eventID, title, timezone, location string
		starts                                         time.Time
	}
	items := []due{}
	for rows.Next() {
		var item due
		if rows.Scan(&item.id, &item.userID, &item.eventID, &item.title, &item.starts, &item.timezone, &item.location) == nil {
			items = append(items, item)
		}
	}
	rows.Close()
	for _, item := range items {
		location, _ := time.LoadLocation(validTimeZone(item.timezone))
		payload := map[string]any{"notificationId": item.id, "eventId": item.eventID, "title": item.title,
			"date": item.starts.In(location).Format("2006-01-02"), "time": item.starts.In(location).Format("15:04"), "location": item.location}
		pushTo([]string{item.userID}, "calendar_reminder", payload)
		_, _ = db.Exec(`UPDATE calendar_reminders SET delivered_at=NOW(6) WHERE id=? AND delivered_at IS NULL`, item.id)
	}
}

func handleCalendarNotifications(w http.ResponseWriter, r *http.Request, uid string) {
	if r.Method != http.MethodGet {
		fail(w, "method not allowed", 405)
		return
	}
	// Deliver immediately on login/load as well as via the 30-second ticker.
	deliverCalendarReminders()
	rows, err := db.Query(`SELECT cr.id,cr.event_id,ce.title,cr.occurrence_start,ce.timezone,ce.location
		FROM calendar_reminders cr JOIN calendar_events ce ON ce.id=cr.event_id
		WHERE cr.user_id=? AND cr.delivered_at IS NOT NULL AND cr.read_at IS NULL
		AND cr.occurrence_start>UTC_TIMESTAMP(6)-INTERVAL 1 DAY ORDER BY cr.occurrence_start LIMIT 30`, uid)
	if err != nil {
		fail(w, "failed to load notifications", 500)
		return
	}
	defer rows.Close()
	items := []map[string]string{}
	for rows.Next() {
		var id, eventID, title, timezone, eventLocation string
		var starts time.Time
		if rows.Scan(&id, &eventID, &title, &starts, &timezone, &eventLocation) == nil {
			location, _ := time.LoadLocation(validTimeZone(timezone))
			items = append(items, map[string]string{"id": id, "eventId": eventID, "title": title,
				"date": starts.In(location).Format("2006-01-02"), "time": starts.In(location).Format("15:04"), "location": eventLocation})
		}
	}
	ok(w, items)
}

func handleCalendarNotificationRead(w http.ResponseWriter, r *http.Request, uid, id string) {
	if r.Method != http.MethodPost {
		fail(w, "method not allowed", 405)
		return
	}
	_, _ = db.Exec(`UPDATE calendar_reminders SET read_at=NOW(6) WHERE id=? AND user_id=?`, id, uid)
	ok(w, map[string]bool{"ok": true})
}

func storeCalendarActionProposal(uid string, proposal CalendarActionProposal) (string, error) {
	return storeCalendarActionProposalFor(uid, proposal, 15*time.Minute)
}

func storeCalendarActionProposalFor(uid string, proposal CalendarActionProposal, ttl time.Duration) (string, error) {
	if ttl < time.Minute {
		ttl = 15 * time.Minute
	}
	id := "cap-" + newID()
	payload, _ := json.Marshal(proposal)
	_, err := db.Exec(`INSERT INTO calendar_action_proposals(id,user_id,action,payload,expires_at) VALUES(?,?,?,?,?)`, id, uid, proposal.Action, payload, time.Now().UTC().Add(ttl))
	return id, err
}

func handleCalendarActionConfirm(w http.ResponseWriter, r *http.Request, uid string) {
	if r.Method != http.MethodPost {
		fail(w, "method not allowed", 405)
		return
	}
	var input struct {
		Token   string `json:"token"`
		Approve bool   `json:"approve"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&input) != nil || input.Token == "" {
		fail(w, "confirmation token is required", 400)
		return
	}
	tx, err := db.Begin()
	if err != nil {
		fail(w, "could not confirm action", 500)
		return
	}
	defer tx.Rollback() //nolint
	var action, payloadJSON string
	err = tx.QueryRow(`SELECT action,payload FROM calendar_action_proposals WHERE id=? AND user_id=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(6) FOR UPDATE`, input.Token, uid).Scan(&action, &payloadJSON)
	if err != nil {
		fail(w, "this calendar action expired or was already used", 409)
		return
	}
	if _, err = tx.Exec(`UPDATE calendar_action_proposals SET consumed_at=UTC_TIMESTAMP(6) WHERE id=?`, input.Token); err != nil {
		fail(w, "could not confirm action", 500)
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, "could not confirm action", 500)
		return
	}
	if !input.Approve {
		completeOpportunityForCalendarToken(uid, input.Token, "", "dismissed")
		ok(w, map[string]any{"ok": true, "message": "Calendar action cancelled."})
		return
	}
	var proposal CalendarActionProposal
	if json.Unmarshal([]byte(payloadJSON), &proposal) != nil {
		fail(w, "invalid calendar action", 500)
		return
	}
	proposal.TimeZone = validTimeZone(proposal.TimeZone)
	switch action {
	case "create":
		calendarID, err := ensureDefaultCalendar(uid, proposal.TimeZone)
		if err != nil {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "could not open your calendar", 500)
			return
		}
		meetingCode := "SCHED-" + strings.ToUpper(newID()[:4])
		created, err := createCalendarEvent(uid, CalendarEventInput{CalendarID: calendarID, Title: proposal.Title,
			Description: "Created by AIPA after confirmation.", Location: "https://meet.icebrkr.space/" + meetingCode,
			Date: proposal.Date, StartTime: proposal.StartTime, EndTime: proposal.EndTime, TimeZone: proposal.TimeZone,
			AttendeeIDs: proposal.AttendeeIDs, ReminderMinutes: 10, MeetingCode: meetingCode})
		if err != nil {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "could not create the event", 500)
			return
		}
		inviteJSON, _ := json.Marshal(proposal.AttendeeIDs)
		_, scheduleErr := db.Exec(`INSERT INTO scheduled_meetings(id,code,title,date,time,creator_id,invitee_ids) VALUES(?,?,?,?,?,?,?)`,
			"sm-"+newID(), meetingCode, proposal.Title, proposal.Date, proposal.StartTime, uid, string(inviteJSON))
		if scheduleErr != nil {
			_, _ = db.Exec(`DELETE FROM calendar_events WHERE id=?`, created.ID)
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "could not create the meeting room", 500)
			return
		}
		completeOpportunityForCalendarToken(uid, input.Token, created.ID, "completed")
		ok(w, map[string]any{"ok": true, "message": "Event created and invitations sent.", "event": created})
	case "update":
		event, err := getCalendarEvent(uid, proposal.EventID)
		if err != nil || !event.CanEdit {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "event is no longer editable", 409)
			return
		}
		start, err := parseLocalDateTime(proposal.Date, proposal.StartTime, proposal.TimeZone)
		if err != nil {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "invalid proposed time", 400)
			return
		}
		end, err := parseLocalDateTime(proposal.Date, proposal.EndTime, proposal.TimeZone)
		if err != nil || !end.After(start) {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "invalid proposed end time", 400)
			return
		}
		_, err = db.Exec(`UPDATE calendar_events SET start_at=?,end_at=?,timezone=?,version=version+1,updated_at=NOW(6) WHERE id=?`, start.UTC(), end.UTC(), proposal.TimeZone, baseEventID(proposal.EventID))
		if err != nil {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "could not reschedule the event", 500)
			return
		}
		rebuildEventReminders(baseEventID(proposal.EventID))
		attendees := []string{}
		for _, attendee := range event.Attendees {
			attendees = append(attendees, attendee.UserID)
		}
		pushTo(attendees, "calendar_updated", map[string]any{"eventId": baseEventID(proposal.EventID), "title": event.Title})
		completeOpportunityForCalendarToken(uid, input.Token, baseEventID(proposal.EventID), "completed")
		ok(w, map[string]any{"ok": true, "message": "Event rescheduled and attendees notified."})
	case "delete":
		event, err := getCalendarEvent(uid, proposal.EventID)
		if err != nil || !event.CanEdit {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "event is no longer editable", 409)
			return
		}
		attendees := []string{}
		for _, attendee := range event.Attendees {
			attendees = append(attendees, attendee.UserID)
		}
		if _, err = db.Exec(`DELETE FROM calendar_events WHERE id=?`, baseEventID(proposal.EventID)); err != nil {
			_, _ = db.Exec(`UPDATE calendar_action_proposals SET consumed_at=NULL WHERE id=?`, input.Token)
			fail(w, "could not cancel the event", 500)
			return
		}
		if event.MeetingCode != "" {
			_, _ = db.Exec(`DELETE FROM scheduled_meetings WHERE code=? AND creator_id=?`, event.MeetingCode, uid)
		}
		pushTo(attendees, "calendar_cancelled", map[string]any{"eventId": baseEventID(proposal.EventID), "title": event.Title})
		completeOpportunityForCalendarToken(uid, input.Token, "", "completed")
		ok(w, map[string]any{"ok": true, "message": "Event cancelled and attendees notified."})
	default:
		fail(w, "unsupported calendar action", 400)
	}
}

func handleCalendarRoutes(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/calendar")
	switch {
	case path == "/events":
		handleCalendarEvents(w, r, uid)
	case strings.HasPrefix(path, "/events/"):
		handleCalendarEvent(w, r, uid)
	case path == "/calendars":
		handleCalendars(w, r, uid)
	case strings.HasPrefix(path, "/calendars/") && strings.HasSuffix(path, "/members"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/calendars/"), "/members")
		handleCalendarMembers(w, r, uid, id)
	case path == "/working-hours":
		handleWorkingHours(w, r, uid)
	case path == "/availability":
		handleAvailability(w, r, uid)
	case path == "/conflicts":
		handleConflicts(w, r, uid)
	case path == "/notifications":
		handleCalendarNotifications(w, r, uid)
	case path == "/actions/confirm":
		handleCalendarActionConfirm(w, r, uid)
	case strings.HasPrefix(path, "/notifications/") && strings.HasSuffix(path, "/read"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/notifications/"), "/read")
		handleCalendarNotificationRead(w, r, uid, id)
	default:
		fail(w, "not found", 404)
	}
}
