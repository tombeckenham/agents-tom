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
});
