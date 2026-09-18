package main

import (
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type upstreamOIDCMetadata struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	JWKSURI               string `json:"jwks_uri"`
}

type upstreamOIDCState struct {
	ReturnURL    string
	CodeVerifier string
	Nonce        string
}

func upstreamConfigured(c *Config) bool {
	return c.UpstreamIssuer != "" && c.UpstreamClientID != "" && c.UpstreamClientSecret != ""
}

func randomURLToken(n int) string {
	return randToken(n)
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (a *App) upstreamMetadata() (*upstreamOIDCMetadata, error) {
	resp, err := http.Get(a.cfg.UpstreamIssuer + "/.well-known/openid-configuration")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream discovery returned %s", resp.Status)
	}
	var metadata upstreamOIDCMetadata
	if err := json.NewDecoder(resp.Body).Decode(&metadata); err != nil {
		return nil, err
	}
	if metadata.Issuer != a.cfg.UpstreamIssuer || metadata.AuthorizationEndpoint == "" || metadata.TokenEndpoint == "" || metadata.JWKSURI == "" {
		return nil, fmt.Errorf("invalid upstream discovery document")
	}
	return &metadata, nil
}

func (a *App) handleUpstreamLogin(w http.ResponseWriter, r *http.Request) {
	if !upstreamConfigured(a.cfg) {
		httpError(w, http.StatusNotFound, "intranet SSO is not configured")
		return
	}
	returnURL := r.URL.Query().Get("return")
	if returnURL == "" {
		returnURL = a.cfg.BasePath + "/"
	}
	parsed, err := url.Parse(returnURL)
	if err != nil || parsed.IsAbs() && strings.TrimSuffix(parsed.Scheme+"://"+parsed.Host, "/") != strings.TrimSuffix(originOf(a.cfg.Issuer), "/") {
		http.Error(w, "invalid return URL", http.StatusBadRequest)
		return
	}
	metadata, err := a.upstreamMetadata()
	if err != nil {
		http.Error(w, "intranet SSO unavailable", http.StatusBadGateway)
		return
	}
	state := randomURLToken(32)
	verifier := randomURLToken(48)
	nonce := randomURLToken(32)
	if err := a.store.saveUpstreamState(state, UpstreamState{ReturnURL: returnURL, CodeVerifier: verifier, Nonce: nonce}, 10*time.Minute); err != nil {
		http.Error(w, "could not start intranet SSO", http.StatusInternalServerError)
		return
	}
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {a.cfg.UpstreamClientID},
		"redirect_uri":          {a.cfg.UpstreamRedirectURI},
		"scope":                 {"openid profile email"},
		"state":                 {state},
		"nonce":                 {nonce},
		"code_challenge":        {pkceChallenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	http.Redirect(w, r, metadata.AuthorizationEndpoint+"?"+q.Encode(), http.StatusFound)
}

func (a *App) handleUpstreamCallback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	if state == "" {
		http.Error(w, "invalid SSO state", http.StatusBadRequest)
		return
	}
	value, err := a.store.consumeUpstreamState(state)
	if err != nil {
		http.Error(w, "invalid or expired SSO state", http.StatusBadRequest)
		return
	}
	if oauthError := r.URL.Query().Get("error"); oauthError != "" {
		http.Error(w, "intranet sign-in was cancelled", http.StatusUnauthorized)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing SSO code", http.StatusBadRequest)
		return
	}
	metadata, err := a.upstreamMetadata()
	if err != nil {
		http.Error(w, "intranet SSO unavailable", http.StatusBadGateway)
		return
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {a.cfg.UpstreamRedirectURI},
		"client_id":     {a.cfg.UpstreamClientID},
		"client_secret": {a.cfg.UpstreamClientSecret},
		"code_verifier": {value.CodeVerifier},
	}
	resp, err := http.PostForm(metadata.TokenEndpoint, form)
	if err != nil {
		log.Printf("[ib-account] upstream token exchange: request to %s failed: %v", metadata.TokenEndpoint, err)
		http.Error(w, "intranet sign-in failed", http.StatusUnauthorized)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		log.Printf("[ib-account] upstream token exchange: %s returned %s: %s", metadata.TokenEndpoint, resp.Status, body)
		http.Error(w, "intranet sign-in failed", http.StatusUnauthorized)
		return
	}
	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		log.Printf("[ib-account] upstream token exchange: reading response body: %v", err)
		http.Error(w, "intranet sign-in failed", http.StatusUnauthorized)
		return
	}
	var token struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(bodyBytes, &token); err != nil || token.IDToken == "" {
		log.Printf("[ib-account] upstream token exchange: response had no id_token (decode err: %v): %s", err, bodyBytes)
		http.Error(w, "intranet sign-in returned no identity", http.StatusUnauthorized)
		return
	}
	claims, err := a.verifyUpstreamIDToken(metadata, token.IDToken, value.Nonce)
	if err != nil || !claims.EmailVerified || !a.allowedUpstreamEmail(claims.Email) {
		http.Error(w, "intranet account is not allowed", http.StatusForbidden)
		return
	}
	u, err := a.store.provisionOIDCUser(claims.Email, claims.Name)
	if err != nil {
		http.Error(w, "could not provision account", http.StatusInternalServerError)
		return
	}
	sid, err := a.store.createSession(u.ID, shortUA(r), clientIP(r))
	if err != nil {
		http.Error(w, "could not create session", http.StatusInternalServerError)
		return
	}
	a.setSessionCookie(w, sid)
	http.Redirect(w, r, value.ReturnURL, http.StatusFound)
}

func (a *App) allowedUpstreamEmail(email string) bool {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(email)), "@")
	if len(parts) != 2 || parts[0] == "" {
		return false
	}
	for _, domain := range a.cfg.UpstreamDomains {
		if strings.EqualFold(strings.TrimSpace(domain), parts[1]) {
			return true
		}
	}
	return false
}

type upstreamClaims struct {
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Nonce         string `json:"nonce"`
	jwt.RegisteredClaims
}

func (a *App) verifyUpstreamIDToken(metadata *upstreamOIDCMetadata, raw, nonce string) (*upstreamClaims, error) {
	resp, err := http.Get(metadata.JWKSURI)
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
	var claims upstreamClaims
	_, err = jwt.ParseWithClaims(raw, &claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		kid, _ := t.Header["kid"].(string)
		for _, k := range doc.Keys {
			if k.Kid != kid {
				continue
			}
			n, e1 := base64.RawURLEncoding.DecodeString(k.N)
			e, e2 := base64.RawURLEncoding.DecodeString(k.E)
			if e1 != nil || e2 != nil || len(e) == 0 {
				return nil, fmt.Errorf("invalid JWK")
			}
			exponent := 0
			for _, b := range e {
				exponent = exponent<<8 | int(b)
			}
			return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exponent}, nil
		}
		return nil, fmt.Errorf("unknown signing key")
	}, jwt.WithIssuer(metadata.Issuer), jwt.WithAudience(a.cfg.UpstreamClientID))
	if err != nil || claims.Nonce != nonce {
		return nil, fmt.Errorf("invalid upstream identity")
	}
	return &claims, nil
}
