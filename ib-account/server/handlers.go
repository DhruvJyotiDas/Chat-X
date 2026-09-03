package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

const sessionCookie = "ib_account_sid"

// ── helpers ─────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (a *App) readJSON(r *http.Request, dst any) bool {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(dst) == nil
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return xr
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func shortUA(r *http.Request) string {
	ua := r.UserAgent()
	if len(ua) > 120 {
		ua = ua[:120]
	}
	return ua
}

func (a *App) setSessionCookie(w http.ResponseWriter, sid string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sid,
		Path:     a.cfg.BasePath,
		MaxAge:   int(a.cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   !a.cfg.AllowInsecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

func (a *App) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: a.cfg.BasePath, MaxAge: -1,
		HttpOnly: true, Secure: !a.cfg.AllowInsecureCookies, SameSite: http.SameSiteLaxMode,
	})
}

func (a *App) currentUser(r *http.Request) (*User, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, errNotFound
	}
	return a.store.sessionUser(c.Value)
}

// sameOriginOK is a lightweight CSRF guard for state-changing API calls: if an
// Origin header is present it must match our own host. (SameSite=Lax already
// blocks cross-site cookie-bearing form posts.)
func (a *App) sameOriginOK(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	return strings.TrimSuffix(o, "/") == strings.TrimSuffix(originOf(a.cfg.Issuer), "/")
}

func originOf(issuer string) string {
	// issuer is like https://host/auth → https://host
	i := strings.Index(issuer, "://")
	if i < 0 {
		return issuer
	}
	rest := issuer[i+3:]
	if j := strings.IndexByte(rest, '/'); j >= 0 {
		return issuer[:i+3] + rest[:j]
	}
	return issuer
}

func validEmail(s string) bool {
	_, err := mail.ParseAddress(s)
	return err == nil && len(s) <= 320
}

// ── POST <base>/api/register ────────────────────────────────────────────
func (a *App) apiRegister(w http.ResponseWriter, r *http.Request) {
	if !a.sameOriginOK(r) {
		httpError(w, 403, "bad origin")
		return
	}
	var b struct{ Name, Email, Password string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	b.Email = normEmail(b.Email)
	if !validEmail(b.Email) {
		httpError(w, 400, "enter a valid email address")
		return
	}
	if len(b.Password) < 8 {
		httpError(w, 400, "password must be at least 8 characters")
		return
	}

	u, err := a.store.createUser(b.Email, b.Name, b.Password)
	if err == errDuplicate {
		// Don't disclose existence; if the account is still unverified, resend.
		if ex, _, e2 := a.store.userByEmail(b.Email); e2 == nil && !ex.EmailVerified {
			if code, e3 := a.store.issueOTP(ex.ID, "verify"); e3 == nil {
				a.mail.sendVerify(ex.Email, ex.Name, code)
			}
			writeJSON(w, 200, map[string]any{"ok": true, "next": "verify", "email": ex.Email})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "next": "verify", "email": b.Email})
		return
	}
	if err != nil {
		httpError(w, 500, "could not create account")
		return
	}

	code, err := a.store.issueOTP(u.ID, "verify")
	if err != nil {
		httpError(w, 500, "could not send verification code")
		return
	}
	a.mail.sendVerify(u.Email, u.Name, code)
	writeJSON(w, 200, map[string]any{"ok": true, "next": "verify", "email": u.Email})
}

// ── POST <base>/api/verify ─────────────────────────────────────────────
func (a *App) apiVerify(w http.ResponseWriter, r *http.Request) {
	if !a.sameOriginOK(r) {
		httpError(w, 403, "bad origin")
		return
	}
	var b struct{ Email, Code string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	u, _, err := a.store.userByEmail(b.Email)
	if err != nil {
		httpError(w, 400, "invalid or expired code")
		return
	}
	if err := a.store.checkOTP(u.ID, "verify", strings.TrimSpace(b.Code)); err != nil {
		httpError(w, 400, "invalid or expired code")
		return
	}
	first := !u.EmailVerified
	a.store.markVerified(u.ID)
	sid, _ := a.store.createSession(u.ID, shortUA(r), clientIP(r))
	a.setSessionCookie(w, sid)
	if first {
		a.mail.sendWelcome(u.Email, u.Name)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── POST <base>/api/resend ────────────────────────────────────────────
func (a *App) apiResend(w http.ResponseWriter, r *http.Request) {
	var b struct{ Email, Purpose string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	purpose := "verify"
	if b.Purpose == "reset" {
		purpose = "reset"
	}
	if u, _, err := a.store.userByEmail(b.Email); err == nil {
		if code, e := a.store.issueOTP(u.ID, purpose); e == nil {
			if purpose == "reset" {
				a.mail.sendReset(u.Email, u.Name, code)
			} else {
				a.mail.sendVerify(u.Email, u.Name, code)
			}
		} else if e == errOTPThrottled {
			httpError(w, 429, "please wait a minute before requesting another code")
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── POST <base>/api/login ─────────────────────────────────────────────
func (a *App) apiLogin(w http.ResponseWriter, r *http.Request) {
	if !a.sameOriginOK(r) {
		httpError(w, 403, "bad origin")
		return
	}
	var b struct{ Email, Password string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	u, hash, err := a.store.userByEmail(b.Email)
	if err == errLocked {
		httpError(w, 423, "too many attempts — try again in 15 minutes")
		return
	}
	if err != nil || !verifyPassword(b.Password, hash) {
		if u != nil {
			a.store.noteLoginFail(u.ID)
		}
		httpError(w, 401, "invalid email or password")
		return
	}
	if !u.EmailVerified {
		if code, e := a.store.issueOTP(u.ID, "verify"); e == nil {
			a.mail.sendVerify(u.Email, u.Name, code)
		}
		writeJSON(w, 200, map[string]any{"ok": false, "next": "verify", "email": u.Email})
		return
	}
	a.store.noteLoginOK(u.ID)
	sid, _ := a.store.createSession(u.ID, shortUA(r), clientIP(r))
	a.setSessionCookie(w, sid)
	a.mail.sendNewLogin(u.Email, u.Name, clientIP(r), shortUA(r), time.Now())
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── POST <base>/api/logout ────────────────────────────────────────────
func (a *App) apiLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.store.deleteSession(c.Value)
	}
	a.clearSessionCookie(w)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── GET <base>/api/session ───────────────────────────────────────────
func (a *App) apiSession(w http.ResponseWriter, r *http.Request) {
	u, err := a.currentUser(r)
	if err != nil {
		writeJSON(w, 200, map[string]any{"authenticated": false})
		return
	}
	writeJSON(w, 200, map[string]any{
		"authenticated": true, "email": u.Email, "name": u.Name,
		"email_verified": u.EmailVerified,
	})
}

// ── POST <base>/api/forgot ──────────────────────────────────────────
func (a *App) apiForgot(w http.ResponseWriter, r *http.Request) {
	var b struct{ Email string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	if u, _, err := a.store.userByEmail(b.Email); err == nil {
		if code, e := a.store.issueOTP(u.ID, "reset"); e == nil {
			a.mail.sendReset(u.Email, u.Name, code)
		}
	}
	// Always OK — never reveal whether the address exists.
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── POST <base>/api/reset ──────────────────────────────────────────
func (a *App) apiReset(w http.ResponseWriter, r *http.Request) {
	if !a.sameOriginOK(r) {
		httpError(w, 403, "bad origin")
		return
	}
	var b struct{ Email, Code, Password string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	if len(b.Password) < 8 {
		httpError(w, 400, "password must be at least 8 characters")
		return
	}
	u, _, err := a.store.userByEmail(b.Email)
	if err != nil {
		httpError(w, 400, "invalid or expired code")
		return
	}
	if err := a.store.checkOTP(u.ID, "reset", strings.TrimSpace(b.Code)); err != nil {
		httpError(w, 400, "invalid or expired code")
		return
	}
	a.store.setPassword(u.ID, b.Password)
	a.store.markVerified(u.ID) // a successful reset also proves email ownership
	a.mail.sendPasswordChanged(u.Email, u.Name)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── GET / PATCH <base>/api/account ────────────────────────────────
func (a *App) apiAccount(w http.ResponseWriter, r *http.Request) {
	u, err := a.currentUser(r)
	if err != nil {
		httpError(w, 401, "not signed in")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]any{
			"email": u.Email, "name": u.Name,
			"email_verified": u.EmailVerified,
			"created_at":     u.CreatedAt.UTC().Format(time.RFC3339),
		})
	case http.MethodPatch:
		if !a.sameOriginOK(r) {
			httpError(w, 403, "bad origin")
			return
		}
		var b struct{ Name string }
		if !a.readJSON(r, &b) || strings.TrimSpace(b.Name) == "" {
			httpError(w, 400, "name required")
			return
		}
		a.store.setName(u.ID, b.Name)
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		httpError(w, 405, "method not allowed")
	}
}

// ── POST <base>/api/password  (change while signed in) ───────────
func (a *App) apiPassword(w http.ResponseWriter, r *http.Request) {
	if !a.sameOriginOK(r) {
		httpError(w, 403, "bad origin")
		return
	}
	u, err := a.currentUser(r)
	if err != nil {
		httpError(w, 401, "not signed in")
		return
	}
	var b struct{ Current, New string }
	if !a.readJSON(r, &b) {
		httpError(w, 400, "invalid request")
		return
	}
	if len(b.New) < 8 {
		httpError(w, 400, "new password must be at least 8 characters")
		return
	}
	_, hash, _ := a.store.userByEmail(u.Email)
	if !verifyPassword(b.Current, hash) {
		httpError(w, 401, "current password is incorrect")
		return
	}
	a.store.setPassword(u.ID, b.New)
	a.mail.sendPasswordChanged(u.Email, u.Name)
	writeJSON(w, 200, map[string]any{"ok": true})
}
