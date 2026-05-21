import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEventToSnapshot,
  createInitialSnapshot,
  isReplayEvent,
  type SnapshotState
} from "../agui-message-builder";
import type {
  AssistantMessage,
  ReasoningMessage,
  ToolMessage
} from "../agui-types";
import { CF_TOOL_APPROVAL_REQUEST } from "../agui-types";

let state: SnapshotState;

beforeEach(() => {
  state = createInitialSnapshot();
});

describe("applyEventToSnapshot", () => {
  it("RUN_STARTED → RUN_FINISHED yields no messages", () => {
    expect(
      applyEventToSnapshot(state, {
        type: "RUN_STARTED",
        threadId: "t-1",
        runId: "r-1"
      })
    ).toBe(true);
    expect(
      applyEventToSnapshot(state, {
        type: "RUN_FINISHED",
        threadId: "t-1",
        runId: "r-1"
      })
    ).toBe(true);
    expect(state.messages).toEqual([]);
    expect(state.threadId).toBe("t-1");
  });

  it("pure text turn concatenates content into one AssistantMessage", () => {
    applyEventToSnapshot(state, {
      type: "RUN_STARTED",
      threadId: "t-1",
      runId: "r-1"
    });
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_START",
      messageId: "m-1",
      role: "assistant"
    });
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m-1",
      delta: "hello "
    });
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m-1",
      delta: "world"
    });
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_END",
      messageId: "m-1"
    });
    applyEventToSnapshot(state, {
      type: "RUN_FINISHED",
      threadId: "t-1",
      runId: "r-1"
    });

    expect(state.messages).toHaveLength(1);
    const assistant = state.messages[0] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.id).toBe("m-1");
    expect(assistant.content).toBe("hello world");
    expect(state.textStreams.size).toBe(0);
  });

  it("tool call buffers arguments across ARGS deltas and finalizes on END", () => {
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_START",
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId: "m-1"
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_ARGS",
      toolCallId: "tc-1",
      delta: '{"q":"'
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_ARGS",
      toolCallId: "tc-1",
      delta: 'hello"}'
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_END",
      toolCallId: "tc-1"
    });

    expect(state.messages).toHaveLength(1);
    const assistant = state.messages[0] as AssistantMessage;
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0]).toEqual({
      id: "tc-1",
      type: "function",
      function: { name: "search", arguments: '{"q":"hello"}' }
    });
    expect(state.toolBuffers.size).toBe(0);
  });

  it("TOOL_CALL_RESULT appends a separate ToolMessage", () => {
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_START",
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId: "m-1"
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_END",
      toolCallId: "tc-1"
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_RESULT",
      messageId: "m-tool-1",
      toolCallId: "tc-1",
      content: '{"results":[]}'
    });

    expect(state.messages).toHaveLength(2);
    const tool = state.messages[1] as ToolMessage;
    expect(tool.role).toBe("tool");
    expect(tool.id).toBe("m-tool-1");
    expect(tool.toolCallId).toBe("tc-1");
    expect(tool.content).toBe('{"results":[]}');
  });

  it("reasoning lifecycle produces a ReasoningMessage with concatenated content", () => {
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_START",
      messageId: "r-1",
      role: "reasoning"
    });
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "r-1",
      delta: "let me "
    });
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "r-1",
      delta: "think"
    });
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_END",
      messageId: "r-1"
    });

    const reasoning = state.messages[0] as ReasoningMessage;
    expect(reasoning.role).toBe("reasoning");
    expect(reasoning.content).toBe("let me think");
    expect(state.reasoningStreams.size).toBe(0);
  });

  it("REASONING_MESSAGE_CHUNK with new messageId is treated as implicit start", () => {
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_CHUNK",
      messageId: "r-1",
      delta: "first "
    });
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_CHUNK",
      messageId: "r-1",
      delta: "second"
    });

    const reasoning = state.messages[0] as ReasoningMessage;
    expect(reasoning.id).toBe("r-1");
    expect(reasoning.content).toBe("first second");
  });

  it("REASONING_ENCRYPTED_VALUE attaches to the matching reasoning message", () => {
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_START",
      messageId: "r-1",
      role: "reasoning"
    });
    applyEventToSnapshot(state, {
      type: "REASONING_MESSAGE_END",
      messageId: "r-1"
    });
    applyEventToSnapshot(state, {
      type: "REASONING_ENCRYPTED_VALUE",
      subtype: "message",
      entityId: "r-1",
      encryptedValue: "sig-abc"
    });

    const reasoning = state.messages[0] as ReasoningMessage;
    expect(reasoning.encryptedValue).toBe("sig-abc");
  });

  it("MESSAGES_SNAPSHOT replaces state and clears in-flight buffers", () => {
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_START",
      messageId: "m-old",
      role: "assistant"
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_START",
      toolCallId: "tc-old",
      toolCallName: "x"
    });

    const snapshot: AssistantMessage[] = [
      { id: "m-new", role: "assistant", content: "snapped" }
    ];
    applyEventToSnapshot(state, {
      type: "MESSAGES_SNAPSHOT",
      messages: snapshot
    });

    expect(state.messages).toEqual(snapshot);
    expect(state.textStreams.size).toBe(0);
    expect(state.toolBuffers.size).toBe(0);

    // Events after snapshot operate as if fresh.
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_START",
      messageId: "m-post",
      role: "assistant"
    });
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m-post",
      delta: "after"
    });
    expect(state.messages).toHaveLength(2);
    expect((state.messages[1] as AssistantMessage).content).toBe("after");
  });

  it("CUSTOM cf.agents.tool_approval.request surfaces via pendingApprovals", () => {
    const value = {
      toolCallId: "tc-1",
      toolName: "delete",
      input: { path: "/" },
      approvalId: "a-1"
    };
    applyEventToSnapshot(state, {
      type: "CUSTOM",
      name: CF_TOOL_APPROVAL_REQUEST,
      value
    });
    expect(state.pendingApprovals.get("tc-1")).toEqual(value);
  });

  it("malformed TEXT_MESSAGE_CONTENT (no matching stream) returns false and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "missing",
      delta: "x"
    });
    expect(ok).toBe(false);
    expect(state.messages).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("createInitialSnapshot adopts seed messages", () => {
    const seed: AssistantMessage[] = [
      { id: "seed-1", role: "assistant", content: "prior" }
    ];
    const s = createInitialSnapshot(seed);
    expect(s.messages).toEqual(seed);
    // The seed copy is independent.
    s.messages.push({ id: "x", role: "assistant" });
    expect(seed).toHaveLength(1);
  });

  it("RUN_ERROR records lastError and clears in-flight state", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyEventToSnapshot(state, {
      type: "TEXT_MESSAGE_START",
      messageId: "m-1",
      role: "assistant"
    });
    const ok = applyEventToSnapshot(state, {
      type: "RUN_ERROR",
      message: "boom",
      code: "E_FAIL"
    });
    expect(ok).toBe(true);
    expect(state.lastError).toEqual({ message: "boom", code: "E_FAIL" });
    expect(state.textStreams.size).toBe(0);
    warn.mockRestore();
  });
});

describe("isReplayEvent", () => {
  it("detects TOOL_CALL_RESULT replay when ToolMessage already exists", () => {
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_START",
      toolCallId: "tc-1",
      toolCallName: "x",
      parentMessageId: "m-1"
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_END",
      toolCallId: "tc-1"
    });
    applyEventToSnapshot(state, {
      type: "TOOL_CALL_RESULT",
      messageId: "m-tool-1",
      toolCallId: "tc-1",
      content: "{}"
    });

    expect(
      isReplayEvent(state, {
        type: "TOOL_CALL_RESULT",
        messageId: "m-tool-1",
        toolCallId: "tc-1",
        content: "{}"
      })
    ).toBe(true);
  });

  it("does not flag fresh TEXT_MESSAGE_START as replay", () => {
    expect(
      isReplayEvent(state, {
        type: "TEXT_MESSAGE_START",
        messageId: "m-new",
        role: "assistant"
      })
    ).toBe(false);
  });
});
