/**
 * Central runtime configuration for the frontend.
 *
 * Nothing about a specific host should be hard-coded anywhere else in `src/`.
 * Every value below is derived from the browser's own origin at runtime, so a
 * default build already works on whatever domain it is served from. Override
 * any of them at build time with a `VITE_*` env var (see `.env.example`) when
 * the frontend and backend live on different hosts, or when the identity
 * provider is somewhere other than `/auth` on this same origin.
 */

const env = import.meta.env;

const hasWindow = typeof window !== 'undefined';

/** e.g. `https://meet.icebrkr.space` — the origin this page was served from. */
const httpOrigin = hasWindow ? window.location.origin : 'http://localhost:3000';

/** e.g. `wss://meet.icebrkr.space` — same host, websocket scheme. */
const wsOrigin = hasWindow
  ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
  : 'ws://localhost:3000';

export const config = {
  /** REST API base path. Relative on purpose — nginx proxies it to the Go backend. */
  apiBase: env.VITE_API_BASE || '/api',

  /** WebRTC signaling / room socket. */
  wsUrl: env.VITE_WS_URL || `${wsOrigin}/ws`,

  /** Live-captions (ASR) relay socket. */
  asrWsUrl: env.VITE_ASR_WS_URL || `${wsOrigin}/asr`,

  /** IB Account — the OIDC identity provider (see server/main.go handleOIDCCallback). */
  ibAccount: {
    issuer: env.VITE_IB_ACCOUNT_ISSUER || `${httpOrigin}/auth`,
    clientId: env.VITE_IB_ACCOUNT_CLIENT_ID || 'ibc_C_gqO2jdhASAN73QgLG0LXbDM4osR046',
    redirectUri: env.VITE_IB_ACCOUNT_REDIRECT_URI || `${httpOrigin}/`,
    /** Deep link to the hosted "manage password & security" page. */
    accountUrl: env.VITE_IB_ACCOUNT_URL || `${httpOrigin}/auth/account`,
  },
} as const;

export type AppConfig = typeof config;
