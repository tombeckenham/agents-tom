/**
 * Shared WebSocket transport for AG-UI chat clients.
 *
 * Speaks the `CF_AGENT_*` envelope (request / response / resume / cancel)
 * and yields the `AGUIEvent`s carried in
 * `CF_AGENT_USE_CHAT_RESPONSE.body` as an `AsyncIterable`. Client adapters
 * layer their own shape on top: `@cloudflare/ai-chat-tanstack` consumes the
 * events directly (identity), `@cloudflare/ai-chat-vercel` pipes them
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

  private _resumeResolver: ((data: { id: string } | null) => void) | null =
    null;
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
    return this._resumeResolver !== null;
  }

  handleStreamResuming(data: { id: string }): boolean {
    return this.settleResume(data);
  }

  handleStreamResumeNone(): boolean {
    return this.settleResume(null);
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

    const decision = await new Promise<{ id: string } | null>((resolve) => {
      const resolver = (data: { id: string } | null) => {
        clearTimeout(timeout);
        resolve(data);
      };
      const giveUp = () => {
        clearTimeout(timeout);
        if (this._resumeResolver === resolver) this._resumeResolver = null;
        resolve(null);
      };
      const timeout = setTimeout(giveUp, RESUME_DECISION_TIMEOUT_MS);
      this._resumeResolver = resolver;
      // A dead socket answers now instead of after the full timeout.
      if (!this.sendResumeRequest()) giveUp();
    });

    if (!decision) return null;

    const requestId = decision.id;
    this.activeRequestIds?.add(requestId);
    // The ACK goes out from inside `setup`, i.e. after the listeners are
    // attached (no replayed frame slips past) and under its try/catch (a
    // send that throws tears the stream down instead of leaking it).
    return this._createEventStream(requestId, (ctx) => {
      ctx.markSent();
      this.setActiveServerTurn(requestId, () => {
        if (ctx.done) return false;
        ctx.finish(abortError(), { keepRequestId: true });
        return true;
      });
      try {
        this.sendResumeAck(requestId);
      } catch {
        ctx.finish(null); // socket died: empty replay, nothing leaked
      }
    });
  }

  /**
   * Continuation stream: the resume handshake runs *inside* the stream, so
   * the caller gets an iterable immediately and events start flowing once
   * the server names the continuation's request id.
   */
  private _createToolContinuationStream(): AGUIEventStream {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => boolean) | null = null;
    let resolve: ((data: { id: string } | null) => void) | null = null;
    return this._createEventStream(
      null,
      (ctx) => {
        timeout = setTimeout(() => {
          if (ctx.requestId === null) ctx.finish(null);
        }, RESUME_DECISION_TIMEOUT_MS);

        abort = () => {
          if (ctx.done) return false;
          // A continuation always cancels the server turn it adopted,
          // regardless of the client-abort policy.
          ctx.finish(abortError(), { keepRequestId: ctx.cancelOnWire(true) });
          return true;
        };
        this._abortToolContinuation = abort;

        resolve = (decision) => {
          clearTimeout(timeout);
          if (decision === null) {
            ctx.finish(null);
            return;
          }
          ctx.adoptRequestId(decision.id);
          this.activeRequestIds?.add(decision.id);
          try {
            this.sendResumeAck(decision.id);
          } catch {
            ctx.finish(null);
          }
        };
        this._resumeResolver = resolve;

        // A dead socket ends the continuation now instead of at the timeout.
        if (!this.sendResumeRequest()) ctx.finish(null);
      },
      () => {
        clearTimeout(timeout);
        // Only drop OUR hooks — a newer resume/continuation may already own
        // the transport-level slots.
        if (this._abortToolContinuation === abort) {
          this._abortToolContinuation = null;
        }
        if (this._resumeResolver === resolve) this._resumeResolver = null;
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
    const resolver = this._resumeResolver;
    if (!resolver) return false;
    this._resumeResolver = null;
    resolver(data);
    return true;
  }

  /** Returns false if the socket was already closed. */
  private sendResumeRequest(): boolean {
    try {
      this.agent.send(
        JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST })
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
