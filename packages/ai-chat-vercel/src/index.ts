/**
 * `@cloudflare/ai-chat-vercel` — server entry.
 *
 * Provides {@link toAGUIResponse}: wrap a Vercel
 * `streamText().toUIMessageStreamResponse()` so the body becomes AG-UI SSE
 * that an {@link AGUIChatAgent.onChatMessage} override can return directly.
 *
 * The legacy `AIChatAgent`-shape compatibility class is deferred to a
 * future minor; the helper alone covers the `streamText` integration case
 * documented in `design/rfc-ag-ui-canonical.md` §§ Migration.
 */

export {
  ChunkToEventProjector,
  projectChunkStreamToAGUISSE,
  type ChunkToEventProjectorOptions
} from "./chunk-to-event";

export {
  EventToChunkProjector,
  type ProjectorAssistantMessage,
  type ProjectorReasoningMessage,
  type ProjectorToolMessage,
  type ProjectorUserMessage
} from "./event-to-chunk";

export {
  MessageType,
  type IncomingAGUIWireMessage,
  type MessageTypeValue,
  type OutgoingAGUIWireMessage
} from "./types";

import {
  projectChunkStreamToAGUISSE,
  type ChunkToEventProjectorOptions
} from "./chunk-to-event";

/**
 * Wrap a Vercel `streamText().toUIMessageStreamResponse()` (or any
 * `Response` whose body is a UI message stream SSE) so the body is AG-UI
 * SSE. The returned `Response` keeps the original headers/status except
 * the `Content-Type` is normalized to `text/event-stream; charset=utf-8`.
 *
 * Usage from an `AGUIChatAgent.onChatMessage`:
 *
 * ```ts
 * async onChatMessage(onFinish, options) {
 *   const result = streamText({ model, messages: this.messages, ... });
 *   return toAGUIResponse(result.toUIMessageStreamResponse());
 * }
 * ```
 */
export function toAGUIResponse(
  response: Response,
  options?: ChunkToEventProjectorOptions
): Response {
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      headers: aguiHeaders(response.headers)
    });
  }

  const chunkStream = parseUIMessageSSE(response.body);
  const aguiStream = projectChunkStreamToAGUISSE(chunkStream, options);

  return new Response(aguiStream, {
    status: response.status,
    headers: aguiHeaders(response.headers)
  });
}

function aguiHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  return headers;
}

/**
 * Parse a Vercel `toUIMessageStreamResponse()` body (SSE with `data: ...`
 * lines each carrying one `UIMessageChunk` JSON) back into a stream of
 * `UIMessageChunk` objects so the chunk-to-event projector can consume it.
 */
function parseUIMessageSSE(
  body: ReadableStream<Uint8Array>
): ReadableStream<import("ai").UIMessageChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  return new ReadableStream<import("ai").UIMessageChunk>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any trailing data: line that wasn't terminated by \n\n.
          const tail = buffer.trim();
          if (tail.startsWith("data: ")) {
            const chunk = parseChunk(tail.slice("data: ".length));
            if (chunk) controller.enqueue(chunk);
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const chunk = parseChunk(line.slice("data: ".length));
            if (chunk) controller.enqueue(chunk);
          }
          boundary = buffer.indexOf("\n\n");
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    }
  });
}

function parseChunk(payload: string): import("ai").UIMessageChunk | null {
  const trimmed = payload.trim();
  if (trimmed === "" || trimmed === "[DONE]") return null;
  try {
    return JSON.parse(trimmed) as import("ai").UIMessageChunk;
  } catch {
    return null;
  }
}
