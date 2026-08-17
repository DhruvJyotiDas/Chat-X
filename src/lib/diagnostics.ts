/**
 * Connection diagnostics.
 *
 * Why this exists: on 2026-08-12 a rotated JWT signing key invalidated every
 * live session. `/chat-ws` correctly answered 401 — but the WebSocket API
 * deliberately hides HTTP response details from JavaScript, so the browser could
 * only report "Firefox can't establish a connection to the server". A dead
 * session was indistinguishable from an unreachable host, and because both
 * sockets reconnected unconditionally every 3s forever, the user saw an endless
 * `reconnecting…` loop instead of "please sign in again".
 *
 * The single 401 that explained the whole incident existed ONLY in nginx's
 * access log. Nothing in the app or the backend recorded it.
 *
 * So: every connection lifecycle event now goes through here, is kept in an
 * in-memory ring buffer, and can be dumped (`window.__ibDiag()`) or shipped to
 * the server. Nothing here records message contents — only connection metadata.
 */

const RING_SIZE = 300;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_MAX_BATCH = 50;

export type DiagCategory = 'signaling' | 'chat-ws' | 'webrtc' | 'media' | 'session';
export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEvent {
  t: string;            // ISO timestamp
  since: number;        // ms since page load — lines up with browser console timeStamps
  cat: DiagCategory;
  level: DiagLevel;
  event: string;
  detail?: Record<string, unknown>;
}

const ring: DiagEvent[] = [];
let pending: DiagEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Reporting to the server is opt-out so a diagnostic build can be shipped quickly. */
let reportingEnabled = true;
export function setDiagReporting(on: boolean) { reportingEnabled = on; }

export function diag(cat: DiagCategory, level: DiagLevel, event: string, detail?: Record<string, unknown>) {
  const e: DiagEvent = {
    t: new Date().toISOString(),
    since: Math.round(performance.now()),
    cat, level, event,
    ...(detail ? { detail } : {}),
  };

  ring.push(e);
  if (ring.length > RING_SIZE) ring.shift();

  // Console, with a stable prefix so a user can copy/paste anything useful.
  const line = `[ib:${cat}] ${event}`;
  const args = detail ? [line, detail] : [line];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);

  if (reportingEnabled) {
    pending.push(e);
    if (pending.length >= FLUSH_MAX_BATCH) void flush();
    ensureFlushTimer();
  }
}

function ensureFlushTimer() {
  if (flushTimer || typeof window === 'undefined') return;
  flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  // Best-effort final flush; flush() already uses sendBeacon, which is the
  // only thing reliable during page teardown.
  window.addEventListener('pagehide', () => { void flush(); });
}

async function flush() {
  if (!pending.length || !reportingEnabled) return;
  const batch = pending;
  pending = [];

  // sendBeacon, not fetch. A periodic fetch that is still in flight when the
  // page unloads (or a tab closes) surfaces as net::ERR_ABORTED — real console
  // noise caused purely by telemetry, which is exactly the kind of false signal
  // this module exists to eliminate. sendBeacon is fire-and-forget, survives
  // teardown, and cannot fail loudly.
  //
  // It cannot set headers, so the token rides in the body; the server falls back
  // to it only when there is no Authorization header.
  const payload = JSON.stringify({
    token: localStorage.getItem('ibconnect_jwt') ?? undefined,
    events: batch,
  });

  try {
    if (navigator.sendBeacon?.('/api/client-events', new Blob([payload], { type: 'application/json' }))) {
      return;
    }
  } catch { /* fall through */ }

  // Fallback for browsers without sendBeacon. keepalive lets it outlive the page.
  try {
    await fetch('/api/client-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    });
  } catch {
    // Never let diagnostics failure become a user-visible failure.
  }
}

/** Dump the buffer for support. Exposed on window deliberately. */
export function dumpDiagnostics(): DiagEvent[] {
  return [...ring];
}
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__ibDiag = () => {
    const rows = dumpDiagnostics();
    // eslint-disable-next-line no-console
    console.table(rows.map((r) => ({ since_ms: r.since, cat: r.cat, level: r.level, event: r.event })));
    return rows;
  };
}

// ─── Why did the socket close? ───────────────────────────────────────────────

export type DisconnectCause = 'session-expired' | 'server-down' | 'network' | 'ok';

/**
 * A failed WebSocket handshake tells JavaScript nothing — not the status code,
 * not the body. The only way to find out whether the session is the problem is
 * to ask over plain HTTP, where we CAN read the status.
 *
 * This is the piece that turns an infinite "reconnecting…" loop into an
 * actionable "your session expired, sign in again".
 *
 * A guest joining by link never has `ibconnect_jwt` at all — `/ws` doesn't require
 * auth (see "Session lifecycle" in CLAUDE.md) — so `/api/auth/me` returning 401 for
 * them is not a dead session, it's the only answer it could ever give: there was
 * never a session to expire. Without this check, EVERY guest whose signaling socket
 * dropped even once (a phone hopping wifi→cellular, a brief network blip — both
 * routine) got permanently, silently signed out of reconnecting, which is exactly
 * why the host stops seeing them at all rather than a momentary "Connecting…" — the
 * *host's* correctly-classified 'network' disconnect reconnects fine; it's the
 * *guest's* side that this was killing outright. Reported live: a guest joined, held
 * for 8s, and every one of them since has this same shape — 1005/clean close,
 * misclassified 'session-expired', 'signing out' logged for an account that was
 * never signed in.
 */
export async function classifyDisconnect(): Promise<DisconnectCause> {
  const token = localStorage.getItem('ibconnect_jwt');
  if (!token) return 'network';
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) return 'session-expired';
    if (res.status >= 500) return 'server-down';
    if (res.ok) return 'network';   // API is fine, so the problem is WS-specific
    return 'network';
  } catch {
    return 'network';               // fetch itself failed — genuinely offline/unreachable
  }
}

// ─── Session expiry fan-out ──────────────────────────────────────────────────

let sessionExpiredHandler: (() => void) | null = null;
let alreadyFired = false;

/** AuthContext registers here so a dead session can force a clean re-login. */
export function onSessionExpired(fn: () => void) {
  sessionExpiredHandler = fn;
}

/** Idempotent: several sockets will discover the same dead session at once. */
export function reportSessionExpired(source: DiagCategory) {
  if (alreadyFired) return;
  alreadyFired = true;
  diag('session', 'error', 'session expired — signing out', { source });
  void flush();
  sessionExpiredHandler?.();
}

/** Called on a successful login so a later expiry can fire again. */
export function resetSessionExpiry() {
  alreadyFired = false;
}

// ─── Reconnect backoff ───────────────────────────────────────────────────────

/**
 * Both sockets previously retried every 3s forever. That is what turned a dead
 * session into an endless console spam loop, and it also means a genuinely down
 * backend gets hammered by every open tab. Exponential with jitter, capped.
 */
export function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)); // 1s→32s, capped 30s
  return Math.round(base * (0.7 + Math.random() * 0.6));           // ±30% jitter
}
