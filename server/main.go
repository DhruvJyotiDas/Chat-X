package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"
)

const (
	jwtKey    = "ibconnect_jwt_secret_prod_2024_change_me"
	jwtExpiry = 30 * 24 * time.Hour
)

var (
	db       *sql.DB
	upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
)

type User struct {
	ID          string    `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email"`
	Avatar      string    `json:"avatar,omitempty"`
	Bio         string    `json:"bio,omitempty"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Thread struct {
	ID            string   `json:"id"`
	Type          string   `json:"type"`
	Name          string   `json:"name"`
	Avatar        string   `json:"avatar,omitempty"`
	Participants  []string `json:"participants"`
	LastMessage   string   `json:"lastMessage"`
	LastTimestamp int64    `json:"lastTimestamp"`
	UnreadCount   int      `json:"unreadCount"`
}

type FileAttachment struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	MType   string `json:"type"`
	DataURL string `json:"dataUrl,omitempty"`
}

type Message struct {
	ID           string          `json:"id"`
	ThreadID     string          `json:"threadId"`
	SenderID     string          `json:"senderId"`
	SenderName   string          `json:"senderName"`
	SenderAvatar string          `json:"senderAvatar,omitempty"`
	Text         string          `json:"text"`
	Time         string          `json:"time"`
	Timestamp    int64           `json:"timestamp"`
	File         *FileAttachment `json:"fileAttachment,omitempty"`
}

type ScheduledMeeting struct {
    ID         string   `json:"id"`
    Code       string   `json:"code"`
    Title      string   `json:"title"`
    Date       string   `json:"date"`
    Time       string   `json:"time"`
    CreatorID  string   `json:"creatorId"`
    InviteeIDs []string `json:"inviteeIds"`
}

type Claims struct {
	UserID string `json:"userId"`
	jwt.RegisteredClaims
}

func signToken(userID string) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(jwtExpiry)),
		},
	}).SignedString([]byte(jwtKey))
}

func parseToken(s string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(s, &Claims{}, func(t *jwt.Token) (any, error) {
		return []byte(jwtKey), nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, fmt.Errorf("invalid")
	}
	return c, nil
}

func bearerUID(r *http.Request) (string, error) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", fmt.Errorf("no token")
	}
	c, err := parseToken(strings.TrimPrefix(auth, "Bearer "))
	if err != nil {
		return "", err
	}
	return c.UserID, nil
}

// ── Real-time chat WebSocket clients ─────────────────────────────────────────

type ChatConn struct {
	uid  string
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *ChatConn) push(msgType string, payload any) {
	data, _ := json.Marshal(payload)
	msg, _ := json.Marshal(map[string]any{"type": msgType, "payload": json.RawMessage(data)})
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.WriteMessage(websocket.TextMessage, msg) //nolint
}

var (
	chatMu      sync.RWMutex
	chatClients = map[string]*ChatConn{}
)

func chatConnect(uid string, c *ChatConn) {
	chatMu.Lock()
	chatClients[uid] = c
	chatMu.Unlock()
	db.Exec(`UPDATE users SET status='online' WHERE id=?`, uid) //nolint
	broadcastStatus(uid, "online")
}

func chatDisconnect(uid string) {
	chatMu.Lock()
	delete(chatClients, uid)
	chatMu.Unlock()
	db.Exec(`UPDATE users SET status='offline' WHERE id=?`, uid) //nolint
	broadcastStatus(uid, "offline")
}

func broadcastStatus(uid, status string) {
	chatMu.RLock()
	defer chatMu.RUnlock()
	payload := map[string]string{"id": uid, "status": status}
	for _, c := range chatClients {
		go c.push("user_status", payload)
	}
}

func pushTo(uids []string, msgType string, payload any) {
	chatMu.RLock()
	defer chatMu.RUnlock()
	for _, uid := range uids {
		if c, ok := chatClients[uid]; ok {
			go c.push(msgType, payload)
		}
	}
}

// ── DB helpers ────────────────────────────────────────────────────────────────

func newID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint
	return hex.EncodeToString(b)
}

func threadMembers(threadID string) []string {
	rows, err := db.Query(`SELECT user_id FROM thread_members WHERE thread_id=?`, threadID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id) //nolint
		ids = append(ids, id)
	}
	return ids
}

func isMember(threadID, uid string) bool {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM thread_members WHERE thread_id=? AND user_id=?`, threadID, uid).Scan(&n) //nolint
	return n > 0
}

func loadThread(threadID, forUID string) (Thread, error) {
	var t Thread
	var ts sql.NullFloat64
	var lastMsg sql.NullString
	err := db.QueryRow(`
		SELECT t.id, t.type, t.name, COALESCE(t.avatar,''),
			(SELECT text FROM messages WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1),
			UNIX_TIMESTAMP((SELECT created_at FROM messages WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1))*1000,
			(SELECT COUNT(*) FROM messages m
			 JOIN thread_members tm ON tm.thread_id=m.thread_id AND tm.user_id=?
			 WHERE m.thread_id=t.id AND (tm.last_read_at IS NULL OR m.created_at > tm.last_read_at))
		FROM threads t WHERE t.id=?
	`, forUID, threadID).Scan(&t.ID, &t.Type, &t.Name, &t.Avatar, &lastMsg, &ts, &t.UnreadCount)
	if err != nil {
		return t, err
	}
	if lastMsg.Valid {
		t.LastMessage = lastMsg.String
	}
	if ts.Valid {
		t.LastTimestamp = int64(ts.Float64)
	} else {
		t.LastTimestamp = time.Now().UnixMilli()
	}
	t.Participants = threadMembers(threadID)
	return t, nil
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v) //nolint
}

func fail(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg}) //nolint
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

func handleSignup(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Email       string `json:"email"`
		Password    string `json:"password"`
		Avatar      string `json:"avatar"`
	}
	if json.NewDecoder(r.Body).Decode(&b) != nil || b.Username == "" || b.DisplayName == "" || b.Email == "" || len(b.Password) < 6 {
		fail(w, "username, displayName, email and password (≥6 chars) required", 400)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	if err != nil {
		fail(w, "server error", 500)
		return
	}
	id := "user-" + newID()
	_, err = db.Exec(
		`INSERT INTO users(id,username,display_name,email,password_hash,avatar,status) VALUES(?,?,?,?,?,?,'online')`,
		id, strings.ToLower(b.Username), b.DisplayName, strings.ToLower(b.Email), string(hash), b.Avatar,
	)
	if err != nil {
		if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
			fail(w, "Username or email already taken", 409)
		} else {
			fail(w, "server error", 500)
		}
		return
	}
	token, _ := signToken(id)
	user := User{ID: id, Username: strings.ToLower(b.Username), DisplayName: b.DisplayName,
		Email: strings.ToLower(b.Email), Avatar: b.Avatar, Status: "online", CreatedAt: time.Now()}
	broadcastStatus(id, "online")
	ok(w, map[string]any{"token": token, "user": user})
}

func handleSSO(w http.ResponseWriter, r *http.Request) {
	tokenParam := r.URL.Query().Get("token")
	emailParam := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("e")))

	if tokenParam == "" || emailParam == "" {
		http.Redirect(w, r, "https://icebrkr.space/index.html?error=invalid_sso", http.StatusFound)
		return
	}

	verifyURL := fmt.Sprintf("https://icebrkr.space/auth.php?action=verify_meet_token&token=%s&e=%s", tokenParam, emailParam)
	resp, err := http.Get(verifyURL)
	if err != nil || resp.StatusCode != 200 {
		http.Redirect(w, r, "https://icebrkr.space/index.html?error=sso_unauthorized", http.StatusFound)
		return
	}
	defer resp.Body.Close()

	var verifyData struct {
		Valid bool   `json:"valid"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&verifyData); err != nil || !verifyData.Valid {
		http.Redirect(w, r, "https://icebrkr.space/index.html?error=sso_invalid_data", http.StatusFound)
		return
	}

	var u User
	var hash string
	err = db.QueryRow(
		`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at,password_hash FROM users WHERE email=?`,
		emailParam,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt, &hash)

	if err != nil {
		baseUsername := strings.Split(emailParam, "@")[0]
		fallbackHash, _ := bcrypt.GenerateFromPassword([]byte("placeholder_sso"), 12)
		id := "user-" + newID()

		_, err = db.Exec(
			`INSERT INTO users(id,username,display_name,email,password_hash,avatar,status) VALUES(?,?,?,?,?,'','online')`,
			id, strings.ToLower(baseUsername), baseUsername, emailParam, string(fallbackHash),
		)
		if err != nil {
			http.Redirect(w, r, "https://icebrkr.space/index.html?error=sso_creation_failed", http.StatusFound)
			return
		}
		u.ID = id
	} else {
		db.Exec(`UPDATE users SET status='online' WHERE id=?`, u.ID) //nolint
		broadcastStatus(u.ID, "online")
	}

	token, _ := signToken(u.ID)
	http.SetCookie(w, &http.Cookie{Name: "token", Value: token, Path: "/"})
	http.Redirect(w, r, "/?token="+token, http.StatusFound)
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	json.NewDecoder(r.Body).Decode(&b) //nolint
	var u User
	var hash string
	err := db.QueryRow(
		`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at,password_hash FROM users WHERE email=?`,
		strings.ToLower(b.Email),
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt, &hash)
	if err != nil {
		fail(w, "No account found with this email", 401)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.Password)) != nil {
		fail(w, "Incorrect password", 401)
		return
	}
	db.Exec(`UPDATE users SET status='online' WHERE id=?`, u.ID) //nolint
	u.Status = "online"
	broadcastStatus(u.ID, "online")
	token, _ := signToken(u.ID)
	ok(w, map[string]any{"token": token, "user": u})
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	var uid string
	var err error

	if token != "" {
		claims, err := parseToken(token)
		if err == nil {
			uid = claims.UserID
		}
	}

	if uid == "" {
		uid, err = bearerUID(r)
		if err != nil {
			fail(w, "unauthorized", 401)
			return
		}
	}

	var u User
	err = db.QueryRow(
		`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at FROM users WHERE id=?`, uid,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt)

	if err != nil {
		fallbackName := "IB Member"
		fallbackEmail := uid + "@sso.icebrkr.space"
		_, insertErr := db.Exec(`
			INSERT INTO users (id, username, display_name, email, password_hash, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, NOW())
		`, uid, uid, fallbackName, fallbackEmail, "", "online")

		if insertErr != nil {
			fail(w, "failed to provision new sso user", 500)
			return
		}

		db.QueryRow(
			`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at FROM users WHERE id=?`, uid,
		).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt)
	}

	ok(w, u)
}

func handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	var b struct {
		DisplayName string `json:"displayName"`
		Bio         string `json:"bio"`
		Avatar      string `json:"avatar"`
	}
	json.NewDecoder(r.Body).Decode(&b) //nolint
	if b.DisplayName == "" {
		db.QueryRow(`SELECT display_name FROM users WHERE id=?`, uid).Scan(&b.DisplayName) //nolint
	}
	_, err = db.Exec(`UPDATE users SET
		display_name = ?,
		bio          = ?,
		avatar       = CASE WHEN ? != '' THEN ? ELSE avatar END
		WHERE id = ?`,
		b.DisplayName, b.Bio, b.Avatar, b.Avatar, uid)
	if err != nil {
		fail(w, "db error", 500)
		return
	}

	var u User
	db.QueryRow(`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at FROM users WHERE id=?`, uid).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt) //nolint
	chatMu.RLock()
	for _, c := range chatClients {
		go c.push("user_updated", u)
	}
	chatMu.RUnlock()
	ok(w, u)
}

func handleChangePassword(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	var b struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	json.NewDecoder(r.Body).Decode(&b) //nolint
	if len(b.NewPassword) < 6 {
		fail(w, "New password must be at least 6 characters", 400)
		return
	}
	var hash string
	if db.QueryRow(`SELECT password_hash FROM users WHERE id=?`, uid).Scan(&hash) != nil {
		fail(w, "user not found", 404)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.OldPassword)) != nil {
		fail(w, "Current password is incorrect", 401)
		return
	}
	newHash, _ := bcrypt.GenerateFromPassword([]byte(b.NewPassword), 12)
	db.Exec(`UPDATE users SET password_hash=? WHERE id=?`, string(newHash), uid) //nolint
	ok(w, map[string]string{"message": "Password updated successfully"})
}

// ── Users endpoint ────────────────────────────────────────────────────────────

func handleUsers(w http.ResponseWriter, r *http.Request) {
	if _, err := bearerUID(r); err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	rows, err := db.Query(`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at FROM users ORDER BY display_name`)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		var u User
		rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt) //nolint
		users = append(users, u)
	}
	ok(w, users)
}

// ── Scheduled Meetings Endpoints (NEW) ────────────────────────────────────────

func handleGetScheduledMeetings(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}

	rows, err := db.Query(`SELECT id, code, title, date, time, creator_id, invitee_ids FROM scheduled_meetings WHERE creator_id=? OR JSON_CONTAINS(invitee_ids, JSON_QUOTE(?)) ORDER BY date ASC, time ASC`, uid, uid)
	if err != nil {
		fail(w, "db error", 500)
		return
	}
	defer rows.Close()

	meetings := []ScheduledMeeting{}
	for rows.Next() {
		var m ScheduledMeeting
		var invJSON string
		rows.Scan(&m.ID, &m.Code, &m.Title, &m.Date, &m.Time, &m.CreatorID, &invJSON) //nolint
		json.Unmarshal([]byte(invJSON), &m.InviteeIDs)                                 //nolint
		meetings = append(meetings, m)
	}
	ok(w, meetings)
}

func handleScheduleMeeting(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}

	var b struct {
		Title        string   `json:"title"`
		Date         string   `json:"date"`
		Time         string   `json:"time"`
		InvitedUsers []string `json:"invitedUsers"`
	}
	json.NewDecoder(r.Body).Decode(&b) //nolint

	if b.Title == "" || b.Date == "" || b.Time == "" {
		fail(w, "title, date, and time are required", 400)
		return
	}

	code := "SCHED-" + strings.ToUpper(newID()[:4])
	id := "sm-" + newID()

	invJSON, _ := json.Marshal(b.InvitedUsers)
	_, err = db.Exec(
		`INSERT INTO scheduled_meetings(id, code, title, date, time, creator_id, invitee_ids) VALUES(?, ?, ?, ?, ?, ?, ?)`,
		id, code, b.Title, b.Date, b.Time, uid, string(invJSON),
	)
	if err != nil {
		fail(w, "failed to schedule meeting", 500)
		return
	}

	m := ScheduledMeeting{ID: id, Code: code, Title: b.Title, Date: b.Date, Time: b.Time, CreatorID: uid}
	ok(w, m)
}

func handleDeleteScheduledMeeting(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}

	id := strings.TrimPrefix(r.URL.Path, "/api/meetings/scheduled/")
	_, err = db.Exec(`DELETE FROM scheduled_meetings WHERE id=? AND creator_id=?`, id, uid)
	if err != nil {
		fail(w, "failed to delete meeting", 500)
		return
	}
	ok(w, map[string]string{"message": "deleted"})
}

func handleValidateRoomCode(w http.ResponseWriter, r *http.Request) {
	if _, err := bearerUID(r); err != nil {
		fail(w, "unauthorized", 401)
		return
	}

	code := strings.TrimPrefix(r.URL.Path, "/api/meetings/validate/")
	var exists int
	db.QueryRow(`SELECT COUNT(*) FROM scheduled_meetings WHERE code=?`, code).Scan(&exists) //nolint

	if exists == 0 {
		fail(w, "Room code not found", 404)
		return
	}
	ok(w, map[string]bool{"valid": true})
}

// ── Threads endpoint ──────────────────────────────────────────────────────────

func handleThreads(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}

	if r.Method == "GET" {
		rows, err := db.Query(`
			SELECT t.id FROM threads t
			JOIN thread_members tm ON tm.thread_id=t.id AND tm.user_id=?
			ORDER BY (SELECT created_at FROM messages WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1) IS NULL ASC,
			         (SELECT created_at FROM messages WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1) DESC,
			         t.created_at DESC
		`, uid)
		if err != nil {
			fail(w, "db error", 500)
			return
		}
		defer rows.Close()
		threads := []Thread{}
		for rows.Next() {
			var id string
			rows.Scan(&id) //nolint
			if t, e := loadThread(id, uid); e == nil {
				threads = append(threads, t)
			}
		}
		ok(w, threads)
		return
	}

	var b struct {
		Kind        string   `json:"type"`
		OtherUserID string   `json:"otherUserId"`
		Name        string   `json:"name"`
		MemberIDs   []string `json:"memberIds"`
	}
	if json.NewDecoder(r.Body).Decode(&b) != nil {
		fail(w, "invalid body", 400)
		return
	}

	switch b.Kind {
	case "dm":
		if b.OtherUserID == "" {
			fail(w, "otherUserId required", 400)
			return
		}
		ids := []string{uid, b.OtherUserID}
		if ids[0] > ids[1] {
			ids[0], ids[1] = ids[1], ids[0]
		}
		threadID := "dm_" + ids[0] + "_" + ids[1]
		var exists int
		db.QueryRow(`SELECT COUNT(*) FROM threads WHERE id=?`, threadID).Scan(&exists) //nolint
		if exists == 0 {
			var otherName, otherAvatar string
			db.QueryRow(`SELECT display_name,COALESCE(avatar,'') FROM users WHERE id=?`, b.OtherUserID).Scan(&otherName, &otherAvatar) //nolint
			tx, _ := db.Begin()
			tx.Exec(`INSERT INTO threads(id,type,name,avatar,created_by) VALUES(?,'dm',?,?,?)`, threadID, otherName, otherAvatar, uid)
			tx.Exec(`INSERT IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)`, threadID, uid)
			tx.Exec(`INSERT IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)`, threadID, b.OtherUserID)
			tx.Commit() //nolint
			if mt, e := loadThread(threadID, b.OtherUserID); e == nil {
				pushTo([]string{b.OtherUserID}, "thread_created", mt)
			}
		}
		t, err := loadThread(threadID, uid)
		if err != nil {
			fail(w, "db error", 500)
			return
		}
		ok(w, t)

	case "group":
		if b.Name == "" || len(b.MemberIDs) == 0 {
			fail(w, "name and memberIds required", 400)
			return
		}
		threadID := "group_" + newID()
		all := append([]string{uid}, b.MemberIDs...)
		tx, _ := db.Begin()
		tx.Exec(`INSERT INTO threads(id,type,name,created_by) VALUES(?,'group',?,?)`, threadID, b.Name, uid)
		for _, m := range all {
			tx.Exec(`INSERT IGNORE INTO thread_members(thread_id,user_id) VALUES(?,?)`, threadID, m)
		}
		tx.Commit() //nolint
		t, _ := loadThread(threadID, uid)
		for _, m := range b.MemberIDs {
			if mt, e := loadThread(threadID, m); e == nil {
				pushTo([]string{m}, "thread_created", mt)
			}
		}
		ok(w, t)

	default:
		fail(w, "type must be 'dm' or 'group'", 400)
	}
}

// ── Messages endpoint ─────────────────────────────────────────────────────────

func handleMessages(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "unauthorized", 401)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/threads/")
	threadID := strings.TrimSuffix(path, "/messages")
	if !isMember(threadID, uid) {
		fail(w, "not a member", 403)
		return
	}

	if r.Method == "GET" {
		rows, err := db.Query(`
			SELECT m.id, m.thread_id, m.sender_id, u.display_name, COALESCE(u.avatar,''),
				m.text, DATE_FORMAT(m.created_at,'%h:%i %p'),
				UNIX_TIMESTAMP(m.created_at)*1000,
				COALESCE(m.file_name,''), COALESCE(m.file_size,0),
				COALESCE(m.file_type,''), COALESCE(m.file_data,'')
			FROM messages m JOIN users u ON u.id=m.sender_id
			WHERE m.thread_id=? ORDER BY m.created_at ASC LIMIT 500
		`, threadID)
		if err != nil {
			fail(w, "db error", 500)
			return
		}
		defer rows.Close()
		msgs := []Message{}
		for rows.Next() {
			var m Message
			var fn, ft, fd string
			var fs, ts float64
			rows.Scan(&m.ID, &m.ThreadID, &m.SenderID, &m.SenderName, &m.SenderAvatar, &m.Text, &m.Time, &ts, &fn, &fs, &ft, &fd) //nolint
			m.Timestamp = int64(ts)
			if fn != "" {
				m.File = &FileAttachment{Name: fn, Size: int64(fs), MType: ft, DataURL: fd}
			}
			msgs = append(msgs, m)
		}
		db.Exec(`UPDATE thread_members SET last_read_at=NOW() WHERE thread_id=? AND user_id=?`, threadID, uid) //nolint
		ok(w, msgs)
		return
	}

	var b struct {
		Text string          `json:"text"`
		File *FileAttachment `json:"fileAttachment"`
	}
	json.NewDecoder(r.Body).Decode(&b) //nolint
	msgID := "msg-" + newID()
	var fn, ft, fd sql.NullString
	var fs sql.NullInt64
	if b.File != nil {
		fn = sql.NullString{String: b.File.Name, Valid: true}
		ft = sql.NullString{String: b.File.MType, Valid: true}
		fd = sql.NullString{String: b.File.DataURL, Valid: true}
		fs = sql.NullInt64{Int64: b.File.Size, Valid: true}
	}
	_, err = db.Exec(
		`INSERT INTO messages(id,thread_id,sender_id,text,file_name,file_size,file_type,file_data) VALUES(?,?,?,?,?,?,?,?)`,
		msgID, threadID, uid, b.Text, fn, fs, ft, fd,
	)
	if err != nil {
		fail(w, "db error: "+err.Error(), 500)
		return
	}
	var m Message
	var ts float64
	db.QueryRow(`
		SELECT m.id, m.thread_id, m.sender_id, u.display_name, COALESCE(u.avatar,''),
			m.text, DATE_FORMAT(m.created_at,'%h:%i %p'),
			UNIX_TIMESTAMP(m.created_at)*1000
		FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
	`, msgID).Scan(&m.ID, &m.ThreadID, &m.SenderID, &m.SenderName, &m.SenderAvatar, &m.Text, &m.Time, &ts) //nolint
	m.Timestamp = int64(ts)
	if b.File != nil {
		m.File = b.File
	}
	members := threadMembers(threadID)
	pushTo(members, "new_message", map[string]any{"threadId": threadID, "message": m})
	db.Exec(`UPDATE thread_members SET last_read_at=NOW() WHERE thread_id=? AND user_id=?`, threadID, uid) //nolint
	ok(w, m)
}

// ── Chat WebSocket ────────────────────────────────────────────────────────────

func handleChatWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	claims, err := parseToken(token)
	if err != nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &ChatConn{uid: claims.UserID, conn: conn}
	chatConnect(claims.UserID, c)
	defer func() {
		chatDisconnect(claims.UserID)
		conn.Close()
	}()

	rows, _ := db.Query(`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at FROM users ORDER BY display_name`)
	users := []User{}
	if rows != nil {
		for rows.Next() {
			var u User
			rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt) //nolint
			users = append(users, u)
		}
		rows.Close()
	}
	c.push("users_list", users)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var msg struct {
			Type     string `json:"type"`
			ThreadID string `json:"threadId"`
			UserName string `json:"userName"`
			To       string `json:"to"`
			RoomID   string `json:"roomId"`
			FromName string `json:"fromName"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if (msg.Type == "typing_start" || msg.Type == "typing_stop") && msg.ThreadID != "" && isMember(msg.ThreadID, claims.UserID) {
			others := []string{}
			for _, m := range threadMembers(msg.ThreadID) {
				if m != claims.UserID {
					others = append(others, m)
				}
			}
			pushTo(others, msg.Type, map[string]any{
				"threadId": msg.ThreadID, "userId": claims.UserID, "userName": msg.UserName,
			})
		}
		if msg.Type == "call_invite" && msg.To != "" && msg.RoomID != "" {
			pushTo([]string{msg.To}, "call_invite", map[string]string{
				"fromId": claims.UserID, "fromName": msg.FromName, "roomId": msg.RoomID,
			})
		}
		if msg.Type == "call_declined" && msg.To != "" {
			pushTo([]string{msg.To}, "call_declined", map[string]string{
				"fromId": claims.UserID,
			})
		}
		if msg.Type == "call_accepted" && msg.To != "" {
			pushTo([]string{msg.To}, "call_accepted", map[string]string{
				"fromId": claims.UserID,
			})
		}
	}
}

// ── Migrations ────────────────────────────────────────────────────────────────

func migrate() {
	for _, s := range []string{
		`CREATE TABLE IF NOT EXISTS users (
			id VARCHAR(255) PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, display_name VARCHAR(255) NOT NULL,
			email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL, avatar TEXT, bio TEXT,
			status VARCHAR(50) DEFAULT 'offline', created_at DATETIME(6) DEFAULT NOW(6))`,
		`CREATE TABLE IF NOT EXISTS threads (
			id VARCHAR(255) PRIMARY KEY, type VARCHAR(50) NOT NULL, name VARCHAR(255) NOT NULL, avatar TEXT,
			created_by VARCHAR(255), created_at DATETIME(6) DEFAULT NOW(6))`,
		`CREATE TABLE IF NOT EXISTS thread_members (
			thread_id VARCHAR(255) NOT NULL, user_id VARCHAR(255) NOT NULL,
			last_read_at DATETIME(6),
			PRIMARY KEY (thread_id, user_id),
			FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS messages (
			id VARCHAR(255) PRIMARY KEY,
			thread_id VARCHAR(255), sender_id VARCHAR(255),
			text TEXT NOT NULL DEFAULT '', file_name TEXT, file_size BIGINT,
			file_type TEXT, file_data LONGTEXT, created_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
			FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL)`,
		`CREATE TABLE IF NOT EXISTS scheduled_meetings (
			id VARCHAR(255) PRIMARY KEY, code VARCHAR(255) UNIQUE NOT NULL, title TEXT NOT NULL,
			date VARCHAR(50) NOT NULL, time VARCHAR(50) NOT NULL,
			creator_id VARCHAR(255),
			invitee_ids JSON,
			created_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_tm_user ON thread_members(user_id)`,
	} {
		if _, err := db.Exec(s); err != nil {
			log.Fatalf("migration: %v", err)
		}
	}
	log.Println("[DB] migrations OK")
}

// ── WebRTC signaling ──────────────────────────────────────────────────────────

type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}
type CreateRoomPayload struct {
	RoomID       string `json:"room_id"`
	UserID       string `json:"user_id"`
	UserName     string `json:"user_name"`
	MeetingTitle string `json:"meeting_title,omitempty"`
}
type JoinRoomPayload struct {
	RoomID   string `json:"room_id"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
}
type SignalPayload struct {
	To        string          `json:"to"`
	SDP       json.RawMessage `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}
type ChatPayload struct{ Text string `json:"text"` }
type PeerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type SigClient struct {
	id   string
	name string
	conn *websocket.Conn
	room *Room
	mu   sync.Mutex
}

func (c *SigClient) sendMsg(t string, payload any) {
	data, _ := json.Marshal(payload)
	msg, _ := json.Marshal(WSMessage{Type: t, Payload: json.RawMessage(data)})
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.WriteMessage(websocket.TextMessage, msg) //nolint
}

type Room struct {
	id      string
	clients map[string]*SigClient
	mu      sync.RWMutex
}

func (room *Room) broadcast(senderID, t string, payload any) {
	room.mu.RLock()
	defer room.mu.RUnlock()
	for id, c := range room.clients {
		if id != senderID {
			c.sendMsg(t, payload)
		}
	}
}

var (
	roomsMu sync.RWMutex
	rooms   = map[string]*Room{}
)

func genCode() string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	code := make([]byte, 9)
	for i := range code {
		if i == 4 {
			code[i] = '-'
			continue
		}
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		code[i] = chars[n.Int64()]
	}
	return string(code)
}

func handleSignaling(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &SigClient{id: "tmp-" + newID(), conn: conn}
	log.Printf("New signaling client: %s", client.id)
	defer func() {
		conn.Close()
		if client.room != nil {
			leaveRoom(client)
		}
		log.Printf("Signaling client disconnected: %s (%s)", client.id, client.name)
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var msg WSMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "create_room":
			var p CreateRoomPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if p.UserID != "" {
				client.id = p.UserID
			}
			client.name = p.UserName

			code := p.RoomID
			if code == "" {
				code = genCode()
			}

			room := &Room{id: code, clients: map[string]*SigClient{client.id: client}}
			roomsMu.Lock()
			rooms[code] = room
			roomsMu.Unlock()
			client.room = room
			client.sendMsg("room_created", map[string]string{"room_id": code})
			log.Printf("Room %s created by %s (%s)", code, client.id, client.name)
		case "join_room":
			var p JoinRoomPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if p.UserID != "" {
				client.id = p.UserID
			}
			client.name = p.UserName
			roomsMu.RLock()
			room, found := rooms[p.RoomID]
			roomsMu.RUnlock()
			if !found {
				client.sendMsg("error", map[string]string{"message": "Room not found: " + p.RoomID})
				continue
			}
			room.mu.Lock()
			peers := []PeerInfo{}
			for _, c := range room.clients {
				peers = append(peers, PeerInfo{ID: c.id, Name: c.name})
			}
			room.clients[client.id] = client
			room.mu.Unlock()
			client.room = room
			client.sendMsg("room_joined", map[string]any{"room_id": room.id, "peers": peers})
			room.broadcast(client.id, "peer_joined", map[string]string{"peer_id": client.id, "peer_name": client.name})
		case "offer", "answer", "ice_candidate":
			var p SignalPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room == nil {
				continue
			}
			client.room.mu.RLock()
			target, found := client.room.clients[p.To]
			client.room.mu.RUnlock()
			if found {
				target.sendMsg(msg.Type, map[string]any{"from": client.id, "sdp": p.SDP, "candidate": p.Candidate})
			}
		case "leave_room":
			if client.room != nil {
				leaveRoom(client)
				client.room = nil
			}
		case "chat_message":
			var p ChatPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room != nil {
				client.room.broadcast(client.id, "chat_message", map[string]string{
					"from_id": client.id, "from_name": client.name,
					"text": p.Text, "time": time.Now().Format("3:04 PM"),
				})
			}
		}
	}
}

func leaveRoom(client *SigClient) {
	room := client.room
	room.mu.Lock()
	delete(room.clients, client.id)
	empty := len(room.clients) == 0
	room.mu.Unlock()
	room.broadcast(client.id, "peer_left", map[string]string{"peer_id": client.id})
	if empty {
		roomsMu.Lock()
		delete(rooms, room.id)
		roomsMu.Unlock()
		log.Printf("Room %s closed (empty)", room.id)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
	w.Write([]byte("ok")) //nolint
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	var err error
	cfg := mysql.NewConfig()
	cfg.User = "lolafire_admin"
	cfg.Passwd = "admin@100"
	cfg.Net = "tcp"
	cfg.Addr = "lolafire.mysql.db.hostpoint.ch:3306"
	cfg.DBName = "lolafire_IBConnect"
	cfg.ParseTime = true
	cfg.Params = map[string]string{"charset": "utf8mb4", "collation": "utf8mb4_unicode_ci"}
	db, err = sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	if err = db.Ping(); err != nil {
		log.Fatalf("db ping: %v", err)
	}
	log.Println("[DB] connected to MariaDB")
	migrate()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleSignaling)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/chat-ws", handleChatWS)
	mux.HandleFunc("/api/auth/signup", handleSignup)
	mux.HandleFunc("/api/sso", handleSSO)

	mux.HandleFunc("/api/auth/login", handleLogin)
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" { handleUpdateMe(w, r) } else { handleMe(w, r) }
	})
	mux.HandleFunc("/api/auth/password", handleChangePassword)
	mux.HandleFunc("/api/users", handleUsers)
	mux.HandleFunc("/api/threads", handleThreads)
	mux.HandleFunc("/api/threads/", handleMessages)

	// New Meetings Endpoints
	mux.HandleFunc("/api/meetings/scheduled", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			handleGetScheduledMeetings(w, r)
		} else {
			fail(w, "Method not allowed", 405)
		}
	})
	mux.HandleFunc("/api/meetings/scheduled/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			handleDeleteScheduledMeeting(w, r)
		} else {
			fail(w, "Method not allowed", 405)
		}
	})
	mux.HandleFunc("/api/meetings/schedule", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			handleScheduleMeeting(w, r)
		} else {
			fail(w, "Method not allowed", 405)
		}
	})
	mux.HandleFunc("/api/meetings/validate/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			handleValidateRoomCode(w, r)
		} else {
			fail(w, "Method not allowed", 405)
		}
	})

	// Proxy /asr → ws://localhost:8765 (NeMo ASR server)
	asrTarget, _ := url.Parse("http://localhost:8765")
	asrProxy := httputil.NewSingleHostReverseProxy(asrTarget)
	mux.HandleFunc("/asr", func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/"
		asrProxy.ServeHTTP(w, r)
	})

	log.Println("[Server] listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", cors(mux)))
}
