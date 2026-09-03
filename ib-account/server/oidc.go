package main

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ── GET <base>/oauth/authorize ────────────────────────────────────────────
//
// Authorization-code + PKCE (S256). If the browser has no IdP session yet we
// serve the sign-in SPA; once it authenticates (which sets the session cookie)
// the SPA reloads this same URL and we fall through to issuing a code.
func (a *App) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	clientID := q.Get("client_id")
	redirectURI := q.Get("redirect_uri")
	respType := q.Get("response_type")
	state := q.Get("state")
	nonce := q.Get("nonce")
	challenge := q.Get("code_challenge")
	method := q.Get("code_challenge_method")
	scope := q.Get("scope")

	cl, err := a.store.client(clientID)
	if err != nil {
		httpError(w, http.StatusBadRequest, "unknown client")
		return
	}
	if redirectURI == "" || !cl.allowsRedirect(redirectURI) {
		httpError(w, http.StatusBadRequest, "redirect_uri not registered for this client")
		return
	}
	// From here on, errors go back to the client via the redirect_uri.
	redirectErr := func(code, desc string) {
		u, _ := url.Parse(redirectURI)
		v := u.Query()
		v.Set("error", code)
		if desc != "" {
			v.Set("error_description", desc)
		}
		if state != "" {
			v.Set("state", state)
		}
		u.RawQuery = v.Encode()
		http.Redirect(w, r, u.String(), http.StatusFound)
	}
	if respType != "code" {
		redirectErr("unsupported_response_type", "only response_type=code is supported")
		return
	}
	if challenge == "" || method != "S256" {
		redirectErr("invalid_request", "PKCE with code_challenge_method=S256 is required")
		return
	}

	user, err := a.currentUser(r)
	if err != nil {
		// not signed in — hand back the SPA (200); it will reload here after login
		a.serveApp(w, r)
		return
	}

	code := randToken(32)
	if err := a.store.createCode(AuthCode{
		Code: code, ClientID: cl.ID, UserID: user.ID, RedirectURI: redirectURI,
		CodeChallenge: challenge, Nonce: nonce, Scope: scope,
	}); err != nil {
		redirectErr("server_error", "could not issue code")
		return
	}
	u, _ := url.Parse(redirectURI)
	v := u.Query()
	v.Set("code", code)
	if state != "" {
		v.Set("state", state)
	}
	u.RawQuery = v.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

// ── POST <base>/oauth/token ──────────────────────────────────────────────
func (a *App) handleToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	f := r.PostForm
	if f.Get("grant_type") != "authorization_code" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
		return
	}

	clientID := f.Get("client_id")
	clientSecret := f.Get("client_secret")
	if u, p, ok := r.BasicAuth(); ok { // also accept HTTP Basic client auth
		clientID, clientSecret = u, p
	}
	cl, err := a.store.client(clientID)
	if err != nil || !cl.verifySecret(clientSecret) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
		return
	}

	ac, err := a.store.consumeCode(f.Get("code"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant", "error_description": "code invalid, expired or already used"})
		return
	}
	if ac.ClientID != cl.ID || ac.RedirectURI != f.Get("redirect_uri") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant", "error_description": "client or redirect_uri mismatch"})
		return
	}
	// PKCE
	sum := sha256.Sum256([]byte(f.Get("code_verifier")))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != ac.CodeChallenge {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant", "error_description": "PKCE verification failed"})
		return
	}

	user, err := a.store.userByID(ac.UserID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}

	idToken, err := a.mintIDToken(user, cl.ID, ac.Nonce)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": randToken(24), // opaque; IB Connect does not use it
		"token_type":   "Bearer",
		"expires_in":   int(a.cfg.IDTokenTTL.Seconds()),
		"id_token":     idToken,
		"scope":        ac.Scope,
	})
}

func (a *App) mintIDToken(u *User, aud, nonce string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":            a.cfg.Issuer,
		"sub":            u.ID,
		"aud":            aud,
		"iat":            now.Unix(),
		"exp":            now.Add(a.cfg.IDTokenTTL).Unix(),
		"email":          u.Email,
		"email_verified": true,
		"name":           u.Name,
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = a.key.Kid
	return tok.SignedString(a.key.Private)
}

// ── GET <base>/oauth/jwks.json ───────────────────────────────────────────
func (a *App) handleJWKS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=600")
	writeJSON(w, http.StatusOK, a.key.JWKS())
}

// ── GET <base>/.well-known/openid-configuration ──────────────────────────
func (a *App) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	base := a.cfg.Issuer
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"jwks_uri":                              base + "/oauth/jwks.json",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "profile", "email"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_post", "client_secret_basic"},
		"code_challenge_methods_supported":      []string{"S256"},
		"claims_supported":                      []string{"sub", "iss", "aud", "exp", "iat", "nonce", "email", "email_verified", "name"},
	})
}

func strip(s, prefix string) string { return strings.TrimPrefix(s, prefix) }
