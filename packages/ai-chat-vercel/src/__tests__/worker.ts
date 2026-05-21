/**
 * Test worker for `@cloudflare/ai-chat-vercel` integration tests.
 *
 * Exposes two `AGUIChatAgent` subclasses that emit known AG-UI SSE streams.
 * The `WebSocketChatTransport` is connected via a programmatic WS pair
 * so tests can drive the transport from the same Worker process.
 */

import { Agent, routeAgentRequest } from "agents";
import { AGUIChatAgent } from "agents/agui-chat-agent";
import type { AGUIEvent } from "agents/chat/agui-types";

function encodeSSE(events: AGUIEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

function encodeSSESlow(
  events: AGUIEvent[],
  delayMs: number,
  signal?: AbortSignal
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export class TestAguiAgent extends AGUIChatAgent {
  // Returns a predictable AG-UI SSE stream so the transport-side
  // projection can be verified end-to-end.
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello " },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "world" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    return encodeSSE(events);
  }
}

export class ToolApprovalAguiAgent extends AGUIChatAgent {
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: { abortSignal?: AbortSignal }
  ) {
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "tick" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    return encodeSSESlow(events, 50, options?.abortSignal);
  }
}

type Env = {
  TestAguiAgent: DurableObjectNamespace<TestAguiAgent>;
  ToolApprovalAguiAgent: DurableObjectNamespace<ToolApprovalAguiAgent>;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

// re-export the Agent type for vitest's wrangler resolution
export { Agent };
