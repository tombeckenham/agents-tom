/**
 * WebSocket-based `ChatTransport` for `useChat` that consumes AG-UI events.
 *
 * Framing, cancellation and the resume handshake all come from the shared
 * {@link AGUIWebSocketTransport} in `agents/chat`; this file is the AI SDK
 * projection layer on top of it — every AG-UI event the shared transport
 * yields is piped through {@link EventToChunkProjector} into the
 * `UIMessageChunk` `ReadableStream`s `useChat` expects.
 */

import {
  AGUIWebSocketTransport,
  type AgentConnection,
  type AGUIEventStream
} from "agents/chat/agui-ws-transport";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { EventToChunkProjector } from "./event-to-chunk";

export type { AgentConnection } from "agents/chat/agui-ws-transport";

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

/** Pipe one AG-UI event stream through the projector into UI chunks. */
function toChunkStream(
  events: AGUIEventStream
): ReadableStream<UIMessageChunk> {
  const projector = new EventToChunkProjector();
  const iterator = events[Symbol.asyncIterator]();

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        // A turn that failed while this read was in flight must reject
        // rather than deliver — `controller.error` also drops whatever is
        // still queued, matching the AI SDK's cancellation semantics.
        if (events.error) {
          controller.error(events.error);
          return;
        }
        if (done) {
          controller.close();
          return;
        }
        for (const chunk of projector.project(value)) {
          controller.enqueue(chunk);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void iterator.return?.().catch(() => {});
    }
  });
}

export class WebSocketChatTransport<ChatMessage extends UIMessage = UIMessage>
  extends AGUIWebSocketTransport
  implements ChatTransport<ChatMessage>
{
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    super(options);
    this.prepareBody = options.prepareBody;
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
    const { events, sent } = this.openRequestStream({
      abortSignal: options.abortSignal,
      buildBody: async () => {
        const extra = this.prepareBody
          ? await this.prepareBody({
              messages: options.messages,
              trigger: options.trigger,
              messageId: options.messageId
            })
          : {};
        return JSON.stringify({
          messages: options.messages,
          trigger: options.trigger,
          ...extra,
          ...(options.body as Record<string, unknown> | undefined)
        });
      }
    });
    // Surfaces a `prepareBody` failure as a rejected `sendMessages`, and
    // puts the request frame on the wire before the stream is handed back.
    await sent;
    return toChunkStream(events);
  }

  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    const events = await this.reconnectToEventStream();
    return events ? toChunkStream(events) : null;
  }
}
