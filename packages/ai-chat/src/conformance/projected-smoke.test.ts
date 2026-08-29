/**
 * Phase-3 smoke test: one turn end-to-end through the PROJECTED
 * `AIChatAgent` (`../agent.ts`) over WebSocket.
 *
 * Not a golden test — full differential coverage is Phase 5's loop. This
 * asserts the projection mechanics work at all: AG-UI events on the wire,
 * AG-UI rows persisted (`_v` marker), the legacy `UIMessage[]` view via
 * `this.messages`, and legacy-shaped `onChatResponse` hook results.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import { connectClient, isDone, sendChatRequest, userMessage } from "./harness";

async function projected() {
  const room = crypto.randomUUID();
  const path = `/agents/projected-agent/${room}`;
  const stub = await getAgentByName(env.ProjectedAgent, room);
  return { path, stub } as const;
}

function eventTypes(frames: Array<{ type: string; body?: unknown }>): string[] {
  return frames
    .filter(
      (f) =>
        f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        typeof f.body === "object" &&
        f.body !== null
    )
    .map((f) => (f.body as { type?: string }).type ?? "");
}

describe("projected AIChatAgent (Phase 3 smoke)", () => {
  it("plain text turn: AI SDK chunks in, AG-UI wire + rows, legacy view out", async () => {
    const { path, stub } = await projected();
    const client = await connectClient(path);

    sendChatRequest(client, "req-1", [userMessage("u-1", "hello")]);
    await client.waitFor(isDone("req-1"));
    expect(await stub.stable()).toBe(true);

    // Wire: the projected UIMessageChunk stream arrived as AG-UI events.
    const events = eventTypes(client.frames);
    expect(events).toContain("RUN_STARTED");
    expect(events).toContain("TEXT_MESSAGE_CONTENT");
    expect(events).toContain("RUN_FINISHED");
    expect(events).not.toContain("text-delta");

    // Persistence: AG-UI rows with the schema marker.
    const rows = (await stub.rows()) as Array<{
      id: string;
      message: Record<string, unknown>;
    }>;
    expect(rows.map((r) => r.message.role)).toEqual(["user", "assistant"]);
    for (const row of rows) {
      expect(row.message._v).toBe("v6_agui_message");
    }
    expect(rows[1].message.content).toBe("Hello world");

    // Legacy view: `this.messages` projects UIMessage[].
    const ui = (await stub.uiMessages()) as Array<Record<string, unknown>>;
    expect(ui).toEqual([
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      expect.objectContaining({
        role: "assistant",
        parts: [{ type: "text", text: "Hello world" }]
      })
    ]);

    // Hook: legacy-shaped onChatResponse fired once.
    expect(await stub.hooks()).toEqual([
      expect.objectContaining({
        hook: "onChatResponse",
        requestId: "req-1",
        status: "completed",
        continuation: false,
        partTypes: ["text"]
      })
    ]);

    client.close();
  });

  it("single tool-call turn projects tool state into the legacy view", async () => {
    const { path, stub } = await projected();
    const client = await connectClient(path);

    sendChatRequest(client, "req-1", [userMessage("u-1", "weather?")], {
      scenario: "tool-single"
    });
    await client.waitFor(isDone("req-1"));
    expect(await stub.stable()).toBe(true);

    const events = eventTypes(client.frames);
    expect(events).toContain("TOOL_CALL_START");
    expect(events).toContain("TOOL_CALL_END");
    expect(events).toContain("TOOL_CALL_RESULT");

    // Legacy view: a tool part with its output folded in, plus the text.
    const ui = (await stub.uiMessages()) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const parts = ui
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-getWeather",
        toolCallId: "call-weather-1",
        state: "output-available",
        input: { city: "Sydney" },
        output: { temp: 21 }
      })
    );
    expect(parts).toContainEqual({ type: "text", text: "It is 21C" });

    client.close();
  });
});
