package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds every deployment-specific value. Defaults target the current
// production box (meet.icebrkr.space, local MariaDB); override with env vars
// when relocating. See deploy/ib-account.env.example for the full list.
type Config struct {
	Addr      string // listen address for this service (nginx upstream)
	BasePath  string // URL prefix nginx mounts us under, e.g. "/auth"
	Issuer    string // OIDC issuer — MUST equal IB Connect's IB_ACCOUNT_ISSUER
	PublicURL string // scheme+host+basepath, links in emails point here

	DBUser string
	DBAddr string
	DBName string
	DBPass string

	KeyFile string // RSA signing key (PEM); generated on first boot if absent

	// Seed OAuth client — IB Connect. Upserted on every boot so the pair here
	// and in /etc/ibconnect/env stay the single source of truth.
	SeedClientID     string
	SeedClientSecret string
	SeedRedirectURIs []string

	// Optional upstream OIDC provider used by the additional intranet login.
	UpstreamIssuer       string
	UpstreamClientID     string
	UpstreamClientSecret string
	UpstreamRedirectURI  string
	UpstreamDomains      []string

	SessionTTL time.Duration
	OTPTTL     time.Duration
	CodeTTL    time.Duration
	IDTokenTTL time.Duration

	// SMTP. If SMTPHost is empty the service runs in "log mode": every email
	// is written to stdout instead of being sent, so the full flow is testable
	// before real mail credentials exist.
	SMTPHost string
	SMTPPort int
	SMTPUser string
	SMTPPass string
	SMTPFrom string

	// HTTPS email API (works when only outbound 443 is allowed). If EmailAPIKey
	// is set it takes precedence over SMTP. Provider: "brevo" or "resend".
	EmailAPI    string
	EmailAPIKey string

	AllowInsecureCookies bool // only for plain-HTTP local dev
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() *Config {
	dbPass := env("IB_ACCOUNT_DB_PASSWORD", os.Getenv("IBCONNECT_DB_PASSWORD"))
	if dbPass == "" {
		log.Fatal("IB_ACCOUNT_DB_PASSWORD (or IBCONNECT_DB_PASSWORD) is required")
	}

	smtpPort, _ := strconv.Atoi(env("SMTP_PORT", "587"))

	issuer := strings.TrimRight(env("IB_ACCOUNT_ISSUER", "https://meet.icebrkr.space/auth"), "/")

	c := &Config{
		Addr:      env("IB_ACCOUNT_ADDR", "127.0.0.1:8090"),
		BasePath:  "/" + strings.Trim(env("IB_ACCOUNT_BASE_PATH", "/auth"), "/"),
		Issuer:    issuer,
		PublicURL: issuer,

		DBUser: env("IB_ACCOUNT_DB_USER", env("IBCONNECT_DB_USER", "ibconnect_app")),
		DBAddr: env("IB_ACCOUNT_DB_ADDR", env("IBCONNECT_DB_ADDR", "127.0.0.1:3306")),
		DBName: env("IB_ACCOUNT_DB_NAME", "ib_account"),
		DBPass: dbPass,

		KeyFile: env("IB_ACCOUNT_KEY_FILE", "data/oidc_signing_key.pem"),

		SeedClientID:     os.Getenv("IB_ACCOUNT_CLIENT_ID"),
		SeedClientSecret: os.Getenv("IB_ACCOUNT_CLIENT_SECRET"),
		SeedRedirectURIs: splitList(env("IB_ACCOUNT_REDIRECT_URIS", env("IB_ACCOUNT_REDIRECT_URI", "https://meet.icebrkr.space/"))),

		UpstreamIssuer:       strings.TrimRight(os.Getenv("UPSTREAM_OIDC_ISSUER"), "/"),
		UpstreamClientID:     os.Getenv("UPSTREAM_OIDC_CLIENT_ID"),
		UpstreamClientSecret: os.Getenv("UPSTREAM_OIDC_CLIENT_SECRET"),
		UpstreamRedirectURI:  env("UPSTREAM_OIDC_REDIRECT_URI", issuer+"/upstream/callback"),
		UpstreamDomains:      splitList(env("UPSTREAM_OIDC_ALLOWED_DOMAINS", "icebrkr.one,icebrkr.space")),

		SessionTTL: 30 * 24 * time.Hour,
		OTPTTL:     10 * time.Minute,
		CodeTTL:    5 * time.Minute,
		IDTokenTTL: 10 * time.Minute,

		SMTPHost: os.Getenv("SMTP_HOST"),
		SMTPPort: smtpPort,
		SMTPUser: os.Getenv("SMTP_USER"),
		SMTPPass: os.Getenv("SMTP_PASS"),
		SMTPFrom: env("SMTP_FROM", "IB Account <no-reply@icebrkr.space>"),

		EmailAPI:    strings.ToLower(env("EMAIL_API", "brevo")),
		EmailAPIKey: os.Getenv("EMAIL_API_KEY"),

		AllowInsecureCookies: os.Getenv("IB_ACCOUNT_INSECURE_COOKIES") == "1",
	}
	return c
}

func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
