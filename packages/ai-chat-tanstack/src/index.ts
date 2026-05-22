/**
 * `@cloudflare/ai-chat-tanstack` — server entry.
 *
 * TanStack AI's `chat()` already emits `AGUIEvent`s, so the server-side
 * "projection" is identity. {@link toAGUIResponse} wraps an
 * `AsyncIterable<AGUIEvent>` (the shape `chat()` returns) into a
 * `Response` whose body is AG-UI SSE so an
 * {@link import("agents/agui-chat-agent").AGUIChatAgent} `onChatMessage`
 * override can return it directly.
 *
 * Mirrors the shape of `toAGUIResponse()` in `@cloudflare/ai-chat-vercel`,
 * minus the `UIMessageChunk → AGUIEvent` projection layer.
 */

export {
  MessageType,
  type IncomingAGUIWireMessage,
  type MessageTypeValue,
  type OutgoingAGUIWireMessage
} from "./types";

import type { AGUIEvent } from "agents/chat/agui-types";

/**
 * Options accepted by {@link toAGUIResponse}.
 */
export interface ToAGUIResponseOptions {
  /**
   * Forwarded onto the `Response` constructor. The `Content-Type` and
   * standard SSE cache-control headers are always overridden so the body
   * is interpreted as `text/event-stream`.
   */
  init?: ResponseInit;
  /**
   * Optional `AbortController` that is `abort()`ed when the response
   * stream is cancelled by its consumer. Mirrors
   * `toServerSentEventsResponse` in `@tanstack/ai`.
   */
  abortController?: AbortController;
}

/**
 * Wrap an `AsyncIterable<AGUIEvent>` (the return of TanStack AI's `chat()`)
 * into a `Response` whose body is AG-UI Server-Sent Events.
 *
 * Each event is emitted as one `data: {…JSON}\n\n` frame, in iteration
 * order. The stream closes cleanly when the iterable is exhausted, and
 * errors mid-iterable propagate via `controller.error` (no half-written
 * frames are emitted).
 *
 * Usage from an `AGUIChatAgent.onChatMessage`:
 *
 * ```ts
 * import { chat } from "@tanstack/ai";
 * import { toAGUIResponse } from "@cloudflare/ai-chat-tanstack";
 *
 * async onChatMessage() {
 *   const stream = chat({ adapter, model, messages: this.messages });
 *   return toAGUIResponse(stream);
 * }
 * ```
 */
export function toAGUIResponse(
  events: AsyncIterable<AGUIEvent>,
  options?: ToAGUIResponseOptions
): Response {
  const body = toAGUISSEStream(events, options?.abortController);
  const init = options?.init ?? {};
  return new Response(body, {
    ...init,
    headers: aguiHeaders(init.headers)
  });
}

/**
 * Encode an `AsyncIterable<AGUIEvent>` as an AG-UI SSE byte stream. Each
 * event becomes one `data: ${JSON.stringify(event)}\n\n` frame.
 *
 * Exposed for callers that need to compose the stream into a larger
 * response (e.g. multiplexing) without going through {@link toAGUIResponse}.
 */
export function toAGUISSEStream(
  events: AsyncIterable<AGUIEvent>,
  abortController?: AbortController
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<AGUIEvent> | undefined;

  return new ReadableStream<Uint8Array>({
    async start() {
      iterator = events[Symbol.asyncIterator]();
    },
    async pull(controller) {
      if (!iterator) {
        controller.close();
        return;
      }
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(result.value)}\n\n`)
        );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      abortController?.abort(reason);
      if (iterator?.return) {
        try {
          await iterator.return(undefined);
        } catch {
          // iterator.return may throw if the underlying generator already
          // finished — that's fine, the consumer already cancelled.
        }
      }
    }
  });
}

function aguiHeaders(source: HeadersInit | undefined): Headers {
  const headers = new Headers(source);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  return headers;
}
