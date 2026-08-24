/**
 * Tool approvals on the AG-UI shape.
 *
 * A CUSTOM `cf.agents.tool_approval.request` event mid-stream eagerly
 * persists the assistant turn (so a refresh keeps the approval modal), and
 * an incoming CF_AGENT_TOOL_APPROVAL broadcasts a CUSTOM
 * `cf.agents.tool_approval.decision` event to clients.
 */

import { describe, expect, it } from "vitest";
import {
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_REQUEST,
  type AssistantMessage
} from "../chat/agui-types";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  isDoneFrame,
  isResponseFrame,
  recordFrames,
  sendChatRequest,
  userMessage,
  waitForPersisted
} from "./test-utils";

describe("AGUIChatAgent — tool approval", () => {
  it("eagerly persists the assistant turn when an approval request streams", async () => {
    const path = `/agents/approval-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "delete it")]);
    // Wait for the approval request event to stream; the fixture then holds
    // the stream open, so persistence at this point must be the eager path.
    await rec.waitFor(
      (f) =>
        isResponseFrame(f) &&
        f.id === "req1" &&
        (f.body?.includes(CF_TOOL_APPROVAL_REQUEST) ?? false)
    );

    // Poll while the fixture holds the stream open — the rows must land
    // before the turn completes (eager approval persistence).
    const persisted = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "assistant")
    );
    const assistant = persisted.find(
      (m): m is AssistantMessage => m.role === "assistant"
    );
    expect(assistant).toBeDefined();
    expect(assistant?.toolCalls?.[0]?.id).toBe("tc-approve");

    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);
  });

  it("broadcasts a CUSTOM decision event when the client approves", async () => {
    const path = `/agents/approval-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "delete it")]);
    await rec.waitFor(
      (f) =>
        isResponseFrame(f) &&
        f.id === "req1" &&
        (f.body?.includes(CF_TOOL_APPROVAL_REQUEST) ?? false)
    );

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
        toolCallId: "tc-approve",
        approved: true
      })
    );

    const decisionFrame = await rec.waitFor(
      (f) =>
        isResponseFrame(f) &&
        (f.body?.includes(CF_TOOL_APPROVAL_DECISION) ?? false)
    );
    const event = JSON.parse(decisionFrame.body as string) as {
      type: string;
      name: string;
      value: { toolCallId: string; approved: boolean };
    };
    expect(event.type).toBe("CUSTOM");
    expect(event.value.toolCallId).toBe("tc-approve");
    expect(event.value.approved).toBe(true);

    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);
  });
});
