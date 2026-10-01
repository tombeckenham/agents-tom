import { routeAgentRequest } from "agents";
import {
  AGUIChatAgent,
  type OnChatMessageOptions
} from "agents/agui-chat-agent";
import { toAGUIResponse, toModelMessages } from "@cloudflare/ai-chat-tanstack";
import { createWorkersAiChat } from "@cloudflare/tanstack-ai";
import { chat } from "@tanstack/ai";
import type { AGUIEvent } from "agents/chat/agui-types";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

/**
 * The `examples/ai-chat` agent, driven by TanStack AI.
 *
 * This is the case the RFC is really about. TanStack's `chat()` already
 * emits AG-UI, so there is no chunk-to-event projection on this path at
 * all — `toAGUIResponse()` just frames the stream as SSE. On the AI SDK
 * path, `toAGUIResponse()` has to translate a `UIMessage` stream into AG-UI
 * events first.
 */
export class ChatAgent extends AGUIChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const adapter = createWorkersAiChat(MODEL, { binding: this.env.AI });

    const controller = new AbortController();
    options?.abortSignal?.addEventListener("abort", () => controller.abort(), {
      once: true
    });

    const { messages, systemPrompts } = toModelMessages(this.messages);

    const stream = chat({
      adapter,
      stream: true,
      messages,
      systemPrompts: [
        "You are a helpful assistant running on Cloudflare Workers.",
        ...systemPrompts
      ],
      abortController: controller
    });

    // TanStack's `StreamChunk` vocabulary is AG-UI; the agents-side union is
    // a superset (it also models ActivityDelta / RawEvent). The JSON wire
    // payloads are identical, so the widening is safe at this boundary.
    return toAGUIResponse(stream as unknown as AsyncIterable<AGUIEvent>, {
      abortController: controller
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
