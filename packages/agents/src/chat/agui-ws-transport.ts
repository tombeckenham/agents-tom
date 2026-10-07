/**
 * Shared WebSocket transport for AG-UI chat clients.
 *
 * Speaks the `CF_AGENT_*` envelope (request / response / resume / cancel)
 * and yields the `AGUIEvent`s carried in
 * `CF_AGENT_USE_CHAT_RESPONSE.body` as an `AsyncIterable`. Client adapters
 * layer their own shape on top: `@cloudflare/ai-chat-tanstack` consumes the
 * events directly (identity), `@cloudflare/ai-chat` pipes them
 * through its `event-to-chunk` projection into a `ReadableStream`.
 *
 * The three stream flavours — request, resume replay and tool
 * continuation — share one queue/waiter implementation
 * ({@link AGUIWebSocketTransport._createEventStream}); they differ only in
 * how their request id arrives and what they send to get started.
 */

import { nanoid } from "nanoid";
import type { AGUIEvent } from "./agui-types";
import { CHAT_MESSAGE_TYPES } from "./protocol";

/**
 * Structural shape of the WebSocket-like object the transport needs. The
 * `agents/react` and `partysocket` `WebSocket` shims both satisfy this.
 */
export interface AgentConnection {
  send: (data: string) => void;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void
  ) => void;
}

export type AGUIWebSocketTransportOptions = {
  agent: AgentConnection;
  /**
   * Externally-tracked set of request IDs owned by this transport. The
   * React hook layers use it to deduplicate stream-resume notifications
   * the server fires for in-flight client requests.
   */
  activeRequestIds?: Set<string>;
  /**
   * When true, an external `AbortSignal.abort()` (React unmount, `stop()`)
   * forwards a `CF_AGENT_CHAT_REQUEST_CANCEL` to the server. When false
   * only the local stream is torn down, so the server keeps streaming for
   * other listeners (the legacy behaviour).
   */
  cancelOnClientAbort?: boolean;
};

/**
 * An AG-UI event stream. `error` is the terminal failure (wire error
 * frame, abort) once one has happened — readable synchronously so a
 * consumer that buffers events elsewhere (the AI SDK adapter's
 * `ReadableStream`) can drop what it already took instead of replaying it
 * past a cancellation.
 */
export type AGUIEventStream = AsyncIterable<AGUIEvent> & {
  readonly error: Error | null;
};

/** Envelope shape the transport reads off the wire. */
type ChatResponseFrame = {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
};

/** Handle the per-flavour setup code uses to drive one event stream. */
type EventStreamContext = {
  /** Id of the turn whose frames this stream accepts; null until known. */
  readonly requestId: string | null;
  readonly done: boolean;
  /**
   * Adopt a request id discovered mid-flight (tool continuation); also
   * marks the turn live on the wire.
   */
  adoptRequestId: (id: string) => void;
  /** Mark an already-known request id as live on the wire. */
  markSent: () => void;
  /**
   * Send `CF_AGENT_CHAT_REQUEST_CANCEL` for this turn if it is live and
   * the cancel-on-abort policy is on (`force` ignores the policy — a tool
   * continuation always hangs up the server). Returns whether a frame
   * went out.
   */
  cancelOnWire: (force?: boolean) => boolean;
  /**
   * The consumer walked away (external abort / early iterator exit): hang
   * the server turn up if policy says so, and return the {@link finish}
   * options for that outcome.
   */
  localTeardown: () => { keepRequestId: boolean; keepServerTurn: boolean };
  /** Terminate the stream; `null` closes it, an error rejects readers. */
  finish: (
    error: Error | null,
    options?: {
      /** Leave the id in `activeRequestIds` (we hung the turn up ourselves). */
      keepRequestId?: boolean;
      /**
       * Leave the turn armed for `cancelActiveServerTurn()`. Set when only
       * the LOCAL stream ended (socket close, client-only abort): the server
       * is still running the turn, so a later `stop()` must still be able to
       * cancel it.
       */
      keepServerTurn?: boolean;
    }
  ) => void;
};

/** Server has 5s to answer a resume probe before the client gives up. */
const RESUME_DECISION_TIMEOUT_MS = 5000;

/**
 * Extended backstop once the server says a turn is pending (`STREAM_PENDING`,
 * #1784). The pre-stream window (queueing, MCP setup, model latency) can far
 * exceed the short probe timeout, and the server guarantees a follow-up
 * `STREAM_RESUMING` / `STREAM_RESUME_NONE` — so keep waiting, but still cap it
 * so a dropped follow-up degrades to "no stream" instead of hanging forever.
 */
const RESUME_PENDING_TIMEOUT_MS = 60000;

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Parse a `CF_AGENT_USE_CHAT_RESPONSE.body` into an `AGUIEvent`. The body
 * is raw JSON (NOT prefixed with `data: ` — that prefix only appears
 * inside server-side AG-UI SSE bodies). Returns `null` for malformed JSON.
 */
function parseAGUIEvent(body: string): AGUIEvent | null {
  try {
    return JSON.parse(body) as AGUIEvent;
  } catch {
    return null;
  }
}

export class AGUIWebSocketTransport {
  /** Reassigned by the React layers when the connection is replaced. */
  agent: AgentConnection;
  private activeRequestIds?: Set<string>;
  private cancelOnClientAbort: boolean;

  /**
   * The outstanding resume handshake, if any. `probeId` travels with the
   * resolver rather than in a separate field so an uncorrelated
   * `STREAM_RESUME_NONE` can never settle a handshake it does not name
   * (#1914). `isProbe` distinguishes a reconnect probe from a tool
   * continuation, which owns the slot for its whole life.
   */
  private _resumeHandshake: {
    probeId: string;
    isProbe: boolean;
    resolve: (data: { id: string } | null) => void;
  } | null = null;
  /** Keep-waiting hook for `STREAM_PENDING` (#1784). */
  private _onStreamPending: (() => void) | null = null;
  /** Retransmits the in-flight probe on a replacement socket. */
  private _retryResumeProbe: (() => void) | null = null;
  /**
   * Local-only close of a resume/continuation stream owned by an obsolete
   * hook generation. Unlike cancellation this never hangs up the server.
   */
  private _detachResumeStream: (() => boolean) | null = null;
  private _expectToolContinuation = false;
  private _abortToolContinuation: (() => boolean) | null = null;
  private _activeServerTurnId: string | null = null;
  private _cancelAttachedStream: (() => boolean) | null = null;

  constructor(options: AGUIWebSocketTransportOptions) {
    this.agent = options.agent;
    this.activeRequestIds = options.activeRequestIds;
    this.cancelOnClientAbort = options.cancelOnClientAbort ?? false;
  }

  setCancelOnClientAbort(value: boolean) {
    this.cancelOnClientAbort = value;
  }

  /**
   * Point the transport at a replacement connection. A pending handshake
   * belongs to the old socket generation and must settle before frames from
   * the new one are consumed (#1914).
   */
  setAgent(agent: AgentConnection) {
    if (this.agent === agent) return;
    this.resetResumeState();
    this.agent = agent;
  }

  /**
   * Cancel the active server turn — sends `CF_AGENT_CHAT_REQUEST_CANCEL`
   * and aborts the attached stream so the consumer sees an `AbortError`.
   * Returns true if anything was cancelled.
   */
  cancelActiveServerTurn(): boolean {
    const requestId = this._activeServerTurnId;
    let cancelledRequest = false;
    if (requestId) {
      this.sendCancelFrame(requestId);
      this._cancelAttachedStream?.();
      this.clearActiveServerTurn(requestId);
      cancelledRequest = true;
    }
    const cancelledToolContinuation = this.abortActiveToolContinuation();
    return cancelledRequest || cancelledToolContinuation;
  }

  private sendCancelFrame(requestId: string) {
    try {
      this.agent.send(
        JSON.stringify({
          id: requestId,
          type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL
        })
      );
    } catch {
      // socket may already be closed
    }
  }

  expectToolContinuation() {
    this._expectToolContinuation = true;
  }

  abortActiveToolContinuation(): boolean {
    return this._abortToolContinuation?.() ?? false;
  }

  isAwaitingResume(): boolean {
    return this._resumeHandshake !== null;
  }

  handleStreamResuming(data: { id: string }): boolean {
    return this.settleResume(data);
  }

  /**
   * A `STREAM_RESUME_NONE` carrying a `probeId` only answers the handshake
   * that asked; an uncorrelated one (older frame, another connection's
   * continuation) is not authoritative for ours (#1914).
   */
  handleStreamResumeNone(data: { probeId?: string } = {}): boolean {
    const handshake = this._resumeHandshake;
    if (!handshake) return false;
    if (data.probeId && data.probeId !== handshake.probeId) return false;
    return this.settleResume(null);
  }

  /**
   * `STREAM_PENDING` (#1784): the server accepted a turn whose stream has not
   * started yet. Extends the waiting probe's timeout. Returns whether a
   * waiting path consumed it.
   */
  handleStreamPending(): boolean {
    if (!this._onStreamPending) return false;
    this._onStreamPending();
    return true;
  }

  /**
   * Retransmit the in-flight handshake on the latest socket. Recovers a
   * request/reply lost with the previous WebSocket without starting a second
   * resume operation.
   */
  retryPendingResume(): boolean {
    if (!this._retryResumeProbe) return false;
    this._retryResumeProbe();
    return true;
  }

  /**
   * Settle the current handshake without interpreting it as "server idle" —
   * used when the owning hook/agent generation changes.
   */
  cancelPendingResume(): boolean {
    return this.settleResume(null);
  }

  /**
   * Invalidate all client-side resume state for an obsolete hook/agent
   * generation, leaving the durable server turn running.
   */
  resetResumeState(): void {
    this._expectToolContinuation = false;
    this.cancelPendingResume();
    this._detachResumeStream?.();
  }

  handleServerTurnCompleted(requestId: string) {
    this.clearActiveServerTurn(requestId);
  }

  observeServerTurn(requestId: string) {
    this.setActiveServerTurn(requestId, null);
  }

  /**
   * Send one chat request and return the server's reply as a stream of
   * AG-UI events. `sent` settles once the request frame has hit the wire
   * (or rejects if `buildBody` threw), so adapters with an async send API
   * can await it before handing the stream to their caller.
   */
  openRequestStream(options: {
    /** Assembles the JSON body; may be async (e.g. a `prepareBody` hook). */
    buildBody: () => Promise<string> | string;
    abortSignal?: AbortSignal;
  }): { events: AGUIEventStream; sent: Promise<void> } {
    const requestId = nanoid(8);
    let resolveSent!: () => void;
    let rejectSent!: (error: unknown) => void;
    const sent = new Promise<void>((resolve, reject) => {
      resolveSent = resolve;
      rejectSent = reject;
    });
    // NOT a swallow: the failure is still delivered — the AI SDK adapter
    // awaits `sent` and rejects `sendMessages`, TanStack reads the same
    // error off the event stream. This handler only stops the copy nobody
    // awaits from surfacing as an unhandled rejection.
    sent.catch(() => {});

    const events = this._createEventStream(requestId, (ctx) => {
      this.setActiveServerTurn(requestId, () => {
        if (ctx.done) return false;
        ctx.finish(abortError(), { keepRequestId: true });
        return true;
      });

      const signal = options.abortSignal;
      if (signal) {
        const onAbort = () => {
          if (ctx.done) return;
          ctx.finish(abortError(), ctx.localTeardown());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      void (async () => {
        try {
          const body = await options.buildBody();
          if (!ctx.done) {
            this.activeRequestIds?.add(requestId);
            ctx.markSent();
            this.agent.send(
              JSON.stringify({
                id: requestId,
                init: { method: "POST", body },
                type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST
              })
            );
          }
          resolveSent();
        } catch (error) {
          ctx.finish(error instanceof Error ? error : new Error(String(error)));
          rejectSent(error);
        }
      })();
    });

    return { events, sent };
  }

  /**
   * Resume an in-flight server turn after a reconnect — or, when
   * {@link expectToolContinuation} was called, pick up the continuation of
   * a turn that was waiting on a client tool result. Resolves to `null`
   * when the server has nothing to replay.
   */
  async reconnectToEventStream(): Promise<AGUIEventStream | null> {
    if (this._expectToolContinuation) {
      this._expectToolContinuation = false;
      return this._createToolContinuationStream();
    }

    // One probe at a time (legacy `reconnectToStream` semantics): a second
    // concurrent caller would overwrite callbacks the first one owns. A tool
    // continuation legitimately holds the slot for its whole life, and a
    // probe is allowed to take it over from one — that hand-off is what
    // `isProbe` distinguishes.
    if (this._resumeHandshake?.isProbe) return null;

    const probeId = nanoid(8);
    const decision = await new Promise<{ id: string } | null>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = (data: { id: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this._resumeHandshake === handshake) this._resumeHandshake = null;
        this.clearProbeHooks(onPending, retry);
        resolve(data);
      };
      const armTimeout = (delay: number) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (delay === RESUME_PENDING_TIMEOUT_MS) {
            // The server promised a follow-up after STREAM_PENDING and never
            // sent one. Resolving "no stream" is the safe outcome, but it is
            // a server-side fault worth seeing.
            console.warn(
              "[agents/chat] resume probe gave up waiting for a pending turn"
            );
          }
          done(null);
        }, delay);
      };
      const handshake = {
        probeId,
        isProbe: true,
        resolve: (data: { id: string } | null) => done(data)
      };
      const onPending = () => {
        if (!settled) armTimeout(RESUME_PENDING_TIMEOUT_MS);
      };
      // Re-arms this same probe on a replacement socket; a send that fails
      // is left to the next open, with the timeout as the backstop.
      const retry = () => {
        if (settled) return;
        armTimeout(RESUME_DECISION_TIMEOUT_MS);
        this.sendResumeRequest(probeId);
      };

      this._resumeHandshake = handshake;
      this._onStreamPending = onPending;
      this._retryResumeProbe = retry;

      armTimeout(RESUME_DECISION_TIMEOUT_MS);
      // A dead socket answers now instead of after the full timeout.
      if (!this.sendResumeRequest(probeId)) done(null);
    });

    if (!decision) return null;

    const requestId = decision.id;
    this.activeRequestIds?.add(requestId);
    let detach: (() => boolean) | null = null;
    // The ACK goes out from inside `setup`, i.e. after the listeners are
    // attached (no replayed frame slips past) and under its try/catch (a
    // send that throws tears the stream down instead of leaking it).
    return this._createEventStream(
      requestId,
      (ctx) => {
        ctx.markSent();
        this.setActiveServerTurn(requestId, () => {
          if (ctx.done) return false;
          ctx.finish(abortError(), { keepRequestId: true });
          return true;
        });
        detach = () => {
          if (ctx.done) return false;
          ctx.finish(null);
          return true;
        };
        this._detachResumeStream = detach;
        try {
          this.sendResumeAck(requestId);
        } catch {
          ctx.finish(null); // socket died: empty replay, nothing leaked
        }
      },
      () => {
        if (this._detachResumeStream === detach)
          this._detachResumeStream = null;
      }
    );
  }

  /** Drop probe-scoped hooks, but only the ones this probe still owns. */
  private clearProbeHooks(onPending: () => void, retry: () => void) {
    if (this._onStreamPending === onPending) this._onStreamPending = null;
    if (this._retryResumeProbe === retry) this._retryResumeProbe = null;
  }

  /**
   * Continuation stream: the resume handshake runs *inside* the stream, so
   * the caller gets an iterable immediately and events start flowing once
   * the server names the continuation's request id.
   */
  private _createToolContinuationStream(): AGUIEventStream {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => boolean) | null = null;
    let detach: (() => boolean) | null = null;
    let handshake: {
      probeId: string;
      isProbe: boolean;
      resolve: (data: { id: string } | null) => void;
    } | null = null;
    let onPending: (() => void) | null = null;
    let retry: (() => void) | null = null;
    const probeId = nanoid(8);
    return this._createEventStream(
      null,
      (ctx) => {
        const armTimeout = (delay: number) => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            if (ctx.requestId === null) ctx.finish(null);
          }, delay);
        };
        armTimeout(RESUME_DECISION_TIMEOUT_MS);

        onPending = () => {
          if (ctx.requestId === null && !ctx.done) {
            armTimeout(RESUME_PENDING_TIMEOUT_MS);
          }
        };
        retry = () => {
          if (ctx.done || ctx.requestId !== null) return;
          armTimeout(RESUME_DECISION_TIMEOUT_MS);
          this.sendResumeRequest(probeId);
        };
        detach = () => {
          if (ctx.done) return false;
          ctx.finish(null);
          return true;
        };
        this._detachResumeStream = detach;

        abort = () => {
          if (ctx.done) return false;
          // A continuation always cancels the server turn it adopted,
          // regardless of the client-abort policy.
          ctx.finish(abortError(), { keepRequestId: ctx.cancelOnWire(true) });
          return true;
        };
        this._abortToolContinuation = abort;

        handshake = {
          probeId,
          isProbe: false,
          resolve: (decision) => {
            clearTimeout(timeout);
            if (decision === null) {
              ctx.finish(null);
              return;
            }
            // The handshake is over once the id is adopted: leaving the
            // probe hooks armed makes `retryPendingResume()` report a
            // retransmit it will not perform, and the hook then skips its
            // own reconnect probe. Mirrors legacy `clearOwnedHandshake`.
            if (onPending && retry) this.clearProbeHooks(onPending, retry);
            ctx.adoptRequestId(decision.id);
            this.activeRequestIds?.add(decision.id);
            try {
              this.sendResumeAck(decision.id);
            } catch {
              ctx.finish(null);
            }
          }
        };
        this._resumeHandshake = handshake;
        this._onStreamPending = onPending;
        this._retryResumeProbe = retry;

        // A dead socket ends the continuation now instead of at the timeout.
        if (!this.sendResumeRequest(probeId)) ctx.finish(null);
      },
      () => {
        clearTimeout(timeout);
        // Only drop OUR hooks — a newer resume/continuation may already own
        // the transport-level slots.
        if (this._abortToolContinuation === abort) {
          this._abortToolContinuation = null;
        }
        if (this._detachResumeStream === detach)
          this._detachResumeStream = null;
        if (this._resumeHandshake === handshake) this._resumeHandshake = null;
        if (onPending && retry) this.clearProbeHooks(onPending, retry);
      }
    );
  }

  private setActiveServerTurn(
    requestId: string,
    cancelAttachedStream: (() => boolean) | null
  ) {
    this._activeServerTurnId = requestId;
    this._cancelAttachedStream = cancelAttachedStream;
  }

  private clearActiveServerTurn(requestId: string) {
    if (this._activeServerTurnId === requestId) {
      this._activeServerTurnId = null;
      this._cancelAttachedStream = null;
    }
  }

  private settleResume(data: { id: string } | null): boolean {
    const handshake = this._resumeHandshake;
    if (!handshake) return false;
    this._resumeHandshake = null;
    handshake.resolve(data);
    return true;
  }

  /** Returns false if the socket was already closed. */
  private sendResumeRequest(probeId?: string): boolean {
    try {
      this.agent.send(
        JSON.stringify({
          type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
          ...(probeId ? { probeId } : {})
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendResumeAck(requestId: string) {
    this.agent.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
        id: requestId
      })
    );
  }

  /**
   * The one queue/waiter/finish/drain implementation behind all three
   * stream flavours. `setup` starts the flavour-specific wire traffic;
   * `onFinish` runs its teardown.
   */
  private _createEventStream(
    initialRequestId: string | null,
    setup: (ctx: EventStreamContext) => void,
    onFinish?: () => void
  ): AGUIEventStream {
    const queue: AGUIEvent[] = [];
    const waiters: Array<{
      resolve: (result: IteratorResult<AGUIEvent>) => void;
      reject: (error: unknown) => void;
    }> = [];
    let requestId = initialRequestId;
    /** True once the server knows about this turn (request sent / resumed). */
    let live = false;
    let done = false;
    let streamError: Error | null = null;

    const drain = () => {
      while (waiters.length > 0 && (queue.length > 0 || done)) {
        const waiter = waiters.shift();
        if (!waiter) continue;
        if (queue.length > 0) {
          waiter.resolve({ value: queue.shift() as AGUIEvent, done: false });
        } else if (streamError) {
          waiter.reject(streamError);
        } else {
          waiter.resolve({ value: undefined, done: true });
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: ChatResponseFrame;
      try {
        frame = JSON.parse(event.data) as ChatResponseFrame;
      } catch {
        return;
      }
      if (frame.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) return;
      if (requestId === null || frame.id !== requestId) return;
      if (frame.error) {
        finish(new Error(frame.body || "Stream error"));
        return;
      }
      if (frame.body && frame.body.trim().length > 0) {
        const aguiEvent = parseAGUIEvent(frame.body);
        if (aguiEvent) queue.push(aguiEvent);
      }
      if (frame.done) finish(null);
      drain();
    };

    // The socket only closed on us — the server turn itself may still be
    // running, so leave it armed for a later `cancelActiveServerTurn()`.
    const onClose = () => finish(null, { keepServerTurn: true });

    const finish: EventStreamContext["finish"] = (error, options) => {
      if (done) return;
      done = true;
      streamError = error;
      // Detach from the socket we attached to, not from whatever
      // `this.agent` points at now (the React layers swap it per render).
      agent.removeEventListener("message", onMessage);
      agent.removeEventListener("close", onClose);
      onFinish?.();
      if (requestId) {
        if (!options?.keepRequestId) this.activeRequestIds?.delete(requestId);
        if (!options?.keepServerTurn) this.clearActiveServerTurn(requestId);
      }
      drain();
    };

    const ctx: EventStreamContext = {
      get requestId() {
        return requestId;
      },
      get done() {
        return done;
      },
      adoptRequestId: (id) => {
        requestId = id;
        live = true;
      },
      markSent: () => {
        live = true;
      },
      cancelOnWire: (force = false) => {
        if (!live || !requestId) return false;
        if (!force && !this.cancelOnClientAbort) return false;
        this.sendCancelFrame(requestId);
        return true;
      },
      localTeardown: () => {
        const cancelled = ctx.cancelOnWire();
        // No cancel frame means the server keeps streaming for everyone
        // else; the turn stays armed so a later stop() can still hang up.
        return { keepRequestId: cancelled, keepServerTurn: !cancelled && live };
      },
      finish
    };

    const agent = this.agent;
    agent.addEventListener("message", onMessage);
    agent.addEventListener("close", onClose);
    try {
      setup(ctx);
    } catch (error) {
      // A setup that throws mid-construction (dead socket) must not leave
      // listeners, ids or an armed turn behind.
      finish(error instanceof Error ? error : new Error(String(error)));
    }

    const iterator: AsyncIterator<AGUIEvent> = {
      next: () =>
        new Promise<IteratorResult<AGUIEvent>>((resolve, reject) => {
          waiters.push({ resolve, reject });
          drain();
        }),
      return: async () => {
        finish(null, ctx.localTeardown());
        return { value: undefined, done: true };
      },
      throw: async (error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
        return { value: undefined, done: true };
      }
    };

    return {
      [Symbol.asyncIterator]: () => iterator,
      get error() {
        return streamError;
      }
    };
  }
}
