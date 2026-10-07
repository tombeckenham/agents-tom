/**
 * Tool-call turns on the AG-UI shape.
 *
 * A streamed TOOL_CALL_START/ARGS/END trio must land as `toolCalls` on the
 * persisted assistant message, and TOOL_CALL_RESULT must persist as a
 * standalone ToolMessage. A client-supplied CF_AGENT_TOOL_RESULT must
 * append a ToolMessage after the owning assistant and broadcast
 * CF_AGENT_MESSAGE_UPDATED.
 */

import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import type { AssistantMessage, ToolMessage } from "../chat/agui-types";
import {
  connectChatWS,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage,
  waitForPersisted
} from "./test-utils";

describe("AGUIChatAgent — tool calls", () => {
  it("persists streamed tool calls on the assistant and the result as a ToolMessage", async () => {
    const path = `/agents/tool-call-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "weather?")]);
    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);

    const persisted = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "tool")
    );
    const assistant = persisted.find(
      (m): m is AssistantMessage => m.role === "assistant"
    );
    expect(assistant?.toolCalls).toHaveLength(1);
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: "tc-1",
      type: "function",
      function: { name: "getWeather", arguments: '{"city":"Sydney"}' }
    });

    const tool = persisted.find((m): m is ToolMessage => m.role === "tool");
    expect(tool).toBeDefined();
    expect(tool?.toolCallId).toBe("tc-1");
    expect(JSON.parse(tool?.content ?? "{}")).toEqual({ temp: 21 });
  });

  it("applies a client tool result as a ToolMessage and broadcasts MESSAGE_UPDATED", async () => {
    const path = `/agents/tool-call-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "weather?")]);
    await rec.waitFor(isDoneFrame("req1"));

    // The streamed turn already produced a result for tc-1; supply a result
    // for an unseen call id to exercise the append path.
    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "tc-client",
        toolName: "clientTool",
        output: { ok: true }
      })
    );

    const updated = await rec.waitFor(
      (f) => f.type === CHAT_MESSAGE_TYPES.MESSAGE_UPDATED
    );
    expect((updated.message as ToolMessage).toolCallId).toBe("tc-client");
    ws.close(1000);

    const persisted = await waitForPersisted(path, (ms) =>
      ms.some(
        (m) =>
          m.role === "tool" && (m as ToolMessage).toolCallId === "tc-client"
      )
    );
    const clientTool = persisted.find(
      (m): m is ToolMessage => m.role === "tool" && m.toolCallId === "tc-client"
    );
    expect(clientTool).toBeDefined();
    expect(JSON.parse(clientTool?.content ?? "{}")).toEqual({ ok: true });
  });

  it("treats a duplicate tool result as a no-op (first write wins)", async () => {
    const path = `/agents/tool-call-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "weather?")]);
    await rec.waitFor(isDoneFrame("req1"));

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "tc-dup",
        toolName: "clientTool",
        output: { first: true }
      })
    );
    await rec.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.MESSAGE_UPDATED);
    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "tc-dup",
        toolName: "clientTool",
        output: { second: true }
      })
    );
    // Allow the duplicate to be processed before reading persistence.
    await new Promise((resolve) => setTimeout(resolve, 250));
    ws.close(1000);

    const persisted = await waitForPersisted(path, (ms) =>
      ms.some(
        (m) => m.role === "tool" && (m as ToolMessage).toolCallId === "tc-dup"
      )
    );
    const dupes = persisted.filter(
      (m): m is ToolMessage => m.role === "tool" && m.toolCallId === "tc-dup"
    );
    expect(dupes).toHaveLength(1);
    expect(JSON.parse(dupes[0].content)).toEqual({ first: true });
  });

  it("persists a tool result answered mid-stream after its still-streaming assistant", async () => {
    // The turn streams call_a, then call_b 100ms later. Answering call_a while
    // the assistant is still streaming used to write a standalone row ahead of
    // that assistant, which the reconciler then folded INTO — producing one row
    // carrying the tool message's id with `role: "assistant"` and no result.
    const path = `/agents/auto-continue-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "do both")], {
      streamToolCallIds: ["call_a", "call_b"],
      streamDelayMs: 100
    });
    await rec.waitFor(
      (f) =>
        typeof f.body === "string" &&
        f.body.includes('"TOOL_CALL_END"') &&
        f.body.includes("call_a")
    );
    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "call_a",
        toolName: "testTool",
        output: { ok: true }
      })
    );
    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);

    const persisted = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "tool")
    );

    const assistants = persisted.filter(
      (m): m is AssistantMessage => m.role === "assistant"
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).not.toMatch(/^tool-/);
    expect(assistants[0].toolCalls?.map((tc) => tc.id)).toEqual([
      "call_a",
      "call_b"
    ]);

    const tools = persisted.filter((m): m is ToolMessage => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCallId).toBe("call_a");
    expect(JSON.parse(tools[0].content)).toEqual({ ok: true });

    // The result must follow the assistant that issued the call — a transcript
    // with the result first is malformed for the next inference turn.
    expect(persisted.indexOf(tools[0])).toBeGreaterThan(
      persisted.indexOf(assistants[0])
    );
  });
});
