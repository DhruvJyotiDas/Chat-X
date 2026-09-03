# IB Account

The OIDC identity provider behind IB Connect's **"Continue with IB"** button.
IB Connect never sees a password — this service owns registration, login, email
OTP verification, forgot-password reset, and account management, and hands IB
Connect a signed `id_token` via the OAuth 2.0 authorization-code + PKCE flow.

Self-contained Go service, ~1k LOC, stdlib + two deps already used by the main
backend (`golang-jwt/jwt/v5`, `go-sql-driver/mysql`). No build step for the UI —
the sign-in / account SPA is a single embedded `server/web/index.html`.

## Layout

```
ib-account/
  server/
    main.go        HTTP server, router, middleware, startup
    config.go      env-driven configuration
    store.go       MariaDB schema + queries, PBKDF2 password hashing, OTP, sessions
    oidc.go        /oauth/authorize · /oauth/token · /oauth/jwks.json · discovery
    handlers.go    /api/register · verify · resend · login · logout · session
                     · forgot · reset · account · password
    email.go       SMTP client + 5 transactional templates (log-mode fallback)
    keys.go        RSA signing key load/generate + JWKS
    web/index.html the whole sign-in / account UI (vanilla, embedded)
  deploy/
    ib-account.service        systemd unit
    ib-account.env.example    every env var, with defaults
```

## Endpoints (all under `IB_ACCOUNT_BASE_PATH`, default `/auth`)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/oauth/authorize` | auth-code + PKCE; serves the SPA when unauthenticated, else 302s back with `?code` |
| POST | `/oauth/token` | code → `{id_token, access_token, …}` (RS256, `client_secret_post` or Basic) |
| GET  | `/oauth/jwks.json` | signing key set (IB Connect fetches this) |
| GET  | `/.well-known/openid-configuration` | discovery document |
| POST | `/api/register` | `{name,email,password}` → sends OTP, `next:"verify"` |
| POST | `/api/verify` | `{email,code}` → marks verified, sets session, welcome email |
| POST | `/api/resend` | `{email,purpose}` → new OTP (60s throttle) |
| POST | `/api/login` | `{email,password}` → session cookie, new-login alert email |
| POST | `/api/logout` | clears the session |
| GET  | `/api/session` | `{authenticated, email, name}` |
| POST | `/api/forgot` | `{email}` → reset OTP (always 200, never reveals existence) |
| POST | `/api/reset` | `{email,code,password}` → new password, confirmation email |
| GET/PATCH | `/api/account` | read / rename while signed in |
| POST | `/api/password` | `{current,new}` → change while signed in |

`id_token` claims: `iss`, `sub`, `aud` (= client_id), `iat`, `exp` (10 min),
`email`, `email_verified`, `name`, `nonce`. Verified by IB Connect against
`/oauth/jwks.json` in `server/main.go`'s `verifyIDToken`.

## Security model

- Passwords: PBKDF2-HMAC-SHA256, 600k iterations, per-user 16-byte salt,
  constant-time compare. No external crypto dependency.
- OTP: 6 digits, SHA-256 stored, 10-min expiry, 5-attempt cap, 60s resend
  throttle, single-use (all codes for the pair are deleted on success).
- Login lockout: 8 failures → 15-minute lock.
- Sessions: 32-byte random id, `HttpOnly; Secure; SameSite=Lax; Path=/auth`,
  30-day expiry, server-side row (revocable).
- PKCE S256 mandatory; `redirect_uri` is an exact-match allow-list per client;
  auth codes are single-use with a 5-min TTL, consumed atomically (`FOR UPDATE`).
- `/api/*` state-changing calls reject a mismatched `Origin` header
  (defense-in-depth on top of `SameSite=Lax`).
- Enumeration-safe: register and forgot-password never reveal whether an email
  is already registered.

## Deploy on this box (meet.icebrkr.space)

```bash
# 1. build
cd ib-account/server && /usr/local/go/bin/go build -o ib-account .

# 2. database — grant the app user on the new schema (created automatically on boot)
sudo mysql -e "CREATE DATABASE IF NOT EXISTS ib_account CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
               GRANT ALL PRIVILEGES ON ib_account.* TO 'ibconnect_app'@'localhost';
               FLUSH PRIVILEGES;"

# 3. env  (chmod 600, root:root)
sudo install -d -m 700 /etc/ib-account
sudo cp deploy/ib-account.env.example /etc/ib-account/env
CLIENT_SECRET=$(openssl rand -hex 32)
sudo tee -a /etc/ib-account/env >/dev/null <<EOF
IB_ACCOUNT_DB_PASSWORD=$(sudo grep -oP '(?<=^IBCONNECT_DB_PASSWORD=).*' /etc/ibconnect/env)
IB_ACCOUNT_CLIENT_ID=ibc_C_gqO2jdhASAN73QgLG0LXbDM4osR046
IB_ACCOUNT_CLIENT_SECRET=$CLIENT_SECRET
EOF
sudo chmod 600 /etc/ib-account/env

# 4. put the SAME client id/secret into IB Connect's env
sudo sed -i "s|^IB_ACCOUNT_CLIENT_ID=.*|IB_ACCOUNT_CLIENT_ID=ibc_C_gqO2jdhASAN73QgLG0LXbDM4osR046|" /etc/ibconnect/env
sudo sed -i "s|^IB_ACCOUNT_CLIENT_SECRET=.*|IB_ACCOUNT_CLIENT_SECRET=$CLIENT_SECRET|" /etc/ibconnect/env

# 5. service
sudo cp deploy/ib-account.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ib-account
sudo systemctl restart ibconnect-backend    # pick up the client secret

# 6. nginx — route ALL of /auth/ to :8090 (see deploy/nginx in the main repo)
```

Until `SMTP_*` is set the service prints every OTP/reset code to its journal:

```bash
sudo journalctl -u ib-account -f | grep -A6 'EMAIL (log mode'
```
