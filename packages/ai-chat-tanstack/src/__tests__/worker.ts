/**
 * Test worker for `@cloudflare/ai-chat-tanstack` integration tests.
 *
 * Exposes two `AGUIChatAgent` subclasses that emit known AG-UI event
 * sequences via `toAGUIResponse`, simulating TanStack AI's `chat()`
 * which already produces `AGUIEvent` async iterables.
 */

import { Agent, routeAgentRequest } from "agents";
import { AGUIChatAgent } from "agents/agui-chat-agent";
import type { AGUIEvent } from "agents/chat/agui-types";
import { toAGUIResponse } from "../index";

async function* yieldEvents(events: AGUIEvent[]): AsyncIterable<AGUIEvent> {
  for (const e of events) yield e;
}

async function* yieldEventsSlow(
  events: AGUIEvent[],
  delayMs: number,
  signal?: AbortSignal
): AsyncIterable<AGUIEvent> {
  for (const e of events) {
    if (signal?.aborted) return;
    yield e;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export class TestTanstackAgent extends AGUIChatAgent {
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
    return toAGUIResponse(yieldEvents(events));
  }
}

export class CancellableTanstackAgent extends AGUIChatAgent {
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
    return toAGUIResponse(yieldEventsSlow(events, 50, options?.abortSignal));
  }
}

type Env = {
  TestTanstackAgent: DurableObjectNamespace<TestTanstackAgent>;
  CancellableTanstackAgent: DurableObjectNamespace<CancellableTanstackAgent>;
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
