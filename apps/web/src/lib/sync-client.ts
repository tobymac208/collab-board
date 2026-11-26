import {
  parseServerMessage,
  type ClientMessage,
  type ClientRequestBody,
  type ErrorCode,
  type ServerEvent,
} from "@collab/shared";

export type ConnectionStatus =
  | { status: "connecting"; attempt: number }
  | { status: "open"; rttMs: number | null }
  | { status: "closed"; retryInMs: number }
  /** The session ended (logout elsewhere, expiry). No reconnects. */
  | { status: "ended" };

export class RequestError extends Error {
  constructor(
    readonly code: ErrorCode | "disconnected",
    message: string,
  ) {
    super(message);
  }
}

const PING_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;
/** Must match the server's CLOSE_SESSION_ENDED. */
const CLOSE_SESSION_ENDED = 4001;

/** Exponential backoff with full jitter, so many clients don't reconnect in lockstep. */
export function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

interface Pending {
  events: ServerEvent[];
  resolve: (events: ServerEvent[]) => void;
  reject: (err: RequestError) => void;
}

export interface SyncClientOptions {
  /**
   * Called when a connection fails before the server welcomed us. A rejected
   * upgrade looks like any other network failure to browser code, so this
   * asks the HTTP API whether the session is still valid.
   */
  isSessionValid: () => Promise<boolean>;
}

/**
 * One WebSocket connection to the server: reconnects with backoff, matches
 * request acks to callers, and fans state events out to listeners.
 *
 * Plain class, not a hook, so its lifetime is explicit and it can be tested
 * or reused outside React.
 */
export class SyncClient {
  #socket: WebSocket | undefined;
  #status: ConnectionStatus = { status: "connecting", attempt: 0 };
  #attempt = 0;
  #nextRequestId = 0;
  #pending = new Map<string, Pending>();
  #eventListeners = new Set<(event: ServerEvent) => void>();
  #statusListeners = new Set<() => void>();
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(
    private readonly url: string,
    private readonly options: SyncClientOptions,
  ) {}

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#retryTimer);
    this.#socket?.close();
    this.#failPending();
  }

  getStatus = (): ConnectionStatus => this.#status;

  /** For useSyncExternalStore. */
  subscribeStatus = (listener: () => void): (() => void) => {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  };

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /**
   * Sends a request. Resolves with the request's state events once the
   * server acks it; by then listeners have already seen those events.
   */
  request(body: ClientRequestBody): Promise<ServerEvent[]> {
    const socket = this.#socket;
    if (this.#status.status !== "open" || !socket) {
      return Promise.reject(new RequestError("disconnected", "Not connected to the server"));
    }
    const requestId = String(++this.#nextRequestId);
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { events: [], resolve, reject });
      socket.send(JSON.stringify({ ...body, requestId } satisfies ClientMessage));
    });
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener();
  }

  #send(msg: ClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(msg));
  }

  #failPending(): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new RequestError("disconnected", "Connection lost before the server replied"));
    }
    this.#pending.clear();
  }

  #connect(): void {
    this.#setStatus({ status: "connecting", attempt: this.#attempt });
    const socket = new WebSocket(this.url);
    this.#socket = socket;
    let welcomed = false;

    socket.onmessage = (event) => {
      const parsed = parseServerMessage(String(event.data));
      if (!parsed.ok) {
        console.warn("ignoring malformed server message:", parsed.error);
        return;
      }
      const msg = parsed.value;
      switch (msg.type) {
        case "welcome":
          welcomed = true;
          this.#attempt = 0;
          this.#setStatus({ status: "open", rttMs: null });
          this.#send({ type: "ping", sentAt: Date.now() });
          this.#pingTimer = setInterval(
            () => this.#send({ type: "ping", sentAt: Date.now() }),
            PING_INTERVAL_MS,
          );
          break;
        case "pong":
          if (this.#status.status === "open") {
            this.#setStatus({ status: "open", rttMs: Date.now() - msg.sentAt });
          }
          break;
        case "ack": {
          const pending = this.#pending.get(msg.requestId);
          this.#pending.delete(msg.requestId);
          pending?.resolve(pending.events);
          break;
        }
        case "error": {
          const pending = msg.requestId ? this.#pending.get(msg.requestId) : undefined;
          if (pending && msg.requestId) {
            pending.reject(new RequestError(msg.code, msg.message));
            this.#pending.delete(msg.requestId);
          } else {
            console.warn(`server error (${msg.code}): ${msg.message}`);
          }
          break;
        }
        default:
          if (msg.requestId) this.#pending.get(msg.requestId)?.events.push(msg);
          for (const listener of this.#eventListeners) listener(msg);
      }
    };

    socket.onclose = async (event) => {
      clearInterval(this.#pingTimer);
      this.#failPending();
      if (this.#stopped || this.#socket !== socket) return;
      if (event.code === CLOSE_SESSION_ENDED) {
        this.#setStatus({ status: "ended" });
        return;
      }
      if (!welcomed) {
        const valid = await this.options.isSessionValid().catch(() => true);
        if (this.#stopped) return;
        if (!valid) {
          this.#setStatus({ status: "ended" });
          return;
        }
      }
      const retryInMs = backoffDelay(this.#attempt++);
      this.#setStatus({ status: "closed", retryInMs });
      this.#retryTimer = setTimeout(() => this.#connect(), retryInMs);
    };
  }
}
