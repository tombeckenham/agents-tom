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
import { ContinuationReplayFilter } from "agents/chat";
import type { AGUIEvent } from "agents/chat/agui-types";
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
  /**
   * Called when a `submit-message` request frame was buffered rather than sent
   * immediately (the socket was not OPEN, so PartySocket queued it for the next
   * reconnect). The hook uses this to preserve the optimistic message across the
   * reconnect transcript replay. `messageId` is the submitted user message's id.
   */
  onRequestBuffered?: (messageId: string | undefined) => void;
};

/** Pipe one AG-UI event stream through the projector into UI chunks. */
function toChunkStream(
  events: AGUIEventStream,
  transport: AGUIWebSocketTransport
): ReadableStream<UIMessageChunk> {
  const projector = new EventToChunkProjector();
  const iterator = events[Symbol.asyncIterator]();
  let replayFilter: ContinuationReplayFilter<{ body: string }> | null = null;

  /**
   * The chunks to deliver for one event. The projector sees every event so
   * its run state stays whole; a continuation's replayed chunks this client
   * already applied are dropped from its output instead, and a part they
   * left open is re-opened for the chunks that follow (#1951).
   */
  const chunksOf = (event: AGUIEvent): UIMessageChunk[] => {
    const chunks = projector.project(event);
    const frame = transport.frameOf(event);
    if (!frame?.continuation) return chunks;
    replayFilter ??= new ContinuationReplayFilter(
      transport.appliedChunks,
      frame.id
    );
    const kept: UIMessageChunk[] = [];
    for (const chunk of chunks) {
      const filtered = replayFilter.filter(
        { body: JSON.stringify(chunk) },
        frame.applied
      );
      for (const { body } of filtered) {
        if (body) kept.push(JSON.parse(body) as UIMessageChunk);
      }
    }
    return kept;
  };

  return new ReadableStream<UIMessageChunk>(
    {
      async pull(controller) {
        try {
          // An event can deliver no chunks (`RUN_STARTED`, a buffered
          // `STEP_STARTED`, an applied replay). A pull that enqueues nothing is
          // not called again for the read that is waiting on it, so keep
          // reading until one does.
          for (;;) {
            const { done, value } = await iterator.next();
            // A turn that failed while this read was in flight must reject
            // rather than deliver — `controller.error` also drops whatever is
            // still queued, matching the AI SDK's cancellation semantics.
            if (events.error) {
              controller.error(events.error);
              return;
            }
            if (done) {
              // A socket that closed before the terminal `done` frame ends
              // the turn with an error chunk, behind the chunks not read
              // yet, so the AI SDK reports an interrupted turn instead of a
              // completed one (#2013).
              if (events.interrupted) {
                controller.enqueue({
                  type: "error",
                  errorText: "WebSocket closed mid-stream"
                });
              }
              controller.close();
              return;
            }
            const chunks = chunksOf(value);
            for (const chunk of chunks) controller.enqueue(chunk);
            if (chunks.length > 0) return;
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        void iterator.return?.().catch(() => {});
      }
    },
    // Read ahead of nothing: an event left in the transport's queue is still
    // dropped when the turn is cancelled, one already enqueued here is not.
    { highWaterMark: 0 }
  );
}

export class WebSocketChatTransport<ChatMessage extends UIMessage = UIMessage>
  extends AGUIWebSocketTransport
  implements ChatTransport<ChatMessage>
{
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];

  private onRequestBuffered?: WebSocketChatTransportOptions<ChatMessage>["onRequestBuffered"];

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    super(options);
    this.prepareBody = options.prepareBody;
    this.onRequestBuffered = options.onRequestBuffered;
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
      // A buffered submit means the server has not seen the message yet, so
      // tell the hook to keep it across the reconnect transcript (#1983).
      onBuffered: () => {
        if (options.trigger !== "submit-message") return;
        this.onRequestBuffered?.(
          [...options.messages]
            .reverse()
            .find((message) => message.role === "user")?.id
        );
      },
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
    return toChunkStream(events, this);
  }

  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    const events = await this.reconnectToEventStream();
    return events ? toChunkStream(events, this) : null;
  }
}
