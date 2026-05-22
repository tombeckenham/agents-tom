/**
 * WebSocket-backed AG-UI event stream source for TanStack AI's
 * `@tanstack/ai-client` `stream()` connection adapter.
 *
 * Identity adapter on the chunk body: TanStack `useChat` already consumes
 * `AGUIEvent`s, and `CF_AGENT_USE_CHAT_RESPONSE.body` is the raw JSON of
 * one `AGUIEvent` per frame. The transport therefore parses each body with
 * `JSON.parse(body) as AGUIEvent` and yields it through unchanged.
 *
 * Framing (request/response/resume/cancel/tool-result/tool-approval) is
 * the same CF_AGENT_* envelope as `@cloudflare/ai-chat-vercel`; only the
 * client-side projection layer is gone.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import { nanoid } from "nanoid";
import { MessageType, type OutgoingAGUIWireMessage } from "./types";

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

export type WebSocketChatTransportOptions = {
  agent: AgentConnection;
  /**
   * Hook to add extra keys to the request body sent to the agent. The
   * transport always includes `messages` (the TanStack-shaped message
   * array passed to `streamFactory`). Anything returned here is merged on
   * top.
   */
  prepareBody?: (options: {
    messages: ReadonlyArray<unknown>;
    forwardedProps?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Externally-tracked set of request IDs that are owned by this
   * transport. Used by the React hook layer to deduplicate
   * stream-resume notifications fired by the server for in-flight
   * client requests.
   */
  activeRequestIds?: Set<string>;
  /**
   * When true, an external `AbortSignal.abort()` (e.g. React unmount,
   * `ChatClient.stop()`) forwards a `CF_AGENT_CHAT_REQUEST_CANCEL` to the
   * server. When false, only the local stream is torn down so the server
   * keeps streaming for other listeners (matches the legacy behaviour).
   */
  cancelOnClientAbort?: boolean;
};

/**
 * AG-UI WebSocket transport. Exposes a TanStack-shaped `streamFactory`
 * suitable for `@tanstack/ai-client`'s `stream(streamFactory)` adapter
 * plus lifecycle helpers (cancel / resume / tool continuation) the React
 * hook wires up to `useChat`.
 */
export class WebSocketChatTransport {
  agent: AgentConnection;
  private prepareBody?: WebSocketChatTransportOptions["prepareBody"];
  private activeRequestIds?: Set<string>;
  private cancelOnClientAbort: boolean;

  private _resumeResolver: ((data: { id: string } | null) => void) | null =
    null;
  private _expectToolContinuation = false;
  private _abortToolContinuation: (() => boolean) | null = null;
  private _activeServerTurnId: string | null = null;
  private _cancelAttachedStream: (() => boolean) | null = null;

  constructor(options: WebSocketChatTransportOptions) {
    this.agent = options.agent;
    this.prepareBody = options.prepareBody;
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
          type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
        })
      );
    } catch {
      // socket may already be closed
    }
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
    if (!this._resumeResolver) return false;
    const resolver = this._resumeResolver;
    this._resumeResolver = null;
    resolver(data);
    return true;
  }

  handleStreamResumeNone(): boolean {
    if (!this._resumeResolver) return false;
    const resolver = this._resumeResolver;
    this._resumeResolver = null;
    resolver(null);
    return true;
  }

  handleServerTurnCompleted(requestId: string) {
    this.clearActiveServerTurn(requestId);
  }

  observeServerTurn(requestId: string) {
    this.setActiveServerTurn(requestId, null);
  }

  /**
   * Open a request stream — returns an `AsyncIterable<AGUIEvent>` of the
   * server's reply. Compatible with `@tanstack/ai-client`'s
   * `stream(streamFactory)` connection adapter (which takes a function
   * `(messages, data?) => AsyncIterable<StreamChunk>` and `StreamChunk ===
   * AGUIEvent`).
   *
   * Pass this to `stream()` directly:
   *
   * ```ts
   * import { stream } from "@tanstack/ai-client";
   *
   * const connection = stream((messages, data) =>
   *   transport.streamFactory(messages, data)
   * );
   * ```
   */
  streamFactory = (
    messages: ReadonlyArray<unknown>,
    data?: Record<string, unknown>,
    abortSignal?: AbortSignal
  ): AsyncIterable<AGUIEvent> => {
    return this._openRequestStream(messages, data, abortSignal);
  };

  private _openRequestStream(
    messages: ReadonlyArray<unknown>,
    data: Record<string, unknown> | undefined,
    externalAbortSignal: AbortSignal | undefined
  ): AsyncIterable<AGUIEvent> {
    const requestId = nanoid(8);
    const transport = this;
    const queue: AGUIEvent[] = [];
    const waiters: Array<{
      resolve: (result: IteratorResult<AGUIEvent>) => void;
      reject: (error: unknown) => void;
    }> = [];
    let done = false;
    let streamError: Error | null = null;
    let requestSent = false;
    let removeListeners: (() => void) | null = null;

    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      streamError = err;
      if (removeListeners) {
        removeListeners();
        removeListeners = null;
      }
      transport.activeRequestIds?.delete(requestId);
      transport.clearActiveServerTurn(requestId);
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (!w) continue;
        if (err) {
          w.reject(err);
        } else {
          w.resolve({ value: undefined, done: true });
        }
      }
    };

    const drainNextWaiter = () => {
      while (waiters.length > 0 && (queue.length > 0 || done)) {
        const w = waiters.shift();
        if (!w) continue;
        if (queue.length > 0) {
          const next = queue.shift();
          if (next !== undefined) {
            w.resolve({ value: next, done: false });
            continue;
          }
        }
        if (streamError) {
          w.reject(streamError);
        } else {
          w.resolve({ value: undefined, done: true });
        }
      }
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    const cancelActiveRequest = (): boolean => {
      if (done) return false;
      finish(abortError);
      return true;
    };
    transport.setActiveServerTurn(requestId, cancelActiveRequest);

    const onAbort = () => {
      if (done) return;
      if (transport.cancelOnClientAbort && requestSent) {
        transport.sendCancelFrame(requestId);
      }
      finish(abortError);
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let data: OutgoingAGUIWireMessage;
      try {
        data = JSON.parse(event.data) as OutgoingAGUIWireMessage;
      } catch {
        return;
      }
      if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
      if (data.id !== requestId) return;
      if (data.error) {
        finish(new Error(data.body || "Stream error"));
        drainNextWaiter();
        return;
      }
      if (data.body && data.body.trim().length > 0) {
        const aguiEvent = parseAGUIEvent(data.body);
        if (aguiEvent) {
          queue.push(aguiEvent);
        }
      }
      if (data.done) {
        finish(null);
      }
      drainNextWaiter();
    };

    const onClose = () => {
      finish(null);
      drainNextWaiter();
    };

    transport.agent.addEventListener("message", onMessage);
    transport.agent.addEventListener("close", onClose);
    removeListeners = () => {
      transport.agent.removeEventListener("message", onMessage);
      transport.agent.removeEventListener("close", onClose);
    };

    if (externalAbortSignal) {
      if (externalAbortSignal.aborted) {
        onAbort();
      } else {
        externalAbortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    void (async () => {
      try {
        const extra = transport.prepareBody
          ? await transport.prepareBody({ messages, forwardedProps: data })
          : {};
        const bodyPayload = JSON.stringify({
          messages,
          ...(data ?? {}),
          ...extra
        });
        if (done) return;
        transport.activeRequestIds?.add(requestId);
        requestSent = true;
        transport.agent.send(
          JSON.stringify({
            id: requestId,
            init: { method: "POST", body: bodyPayload },
            type: MessageType.CF_AGENT_USE_CHAT_REQUEST
          })
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        drainNextWaiter();
      }
    })();

    const iterator: AsyncIterator<AGUIEvent> = {
      next(): Promise<IteratorResult<AGUIEvent>> {
        return new Promise<IteratorResult<AGUIEvent>>((resolve, reject) => {
          waiters.push({ resolve, reject });
          drainNextWaiter();
        });
      },
      async return(): Promise<IteratorResult<AGUIEvent>> {
        if (transport.cancelOnClientAbort && requestSent) {
          transport.sendCancelFrame(requestId);
        }
        finish(null);
        return { value: undefined, done: true };
      },
      async throw(err): Promise<IteratorResult<AGUIEvent>> {
        finish(err instanceof Error ? err : new Error(String(err)));
        drainNextWaiter();
        return { value: undefined, done: true };
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      }
    };
  }

  /**
   * Open a resume / reconnect stream and return it as
   * `AsyncIterable<AGUIEvent>` so the same TanStack `stream()` adapter can
   * consume the replayed run. Resolves to `null` if the server has no
   * active stream (`CF_AGENT_STREAM_RESUME_NONE`).
   *
   * Mirrors the Vercel adapter's `reconnectToStream` shape so the React
   * hook can wire the two interchangeably.
   */
  async reconnectToStream(): Promise<AsyncIterable<AGUIEvent> | null> {
    if (this._expectToolContinuation) {
      this._expectToolContinuation = false;
      return this._createToolContinuationStream();
    }

    const decision = await new Promise<{ id: string } | null>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._resumeResolver = null;
        resolve(null);
      }, 5000);

      this._resumeResolver = (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(data);
      };

      try {
        this.agent.send(
          JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
        );
      } catch {
        // socket may already be closed
      }
    });

    if (!decision) return null;

    const requestId = decision.id;
    this.activeRequestIds?.add(requestId);
    this.agent.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: requestId
      })
    );
    return this._createResumeStream(requestId);
  }

  private _createResumeStream(requestId: string): AsyncIterable<AGUIEvent> {
    const transport = this;
    const queue: AGUIEvent[] = [];
    const waiters: Array<{
      resolve: (result: IteratorResult<AGUIEvent>) => void;
      reject: (error: unknown) => void;
    }> = [];
    let done = false;
    let streamError: Error | null = null;
    let removeListeners: (() => void) | null = null;

    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      streamError = err;
      if (removeListeners) {
        removeListeners();
        removeListeners = null;
      }
      transport.activeRequestIds?.delete(requestId);
      transport.clearActiveServerTurn(requestId);
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (!w) continue;
        if (err) w.reject(err);
        else w.resolve({ value: undefined, done: true });
      }
    };

    const drainNextWaiter = () => {
      while (waiters.length > 0 && (queue.length > 0 || done)) {
        const w = waiters.shift();
        if (!w) continue;
        if (queue.length > 0) {
          const next = queue.shift();
          if (next !== undefined) {
            w.resolve({ value: next, done: false });
            continue;
          }
        }
        if (streamError) w.reject(streamError);
        else w.resolve({ value: undefined, done: true });
      }
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    transport.setActiveServerTurn(requestId, () => {
      if (done) return false;
      finish(abortError);
      drainNextWaiter();
      return true;
    });

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let data: OutgoingAGUIWireMessage;
      try {
        data = JSON.parse(event.data) as OutgoingAGUIWireMessage;
      } catch {
        return;
      }
      if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
      if (data.id !== requestId) return;
      if (data.error) {
        finish(new Error(data.body || "Stream error"));
        drainNextWaiter();
        return;
      }
      if (data.body && data.body.trim().length > 0) {
        const aguiEvent = parseAGUIEvent(data.body);
        if (aguiEvent) queue.push(aguiEvent);
      }
      if (data.done) finish(null);
      drainNextWaiter();
    };

    const onClose = () => {
      finish(null);
      drainNextWaiter();
    };

    transport.agent.addEventListener("message", onMessage);
    transport.agent.addEventListener("close", onClose);
    removeListeners = () => {
      transport.agent.removeEventListener("message", onMessage);
      transport.agent.removeEventListener("close", onClose);
    };

    const iterator: AsyncIterator<AGUIEvent> = {
      next(): Promise<IteratorResult<AGUIEvent>> {
        return new Promise<IteratorResult<AGUIEvent>>((resolve, reject) => {
          waiters.push({ resolve, reject });
          drainNextWaiter();
        });
      },
      async return(): Promise<IteratorResult<AGUIEvent>> {
        if (transport.cancelOnClientAbort) {
          transport.sendCancelFrame(requestId);
        }
        finish(null);
        return { value: undefined, done: true };
      },
      async throw(err): Promise<IteratorResult<AGUIEvent>> {
        finish(err instanceof Error ? err : new Error(String(err)));
        drainNextWaiter();
        return { value: undefined, done: true };
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      }
    };
  }

  private _createToolContinuationStream(): AsyncIterable<AGUIEvent> {
    const transport = this;
    const queue: AGUIEvent[] = [];
    const waiters: Array<{
      resolve: (result: IteratorResult<AGUIEvent>) => void;
      reject: (error: unknown) => void;
    }> = [];
    let done = false;
    let streamError: Error | null = null;
    let requestId: string | null = null;
    let removeListeners: (() => void) | null = null;

    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      streamError = err;
      transport._abortToolContinuation = null;
      transport._resumeResolver = null;
      if (removeListeners) {
        removeListeners();
        removeListeners = null;
      }
      if (requestId) {
        transport.activeRequestIds?.delete(requestId);
        transport.clearActiveServerTurn(requestId);
      }
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (!w) continue;
        if (err) w.reject(err);
        else w.resolve({ value: undefined, done: true });
      }
    };

    const drainNextWaiter = () => {
      while (waiters.length > 0 && (queue.length > 0 || done)) {
        const w = waiters.shift();
        if (!w) continue;
        if (queue.length > 0) {
          const next = queue.shift();
          if (next !== undefined) {
            w.resolve({ value: next, done: false });
            continue;
          }
        }
        if (streamError) w.reject(streamError);
        else w.resolve({ value: undefined, done: true });
      }
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    transport._abortToolContinuation = () => {
      if (done) return false;
      if (requestId) {
        try {
          transport.agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
              id: requestId
            })
          );
        } catch {
          // socket may already be closed
        }
      }
      finish(abortError);
      drainNextWaiter();
      return true;
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let data: OutgoingAGUIWireMessage;
      try {
        data = JSON.parse(event.data) as OutgoingAGUIWireMessage;
      } catch {
        return;
      }
      if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
      if (requestId === null || data.id !== requestId) return;
      if (data.error) {
        finish(new Error(data.body || "Stream error"));
        drainNextWaiter();
        return;
      }
      if (data.body && data.body.trim().length > 0) {
        const aguiEvent = parseAGUIEvent(data.body);
        if (aguiEvent) queue.push(aguiEvent);
      }
      if (data.done) finish(null);
      drainNextWaiter();
    };

    const onClose = () => {
      finish(null);
      drainNextWaiter();
    };

    transport.agent.addEventListener("message", onMessage);
    transport.agent.addEventListener("close", onClose);
    removeListeners = () => {
      transport.agent.removeEventListener("message", onMessage);
      transport.agent.removeEventListener("close", onClose);
    };

    const timeout = setTimeout(() => {
      if (requestId === null) {
        finish(null);
        drainNextWaiter();
      }
    }, 5000);

    transport._resumeResolver = (decision) => {
      if (decision === null) {
        clearTimeout(timeout);
        finish(null);
        drainNextWaiter();
        return;
      }
      requestId = decision.id;
      transport.activeRequestIds?.add(requestId);
      clearTimeout(timeout);
      try {
        transport.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: requestId
          })
        );
      } catch {
        finish(null);
        drainNextWaiter();
      }
    };

    try {
      transport.agent.send(
        JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
      );
    } catch {
      finish(null);
    }

    const iterator: AsyncIterator<AGUIEvent> = {
      next(): Promise<IteratorResult<AGUIEvent>> {
        return new Promise<IteratorResult<AGUIEvent>>((resolve, reject) => {
          waiters.push({ resolve, reject });
          drainNextWaiter();
        });
      },
      async return(): Promise<IteratorResult<AGUIEvent>> {
        if (transport.cancelOnClientAbort && requestId) {
          transport.sendCancelFrame(requestId);
        }
        finish(null);
        return { value: undefined, done: true };
      },
      async throw(err): Promise<IteratorResult<AGUIEvent>> {
        finish(err instanceof Error ? err : new Error(String(err)));
        drainNextWaiter();
        return { value: undefined, done: true };
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      }
    };
  }
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
