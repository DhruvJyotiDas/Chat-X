import {
  diag, classifyDisconnect, reportSessionExpired, backoffDelay,
} from './diagnostics';

type EventHandler = (payload: unknown) => void;

/**
 * WebSocket close codes worth naming in logs. The code is very often the only
 * clue about why a connection died, and `1006` in particular means "closed
 * abnormally, no close frame" — i.e. the browser never completed a handshake or
 * the connection was cut. A rejected handshake (401, 502, blocked by a proxy)
 * shows up here as 1006 with no further detail, which is exactly why
 * classifyDisconnect() has to ask over HTTP instead.
 */
const CLOSE_CODES: Record<number, string> = {
  1000: 'normal',
  1001: 'going away',
  1005: 'no status',
  1006: 'abnormal — handshake rejected, dropped, or blocked',
  1011: 'server error',
  1012: 'server restarting',
  1013: 'try again later',
  1015: 'TLS failure',
  4001: 'evicted — signed in from another device or tab',
};

/**
 * Sent by `enterRoom` (server/main.go) when a second tab/device connects with the same
 * user id. Reconnecting into an eviction just gets evicted again — two tabs of the same
 * account can otherwise fight over the seat forever, each round tearing down and
 * rebuilding every WebRTC connection in the room, which is what makes it look like
 * "my video keeps coming and going" to everyone else in the call, not just the two
 * competing tabs. Before this code existed the close carried no frame at all, so the
 * loser saw a bare 1006 ("abnormal") — indistinguishable from a real network drop, and
 * exactly what kept the fight going.
 */
const EVICTED_CODE = 4001;

export class SignalingSocket {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private readonly url: string;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onReconnect?: () => void;
  private onEvicted?: () => void;
  private attempt = 0;
  private openedAt = 0;

  constructor(url: string, onReconnect?: () => void, onEvicted?: () => void) {
    this.url = url;
    this.onReconnect = onReconnect;
    this.onEvicted = onEvicted;
  }

  connect(): Promise<void> {
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      diag('signaling', 'info', 'connecting', { url: this.url, attempt: this.attempt });
      let settled = false;

      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.openedAt = performance.now();
        this.attempt = 0;
        diag('signaling', 'info', 'connected');
        settled = true;
        resolve();
      };

      this.ws.onerror = () => {
        // The event object carries nothing useful by design — no status, no
        // reason. Logging it verbatim (as this used to) produces a wall of
        // WebSocket internals that says nothing. onclose does the real work.
        diag('signaling', 'warn', 'socket error (no detail available from the WebSocket API)');
        if (!settled) { settled = true; reject(new Error('WebSocket connection failed')); }
      };

      this.ws.onclose = (ev) => {
        const heldMs = this.openedAt ? Math.round(performance.now() - this.openedAt) : 0;
        this.openedAt = 0;
        this.ws = null;
        diag('signaling', 'warn', 'disconnected', {
          code: ev.code,
          meaning: CLOSE_CODES[ev.code] ?? 'unspecified',
          reason: ev.reason || '(none)',
          wasClean: ev.wasClean,
          heldOpenMs: heldMs,
          intentional: this.intentionalClose,
        });
        if (!settled) { settled = true; reject(new Error('WebSocket closed before opening')); }
        if (ev.code === EVICTED_CODE) {
          // Do NOT reconnect — see EVICTED_CODE above. Reconnecting here is exactly
          // the behaviour that turns one eviction into an endless fight.
          this.onEvicted?.();
          return;
        }
        if (!this.intentionalClose) void this.scheduleReconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; payload: unknown };
          const handlers = this.handlers.get(msg.type);
          if (handlers) handlers.forEach((h) => h(msg.payload));
        } catch (e) {
          diag('signaling', 'error', 'message parse failed', { err: String(e) });
        }
      };
    });
  }

  /**
   * Reconnect, but first find out WHY we dropped. Retrying a dead session
   * forever is what made a routine key rotation look like a server outage.
   */
  private async scheduleReconnect() {
    const cause = await classifyDisconnect();
    diag('signaling', cause === 'session-expired' ? 'error' : 'warn', 'disconnect classified', {
      cause, attempt: this.attempt,
    });

    if (cause === 'session-expired') {
      reportSessionExpired('signaling');
      return; // deliberately do NOT reconnect — the token will never work again
    }

    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    diag('signaling', 'info', 'reconnect scheduled', { inMs: delay, attempt: this.attempt, cause });
    this.reconnectTimer = setTimeout(() => {
      this.connect()
        .then(() => this.onReconnect?.())
        .catch((e) => diag('signaling', 'warn', 'reconnect attempt failed', { err: String(e) }));
    }, delay);
  }

  disconnect() {
    diag('signaling', 'info', 'closing (intentional)');
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  send(type: string, payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      diag('signaling', 'warn', 'send dropped — socket not open', {
        type, readyState: this.ws?.readyState ?? 'null',
      });
      return;
    }
    this.ws.send(JSON.stringify({ type, payload }));
  }

  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => { this.handlers.get(type)?.delete(handler); };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
