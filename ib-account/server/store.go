package main

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

var (
	errNotFound      = errors.New("not found")
	errBadCredential = errors.New("invalid email or password")
	errLocked        = errors.New("account temporarily locked")
	errOTPBad        = errors.New("invalid or expired code")
	errOTPThrottled  = errors.New("please wait before requesting another code")
)

type Store struct {
	db  *sql.DB
	cfg *Config
}

type User struct {
	ID            string
	Email         string
	EmailVerified bool
	Name          string
	CreatedAt     time.Time
}

// openStore connects directly to the configured schema first. This lets a
// production/container runtime use a least-privilege account that has rights
// only inside an already-provisioned database. For backwards compatibility,
// an account with CREATE DATABASE can still bootstrap a missing schema.
func openStore(cfg *Config) (*Store, error) {
	base := mysql.Config{
		User: cfg.DBUser, Passwd: cfg.DBPass,
		Net: "tcp", Addr: cfg.DBAddr,
		AllowNativePasswords: true, ParseTime: true, Loc: time.UTC,
		MultiStatements: true,
	}

	base.DBName = cfg.DBName
	db, err := sql.Open("mysql", base.FormatDSN())
	if err != nil {
		return nil, err
	}
	if err = db.Ping(); err != nil {
		db.Close()
		var mysqlErr *mysql.MySQLError
		if !errors.As(err, &mysqlErr) || mysqlErr.Number != 1049 {
			return nil, err
		}

		// Legacy bootstrap path for installations that intentionally grant the
		// service account CREATE DATABASE.
		bootstrap := base
		bootstrap.DBName = ""
		bdb, openErr := sql.Open("mysql", bootstrap.FormatDSN())
		if openErr != nil {
			return nil, openErr
		}
		if _, createErr := bdb.Exec("CREATE DATABASE IF NOT EXISTS `" + cfg.DBName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); createErr != nil {
			bdb.Close()
			return nil, fmt.Errorf("database %q must be provisioned before startup: %w", cfg.DBName, createErr)
		}
		bdb.Close()

		db, err = sql.Open("mysql", base.FormatDSN())
		if err != nil {
			return nil, err
		}
		if err = db.Ping(); err != nil {
			db.Close()
			return nil, err
		}
	}
	db.SetConnMaxLifetime(3 * time.Minute)
	db.SetConnMaxIdleTime(1 * time.Minute)
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)

	s := &Store{db: db, cfg: cfg}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id             CHAR(36)     NOT NULL PRIMARY KEY,
			email          VARCHAR(320) NOT NULL,
			email_verified TINYINT(1)   NOT NULL DEFAULT 0,
			password_hash  VARCHAR(255) NOT NULL,
			display_name   VARCHAR(120) NOT NULL DEFAULT '',
			failed_logins  INT          NOT NULL DEFAULT 0,
			locked_until   DATETIME     NULL,
			created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			last_login_at  DATETIME     NULL,
			UNIQUE KEY uq_users_email (email)
		) ENGINE=InnoDB`,

		`CREATE TABLE IF NOT EXISTS otps (
			id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
			user_id    CHAR(36)     NOT NULL,
			purpose    VARCHAR(16)  NOT NULL,
			code_hash  CHAR(64)     NOT NULL,
			attempts   INT          NOT NULL DEFAULT 0,
			expires_at DATETIME     NOT NULL,
			created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			KEY idx_otps_lookup (user_id, purpose, id)
		) ENGINE=InnoDB`,

		`CREATE TABLE IF NOT EXISTS sessions (
			id         CHAR(64)     NOT NULL PRIMARY KEY,
			user_id    CHAR(36)     NOT NULL,
			user_agent VARCHAR(255) NOT NULL DEFAULT '',
			ip         VARCHAR(64)  NOT NULL DEFAULT '',
			created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			expires_at DATETIME     NOT NULL,
			KEY idx_sessions_user (user_id)
		) ENGINE=InnoDB`,

		`CREATE TABLE IF NOT EXISTS oauth_clients (
			client_id          VARCHAR(128) NOT NULL PRIMARY KEY,
			client_secret_hash VARCHAR(255) NOT NULL,
			name               VARCHAR(120) NOT NULL DEFAULT '',
			redirect_uris      TEXT         NOT NULL,
			created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
		) ENGINE=InnoDB`,

		`CREATE TABLE IF NOT EXISTS oauth_codes (
			code           CHAR(64)     NOT NULL PRIMARY KEY,
			client_id      VARCHAR(128) NOT NULL,
			user_id        CHAR(36)     NOT NULL,
			redirect_uri   VARCHAR(512) NOT NULL,
			code_challenge VARCHAR(255) NOT NULL,
			nonce          VARCHAR(255) NOT NULL DEFAULT '',
			scope          VARCHAR(255) NOT NULL DEFAULT '',
			consumed       TINYINT(1)   NOT NULL DEFAULT 0,
			expires_at     DATETIME     NOT NULL,
			created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
		) ENGINE=InnoDB`,

		`CREATE TABLE IF NOT EXISTS upstream_oidc_states (
			state_hash       CHAR(64)       NOT NULL PRIMARY KEY,
			return_url       VARCHAR(2048)  NOT NULL,
			code_verifier    VARCHAR(255)   NOT NULL,
			nonce            VARCHAR(255)   NOT NULL,
			expires_at       DATETIME       NOT NULL,
			created_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP
		) ENGINE=InnoDB`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}

func (s *Store) gc() {
	s.db.Exec(`DELETE FROM otps        WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY`)
	s.db.Exec(`DELETE FROM oauth_codes WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY`)
	s.db.Exec(`DELETE FROM upstream_oidc_states WHERE expires_at < UTC_TIMESTAMP()`)
	s.db.Exec(`DELETE FROM sessions    WHERE expires_at < UTC_TIMESTAMP()`)
}

// ── password hashing (PBKDF2-HMAC-SHA256, stdlib only) ─────────────────────

const pbkdf2Iter = 600_000

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	dk, _ := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iter, 32)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s", pbkdf2Iter,
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(dk))
}

func verifyPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	var iter int
	fmt.Sscanf(parts[1], "%d", &iter)
	salt, err1 := base64.StdEncoding.DecodeString(parts[2])
	want, err2 := base64.StdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil || iter <= 0 {
		return false
	}
	got, _ := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ── ids / tokens ─────────────────────────────────────────────────────────

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func randToken(nBytes int) string {
	b := make([]byte, nBytes)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ── users ───────────────────────────────────────────────────────────────

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

func (s *Store) userByEmail(email string) (*User, string, error) {
	u := &User{}
	var hash string
	var locked sql.NullTime
	err := s.db.QueryRow(
		`SELECT id,email,email_verified,password_hash,display_name,locked_until,created_at
		   FROM users WHERE email=?`, normEmail(email),
	).Scan(&u.ID, &u.Email, &u.EmailVerified, &hash, &u.Name, &locked, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, "", errNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if locked.Valid && locked.Time.After(time.Now().UTC()) {
		return u, hash, errLocked
	}
	return u, hash, nil
}

func (s *Store) userByID(id string) (*User, error) {
	u := &User{}
	err := s.db.QueryRow(
		`SELECT id,email,email_verified,display_name,created_at FROM users WHERE id=?`, id,
	).Scan(&u.ID, &u.Email, &u.EmailVerified, &u.Name, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, errNotFound
	}
	return u, err
}

// createUser inserts an unverified user. Returns errDuplicate-wrapped error if
// the email already exists.
func (s *Store) createUser(email, name, pw string) (*User, error) {
	id := newUUID()
	_, err := s.db.Exec(
		`INSERT INTO users(id,email,email_verified,password_hash,display_name) VALUES(?,?,0,?,?)`,
		id, normEmail(email), hashPassword(pw), strings.TrimSpace(name),
	)
	if err != nil {
		if me, ok := err.(*mysql.MySQLError); ok && me.Number == 1062 {
			return nil, errDuplicate
		}
		return nil, err
	}
	return &User{ID: id, Email: normEmail(email), Name: strings.TrimSpace(name)}, nil
}

var errDuplicate = errors.New("email already registered")

func (s *Store) markVerified(userID string) error {
	_, err := s.db.Exec(`UPDATE users SET email_verified=1 WHERE id=?`, userID)
	return err
}

func (s *Store) setPassword(userID, pw string) error {
	_, err := s.db.Exec(
		`UPDATE users SET password_hash=?, failed_logins=0, locked_until=NULL WHERE id=?`,
		hashPassword(pw), userID)
	return err
}

func (s *Store) setName(userID, name string) error {
	_, err := s.db.Exec(`UPDATE users SET display_name=? WHERE id=?`, strings.TrimSpace(name), userID)
	return err
}

func (s *Store) provisionOIDCUser(email, name string) (*User, error) {
	email = normEmail(email)
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	u, _, err := s.userByEmail(email)
	if err == nil {
		if !u.EmailVerified {
			_ = s.markVerified(u.ID)
		}
		if u.Name == "" {
			_ = s.setName(u.ID, name)
			u.Name = name
		}
		u.EmailVerified = true
		return u, nil
	}
	if err != errNotFound {
		return nil, err
	}
	// External users authenticate upstream; the random password is never used
	// for login and prevents creation of a usable blank-password account.
	u = &User{ID: newUUID(), Email: email, EmailVerified: true, Name: name}
	_, err = s.db.Exec(`INSERT INTO users(id,email,email_verified,password_hash,display_name) VALUES(?,?,1,?,?)`,
		u.ID, u.Email, hashPassword(randToken(32)), u.Name)
	if err != nil {
		return nil, err
	}
	return u, nil
}

type UpstreamState struct {
	ReturnURL    string
	CodeVerifier string
	Nonce        string
}

func (s *Store) saveUpstreamState(state string, value UpstreamState, ttl time.Duration) error {
	_, err := s.db.Exec(
		`INSERT INTO upstream_oidc_states(state_hash,return_url,code_verifier,nonce,expires_at)
		 VALUES(?,?,?,?, UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
		sha256hex(state), value.ReturnURL, value.CodeVerifier, value.Nonce, int(ttl.Seconds()))
	return err
}

func (s *Store) consumeUpstreamState(state string) (UpstreamState, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return UpstreamState{}, err
	}
	defer tx.Rollback()
	var value UpstreamState
	err = tx.QueryRow(
		`SELECT return_url,code_verifier,nonce FROM upstream_oidc_states
		 WHERE state_hash=? AND expires_at > UTC_TIMESTAMP() FOR UPDATE`, sha256hex(state),
	).Scan(&value.ReturnURL, &value.CodeVerifier, &value.Nonce)
	if err == sql.ErrNoRows {
		return UpstreamState{}, errNotFound
	}
	if err != nil {
		return UpstreamState{}, err
	}
	if _, err = tx.Exec(`DELETE FROM upstream_oidc_states WHERE state_hash=?`, sha256hex(state)); err != nil {
		return UpstreamState{}, err
	}
	return value, tx.Commit()
}

func (s *Store) noteLoginOK(userID string) {
	s.db.Exec(`UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=UTC_TIMESTAMP() WHERE id=?`, userID)
}

func (s *Store) noteLoginFail(userID string) {
	s.db.Exec(`UPDATE users
		SET failed_logins = failed_logins + 1,
		    locked_until  = IF(failed_logins + 1 >= 8, UTC_TIMESTAMP() + INTERVAL 15 MINUTE, locked_until)
		WHERE id=?`, userID)
}

// ── OTP ─────────────────────────────────────────────────────────────────

// issueOTP creates a fresh 6-digit code for (user,purpose), returning the
// plaintext code (to email). Throttled to one per 60s.
func (s *Store) issueOTP(userID, purpose string) (string, error) {
	var lastAgo sql.NullInt64
	s.db.QueryRow(
		`SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), UTC_TIMESTAMP())
		   FROM otps WHERE user_id=? AND purpose=?`, userID, purpose,
	).Scan(&lastAgo)
	if lastAgo.Valid && lastAgo.Int64 < 60 {
		return "", errOTPThrottled
	}

	n, _ := rand.Int(rand.Reader, big.NewInt(1_000_000))
	code := fmt.Sprintf("%06d", n.Int64())
	_, err := s.db.Exec(
		`INSERT INTO otps(user_id,purpose,code_hash,expires_at)
		 VALUES(?,?,?, UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
		userID, purpose, sha256hex(code), int(s.cfg.OTPTTL.Seconds()),
	)
	if err != nil {
		return "", err
	}
	// keep only the newest few rows per (user,purpose)
	s.db.Exec(`DELETE FROM otps WHERE user_id=? AND purpose=? AND id NOT IN (
			SELECT id FROM (SELECT id FROM otps WHERE user_id=? AND purpose=? ORDER BY id DESC LIMIT 3) t
		)`, userID, purpose, userID, purpose)
	return code, nil
}

// checkOTP validates a code for (user,purpose). On success every OTP for that
// pair is deleted. Caps at 5 attempts per code.
func (s *Store) checkOTP(userID, purpose, code string) error {
	var id int64
	var hash string
	var attempts int
	err := s.db.QueryRow(
		`SELECT id, code_hash, attempts FROM otps
		  WHERE user_id=? AND purpose=? AND expires_at > UTC_TIMESTAMP()
		  ORDER BY id DESC LIMIT 1`, userID, purpose,
	).Scan(&id, &hash, &attempts)
	if err == sql.ErrNoRows {
		return errOTPBad
	}
	if err != nil {
		return err
	}
	if attempts >= 5 {
		s.db.Exec(`DELETE FROM otps WHERE id=?`, id)
		return errOTPBad
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(sha256hex(code))) != 1 {
		s.db.Exec(`UPDATE otps SET attempts=attempts+1 WHERE id=?`, id)
		return errOTPBad
	}
	s.db.Exec(`DELETE FROM otps WHERE user_id=? AND purpose=?`, userID, purpose)
	return nil
}

// ── sessions ────────────────────────────────────────────────────────────

func (s *Store) createSession(userID, ua, ip string) (string, error) {
	sid := randToken(32)
	_, err := s.db.Exec(
		`INSERT INTO sessions(id,user_id,user_agent,ip,expires_at)
		 VALUES(?,?,?,?, UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
		sid, userID, trunc(ua, 255), trunc(ip, 64), int(s.cfg.SessionTTL.Seconds()),
	)
	return sid, err
}

func (s *Store) sessionUser(sid string) (*User, error) {
	if sid == "" {
		return nil, errNotFound
	}
	var uid string
	err := s.db.QueryRow(
		`SELECT user_id FROM sessions WHERE id=? AND expires_at > UTC_TIMESTAMP()`, sid,
	).Scan(&uid)
	if err == sql.ErrNoRows {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.userByID(uid)
}

func (s *Store) deleteSession(sid string) { s.db.Exec(`DELETE FROM sessions WHERE id=?`, sid) }

// ── oauth clients / codes ───────────────────────────────────────────────

type Client struct {
	ID           string
	SecretHash   string
	Name         string
	RedirectURIs []string
}

func (s *Store) upsertClient(id, secret, name string, redirects []string) error {
	if id == "" || secret == "" {
		return nil
	}
	_, err := s.db.Exec(
		`INSERT INTO oauth_clients(client_id,client_secret_hash,name,redirect_uris)
		 VALUES(?,?,?,?)
		 ON DUPLICATE KEY UPDATE client_secret_hash=VALUES(client_secret_hash),
		                         name=VALUES(name),
		                         redirect_uris=VALUES(redirect_uris)`,
		id, hashPassword(secret), name, strings.Join(redirects, "\n"),
	)
	return err
}

func (s *Store) client(id string) (*Client, error) {
	c := &Client{}
	var redirects string
	err := s.db.QueryRow(
		`SELECT client_id,client_secret_hash,name,redirect_uris FROM oauth_clients WHERE client_id=?`, id,
	).Scan(&c.ID, &c.SecretHash, &c.Name, &redirects)
	if err == sql.ErrNoRows {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(redirects, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			c.RedirectURIs = append(c.RedirectURIs, line)
		}
	}
	return c, nil
}

func (c *Client) allowsRedirect(uri string) bool {
	for _, r := range c.RedirectURIs {
		if hmac.Equal([]byte(r), []byte(uri)) {
			return true
		}
	}
	return false
}

func (c *Client) verifySecret(secret string) bool { return verifyPassword(secret, c.SecretHash) }

type AuthCode struct {
	Code          string
	ClientID      string
	UserID        string
	RedirectURI   string
	CodeChallenge string
	Nonce         string
	Scope         string
}

func (s *Store) createCode(ac AuthCode) error {
	_, err := s.db.Exec(
		`INSERT INTO oauth_codes(code,client_id,user_id,redirect_uri,code_challenge,nonce,scope,expires_at)
		 VALUES(?,?,?,?,?,?,?, UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
		ac.Code, ac.ClientID, ac.UserID, ac.RedirectURI, ac.CodeChallenge, ac.Nonce, ac.Scope,
		int(s.cfg.CodeTTL.Seconds()),
	)
	return err
}

// consumeCode atomically marks a code used and returns it. A second call for
// the same code returns errNotFound.
func (s *Store) consumeCode(code string) (*AuthCode, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	ac := &AuthCode{}
	err = tx.QueryRow(
		`SELECT code,client_id,user_id,redirect_uri,code_challenge,nonce,scope
		   FROM oauth_codes
		  WHERE code=? AND consumed=0 AND expires_at > UTC_TIMESTAMP() FOR UPDATE`, code,
	).Scan(&ac.Code, &ac.ClientID, &ac.UserID, &ac.RedirectURI, &ac.CodeChallenge, &ac.Nonce, &ac.Scope)
	if err == sql.ErrNoRows {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE oauth_codes SET consumed=1 WHERE code=?`, code); err != nil {
		return nil, err
	}
	return ac, tx.Commit()
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
