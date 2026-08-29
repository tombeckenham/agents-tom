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
import {
  type WireFrame,
  connectClient,
  isDone,
  sendChatRequest,
  sendToolApproval,
  userMessage
} from "./harness";

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

  it("folds a reasoning turn into one assistant message (legacy shape)", async () => {
    const { path, stub } = await projected();
    const client = await connectClient(path);

    sendChatRequest(client, "req-1", [userMessage("u-1", "think")], {
      scenario: "reasoning"
    });
    await client.waitFor(isDone("req-1"));
    expect(await stub.stable()).toBe(true);

    const ui = (await stub.uiMessages()) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    // ONE assistant message with [reasoning, text] parts — not two.
    expect(ui).toHaveLength(2);
    expect(ui[1].role).toBe("assistant");
    expect(ui[1].parts).toEqual([
      { type: "reasoning", text: "thinking about it" },
      { type: "text", text: "reasoned answer" }
    ]);

    // The hook's folded message carries the reasoning part too.
    expect(await stub.hooks()).toEqual([
      expect.objectContaining({
        hook: "onChatResponse",
        partTypes: ["reasoning", "text"]
      })
    ]);

    client.close();
  });

  it("projects a tool error as output-error", async () => {
    const { path, stub } = await projected();
    const client = await connectClient(path);

    sendChatRequest(client, "req-1", [userMessage("u-1", "boom")], {
      scenario: "tool-error"
    });
    await client.waitFor(isDone("req-1"));
    expect(await stub.stable()).toBe(true);

    const rows = (await stub.rows()) as Array<{
      message: Record<string, unknown>;
    }>;
    const toolRow = rows.find((r) => r.message.role === "tool");
    expect(toolRow?.message.error).toBe("exploded");

    const ui = (await stub.uiMessages()) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const parts = ui
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-boom",
        toolCallId: "call-boom-1",
        state: "output-error",
        input: { fuse: "short" },
        errorText: "exploded"
      })
    );

    client.close();
  });

  async function runApprovalFlow(approved: boolean, finalText: string) {
    const { path, stub } = await projected();
    const client = await connectClient(path);

    sendChatRequest(client, "req-1", [userMessage("u-1", "do it")], {
      scenario: "approval"
    });
    // Approval request rides the event stream; wait for it, then decide.
    await client.waitFor(
      (f: WireFrame) =>
        typeof f.body === "object" &&
        f.body !== null &&
        (f.body as { name?: string }).name === "cf.agents.tool_approval.request"
    );
    await client.waitFor(isDone("req-1"));
    sendToolApproval(client, "call-approval-1", approved);
    // The continuation is a server-initiated stream: ack the resume offer so
    // its chunks replay, then wait for the outcome text.
    const resuming = await client.waitFor(
      (f: WireFrame) => f.type === MessageType.CF_AGENT_STREAM_RESUMING
    );
    client.ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: resuming.id
      })
    );
    await client.waitFor(
      (f: WireFrame) =>
        typeof f.body === "object" &&
        f.body !== null &&
        (f.body as { delta?: string }).delta === finalText
    );
    expect(await stub.stable()).toBe(true);
    return { client, stub };
  }

  it("approval approve: durable decision, tool runs on continuation", async () => {
    const { client, stub } = await runApprovalFlow(true, "approved and ran");

    const rows = (await stub.rows()) as Array<{
      message: Record<string, unknown>;
    }>;
    const assistantRow = rows.find(
      (r) =>
        r.message.role === "assistant" &&
        (r.message as { toolApprovals?: unknown }).toolApprovals !== undefined
    );
    expect(assistantRow?.message.toolApprovals).toEqual({
      "call-approval-1": expect.objectContaining({ approved: true })
    });

    const ui = (await stub.uiMessages()) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const parts = ui
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-riskyTool",
        toolCallId: "call-approval-1",
        state: "output-available",
        output: { ran: true },
        approval: expect.objectContaining({ approved: true })
      })
    );
    expect(parts).toContainEqual({ type: "text", text: "approved and ran" });

    client.close();
  });

  it("approval deny: projects output-denied and takes the deny branch", async () => {
    const { client, stub } = await runApprovalFlow(
      false,
      "denied — riskyTool not run"
    );

    const ui = (await stub.uiMessages()) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const parts = ui
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-riskyTool",
        toolCallId: "call-approval-1",
        state: "output-denied",
        approval: expect.objectContaining({ approved: false })
      })
    );
    expect(parts).toContainEqual({
      type: "text",
      text: "denied — riskyTool not run"
    });
    // No tool result row for a denied call.
    const rows = (await stub.rows()) as Array<{
      message: Record<string, unknown>;
    }>;
    expect(rows.some((r) => r.message.role === "tool")).toBe(false);

    client.close();
  });

  it("persists and projects metadata, data parts, files, and sources", async () => {
    const { path, stub } = await projected();
    const client = await connectClient(path);

    sendChatRequest(client, "req-1", [userMessage("u-1", "extras")], {
      scenario: "metadata"
    });
    await client.waitFor(isDone("req-1"));
    expect(await stub.stable()).toBe(true);

    const rows = (await stub.rows()) as Array<{
      message: Record<string, unknown>;
    }>;
    const assistantRow = rows.find((r) => r.message.role === "assistant")
      ?.message as {
      metadata?: unknown;
      extraParts?: Array<{ type: string }>;
    };
    expect(assistantRow.metadata).toEqual({ model: "fixture-model" });
    expect(assistantRow.extraParts?.map((p) => p.type)).toEqual([
      "data-weather",
      "file",
      "source-url"
    ]);

    const ui = (await stub.uiMessages()) as Array<{
      role: string;
      metadata?: unknown;
      parts: Array<Record<string, unknown>>;
    }>;
    const assistant = ui.find((m) => m.role === "assistant");
    expect(assistant?.metadata).toEqual({ model: "fixture-model" });
    expect(assistant?.parts.map((p) => p.type)).toEqual([
      "data-weather",
      "file",
      "source-url",
      "text"
    ]);
    expect(assistant?.parts.at(-1)).toEqual({
      type: "text",
      text: "with extras"
    });

    client.close();
  });

  it("agent-tool child turn does not strip projection-invisible fields (encryptedValue)", async () => {
    // The child lifecycle persists via the AG-UI-native `_saveAGUIMessages`;
    // if it went through the projected `saveMessages` instead, the history
    // would round-trip AG-UI→UIMessage→AG-UI and `toUIMessages` would drop
    // `encryptedValue` from the pre-existing reasoning row, which the rebuilt
    // rows then overwrite in place.
    const runId = crypto.randomUUID();
    const parent = await getAgentByName(
      env.ProjectedToolParent,
      crypto.randomUUID()
    );

    await parent.seedChildEncryptedRowForTest(runId);
    const result = await parent.runChild({ prompt: "do the thing" }, runId);
    expect(result).toMatchObject({
      runId,
      status: "completed",
      output: "child says hi"
    });

    const rows = (await parent.childRawRows(runId)) as Array<
      Record<string, unknown>
    >;
    const reasoning = rows.find((row) => row.id === "seed-reasoning");
    expect(reasoning).toMatchObject({
      role: "reasoning",
      content: "seeded chain of thought",
      encryptedValue: "SECRET-ENCRYPTED-BLOB"
    });
  });
});
