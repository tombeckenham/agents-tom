import { beforeEach, describe, expect, it } from "vitest";
import { AGUIStreamAccumulator } from "../agui-stream-accumulator";
import type {
  AGUIMessage,
  AssistantMessage,
  CFToolApprovalRequestValue,
  ToolMessage,
  UserMessage
} from "../agui-types";
import { CF_TOOL_APPROVAL_REQUEST } from "../agui-types";

let acc: AGUIStreamAccumulator;

beforeEach(() => {
  acc = new AGUIStreamAccumulator();
});

describe("AGUIStreamAccumulator", () => {
  it("empty stream yields no messages and accepts nothing", () => {
    expect(acc.messages).toEqual([]);
    expect(acc.pendingApprovals.size).toBe(0);
    expect(acc.runMetadata).toEqual({
      threadId: undefined,
      runId: undefined,
      finishReason: undefined,
      usage: undefined
    });
  });

  it("RUN_STARTED returns lifecycle action and captures thread/run ids", () => {
    const action = acc.applyEvent({
      type: "RUN_STARTED",
      threadId: "t-1",
      runId: "r-1"
    });
    expect(action).toEqual({ kind: "lifecycle", phase: "run-start" });
    expect(acc.runMetadata.threadId).toBe("t-1");
    expect(acc.runMetadata.runId).toBe("r-1");
  });

  it("RUN_FINISHED captures finishReason and usage from result", () => {
    acc.applyEvent({ type: "RUN_STARTED", threadId: "t", runId: "r" });
    const action = acc.applyEvent({
      type: "RUN_FINISHED",
      threadId: "t",
      runId: "r",
      result: { finishReason: "stop", usage: { totalTokens: 42 } }
    });
    expect(action).toEqual({ kind: "lifecycle", phase: "run-finish" });
    expect(acc.runMetadata.finishReason).toBe("stop");
    expect(acc.runMetadata.usage).toEqual({ totalTokens: 42 });
  });

  it("text turn returns start then extend for each subsequent event", () => {
    const a1 = acc.applyEvent({
      type: "TEXT_MESSAGE_START",
      messageId: "m-1",
      role: "assistant"
    });
    const a2 = acc.applyEvent({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m-1",
      delta: "hi "
    });
    const a3 = acc.applyEvent({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m-1",
      delta: "there"
    });
    const a4 = acc.applyEvent({
      type: "TEXT_MESSAGE_END",
      messageId: "m-1"
    });
    expect(a1).toEqual({ kind: "start", messageId: "m-1" });
    expect(a2).toEqual({ kind: "extend", messageId: "m-1" });
    expect(a3).toEqual({ kind: "extend", messageId: "m-1" });
    expect(a4).toEqual({ kind: "extend", messageId: "m-1" });
    const m = acc.messages[0] as AssistantMessage;
    expect(m.content).toBe("hi there");
  });

  it("tool call lifecycle: start synthesizes assistant, args/end extend, result emits tool-result", () => {
    const aStart = acc.applyEvent({
      type: "TOOL_CALL_START",
      toolCallId: "tc-1",
      toolCallName: "search"
    });
    expect(aStart.kind).toBe("start");
    const startMsgId = (aStart as { messageId: string }).messageId;

    const aArgs = acc.applyEvent({
      type: "TOOL_CALL_ARGS",
      toolCallId: "tc-1",
      delta: '{"q":"x"}'
    });
    expect(aArgs).toEqual({ kind: "extend", messageId: startMsgId });

    const aEnd = acc.applyEvent({
      type: "TOOL_CALL_END",
      toolCallId: "tc-1"
    });
    expect(aEnd).toEqual({ kind: "extend", messageId: startMsgId });

    const aResult = acc.applyEvent({
      type: "TOOL_CALL_RESULT",
      messageId: "tm-1",
      toolCallId: "tc-1",
      content: '{"ok":true}'
    });
    expect(aResult).toEqual({ kind: "tool-result", toolCallId: "tc-1" });

    expect(acc.messages).toHaveLength(2);
    expect(acc.messages[0].role).toBe("assistant");
    expect(acc.messages[1].role).toBe("tool");
  });

  it("CUSTOM cf.agents.tool_approval.request returns approval and surfaces pendingApprovals", () => {
    const value: CFToolApprovalRequestValue = {
      toolCallId: "tc-9",
      toolName: "delete",
      input: { id: 1 },
      approvalId: "ap-1"
    };
    const action = acc.applyEvent({
      type: "CUSTOM",
      name: CF_TOOL_APPROVAL_REQUEST,
      value
    });
    expect(action).toEqual({
      kind: "approval",
      toolCallId: "tc-9",
      approvalId: "ap-1"
    });
    expect(acc.pendingApprovals.get("tc-9")).toEqual(value);
  });

  it("non-approval CUSTOM events accumulate in customEvents and return noop", () => {
    const action = acc.applyEvent({
      type: "CUSTOM",
      name: "user.toast",
      value: { text: "saved" }
    });
    expect(action).toEqual({ kind: "noop" });
    expect(acc.customEvents).toHaveLength(1);
    expect(acc.customEvents[0]).toMatchObject({
      type: "CUSTOM",
      name: "user.toast",
      value: { text: "saved" }
    });
  });

  it("MESSAGES_SNAPSHOT replaces the accumulator's message list cleanly", () => {
    acc.applyEvent({
      type: "TEXT_MESSAGE_START",
      messageId: "m-old",
      role: "assistant"
    });
    const snapshot: AGUIMessage[] = [
      { id: "u-1", role: "user", content: "hello" } satisfies UserMessage,
      { id: "a-1", role: "assistant", content: "hi" } satisfies AssistantMessage
    ];
    const action = acc.applyEvent({
      type: "MESSAGES_SNAPSHOT",
      messages: snapshot
    });
    expect(action).toEqual({ kind: "noop" });
    expect(acc.messages).toEqual(snapshot);
  });

  it("mergeInto replaces matching prev entries by id and appends new ones", () => {
    acc.applyEvent({
      type: "TEXT_MESSAGE_START",
      messageId: "X",
      role: "assistant"
    });
    acc.applyEvent({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "X",
      delta: "updated"
    });

    const m1: UserMessage = { id: "m1", role: "user", content: "first" };
    const m2: AssistantMessage = {
      id: "X",
      role: "assistant",
      content: "stale"
    };
    const prev: AGUIMessage[] = [m1, m2];

    const merged = acc.mergeInto(prev);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(m1);
    expect((merged[1] as AssistantMessage).content).toBe("updated");
    expect(prev).toEqual([m1, m2]);
  });

  it("mergeInto with empty prev preserves assistant+tool pairing order", () => {
    acc.applyEvent({
      type: "TOOL_CALL_START",
      toolCallId: "tc-1",
      toolCallName: "f",
      parentMessageId: "a-1"
    });
    acc.applyEvent({ type: "TOOL_CALL_END", toolCallId: "tc-1" });
    acc.applyEvent({
      type: "TOOL_CALL_RESULT",
      messageId: "tm-1",
      toolCallId: "tc-1",
      content: "{}"
    });

    const merged = acc.mergeInto([]);
    expect(merged).toHaveLength(2);
    expect(merged[0].role).toBe("assistant");
    expect(merged[0].id).toBe("a-1");
    expect(merged[1].role).toBe("tool");
    expect((merged[1] as ToolMessage).toolCallId).toBe("tc-1");
  });

  it("malformed event returns unknown without throwing", () => {
    const action = acc.applyEvent({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "no-such-stream",
      delta: "x"
    });
    expect(action).toEqual({ kind: "unknown" });
    expect(acc.messages).toEqual([]);
  });

  it("reset clears messages, approvals, and run metadata", () => {
    acc.applyEvent({ type: "RUN_STARTED", threadId: "t", runId: "r" });
    acc.applyEvent({
      type: "CUSTOM",
      name: CF_TOOL_APPROVAL_REQUEST,
      value: {
        toolCallId: "tc",
        toolName: "x",
        input: {},
        approvalId: "ap"
      } satisfies CFToolApprovalRequestValue
    });
    acc.reset();
    expect(acc.messages).toEqual([]);
    expect(acc.pendingApprovals.size).toBe(0);
    expect(acc.runMetadata.threadId).toBeUndefined();
  });

  it("existingMessages are adopted as initial state for mergeInto", () => {
    const seed: AGUIMessage[] = [
      { id: "u-1", role: "user", content: "hi" } satisfies UserMessage
    ];
    const seeded = new AGUIStreamAccumulator({ existingMessages: seed });
    expect(seeded.messages).toEqual(seed);
    const merged = seeded.mergeInto([]);
    expect(merged).toEqual(seed);
  });
});
