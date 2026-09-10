// IB Account — the OIDC identity provider behind "Continue with IB".
//
// One self-contained Go service: email+password accounts with OTP email
// verification, forgot-password reset, account management, and an
// OAuth 2.0 / OpenID Connect authorization-code + PKCE endpoint that IB
// Connect (server/main.go handleOIDCCallback) consumes.
//
// Runs behind nginx at https://<host>/auth/ ; listens on 127.0.0.1:8090 by
// default. See deploy/ib-account.env.example for configuration and
// ib-account/README.md for the deploy runbook.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type App struct {
	cfg   *Config
	store *Store
	mail  *Mailer
	key   *SigningKey
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "-healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get("http://127.0.0.1:8090/auth/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		resp.Body.Close()
		return
	}
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[ib-account] ")

	cfg := loadConfig()

	key, err := loadOrCreateSigningKey(cfg.KeyFile)
	if err != nil {
		log.Fatalf("signing key: %v", err)
	}
	log.Printf("signing key ready (kid=%s, file=%s)", key.Kid, cfg.KeyFile)

	store, err := openStore(cfg)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	log.Printf("database ready (%s/%s)", cfg.DBAddr, cfg.DBName)

	if cfg.SeedClientID != "" && cfg.SeedClientSecret != "" {
		if err := store.upsertClient(cfg.SeedClientID, cfg.SeedClientSecret, "IB Connect", cfg.SeedRedirectURIs); err != nil {
			log.Fatalf("seed client: %v", err)
		}
		log.Printf("oauth client %q upserted (redirects: %s)", cfg.SeedClientID, strings.Join(cfg.SeedRedirectURIs, ", "))
	} else {
		log.Printf("WARNING: IB_ACCOUNT_CLIENT_ID / IB_ACCOUNT_CLIENT_SECRET not set — no OAuth client is registered, \"Continue with IB\" will fail until they are")
	}

	mail := newMailer(cfg)
	switch mail.mode() {
	case "http":
		log.Printf("email transport: %s HTTPS API (from %q)", cfg.EmailAPI, cfg.SMTPFrom)
	case "smtp":
		log.Printf("email transport: SMTP %s:%d (from %q)", cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPFrom)
	default:
		log.Printf("WARNING: no email transport configured (set EMAIL_API_KEY or SMTP_HOST) — running in LOG MODE, codes are written to this journal")
	}

	app := &App{cfg: cfg, store: store, mail: mail, key: key}

	// background housekeeping
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			store.gc()
			<-t.C
		}
	}()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("listening on %s (issuer %s)", cfg.Addr, cfg.Issuer)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

func (a *App) routes() http.Handler {
	b := a.cfg.BasePath
	mux := http.NewServeMux()

	mux.HandleFunc("GET "+b+"/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// OIDC
	mux.HandleFunc("GET "+b+"/oauth/authorize", a.handleAuthorize)
	mux.HandleFunc("POST "+b+"/oauth/token", a.handleToken)
	mux.HandleFunc("GET "+b+"/oauth/jwks.json", a.handleJWKS)
	mux.HandleFunc("GET "+b+"/.well-known/openid-configuration", a.handleDiscovery)

	// account API
	mux.HandleFunc("POST "+b+"/api/register", a.apiRegister)
	mux.HandleFunc("POST "+b+"/api/verify", a.apiVerify)
	mux.HandleFunc("POST "+b+"/api/resend", a.apiResend)
	mux.HandleFunc("POST "+b+"/api/login", a.apiLogin)
	mux.HandleFunc("POST "+b+"/api/logout", a.apiLogout)
	mux.HandleFunc("GET "+b+"/api/session", a.apiSession)
	mux.HandleFunc("POST "+b+"/api/forgot", a.apiForgot)
	mux.HandleFunc("POST "+b+"/api/reset", a.apiReset)
	mux.HandleFunc(b+"/api/account", a.apiAccount) // GET + PATCH
	mux.HandleFunc("POST "+b+"/api/password", a.apiPassword)

	// unmatched API paths → JSON 404 (keep the SPA catch-all HTML-only)
	mux.HandleFunc(b+"/api/", func(w http.ResponseWriter, r *http.Request) {
		httpError(w, http.StatusNotFound, "no such endpoint")
	})

	// SPA — everything else under the base path
	mux.HandleFunc(b+"/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			httpError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		a.serveApp(w, r)
	})

	return logRequests(securityHeaders(mux))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(c int) { s.status = c; s.ResponseWriter.WriteHeader(c) }

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic %s %s: %v", r.Method, r.URL.Path, rec)
				httpError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		sr := &statusRecorder{ResponseWriter: w, status: 200}
		start := time.Now()
		next.ServeHTTP(sr, r)
		// don't log the noisy SPA asset / session poll at info volume
		if !strings.HasSuffix(r.URL.Path, "/api/session") {
			log.Printf("%s %s -> %d (%s) %s", r.Method, r.URL.Path, sr.status,
				time.Since(start).Round(time.Millisecond), clientIP(r))
		}
	})
}
