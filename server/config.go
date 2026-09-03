package main

// Deployment-specific configuration.
//
// Every value here has a default that matches the current production box, so
// an environment with none of these set behaves exactly as before. Override
// them via the systemd EnvironmentFile (/etc/ibconnect/env) when moving this
// project to another VM, changing the database, or pointing at a different
// identity domain. See deploy/ibconnect.env.example for the complete list of
// environment variables this backend reads, including the required secrets
// (IBCONNECT_JWT_SECRET, IBCONNECT_DB_PASSWORD) that have no default.
//
// getenvOr is defined in main.go (same package).
var (
	// Database — see main().
	dbUser = getenvOr("IBCONNECT_DB_USER", "ibconnect_app")
	dbAddr = getenvOr("IBCONNECT_DB_ADDR", "127.0.0.1:3306")
	dbName = getenvOr("IBCONNECT_DB_NAME", "lolafire_IBConnect")

	// Domain used to synthesise a fallback email when an OIDC user row has to
	// be created before the id_token's email claim is available.
	ssoEmailDomain = getenvOr("SSO_EMAIL_DOMAIN", "sso.icebrkr.space")
)
