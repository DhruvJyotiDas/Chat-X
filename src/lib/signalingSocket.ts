type EventHandler = (payload: unknown) => void;

export class SignalingSocket {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private readonly url: string;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onReconnect?: () => void;

  constructor(url: string, onReconnect?: () => void) {
    this.url = url;
    this.onReconnect = onReconnect;
  }

  connect(): Promise<void> {
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('[SignalingSocket] connected');
        resolve();
      };

      this.ws.onerror = (err) => {
        console.error('[SignalingSocket] error', err);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        console.log('[SignalingSocket] disconnected');
        this.ws = null;
        if (!this.intentionalClose) {
          this.reconnectTimer = setTimeout(() => {
            console.log('[SignalingSocket] reconnecting…');
            this.connect().then(() => this.onReconnect?.()).catch(() => {});
          }, 3000);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; payload: unknown };
          const handlers = this.handlers.get(msg.type);
          if (handlers) {
            handlers.forEach((h) => h(msg.payload));
          }
        } catch (e) {
          console.error('[SignalingSocket] parse error', e);
        }
      };
    });
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  send(type: string, payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingSocket] not open, dropping:', type);
      return;
    }
    this.ws.send(JSON.stringify({ type, payload }));
  }

  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
