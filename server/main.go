package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/rsa"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

const (
	// The value this used to be hardcoded to. Kept ONLY so the startup guard can
	// recognise and refuse it — never used to sign anything.
	jwtKeyLegacyDefault = "ibconnect_jwt_secret_prod_2024_change_me"
	jwtExpiry           = 30 * 24 * time.Hour
)

// jwtKey signs every session token. It used to be the compile-time constant
// above, which meant the signing key for production sessions lived in the git
// history — anyone able to read the repo could mint a valid token for any user
// id, with no password and no OIDC round-trip. It now comes from the
// environment (systemd already loads EnvironmentFile=/etc/ibconnect/env).
//
// Rotating it invalidates every existing session, so everyone signs in again.
var jwtKey = os.Getenv("IBCONNECT_JWT_SECRET")

// mustHaveSigningKey refuses to start rather than fall back to a known key.
// A silent fallback is how the old value survived for months: everything kept
// working, so nothing ever surfaced the problem.
// mustEnv fails fast on a missing credential rather than starting up degraded.
func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("%s is not set. Add it to /etc/ibconnect/env (chmod 600) and restart.", key)
	}
	return v
}

func mustHaveSigningKey() {
	switch {
	case jwtKey == "":
		log.Fatal("IBCONNECT_JWT_SECRET is not set. Generate one with `openssl rand -base64 48`, " +
			"put it in /etc/ibconnect/env as IBCONNECT_JWT_SECRET=..., chmod 600, and restart. " +
			"Refusing to start rather than sign sessions with a default key.")
	case jwtKey == jwtKeyLegacyDefault:
		log.Fatal("IBCONNECT_JWT_SECRET is still the old hardcoded value, which is public in the " +
			"git history. Generate a fresh one with `openssl rand -base64 48`. Refusing to start.")
	case len(jwtKey) < 32:
		log.Fatalf("IBCONNECT_JWT_SECRET is only %d characters; use at least 32 (openssl rand -base64 48).", len(jwtKey))
	}
}

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

const (
	chatPongWait   = 30 * time.Second
	chatPingPeriod = (chatPongWait * 8) / 10
	// Mirrors sigWriteWait/sigSendBuffer on the signaling side — see the
	// comment on ChatConn.send for why chat now uses the same shape.
	chatWriteWait  = 10 * time.Second
	chatSendBuffer = 256
)

type ChatConn struct {
	uid  string
	conn *websocket.Conn

	// Outbound queue — the same fix SigClient already carries (see its own
	// comment), ported here because the chat socket had both halves of the bug
	// the signaling socket was fixed for:
	//
	//   1. push() held c.mu across conn.WriteMessage with NO write deadline, so
	//      one client that stopped reading blocked that goroutine forever while
	//      holding the mutex. Callers spawned `go c.push(...)`, so every
	//      subsequent message to that connection parked another goroutine on the
	//      same mutex, without bound.
	//   2. Because delivery was one detached goroutine per message and goroutine
	//      scheduling is not FIFO, two messages sent microseconds apart could
	//      arrive at the client in either order.
	//
	// A single writePump draining an ordered channel fixes both: ordering
	// becomes structural rather than incidental, and a client that will not
	// drain is dropped instead of accumulating goroutines.
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

// kill tears the connection down from the writer side. Closing the socket makes
// the read loop's ReadMessage fail, so handleChatWS's existing deferred
// chatDisconnect still runs — there is no second cleanup path to keep in sync.
func (c *ChatConn) kill() {
	c.closeOnce.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

// writePump is the ONLY goroutine that writes to this socket. Gorilla requires a
// single writer, and folding the keepalive ping in here (rather than the separate
// ping goroutine handleChatWS used to start, which needed c.mu to coordinate with
// push) is what makes that true with no locking at all.
func (c *ChatConn) writePump() {
	ticker := time.NewTicker(chatPingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(chatWriteWait)) //nolint
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.kill()
				return
			}
		case <-ticker.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(chatWriteWait)); err != nil {
				c.kill()
				return
			}
		case <-c.done:
			return
		}
	}
}

// push enqueues; it never blocks and never touches the socket. Callers therefore
// no longer need (and must no longer use) a `go` prefix — that was what made
// delivery unordered.
func (c *ChatConn) push(msgType string, payload any) {
	data, _ := json.Marshal(payload)
	msg, _ := json.Marshal(map[string]any{"type": msgType, "payload": json.RawMessage(data)})
	select {
	case c.send <- msg:
	case <-c.done:
	default:
		// Queue full: this client is not draining its socket. Drop it rather
		// than let it accumulate — same call the signaling path already makes.
		log.Printf("[ChatWS] send queue full for %s — dropping connection", c.uid)
		c.kill()
	}
}

var (
	chatMu sync.RWMutex
	// Same user can have several live connections at once (multiple tabs/devices) —
	// this used to be a single *ChatConn per uid, so opening a second tab and later
	// closing the first one would delete the *second* tab's (still-live) connection
	// out of the map, wrongly broadcasting "offline" while the user was still
	// connected, and silently killing push delivery (new messages, typing_start/stop)
	// to their surviving tab until they refreshed. Track a set of connections per uid
	// instead: "online" fires on the first connect, "offline" only on the last
	// disconnect, and every push fans out to all of a user's live connections.
	chatClients = map[string]map[*ChatConn]bool{}
)

func chatConnect(uid string, c *ChatConn) {
	chatMu.Lock()
	conns, ok := chatClients[uid]
	if !ok {
		conns = map[*ChatConn]bool{}
		chatClients[uid] = conns
	}
	isFirst := len(conns) == 0
	conns[c] = true
	chatMu.Unlock()
	if isFirst {
		db.Exec(`UPDATE users SET status='online' WHERE id=?`, uid) //nolint
		broadcastStatus(uid, "online")
	}
}

func chatDisconnect(uid string, c *ChatConn) {
	chatMu.Lock()
	conns, ok := chatClients[uid]
	isLast := false
	if ok {
		delete(conns, c)
		if len(conns) == 0 {
			delete(chatClients, uid)
			isLast = true
		}
	}
	chatMu.Unlock()
	if isLast {
		db.Exec(`UPDATE users SET status='offline' WHERE id=?`, uid) //nolint
		broadcastStatus(uid, "offline")
	}
}

func broadcastStatus(uid, status string) {
	chatMu.RLock()
	defer chatMu.RUnlock()
	payload := map[string]string{"id": uid, "status": status}
	for _, conns := range chatClients {
		for c := range conns {
			c.push("user_status", payload)
		}
	}
}

func pushTo(uids []string, msgType string, payload any) {
	chatMu.RLock()
	defer chatMu.RUnlock()
	for _, uid := range uids {
		for c := range chatClients[uid] {
			c.push(msgType, payload)
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
			 WHERE m.thread_id=t.id AND m.sender_id <> tm.user_id
			   AND (tm.last_read_at IS NULL OR m.created_at > tm.last_read_at))
		FROM threads t WHERE t.id=?
	`, forUID, threadID).Scan(&t.ID, &t.Type, &t.Name, &t.Avatar, &lastMsg, &ts, &t.UnreadCount)
	if err != nil {
		return t, err
	}
	// A DM's stored name/avatar are whatever the *creator* saw at creation time — i.e. the
	// other participant from their side only. Served as-is, the recipient sees their own
	// name and their own avatar as the thread title. Resolve the counterpart live, per
	// viewer, which also keeps the title in step with display-name/avatar changes.
	if t.Type == "dm" {
		var otherName, otherAvatar string
		if e := db.QueryRow(`
			SELECT u.display_name, COALESCE(u.avatar,'')
			FROM thread_members tm JOIN users u ON u.id=tm.user_id
			WHERE tm.thread_id=? AND tm.user_id<>? LIMIT 1
		`, threadID, forUID).Scan(&otherName, &otherAvatar); e == nil && otherName != "" {
			t.Name = otherName
			t.Avatar = otherAvatar
		}
	}
	if lastMsg.Valid {
		t.LastMessage = friendlyMessagePreview(lastMsg.String)
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

// ── Continue with IB (OIDC client of the IB Account identity provider) ──────
//
// IB Connect never collects or stores a password itself anymore: the hosted
// IB Account login/register/OTP/forgot-password UI does that, and hands back
// a verified OIDC id_token. This handler exchanges the authorization code
// the browser received, verifies the id_token against IB Account's JWKS, and
// upserts the local user row (matched by email so pre-existing accounts keep
// their internal id — and therefore their calendar/calls/preferences
// localStorage — unchanged) before minting IB Connect's own session JWT.

var (
	ibAccountIssuer       = strings.TrimSuffix(getenvOr("IB_ACCOUNT_ISSUER", "https://meet.icebrkr.space/auth"), "/")
	ibAccountClientID     = os.Getenv("IB_ACCOUNT_CLIENT_ID")
	ibAccountClientSecret = os.Getenv("IB_ACCOUNT_CLIENT_SECRET")
	ibAccountRedirectURI  = getenvOr("IB_ACCOUNT_REDIRECT_URI", "https://meet.icebrkr.space/")

	jwksMu      sync.RWMutex
	jwksKeys    map[string]*rsa.PublicKey
	jwksFetched time.Time
)

func getenvOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

type oidcIDClaims struct {
	Name          string `json:"name"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Nonce         string `json:"nonce"`
	jwt.RegisteredClaims
}

// fetchJWKS returns IB Account's current signing keys, refreshing at most
// every 10 minutes (rotation-tolerant: a kid miss forces an immediate
// refetch in verifyIDToken's caller path isn't implemented here since a
// 10-minute cache window is well within any reasonable rotation grace period).
func fetchJWKS() (map[string]*rsa.PublicKey, error) {
	jwksMu.RLock()
	if jwksKeys != nil && time.Since(jwksFetched) < 10*time.Minute {
		defer jwksMu.RUnlock()
		return jwksKeys, nil
	}
	jwksMu.RUnlock()

	resp, err := http.Get(ibAccountIssuer + "/oauth/jwks.json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var doc struct {
		Keys []struct {
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	keys := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		e := 0
		for _, eb := range eBytes {
			e = e<<8 | int(eb)
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}
	}
	jwksMu.Lock()
	jwksKeys = keys
	jwksFetched = time.Now()
	jwksMu.Unlock()
	return keys, nil
}

func verifyIDToken(idToken string) (*oidcIDClaims, error) {
	var claims oidcIDClaims
	_, err := jwt.ParseWithClaims(idToken, &claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		kid, _ := t.Header["kid"].(string)
		keys, err := fetchJWKS()
		if err != nil {
			return nil, err
		}
		key, ok := keys[kid]
		if !ok {
			return nil, fmt.Errorf("unknown signing key %q", kid)
		}
		return key, nil
	}, jwt.WithIssuer(ibAccountIssuer), jwt.WithAudience(ibAccountClientID))
	if err != nil {
		return nil, err
	}
	return &claims, nil
}

func handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"code_verifier"`
		Nonce        string `json:"nonce"`
	}
	if json.NewDecoder(r.Body).Decode(&b) != nil || b.Code == "" || b.CodeVerifier == "" || b.Nonce == "" {
		fail(w, "invalid request", 400)
		return
	}

	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {b.Code},
		"redirect_uri":  {ibAccountRedirectURI},
		"code_verifier": {b.CodeVerifier},
		"client_id":     {ibAccountClientID},
		"client_secret": {ibAccountClientSecret},
	}
	tokenResp, err := http.PostForm(ibAccountIssuer+"/oauth/token", form)
	if err != nil {
		fail(w, "could not reach IB Account", 502)
		return
	}
	defer tokenResp.Body.Close()
	var tokenData struct {
		IDToken string `json:"id_token"`
	}
	if json.NewDecoder(tokenResp.Body).Decode(&tokenData) != nil || tokenResp.StatusCode != 200 || tokenData.IDToken == "" {
		fail(w, "sign-in with IB Account failed", 401)
		return
	}

	claims, err := verifyIDToken(tokenData.IDToken)
	if err != nil || claims.Email == "" || claims.Subject == "" {
		fail(w, "could not verify IB Account identity", 401)
		return
	}
	if claims.Nonce != b.Nonce {
		fail(w, "could not verify IB Account identity", 401)
		return
	}
	email := strings.ToLower(strings.TrimSpace(claims.Email))
	sub := claims.Subject
	name := claims.Name
	if name == "" {
		name = strings.Split(email, "@")[0]
	}

	var u User
	err = db.QueryRow(
		`SELECT id,username,display_name,email,COALESCE(avatar,''),COALESCE(bio,''),status,created_at FROM users WHERE email=?`,
		email,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Avatar, &u.Bio, &u.Status, &u.CreatedAt)

	if err != nil {
		id := "user-" + newID()
		baseUsername := strings.ToLower(strings.Split(email, "@")[0])
		if _, insertErr := db.Exec(
			`INSERT INTO users(id,username,display_name,email,password_hash,status,ib_sub,auth_provider) VALUES(?,?,?,?,'','online',?,'ib_account')`,
			id, baseUsername, name, email, sub,
		); insertErr != nil {
			fail(w, "could not provision account", 500)
			return
		}
		u = User{ID: id, Username: baseUsername, DisplayName: name, Email: email, Status: "online", CreatedAt: time.Now()}
	} else {
		db.Exec(`UPDATE users SET status='online', ib_sub=COALESCE(ib_sub,?), auth_provider='ib_account' WHERE id=?`, sub, u.ID) //nolint
		u.Status = "online"
	}
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
		fallbackEmail := uid + "@" + ssoEmailDomain
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
	for _, conns := range chatClients {
		for c := range conns {
			c.push("user_updated", u)
		}
	}
	chatMu.RUnlock()
	ok(w, u)
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
	isRead := strings.HasSuffix(path, "/read")
	threadID := strings.TrimSuffix(strings.TrimSuffix(path, "/messages"), "/read")
	if !isMember(threadID, uid) {
		fail(w, "not a member", 403)
		return
	}

	// POST /api/threads/{id}/read — the only way to clear unread for messages that arrived while
	// the thread was already open. Those come in over the chat WS, which never touches the DB, so
	// without this the client zeroes the badge locally and the server still counts them: the badge
	// reappears on the next reload for messages the user has demonstrably already seen.
	if isRead {
		if r.Method != "POST" {
			fail(w, "method not allowed", 405)
			return
		}
		db.Exec(`UPDATE thread_members SET last_read_at=NOW(6) WHERE thread_id=? AND user_id=?`, threadID, uid) //nolint
		ok(w, map[string]any{"ok": true})
		return
	}

	if r.Method == "GET" {
		rows, err := db.Query(`
			SELECT m.id, m.thread_id, COALESCE(m.sender_id,''), COALESCE(u.display_name,'IB Connect'), COALESCE(u.avatar,''),
				m.text, DATE_FORMAT(m.created_at,'%h:%i %p'),
				UNIX_TIMESTAMP(m.created_at)*1000,
				COALESCE(m.file_name,''), COALESCE(m.file_size,0),
				COALESCE(m.file_type,''), COALESCE(m.file_data,'')
			FROM messages m LEFT JOIN users u ON u.id=m.sender_id
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
		// NOW(6), not NOW(): messages.created_at is DATETIME(6) but bare NOW() truncates to whole
		// seconds, so a message written at 07:13:19.575786 stays "unread" against a marker of
		// 07:13:19.000000 — forever, since nothing ever re-reads it. That off-by-a-fraction is
		// what made a thread you had just opened (or posted in) keep a stuck unread badge.
		db.Exec(`UPDATE thread_members SET last_read_at=NOW(6) WHERE thread_id=? AND user_id=?`, threadID, uid) //nolint
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
		SELECT m.id, m.thread_id, COALESCE(m.sender_id,''), COALESCE(u.display_name,'IB Connect'), COALESCE(u.avatar,''),
			m.text, DATE_FORMAT(m.created_at,'%h:%i %p'),
			UNIX_TIMESTAMP(m.created_at)*1000
		FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.id=?
	`, msgID).Scan(&m.ID, &m.ThreadID, &m.SenderID, &m.SenderName, &m.SenderAvatar, &m.Text, &m.Time, &ts) //nolint
	m.Timestamp = int64(ts)
	if b.File != nil {
		m.File = b.File
	}
	members := threadMembers(threadID)
	pushTo(members, "new_message", map[string]any{"threadId": threadID, "message": m})
	db.Exec(`UPDATE thread_members SET last_read_at=NOW(6) WHERE thread_id=? AND user_id=?`, threadID, uid) //nolint
	// AI Calendar Intelligence, live: a cheap keyword check on the just-sent
	// message decides whether it's worth an (expensive, slow — this model
	// measures 60-200s per call) meeting-detection pass. Fired async so
	// sending a message is never blocked on it; the eventual result (if any)
	// arrives as its own chat message a couple of minutes later, not inline.
	if looksLikeMeetingMention(b.Text) {
		go detectAndSyncMeeting(threadID)
	}
	ok(w, m)
}

// ── Chat WebSocket ────────────────────────────────────────────────────────────

// clientIP prefers X-Forwarded-For since every request arrives via nginx.
func roomLabel(c *SigClient) string {
	if c.room == nil {
		return "(none)"
	}
	return c.room.id
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		if i := strings.IndexByte(f, ','); i > 0 {
			return strings.TrimSpace(f[:i])
		}
		return strings.TrimSpace(f)
	}
	return r.RemoteAddr
}

func handleChatWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	claims, err := parseToken(token)
	if err != nil {
		// Previously silent. The single 401 that explained the 2026-08-12
		// incident existed ONLY in nginx's access log — the app logged nothing,
		// and the browser cannot see a WebSocket handshake status at all. Log
		// the reason (expired vs bad signature vs malformed) so an expired
		// session is never again mistaken for the server being down.
		reason := "malformed"
		switch {
		case token == "":
			reason = "missing token"
		case errors.Is(err, jwt.ErrTokenExpired):
			reason = "expired"
		case errors.Is(err, jwt.ErrTokenSignatureInvalid):
			reason = "bad signature (key rotated?)"
		}
		log.Printf("[ChatWS] AUTH REJECTED from %s: %s (%v)", clientIP(r), reason, err)
		http.Error(w, "unauthorized", 401)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &ChatConn{
		uid:  claims.UserID,
		conn: conn,
		send: make(chan []byte, chatSendBuffer),
		done: make(chan struct{}),
	}
	go c.writePump()
	chatConnect(claims.UserID, c)

	// Without a keepalive, a connection that dies without a clean close frame
	// (laptop sleep, wifi drop, browser force-quit, crash) is never noticed —
	// conn.ReadMessage() below just blocks forever, so chatDisconnect never runs
	// and the user is stuck showing "online" indefinitely. Pings force the issue:
	// if no pong arrives within chatPongWait, the read deadline trips and
	// ReadMessage returns an error, unblocking the loop and running the deferred
	// cleanup below like any other disconnect.
	conn.SetReadDeadline(time.Now().Add(chatPongWait)) //nolint
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(chatPongWait)) //nolint
		return nil
	})
	// The ping ticker that used to live here as its own goroutine (taking c.mu
	// to coordinate with push) is now inside writePump, which is the single
	// writer. Nothing else may write to this socket.

	defer func() {
		chatDisconnect(claims.UserID, c)
		c.kill()
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
			email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL, avatar LONGTEXT, bio TEXT,
			status VARCHAR(50) DEFAULT 'offline', created_at DATETIME(6) DEFAULT NOW(6))`,
		`CREATE TABLE IF NOT EXISTS threads (
			id VARCHAR(255) PRIMARY KEY, type VARCHAR(50) NOT NULL, name VARCHAR(255) NOT NULL, avatar LONGTEXT,
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
		// Identity now comes from IB Account (see handleOIDCCallback) rather
		// than a locally-collected password; CREATE TABLE IF NOT EXISTS above
		// won't retrofit these onto an already-existing users table, so they
		// need explicit ALTERs.
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS ib_sub VARCHAR(255) UNIQUE`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'local'`,
		`ALTER TABLE users MODIFY password_hash TEXT NULL`,
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
type JoinResponsePayload struct {
	RequestID string `json:"request_id"`
	Approve   bool   `json:"approve"`
}
type ChatPayload struct{ Text string `json:"text"` }
type ReactionPayload struct{ Emoji string `json:"emoji"` }

// Kept in sync with REACTIONS in src/lib/reactions.ts. Anything not listed here is
// dropped silently rather than rejected — a client sending an unknown reaction is
// either out of date or malicious, and neither deserves an error round-trip.
var allowedReactions = map[string]bool{
	"👍": true, "👏": true, "🎉": true, "❤️": true,
	"😂": true, "😮": true, "🤔": true, "👋": true,
}

type HandPayload struct{ Raised bool `json:"raised"` }
type CaptionLangPayload struct{ Lang string `json:"lang"` }
type RequireApprovalPayload struct {
	Value bool `json:"value"`
}
type PeerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type SigClient struct {
	id   string
	name string
	conn *websocket.Conn
	room *Room

	// Set only while this client is knocking — waiting in PendingJoin for an
	// accept/reject — and nil otherwise. room stays nil for the whole
	// duration of a knock (this client is deliberately NOT a room member
	// yet), so the normal deferred-leaveRoom cleanup in handleSignaling can't
	// find and clean up a pending knock the way it does a real membership;
	// these two fields are what let it do that instead, e.g. if the knocking
	// browser closes the tab before anyone answers.
	pendingRoom  *Room
	pendingReqID string

	// Which language, if any, this client wants live captions translated
	// into. Read by transcription_relay.go's activeCaptionLangs (a snapshot
	// across every client in a room) and written by the "caption_lang" case
	// below — both cross-goroutine, so guarded by room.mu like the rest of
	// Room's mutable state rather than SigClient's own fields, which are
	// otherwise set once at join and not concurrently mutated.
	captionLang string

	// Outbound queue. Writes used to happen synchronously inside broadcast(),
	// while it held the room's read lock — so one client whose TCP send buffer
	// was full (a phone on bad mobile data) blocked delivery to everyone behind
	// it in the map AND blocked enterRoom/leaveRoom, which take the write lock.
	// In a large room that serialised every join and leave behind the slowest
	// socket, which is why joiners stayed invisible until they reloaded.
	// Now sendMsg only enqueues; a single writePump goroutine owns the socket.
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

// kill tears the connection down from the writer side. Closing the conn makes the
// read loop's ReadMessage fail, so the normal deferred leaveRoom still runs and
// the room stays consistent — there is no separate cleanup path to keep in sync.
func (c *SigClient) kill() {
	c.closeOnce.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

// writePump is the ONLY goroutine that writes to the socket. Gorilla requires a
// single writer, and folding the keepalive ping in here (rather than a second
// goroutine with a mutex) is what makes that true without any locking.
func (c *SigClient) writePump() {
	ticker := time.NewTicker(sigPingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(sigWriteWait)) //nolint
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.kill()
				return
			}
		case <-ticker.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(sigWriteWait)); err != nil {
				c.kill()
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *SigClient) sendMsg(t string, payload any) {
	data, _ := json.Marshal(payload)
	msg, _ := json.Marshal(WSMessage{Type: t, Payload: json.RawMessage(data)})
	select {
	case c.send <- msg:
	case <-c.done:
	default:
		// The queue is full, so this client is not draining its socket. Drop it
		// rather than stall the room: a ghost that everyone waits on is strictly
		// worse than a peer that disconnects and reconnects.
		log.Printf("[Signaling] send queue full for %s (%s) — dropping connection", c.id, c.name)
		c.kill()
	}
}

type Room struct {
	id      string
	clients map[string]*SigClient
	mu      sync.RWMutex

	// reap is a pending "delete this empty room" timer, guarded by roomsMu (not
	// room.mu) because firing it mutates the global rooms map. An empty room is
	// kept alive for emptyRoomGrace rather than deleted on the spot so that a
	// participant who reloads the page — including the host, whose departure
	// empties a 1-person room instantly — can rejoin the same code instead of
	// getting "Room not found".
	reap *time.Timer

	// admitted is every user id that has ever been let into THIS room instance
	// (the creator, plus anyone an existing participant approved) — it is
	// checked on every join_room, not just once, so a reconnect (network blip,
	// second tab, page reload) never re-triggers the knock/approve flow for an
	// identity that's already been let in. It intentionally outlives a
	// temporary empty room (survives the emptyRoomGrace window) so the host
	// reloading mid-call doesn't get knocked out of their own meeting.
	admitted map[string]bool

	// pending holds join requests currently awaiting an accept/reject from
	// someone already in the room, keyed by a random request id (not by user
	// id — nothing stops two different unadmitted people from knocking at
	// once, and each needs its own independent decision).
	pending map[string]*PendingJoin

	// requireApproval is the knock-to-join feature's on/off switch for this
	// room, defaulting to false. OPT-IN, not automatic, and deliberately so:
	// a first version that gated every join unconditionally was measured
	// directly against this repo's own existing call-flow test suite before
	// shipping and broke a real chunk of it (multi-party join, screen share,
	// speaker promotion — any scenario assuming a second participant is
	// visible immediately) precisely because most real calls here are among
	// already-known teammates who don't want a gate on every join. Toggled at
	// any time by anyone currently in the room via the "require_approval" WS
	// message (see JoinRequestBanner/MeetingInviteDialog on the frontend) —
	// not only at creation time, so a host can turn it on mid-call if an
	// unexpected link gets forwarded around.
	requireApproval bool
}

// PendingJoin is one knock-to-join request waiting on a decision. The
// requester's own SigClient is held here — not yet in room.clients, not yet
// broadcastable to — until join_response resolves it one way or the other.
type PendingJoin struct {
	client   *SigClient
	userID   string
	userName string
}

// joinRequestTimeout bounds how long a knock can sit unanswered. Without
// this, a requester whose knock nobody notices (everyone's attention is on
// the call itself) would wait forever with no feedback — auto-rejecting
// after a while at least tells them clearly to try again rather than
// leaving them on an indefinite "waiting to be let in" screen.
const joinRequestTimeout = 60 * time.Second

const emptyRoomGrace = 90 * time.Second

// WebSocket close codes 4000-4999 are reserved for private/application use per RFC
// 6455 6.4. Sent to a socket evicted by enterRoom (see there for why this matters —
// without it the client sees code 1006 and reconnects straight into another eviction).
const evictedCode = 4001

// Signaling keepalive. A call can legitimately sit idle on the wire for minutes
// (media flows peer-to-peer, not through here), so nothing else would notice a
// dead socket. Same shape as the chat WS's ping loop.
const (
	sigPongWait   = 30 * time.Second
	sigPingPeriod = (sigPongWait * 8) / 10
	sigWriteWait  = 10 * time.Second
	// Deep enough to absorb a burst (a 35-person room re-offering at once) but
	// shallow enough that a genuinely stuck client is detected in seconds.
	sigSendBuffer = 256
)

// wsLeaveGraceInterval bounds the /ws-vs-LiveKit membership divergence
// documented in CLAUDE.md's 2026-08-27 known-limitation entry: killing only a
// client's /ws socket (LiveKit connection untouched — a network blip, a
// backgrounded tab, a brief wifi handoff) used to call leaveRoom() the
// instant the read loop errored out, which for the ~1s until
// SignalingSocket's own reconnect logic healed it, made isRoomMember() (the
// gate /api/livekit/token and /asr both check) wrongly say this very-much-
// still-on-the-call participant wasn't in the room.
//
// This is deliberately NOT the LiveKit-disconnect-webhook or reconciliation
// approach CLAUDE.md sketched as the backlog fix — that direction turned out
// to be the wrong tool for this specific bug. The measured divergence is
// /ws's roster lagging BEHIND live reality (still on the call, briefly
// unrecognised), not /ws being stale about someone who actually left; a
// LiveKit-driven eviction would only ever help the opposite case, and if
// wired to fire on every transient LiveKit hiccup it would newly risk
// evicting someone who never actually left. What actually fixes the measured
// case is not being trigger-happy about a bare /ws disconnect: delay
// leaveRoom() by a short grace window instead of running it inline in the
// deferred cleanup below. enterRoom() already overwrites
// room.clients[client.id] the instant a reconnect's join_room/create_room
// lands (server/main.go, enterRoom), and leaveRoom() already only vacates
// "if the room still points at *this* connection" — so a delayed leaveRoom
// for a client that has since reconnected finds someone else's entry in its
// place and correctly no-ops, with no new bookkeeping needed to "cancel" it.
// A genuine departure (tab closed, network gone for good) just waits out the
// same window before anyone sees peer_left / a lowered hand / cleared
// captions for them — an imperceptible cost for the rare real case, against
// closing a real spurious-403 window for the common transient one.
//
// 3s is chosen with margin over the measured ~1s self-heal: backoffDelay's
// first reconnect attempt alone is ~0.7-1.3s (1000ms base * 0.7-1.3 jitter,
// diagnostics.ts), before the actual reconnect handshake and rejoin
// round-trip even start.
const wsLeaveGraceInterval = 3 * time.Second

// maxRoomSize caps participants per room. DEFAULT IS 0 = UNLIMITED, deliberately:
// turning a cap on silently would start rejecting users from calls that
// currently connect. Set MAX_ROOM_SIZE in /etc/ibconnect/env to enforce one.
//
// The "6-8 people" this comment used to cite was a MESH figure and has been
// stale since the 2026-08-27 LiveKit migration: it came from a 4-core test VM
// where the LOAD GENERATOR saturated while LiveKit's own process sat at
// 0.04-0.13 cores, so it never measured this server at all. It has now been
// measured properly, and the server is nowhere near being the constraint:
//
//   - signaling: 10,000 concurrent /ws connections = 544 MB, 0.08 cores,
//     0% loss, p99 fan-out 7.9 ms; 1,000 in ONE room = p99 11.9 ms
//   - SFU: 0.007-0.011 cores per forwarded Mbps, so saturating the whole
//     625 Mbps WAN link costs ~5.6 of this box's 32 cores
//   - a real 7-person production meeting (2026-09-06 23:29-00:20) peaked at
//     24.97 Mbps egress (4.0% of the link) and 1.42 cores of LiveKit CPU
//
// What actually binds first is CLIENT-side: VP8 software decode (16 tiles is
// ~73.8 Mpixel/s), then the grid layout, then the WAN at N~82. See
// ibconnect-planning/{MAX_ROOM_SIZE,ARCHITECTURE_scale}.md for the arithmetic.
var maxRoomSize = func() int {
	n, err := strconv.Atoi(os.Getenv("MAX_ROOM_SIZE"))
	if err != nil || n < 0 {
		return 0
	}
	return n
}()

// roomIsFull reports whether the room already holds maxRoomSize *other* clients.
// Re-entry by an id already in the room (a reload) is never counted as growth.
func roomIsFull(room *Room, clientID string) bool {
	if maxRoomSize <= 0 {
		return false
	}
	room.mu.RLock()
	defer room.mu.RUnlock()
	if _, rejoining := room.clients[clientID]; rejoining {
		return false
	}
	return len(room.clients) >= maxRoomSize
}

// sigReporter (offer/answer/ICE-candidate volume logging) was removed here as
// part of the mesh->LiveKit migration (2026-08-27) — it measured mesh
// renegotiation traffic that no longer flows through this socket at all.
// LiveKit's own server has its own telemetry for SFU-side traffic; this was
// never that, so nothing replaces it here.

func (room *Room) broadcast(senderID, t string, payload any) {
	// Snapshot the recipients, then release the lock before touching any socket.
	// sendMsg can now call kill() on a client that has fallen behind, and doing
	// that while holding room.mu would deadlock against leaveRoom.
	room.mu.RLock()
	targets := make([]*SigClient, 0, len(room.clients))
	for id, c := range room.clients {
		if id != senderID {
			targets = append(targets, c)
		}
	}
	room.mu.RUnlock()
	for _, c := range targets {
		c.sendMsg(t, payload)
	}
}

// broadcastAll is broadcast without excluding the sender — used for captions,
// which need to reach the speaker too (in whatever language THEY have
// selected, which may differ from the language they're speaking).
func (room *Room) broadcastAll(t string, payload any) {
	room.mu.RLock()
	targets := make([]*SigClient, 0, len(room.clients))
	for _, c := range room.clients {
		targets = append(targets, c)
	}
	room.mu.RUnlock()
	for _, c := range targets {
		c.sendMsg(t, payload)
	}
}

var (
	roomsMu sync.RWMutex
	rooms   = map[string]*Room{}
)

// cancelReapLocked stops a pending empty-room deletion. Caller must hold roomsMu.
func cancelReapLocked(room *Room) {
	if room.reap != nil {
		room.reap.Stop()
		room.reap = nil
	}
}

// scheduleReap arms the delayed deletion of a room that just became empty.
func scheduleReap(room *Room) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	cancelReapLocked(room)
	room.reap = time.AfterFunc(emptyRoomGrace, func() {
		roomsMu.Lock()
		defer roomsMu.Unlock()
		room.mu.RLock()
		empty := len(room.clients) == 0
		room.mu.RUnlock()
		// Somebody rejoined during the grace window — keep the room.
		if !empty {
			return
		}
		// Only delete if the map still points at this exact Room value.
		if rooms[room.id] == room {
			delete(rooms, room.id)
			log.Printf("Room %s closed (empty after grace)", room.id)
		}
	})
}

// enterRoom registers client in room, evicting any previous connection that was
// holding the same user id (a reload leaves the old socket briefly alive). It
// returns the peers that were already present, never including the caller.
// markAdmitted records that userID has been let into room at least once —
// checked by join_room on every subsequent attempt so a reconnect (network
// blip, second tab, reload) never re-triggers the knock/approve flow for an
// identity that's already inside.
func markAdmitted(room *Room, userID string) {
	room.mu.Lock()
	if room.admitted == nil {
		room.admitted = map[string]bool{}
	}
	room.admitted[userID] = true
	room.mu.Unlock()
}

// attemptRoomEntry is the shared knock-to-join gate behind both create_room
// and join_room: an already-admitted identity (the creator, or anyone
// previously approved into this exact room instance) is let straight in,
// same as before this feature existed; anyone else, when the room already
// has other members, must wait for one of them to accept or reject before
// being admitted. successType is which event the caller gets on immediate
// (non-knock) entry — "room_created" for create_room, "room_joined" for
// join_room; once a knock is actually decided by someone, the outcome is
// always reported as "room_joined" regardless of which message type
// triggered the knock, since by then "you're in" is the only thing that's
// true — nothing was created.
//
// Applying this to create_room too (not just join_room) closes a real gap a
// join_room-only version would leave open: create_room reuses an existing
// room for its code rather than replacing it (see its own comment), so
// without this same gate anyone could bypass the whole approval flow simply
// by sending create_room with a room code they'd learned instead of
// join_room — the room object is identical either way, and admission should
// not depend on which message type asked for it.
func attemptRoomEntry(client *SigClient, room *Room, successType string) {
	room.mu.RLock()
	alreadyAdmitted := room.admitted[client.id]
	empty := len(room.clients) == 0
	requireApproval := room.requireApproval
	room.mu.RUnlock()

	if !requireApproval || alreadyAdmitted || empty {
		markAdmitted(room, client.id)
		peers := enterRoom(client, room)
		log.Printf("Room %s entered by %s (%s) via %s, now %d participant(s)",
			room.id, client.id, client.name, successType, len(peers)+1)
		client.sendMsg(successType, map[string]any{"room_id": room.id, "peers": peers})
		if len(peers) > 0 {
			room.broadcast(client.id, "peer_joined", map[string]string{"peer_id": client.id, "peer_name": client.name})
		}
		return
	}

	// Knock: hold this connection out of room.clients — not a member yet, not
	// broadcastable to, invisible to everyone already inside — until
	// join_response resolves it. client.room deliberately stays nil for this
	// whole window; pendingRoom/pendingReqID are what let the deferred
	// cleanup in handleSignaling find and remove this specific knock if the
	// browser closes the tab before anyone answers (see their own comment).
	reqID := newID()
	room.mu.Lock()
	if room.pending == nil {
		room.pending = map[string]*PendingJoin{}
	}
	room.pending[reqID] = &PendingJoin{client: client, userID: client.id, userName: client.name}
	room.mu.Unlock()

	client.pendingRoom = room
	client.pendingReqID = reqID
	client.sendMsg("join_waiting", map[string]string{"room_id": room.id})
	room.broadcastAll("join_request", map[string]string{
		"request_id": reqID, "user_id": client.id, "user_name": client.name,
	})
	log.Printf("Room %s: %s (%s) is waiting to be let in (request %s)", room.id, client.id, client.name, reqID)

	time.AfterFunc(joinRequestTimeout, func() {
		room.mu.Lock()
		_, stillPending := room.pending[reqID]
		if stillPending {
			delete(room.pending, reqID)
		}
		room.mu.Unlock()
		// If it's already gone, join_response (or a cancellation) beat this
		// timer to it — nothing left to do.
		if stillPending {
			log.Printf("Room %s: join request %s (%s) timed out with no response", room.id, reqID, client.name)
			client.sendMsg("join_rejected", map[string]string{"reason": "timed_out"})
		}
	})
}

func enterRoom(client *SigClient, room *Room) []PeerInfo {
	room.mu.Lock()
	peers := []PeerInfo{}
	for _, c := range room.clients {
		if c.id == client.id {
			continue
		}
		peers = append(peers, PeerInfo{ID: c.id, Name: c.name})
	}
	prev := room.clients[client.id]
	room.clients[client.id] = client
	room.mu.Unlock()

	// Drop the stale socket *after* releasing the lock. Its read loop will error
	// out and run leaveRoom, which no-ops because the map no longer points at it.
	//
	// This eviction is INVISIBLE in the logs until now, and it is a real source of
	// apparent "random disconnects": a room is keyed by user id, so a second tab,
	// a second device, or a fast reload forcibly closes the previous socket. In the
	// 2026-08-10 incident 14 of one participant's 24 disconnects carried this
	// signature (a new connection within <=2s). Whether one user should be able to
	// hold two seats is a product decision, but it must at least be diagnosable.
	if prev != nil && prev != client {
		log.Printf("[Signaling] EVICT %s (%s) from room %s — same user id reconnected (second tab/device or reload)",
			client.id, client.name, room.id)
		// A bare Close() sends no close frame, so the evicted browser sees an
		// uninformative code 1006 ("abnormal") — indistinguishable from a real network
		// failure. Its reconnect logic then treats it as transient and immediately
		// reconnects, which evicts THIS connection in turn: two tabs/devices of the
		// same account can fight over the seat forever, each eviction tearing down and
		// rebuilding every WebRTC connection in the room, which is why "my video keeps
		// coming and going" is the symptom this produces for anyone in a call with that
		// user — not just the two competing tabs. evictedCode lets the client recognise
		// this specific case and stop reconnecting instead of fighting back.
		closeMsg := websocket.FormatCloseMessage(evictedCode, "evicted: signed in from another device or tab")
		_ = prev.conn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(2*time.Second))
		prev.conn.Close()
	}
	client.room = room
	return peers
}

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

// ─── TURN credentials ────────────────────────────────────────────────────────
//
// These used to be a hardcoded username/password pair in the client bundle
// (useWebRTC.ts), i.e. an open relay for anybody who opened the site's
// JavaScript. Serving them from here means they can be short-lived.
//
// ROLLOUT IS TWO-STEP AND ORDER MATTERS. With TURN_STATIC_AUTH_SECRET unset
// this returns the same long-lived credentials as before, so deploying the
// backend and frontend together changes nothing operationally. Only once
// coturn is switched to `use-auth-secret` + a matching `static-auth-secret`
// should the env var be set here. Setting it before coturn is reconfigured
// makes every relayed call fail authentication.
//
// Deliberately unauthenticated: guests join meetings by link without a session
// (see PreJoinScreen), so requiring a JWT here would break guest calls. The
// improvement is that credentials now expire, not that they are gated.

// ─── Client-side diagnostics sink ────────────────────────────────────────────
//
// The 2026-08-10 call RCA and the 2026-08-12 session incident both failed on the
// same gap: everything that actually goes wrong happens in the BROWSER — ICE
// state, WebSocket handshake rejections, media errors — and none of it was ever
// recorded anywhere. The browser cannot even see a WebSocket handshake status.
//
// This accepts connection-lifecycle events from the client and writes them to
// the journal alongside the server's own view, so the two can be correlated.
// Deliberately NOT stored in the database: this is operational telemetry with a
// short useful life, and journald already has rotation and retention.
//
// Scope is connection metadata only — never message contents. Unauthenticated
// because the most important events (a rejected session) happen precisely when
// there is no valid token; the user id is taken from the token when present and
// otherwise reported as anonymous.
func handleClientEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		fail(w, "Method not allowed", 405)
		return
	}
	var body struct {
		// Token fallback: sendBeacon cannot set an Authorization header, so the
		// client includes it here. Header still wins when present.
		Token  string `json:"token"`
		Events []struct {
			T      string         `json:"t"`
			Since  int            `json:"since"`
			Cat    string         `json:"cat"`
			Level  string         `json:"level"`
			Event  string         `json:"event"`
			Detail map[string]any `json:"detail"`
		} `json:"events"`
	}
	// Cap the body so this endpoint cannot be used to flood the journal.
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&body); err != nil {
		fail(w, "bad payload", 400)
		return
	}

	who := "anon"
	if uid, err := bearerUID(r); err == nil {
		who = uid
	} else if body.Token != "" {
		if claims, err := parseToken(body.Token); err == nil {
			who = claims.UserID
		}
	}
	ip := clientIP(r)

	const maxPerBatch = 100
	for i, e := range body.Events {
		if i >= maxPerBatch {
			log.Printf("[Client] %s@%s — %d further events dropped (batch cap)", who, ip, len(body.Events)-maxPerBatch)
			break
		}
		detail := ""
		if len(e.Detail) > 0 {
			if b, err := json.Marshal(e.Detail); err == nil {
				detail = " " + string(b)
			}
		}
		log.Printf("[Client] %s@%s %s/%s +%dms %s%s", who, ip, e.Cat, e.Level, e.Since, e.Event, detail)
	}
	w.WriteHeader(204)
}

func handleTurnCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		fail(w, "Method not allowed", 405)
		return
	}
	host := getenvOr("TURN_HOST", "meet.icebrkr.space")
	ttl := 12 * time.Hour

	var username, credential string
	if secret := os.Getenv("TURN_STATIC_AUTH_SECRET"); secret != "" {
		// coturn's REST-API scheme: username is "<unix-expiry>:<name>" and the
		// credential is base64(HMAC-SHA1(secret, username)).
		username = fmt.Sprintf("%d:ibconnect", time.Now().Add(ttl).Unix())
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username)) //nolint
		credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	} else {
		username = getenvOr("TURN_STATIC_USER", "webrtc")
		credential = getenvOr("TURN_STATIC_PASS", "webrtc123")
		ttl = 0 // static credentials do not expire; tell the client not to refetch on a timer
	}

	ok(w, map[string]any{
		"iceServers": []map[string]any{
			{"urls": []string{"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"}},
			{
				"urls": []string{
					"turn:" + host + ":3478",
					"turn:" + host + ":3478?transport=tcp",
					"turns:" + host + ":5349",
				},
				"username":   username,
				"credential": credential,
			},
		},
		"ttlSeconds": int(ttl.Seconds()),
	})
}

func handleSignaling(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	connectedAt := time.Now()
	client := &SigClient{
		id:   "tmp-" + newID(),
		conn: conn,
		send: make(chan []byte, sigSendBuffer),
		done: make(chan struct{}),
	}
	go client.writePump()
	log.Printf("New signaling client: %s from %s ua=%q", client.id, clientIP(r), r.UserAgent())

	// Keepalive, same reasoning as handleChatWS: a phone that sleeps, switches
	// from wifi to cellular, or drops off the network never sends a close frame,
	// so ReadMessage below would block forever and the client would sit in its
	// room as a ghost — everyone else keeps a frozen tile for someone who is
	// gone, and the room never empties (so it's never reaped). Pings force the
	// issue: no pong within sigPongWait trips the read deadline and the deferred
	// leaveRoom runs like any other disconnect.
	conn.SetReadDeadline(time.Now().Add(sigPongWait)) //nolint
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(sigPongWait)) //nolint
		return nil
	})
	defer func() {
		client.kill()
		// Delayed, not inline — see wsLeaveGraceInterval above for why.
		if client.room != nil {
			time.AfterFunc(wsLeaveGraceInterval, func() { leaveRoom(client) })
		} else if client.pendingRoom != nil {
			// Never made it into room.clients — this connection closed while
			// still knocking, waiting on a join_response nobody sent yet (tab
			// closed, gave up, network dropped). No grace window needed the
			// way a real member gets one: there's no call to preserve, just a
			// knock to withdraw. Racing join_response/the timeout AfterFunc is
			// fine either way — whichever removes the map entry first wins,
			// the other finds it already gone and no-ops (see their comments).
			room := client.pendingRoom
			reqID := client.pendingReqID
			room.mu.Lock()
			_, stillPending := room.pending[reqID]
			if stillPending {
				delete(room.pending, reqID)
			}
			room.mu.Unlock()
			if stillPending {
				room.broadcastAll("join_request_cancelled", map[string]string{"request_id": reqID})
			}
		}
		log.Printf("Signaling client disconnected: %s (%s) after %s, room=%s",
			client.id, client.name, time.Since(connectedAt).Round(time.Second), roomLabel(client))
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

			// Leave whatever room this connection was already in first. Without
			// this the old room keeps a stale entry for us forever: it never
			// becomes empty (so it's never reaped) and everyone still in it sees
			// our name on a frozen, blank tile because no peer_left is ever sent.
			if client.room != nil {
				leaveRoom(client)
			}

			code := p.RoomID
			if code == "" {
				code = genCode()
			}

			// Reuse an existing room with this code rather than replacing it —
			// overwriting rooms[code] used to orphan everyone already inside.
			roomsMu.Lock()
			room, exists := rooms[code]
			if !exists {
				room = &Room{id: code, clients: map[string]*SigClient{}}
				rooms[code] = room
			}
			cancelReapLocked(room)
			roomsMu.Unlock()

			if roomIsFull(room, client.id) {
				client.sendMsg("error", map[string]string{
					"message": fmt.Sprintf("This meeting is full (%d participants max).", maxRoomSize),
				})
				continue
			}

			attemptRoomEntry(client, room, "room_created")
		case "join_room":
			var p JoinRoomPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if p.UserID != "" {
				client.id = p.UserID
			}
			client.name = p.UserName

			// Same leak as create_room: hopping straight from one room to another
			// on a single socket must vacate the first one.
			if client.room != nil {
				leaveRoom(client)
			}

			roomsMu.Lock()
			room, found := rooms[p.RoomID]
			if found {
				cancelReapLocked(room)
			}
			roomsMu.Unlock()
			if !found {
				client.sendMsg("error", map[string]string{"message": "Room not found: " + p.RoomID})
				continue
			}
			if roomIsFull(room, client.id) {
				client.sendMsg("error", map[string]string{
					"message": fmt.Sprintf("This meeting is full (%d participants max).", maxRoomSize),
				})
				continue
			}

			attemptRoomEntry(client, room, "room_joined")
		case "join_response":
			var p JoinResponsePayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room == nil {
				continue // not an actual member of any room — can't approve anyone
			}
			room := client.room
			room.mu.Lock()
			pj, found := room.pending[p.RequestID]
			if found {
				delete(room.pending, p.RequestID)
			}
			room.mu.Unlock()
			if !found {
				// Already decided by someone else, already timed out, or the
				// requester already gave up and disconnected — nothing to do.
				continue
			}
			if p.Approve {
				markAdmitted(room, pj.userID)
				peers := enterRoom(pj.client, room)
				log.Printf("Room %s: %s (%s) admitted by %s after a join request", room.id, pj.userID, pj.userName, client.name)
				pj.client.sendMsg("room_joined", map[string]any{"room_id": room.id, "peers": peers})
				room.broadcast(pj.client.id, "peer_joined", map[string]string{"peer_id": pj.client.id, "peer_name": pj.client.name})
			} else {
				log.Printf("Room %s: %s (%s) was denied entry by %s", room.id, pj.userID, pj.userName, client.name)
				pj.client.sendMsg("join_rejected", map[string]string{"reason": "denied"})
			}
			// Tell everyone else's popup for this same request to close too —
			// only one of possibly several current participants can decide it,
			// and the rest never sent a join_response at all.
			room.broadcastAll("join_request_cancelled", map[string]string{"request_id": p.RequestID})
		// "offer"/"answer"/"ice_candidate" (mesh SDP/ICE relay) and
		// "screen_share_state" (mesh screen-share track presence) were removed
		// here as part of the mesh->LiveKit SFU migration (2026-08-27) — camera/
		// mic media now goes through LiveKit, not through this socket, so there
		// is nothing left to relay. See CLAUDE.md's migration work log:
		// screen sharing rode this exact same relay (kind:"screen" on these same
		// message types) and has NO replacement transport yet — it is
		// deliberately, visibly non-functional until it's rebuilt as a second
		// published LiveKit track, not silently broken. SignalPayload and
		// ScreenSharePayload (the structs these two cases used) were removed
		// with them.
		case "leave_room":
			leaveRoom(client) // no-ops when client.room is nil, and clears it itself
		case "chat_message":
			var p ChatPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room != nil {
				client.room.broadcast(client.id, "chat_message", map[string]string{
					"from_id": client.id, "from_name": client.name,
					"text": p.Text, "time": time.Now().Format("3:04 PM"),
				})
			}
		// Reactions are transient by design: they animate for two seconds and are
		// gone, so they are relayed and never stored. Anyone who joins afterwards
		// has missed them, which is the correct behaviour for a reaction.
		case "reaction":
			var p ReactionPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			// Allow-list rather than relaying whatever arrives: this string is
			// rendered in every other participant's DOM, and an unbounded field
			// here would let one client push arbitrary payloads at the room.
			if client.room != nil && allowedReactions[p.Emoji] {
				client.room.broadcast(client.id, "reaction", map[string]any{
					"peer_id": client.id, "peer_name": client.name, "emoji": p.Emoji,
				})
			}
		// A raised hand is state, not an event — it stays up until lowered, so it
		// carries a boolean like screen_share_state rather than firing once.
		case "hand_state":
			var p HandPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room != nil {
				client.room.broadcast(client.id, "hand_state", map[string]any{
					"peer_id": client.id, "peer_name": client.name, "raised": p.Raised,
				})
			}
		// A viewer's caption-language pick. State, not an event, like
		// hand_state — it stays in effect until changed. Read by
		// transcription_relay.go's activeCaptionLangs to decide which
		// languages a final transcript needs translating into; empty means
		// "no captions" / "show original language only".
		case "caption_lang":
			var p CaptionLangPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room != nil {
				client.room.mu.Lock()
				client.captionLang = p.Lang
				client.room.mu.Unlock()
			}
		// Knock-to-join's on/off switch — see Room.requireApproval's own
		// comment for why this is opt-in rather than automatic, and toggle-
		// able rather than fixed at creation time. Anyone currently in the
		// room can flip it (same trust level as everything else here — no
		// separate host concept exists server-side); broadcast so every
		// other participant's own UI (if it shows the setting at all) stays
		// in sync rather than only reflecting whoever last toggled it.
		case "require_approval":
			var p RequireApprovalPayload
			json.Unmarshal(msg.Payload, &p) //nolint
			if client.room != nil {
				room := client.room
				room.mu.Lock()
				room.requireApproval = p.Value
				room.mu.Unlock()
				room.broadcastAll("require_approval", map[string]bool{"value": p.Value})
			}
		}
	}
}

func leaveRoom(client *SigClient) {
	room := client.room
	if room == nil {
		return
	}
	room.mu.Lock()
	// Only vacate if the room still points at *this* connection. When someone
	// reloads, their new socket takes over the id before the old socket's read
	// loop notices it died; without this guard that late teardown would evict
	// the freshly-rejoined client and broadcast a bogus peer_left for them.
	removed := room.clients[client.id] == client
	if removed {
		delete(room.clients, client.id)
	}
	empty := len(room.clients) == 0
	room.mu.Unlock()
	client.room = nil
	if !removed {
		return
	}
	room.broadcast(client.id, "peer_left", map[string]string{"peer_id": client.id})
	if empty {
		scheduleReap(room)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
	w.Write([]byte("ok")) //nolint
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	mustHaveSigningKey()

	var err error
	cfg := mysql.NewConfig()
	cfg.User = dbUser
	// Was a hardcoded literal, and this repo is PUBLIC on GitHub — the database
	// password was world-readable. Mitigated only by MariaDB binding to localhost,
	// which stops being a mitigation the moment anything else on this host is
	// compromised. Sourced from the environment like every other credential now.
	cfg.Passwd = mustEnv("IBCONNECT_DB_PASSWORD")
	cfg.Net = "tcp"
	// dbUser/dbAddr/dbName default to the current box's values — override via
	// IBCONNECT_DB_USER / IBCONNECT_DB_ADDR / IBCONNECT_DB_NAME (see config.go).
	cfg.Addr = dbAddr
	cfg.DBName = dbName
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
	// Presence is only ever cleared by chatDisconnect's deferred cleanup, which
	// a crash or `kill -9` skips — leaving those rows reading 'online' forever,
	// with no live connection behind them. Nothing is connected yet at this
	// point in startup, so every 'online' row is by definition stale.
	if res, err := db.Exec(`UPDATE users SET status='offline' WHERE status<>'offline'`); err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("[DB] cleared %d stale 'online' status row(s) left by a previous run", n)
		}
	}
	migrateInterview()
	migrateAI()
	migrateAIMeetings()
	migrateAIDocuments()
	migrateMeetingTranscripts()
	startMeetingReminderTicker()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleSignaling)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/chat-ws", handleChatWS)
	mux.HandleFunc("/api/auth/oidc/callback", handleOIDCCallback)
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" { handleUpdateMe(w, r) } else { handleMe(w, r) }
	})
	mux.HandleFunc("/api/turn-credentials", handleTurnCredentials)
	mux.HandleFunc("/api/livekit/token", handleLiveKitToken)
	mux.HandleFunc("/api/client-events", handleClientEvents)
	mux.HandleFunc("/api/interview/", handleInterviewRoutes)
	mux.HandleFunc("/api/ai/status", handleAIStatus)
	mux.HandleFunc("/api/ai/chat", handleAIChat)
	mux.HandleFunc("/api/ai/rewrite", handleAIRewrite)
	mux.HandleFunc("/api/ai/reply-suggestions", handleAIReplySuggestions)
	mux.HandleFunc("/api/ai/ask-thread", handleAIAskThread)
	mux.HandleFunc("/api/ai/analyze-thread", handleAIAnalyzeThread)
	mux.HandleFunc("/api/ai/memory", handleAIMemory)
	mux.HandleFunc("/api/ai/memory/", handleAIMemory)
	mux.HandleFunc("/api/ai/tasks", handleAITasks)
	mux.HandleFunc("/api/ai/tasks/", handleAITaskComplete)
	mux.HandleFunc("/api/ai/reminders", handleAIReminders)
	mux.HandleFunc("/api/ai/reminders/", handleAIReminders)
	mux.HandleFunc("/api/ai/search", handleAISearch)
	mux.HandleFunc("/api/ai/translate", handleAITranslate)
	mux.HandleFunc("/api/ai/documents/extract", handleAIDocumentExtract)
	mux.HandleFunc("/api/ai/documents/ask", handleAIDocumentAsk)
	mux.HandleFunc("/api/meetings/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/transcript"):
			handleMeetingTranscript(w, r)
		case strings.HasSuffix(r.URL.Path, "/summary"):
			handleMeetingSummary(w, r)
		default:
			fail(w, "not found", 404)
		}
	})
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

	// Live-captions relay → the GPU VM (gpu/ASR_CONTRACT.md via asr_gpu.go).
	// Used to reverse-proxy straight to a local Python process on :8765; that
	// process (server/transcription_server.py) is retired — this now goes
	// through handleASRRelay, which is the only thing that knows the GPU
	// VM's address, same as the interview feature.
	mux.HandleFunc("/asr", handleASRRelay)

	// Defaults to the port the systemd unit expects; overridable so a throwaway
	// instance can be run alongside it for testing without restarting production.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Bind to loopback, not 0.0.0.0. nginx proxies to 127.0.0.1:8080 and terminates
	// TLS, but the listener was on every interface, so the API and WebSocket were
	// ALSO reachable directly on the public IP over plain HTTP — bypassing TLS and
	// anything nginx enforces. BIND_ADDR overrides it for local testing.
	addr := getenvOr("BIND_ADDR", "127.0.0.1") + ":" + port
	log.Printf("[Server] listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, cors(mux)))
}
