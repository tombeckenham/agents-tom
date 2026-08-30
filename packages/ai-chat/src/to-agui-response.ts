/**
 * `toAGUIResponse` — wrap a Vercel AI SDK `UIMessageChunk` SSE response so its
 * body becomes AG-UI SSE, for an `AGUIChatAgent.onChatMessage` override that
 * builds its stream with `streamText()`.
 *
 * `AIChatAgent` (./agent.ts) uses the same `chunk-to-event` projector
 * internally; this helper is the standalone entry point for consumers who
 * extend `AGUIChatAgent` from the `agents` package directly.
 */

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
    // A pull MUST NOT resolve without enqueueing (or closing): workerd does
    // not reliably re-invoke pull after an empty one when the pending read
    // belongs to another request context, which strands the consumer. Loop
    // until at least one chunk lands.
    async pull(controller) {
      try {
        let enqueued = false;
        while (!enqueued) {
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
              if (chunk) {
                controller.enqueue(chunk);
                enqueued = true;
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
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
