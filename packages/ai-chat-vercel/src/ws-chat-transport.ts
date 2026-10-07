/**
 * WebSocket-based ChatTransport for `useChat` that consumes AG-UI events.
 *
 * Mirrors the legacy `@cloudflare/ai-chat/ws-chat-transport.ts` structure
 * but inverts the wire body: the legacy transport parsed
 * `CF_AGENT_USE_CHAT_RESPONSE.body` as a Vercel `UIMessageChunk` and
 * forwarded it untouched; this transport parses it as an `AGUIEvent` and
 * projects to `UIMessageChunk` via {@link EventToChunkProjector}.
 *
 * Framing (request/response/resume/cancel/tool-result/tool-approval) is
 * unchanged — only the chunk body format differs.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { EventToChunkProjector } from "./event-to-chunk";
import { MessageType, type OutgoingAGUIWireMessage } from "./types";

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

export type WebSocketChatTransportOptions<
  ChatMessage extends UIMessage = UIMessage
> = {
  agent: AgentConnection;
  prepareBody?: (options: {
    messages: ChatMessage[];
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  activeRequestIds?: Set<string>;
  cancelOnClientAbort?: boolean;
};

export class WebSocketChatTransport<
  ChatMessage extends UIMessage = UIMessage
> implements ChatTransport<ChatMessage> {
  agent: AgentConnection;
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];
  private activeRequestIds?: Set<string>;
  private cancelOnClientAbort: boolean;

  private _resumeResolver: ((data: { id: string }) => void) | null = null;
  private _resumeNoneResolver: (() => void) | null = null;
  private _expectToolContinuation = false;
  private _abortToolContinuation: (() => boolean) | null = null;
  private _activeServerTurnId: string | null = null;
  private _cancelAttachedStream: (() => boolean) | null = null;

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    this.agent = options.agent;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds;
    this.cancelOnClientAbort = options.cancelOnClientAbort ?? false;
  }

  setCancelOnClientAbort(value: boolean) {
    this.cancelOnClientAbort = value;
  }

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
    return this._resumeResolver !== null || this._resumeNoneResolver !== null;
  }

  handleStreamResuming(data: { id: string }): boolean {
    if (!this._resumeResolver) return false;
    this._resumeResolver(data);
    return true;
  }

  handleStreamResumeNone(): boolean {
    if (!this._resumeNoneResolver) return false;
    this._resumeNoneResolver();
    return true;
  }

  handleServerTurnCompleted(requestId: string) {
    this.clearActiveServerTurn(requestId);
  }

  observeServerTurn(requestId: string) {
    this.setActiveServerTurn(requestId, null);
  }

  async sendMessages(options: {
    chatId: string;
    messages: ChatMessage[];
    abortSignal: AbortSignal | undefined;
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
    body?: object;
    headers?: Record<string, string> | Headers;
    metadata?: unknown;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = nanoid(8);
    const abortController = new AbortController();
    let completed = false;
    let requestSent = false;

    let extraBody: Record<string, unknown> = {};
    if (this.prepareBody) {
      extraBody = await this.prepareBody({
        messages: options.messages,
        trigger: options.trigger,
        messageId: options.messageId
      });
    }
    if (options.body) {
      extraBody = {
        ...extraBody,
        ...(options.body as Record<string, unknown>)
      };
    }

    const bodyPayload = JSON.stringify({
      messages: options.messages,
      trigger: options.trigger,
      ...extraBody
    });

    this.activeRequestIds?.add(requestId);

    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const projector = new EventToChunkProjector();

    const finish = (
      action: () => void,
      keepId = false,
      clearServerTurn = true
    ) => {
      if (completed) return;
      completed = true;
      if (clearServerTurn) this.clearActiveServerTurn(requestId);
      try {
        action();
      } catch {
        // controller may already be closed
      }
      if (!keepId) activeIds?.delete(requestId);
      abortController.abort();
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    const cancelActiveRequest = () => {
      if (completed) return false;
      finish(() => streamController.error(abortError), true);
      return true;
    };
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    const onAbort = () => {
      if (completed) return;
      if (this.cancelOnClientAbort) {
        if (requestSent) this.sendCancelFrame(requestId);
        finish(() => streamController.error(abortError), requestSent);
      } else {
        finish(() => streamController.error(abortError), false, !requestSent);
      }
    };

    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingAGUIWireMessage;
            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }

            if (data.body?.trim()) {
              const aguiEvent = parseAGUIEvent(data.body);
              if (aguiEvent) {
                for (const chunk of projector.project(aguiEvent)) {
                  controller.enqueue(chunk);
                }
              }
            }

            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // ignore non-JSON messages
          }
        };

        const onClose = () => {
          finish(() => controller.close(), false, false);
        };

        agent.addEventListener("message", onMessage, {
          signal: abortController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: abortController.signal
        });
      },
      cancel() {
        onAbort();
      }
    });

    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) onAbort();
    }

    if (completed) return stream;

    requestSent = true;
    agent.send(
      JSON.stringify({
        id: requestId,
        init: { method: "POST", body: bodyPayload },
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST
      })
    );

    return stream;
  }

  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    if (this._expectToolContinuation) {
      this._expectToolContinuation = false;
      return this._createToolContinuationStream();
    }

    const activeIds = this.activeRequestIds;

    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const done = (value: ReadableStream<UIMessageChunk> | null) => {
        if (resolved) return;
        resolved = true;
        this._resumeResolver = null;
        this._resumeNoneResolver = null;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };

      this._resumeNoneResolver = () => done(null);
      this._resumeResolver = (data: { id: string }) => {
        const requestId = data.id;
        activeIds?.add(requestId);
        const stream = this._createResumeStream(requestId);
        this.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: requestId
          })
        );
        done(stream);
      };

      try {
        this.agent.send(
          JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
        );
      } catch {
        // socket may already be closed
      }

      timeout = setTimeout(() => done(null), 5000);
    });
  }

  private _createToolContinuationStream(): ReadableStream<UIMessageChunk> {
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const streamController = new AbortController();
    const projector = new EventToChunkProjector();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;
    let requestId: string | null = null;
    let readerController!: ReadableStreamDefaultController<UIMessageChunk>;
    let onResumeRef: ((data: { id: string }) => void) | null = null;
    let onResumeNoneRef: (() => void) | null = null;

    const clearHandshakeResolvers = (
      resumeResolver?: ((data: { id: string }) => void) | null,
      resumeNoneResolver?: (() => void) | null
    ) => {
      if (resumeResolver === undefined && resumeNoneResolver === undefined) {
        this._resumeResolver = null;
        this._resumeNoneResolver = null;
        return;
      }
      if (resumeResolver && this._resumeResolver === resumeResolver) {
        this._resumeResolver = null;
      }
      if (
        resumeNoneResolver &&
        this._resumeNoneResolver === resumeNoneResolver
      ) {
        this._resumeNoneResolver = null;
      }
    };

    const finish = (
      action: () => void,
      resumeResolver?: ((data: { id: string }) => void) | null,
      resumeNoneResolver?: (() => void) | null,
      keepRequestId = false
    ) => {
      if (completed) return;
      completed = true;
      this._abortToolContinuation = null;
      clearHandshakeResolvers(resumeResolver, resumeNoneResolver);
      try {
        action();
      } catch {
        // controller may already be closed
      }
      if (requestId && !keepRequestId) activeIds?.delete(requestId);
      streamController.abort();
    };

    this._abortToolContinuation = () => {
      if (completed) return false;
      if (requestId === null) {
        finish(
          () => readerController.error(abortError),
          onResumeRef,
          onResumeNoneRef
        );
        return true;
      }
      try {
        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
            id: requestId
          })
        );
      } catch {
        // socket may already be closed
      }
      finish(
        () => readerController.error(abortError),
        onResumeRef,
        onResumeNoneRef,
        true
      );
      return true;
    };

    const transport = this;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        readerController = controller;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const onResumeNone = () => {
          if (timeout) clearTimeout(timeout);
          finish(() => controller.close(), onResume, onResumeNone);
        };

        const onResume = (data: { id: string }) => {
          if (requestId) return;
          requestId = data.id;
          activeIds?.add(requestId);
          clearHandshakeResolvers(onResume, onResumeNone);
          if (timeout) clearTimeout(timeout);
          agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
              id: requestId
            })
          );
        };

        onResumeRef = onResume;
        onResumeNoneRef = onResumeNone;
        timeout = setTimeout(
          () => finish(() => controller.close(), onResume, onResumeNone),
          5000
        );

        transport._resumeResolver = onResume;
        transport._resumeNoneResolver = onResumeNone;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingAGUIWireMessage;
            if (
              data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
              requestId === null ||
              data.id !== requestId
            ) {
              return;
            }
            if (data.error) {
              finish(
                () => controller.error(new Error(data.body || "Stream error")),
                onResume,
                onResumeNone
              );
              return;
            }
            if (data.body?.trim()) {
              const aguiEvent = parseAGUIEvent(data.body);
              if (aguiEvent) {
                for (const chunk of projector.project(aguiEvent)) {
                  controller.enqueue(chunk);
                }
              }
            }
            if (data.done) {
              finish(() => controller.close(), onResume, onResumeNone);
            }
          } catch {
            // ignore non-JSON messages
          }
        };

        const onClose = () => {
          if (timeout) clearTimeout(timeout);
          finish(() => controller.close(), onResume, onResumeNone);
        };

        agent.addEventListener("message", onMessage, {
          signal: streamController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: streamController.signal
        });

        try {
          agent.send(
            JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
          );
        } catch {
          finish(() => controller.close());
        }
      },
      cancel() {
        if (requestId && transport.cancelOnClientAbort) {
          transport.sendCancelFrame(requestId);
          finish(() => {}, onResumeRef, onResumeNoneRef, true);
        } else {
          finish(() => {}, onResumeRef, onResumeNoneRef);
        }
      }
    });
  }

  private _createResumeStream(
    requestId: string
  ): ReadableStream<UIMessageChunk> {
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const chunkController = new AbortController();
    const projector = new EventToChunkProjector();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;

    const finish = (
      action: () => void,
      keepId = false,
      clearServerTurn = true
    ) => {
      if (completed) return;
      completed = true;
      if (clearServerTurn) this.clearActiveServerTurn(requestId);
      try {
        action();
      } catch {
        // controller may already be closed
      }
      if (!keepId) activeIds?.delete(requestId);
      chunkController.abort();
    };

    const cancelActiveRequest = () => {
      if (completed) return false;
      finish(() => streamController.error(abortError), true);
      return true;
    };
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;
    const transport = this;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingAGUIWireMessage;
            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;
            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }
            if (data.body?.trim()) {
              const aguiEvent = parseAGUIEvent(data.body);
              if (aguiEvent) {
                for (const chunk of projector.project(aguiEvent)) {
                  controller.enqueue(chunk);
                }
              }
            }
            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // ignore non-JSON messages
          }
        };

        const onClose = () => {
          finish(() => controller.close(), false, false);
        };

        agent.addEventListener("message", onMessage, {
          signal: chunkController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: chunkController.signal
        });
      },
      cancel() {
        if (transport.cancelOnClientAbort) {
          transport.sendCancelFrame(requestId);
          finish(() => {}, true);
        } else {
          finish(() => {}, false, false);
        }
      }
    });
  }
}

/**
 * Parse an `OutgoingAGUIWireMessage.body` into an `AGUIEvent`. The body is
 * raw JSON (NOT prefixed with `data: ` — that prefix only appears inside
 * AG-UI SSE bodies on the server). Returns `null` for malformed JSON.
 */
function parseAGUIEvent(body: string): AGUIEvent | null {
  try {
    return JSON.parse(body) as AGUIEvent;
  } catch {
    return null;
  }
}
