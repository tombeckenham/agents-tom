/**
 * WebSocket-backed AG-UI event stream source for TanStack AI's
 * `@tanstack/ai-client` `stream()` connection adapter.
 *
 * Identity adapter on the chunk body: TanStack `useChat` already consumes
 * `AGUIEvent`s and `CF_AGENT_USE_CHAT_RESPONSE.body` is the raw JSON of one
 * `AGUIEvent` per frame, so the shared {@link AGUIWebSocketTransport} is
 * used as-is. All this file adds is the `prepareBody` hook and the
 * TanStack-shaped `streamFactory`.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import {
  AGUIWebSocketTransport,
  type AgentConnection
} from "agents/chat/agui-ws-transport";

export { AGUIWebSocketTransport } from "agents/chat/agui-ws-transport";
export type { AgentConnection } from "agents/chat/agui-ws-transport";

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
 * plus the shared lifecycle helpers (cancel / resume / tool continuation)
 * the React hook wires up to `useChat`.
 */
export class WebSocketChatTransport extends AGUIWebSocketTransport {
  private prepareBody?: WebSocketChatTransportOptions["prepareBody"];

  constructor(options: WebSocketChatTransportOptions) {
    super(options);
    this.prepareBody = options.prepareBody;
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
  ): AsyncIterable<AGUIEvent> =>
    this.openRequestStream({
      abortSignal,
      buildBody: async () => {
        const extra = this.prepareBody
          ? await this.prepareBody({ messages, forwardedProps: data })
          : {};
        return JSON.stringify({ messages, ...(data ?? {}), ...extra });
      }
    }).events;

  /**
   * Open a resume / reconnect stream (or the pending tool continuation,
   * after `expectToolContinuation()`). Resolves to `null` if the server
   * has no active stream (`CF_AGENT_STREAM_RESUME_NONE`).
   */
  reconnectToStream(): Promise<AsyncIterable<AGUIEvent> | null> {
    return this.reconnectToEventStream();
  }
}
