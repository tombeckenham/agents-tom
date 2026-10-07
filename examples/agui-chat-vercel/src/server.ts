import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import {
  AGUIChatAgent,
  type OnChatMessageOptions
} from "agents/agui-chat-agent";
import { toAGUIResponse, toUIMessages } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, tool, isStepCount } from "ai";
import { z } from "zod";

/**
 * The `examples/ai-chat` agent, moved onto the AG-UI path.
 *
 * Three differences from the legacy version, and nothing else:
 *
 *   1. Extend `AGUIChatAgent` instead of `AIChatAgent`.
 *   2. `this.messages` is canonical AG-UI, so it goes through
 *      `toUIMessages()` before `convertToModelMessages()`.
 *   3. Wrap the result in `toAGUIResponse()` so the body is AG-UI SSE
 *      instead of a Vercel UI message stream.
 *
 * Everything else — tool definitions, client-side tools, streaming,
 * persistence — is unchanged.
 */
export class ChatAgent extends AGUIChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.7-code", {
        sessionAffinity: this.sessionAffinity
      }),
      instructions:
        "You are a helpful assistant running on Cloudflare Workers. " +
        "You can check the weather and get the user's timezone.",
      messages: await convertToModelMessages(toUIMessages(this.messages)),
      tools: {
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),
        // Client-side tool: no execute, resolved by onToolCall in the client.
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        })
      },
      stopWhen: isStepCount(5)
    });

    return toAGUIResponse(result.toUIMessageStreamResponse());
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
