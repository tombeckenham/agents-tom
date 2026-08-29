/**
 * Coverage for `UIMessageChunk → AGUIEvent` projection.
 * Each `describe` corresponds to a row in the projection table in
 * `design/discovery-agui-types.md` §§ "UIMessageChunk → AG-UI Event".
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import {
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_REQUEST
} from "agents/chat/agui-types";
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { ChunkToEventProjector } from "../chunk-to-event";

function project(chunks: UIMessageChunk[]): AGUIEvent[] {
  const projector = new ChunkToEventProjector({
    threadId: "thread-1",
    runId: "run-1"
  });
  const out: AGUIEvent[] = [];
  for (const chunk of chunks) out.push(...projector.project(chunk));
  out.push(...projector.flush());
  return out;
}

describe("ChunkToEventProjector — lifecycle", () => {
  it("start → buffers, RUN_STARTED emits on first content", () => {
    const events = project([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "m1" }
    ]);
    expect(events[0]).toEqual({
      type: "RUN_STARTED",
      threadId: "thread-1",
      runId: "run-1"
    });
    expect(events[1]).toEqual({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
  });

  it("finish → RUN_FINISHED with result.finishReason", () => {
    const events = project([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "m1" },
      { type: "text-end", id: "m1" },
      { type: "finish", finishReason: "stop" }
    ]);
    const finish = events.find((e) => e.type === "RUN_FINISHED");
    expect(finish).toEqual({
      type: "RUN_FINISHED",
      threadId: "thread-1",
      runId: "run-1",
      result: { finishReason: "stop" }
    });
  });

  it("flush() synthesizes RUN_FINISHED when stream ends without a finish chunk", () => {
    const projector = new ChunkToEventProjector({
      threadId: "t",
      runId: "r"
    });
    projector.project({ type: "text-start", id: "m1" });
    const flushed = projector.flush();
    expect(flushed.some((e) => e.type === "RUN_FINISHED")).toBe(true);
  });

  it("error → RUN_ERROR", () => {
    const events = project([{ type: "error", errorText: "boom" }]);
    expect(events).toEqual([{ type: "RUN_ERROR", message: "boom" }]);
  });

  it("abort → RUN_ERROR with code: aborted", () => {
    const events = project([{ type: "abort", reason: "user cancelled" }]);
    expect(events).toEqual([
      { type: "RUN_ERROR", message: "user cancelled", code: "aborted" }
    ]);
  });

  it("start-step / finish-step → STEP_STARTED / STEP_FINISHED", () => {
    const events = project([{ type: "start-step" }, { type: "finish-step" }]);
    expect(events).toContainEqual({ type: "STEP_STARTED", stepName: "step" });
    expect(events).toContainEqual({ type: "STEP_FINISHED", stepName: "step" });
  });
});

describe("ChunkToEventProjector — text", () => {
  it("text-start / delta / end → TEXT_MESSAGE_*", () => {
    const events = project([
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "hello" },
      { type: "text-delta", id: "m1", delta: " world" },
      { type: "text-end", id: "m1" }
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED"
    ]);
  });
});

describe("ChunkToEventProjector — reasoning", () => {
  it("reasoning-start / delta / end → REASONING_MESSAGE_*", () => {
    const events = project([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thinking" },
      { type: "reasoning-end", id: "r1" }
    ]);
    expect(events).toContainEqual({
      type: "REASONING_MESSAGE_START",
      messageId: "r1",
      role: "reasoning"
    });
    expect(events).toContainEqual({
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "r1",
      delta: "thinking"
    });
    expect(events).toContainEqual({
      type: "REASONING_MESSAGE_END",
      messageId: "r1"
    });
  });
});

describe("ChunkToEventProjector — tool calls (single)", () => {
  it("tool-input-start / 3×delta / tool-input-available → START + 3×ARGS + END", () => {
    const events = project([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "search" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '{"q":' },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '"hi' },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '"}' },
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "search",
        input: { q: "hi" }
      }
    ]);
    const toolEvents = events.filter(
      (e) =>
        e.type === "TOOL_CALL_START" ||
        e.type === "TOOL_CALL_ARGS" ||
        e.type === "TOOL_CALL_END"
    );
    expect(toolEvents.map((e) => e.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END"
    ]);
    // tool-input-available does NOT emit TOOL_CALL_RESULT
    expect(events.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(false);
  });

  it("tool-output-available → TOOL_CALL_RESULT only", () => {
    const events = project([
      {
        type: "tool-output-available",
        toolCallId: "tc1",
        output: { result: 42 }
      }
    ]);
    expect(events).toEqual([
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool_tc1",
        toolCallId: "tc1",
        content: JSON.stringify({ result: 42 }),
        role: "tool"
      }
    ]);
  });

  it("tool-output-error → TOOL_CALL_RESULT with error JSON", () => {
    const events = project([
      { type: "tool-output-error", toolCallId: "tc1", errorText: "nope" }
    ]);
    expect(events).toEqual([
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool_tc1",
        toolCallId: "tc1",
        content: JSON.stringify({ error: "nope" }),
        role: "tool",
        error: "nope"
      }
    ]);
  });

  it("tool-output-denied → CUSTOM tool_approval.decision approved:false", () => {
    const events = project([{ type: "tool-output-denied", toolCallId: "tc1" }]);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: CF_TOOL_APPROVAL_DECISION,
      value: { toolCallId: "tc1", approved: false }
    });
  });

  it("tool-approval-request → CUSTOM tool_approval.request", () => {
    const events = project([
      {
        type: "tool-approval-request",
        toolCallId: "tc1",
        approvalId: "ap1"
      }
    ]);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: CF_TOOL_APPROVAL_REQUEST,
      value: { toolCallId: "tc1", approvalId: "ap1" }
    });
  });
});

describe("ChunkToEventProjector — two parallel tool calls", () => {
  it("interleaved tool calls keep independent buffers", () => {
    const events = project([
      { type: "tool-input-start", toolCallId: "a", toolName: "alpha" },
      { type: "tool-input-start", toolCallId: "b", toolName: "beta" },
      { type: "tool-input-delta", toolCallId: "a", inputTextDelta: '{"x' },
      { type: "tool-input-delta", toolCallId: "b", inputTextDelta: '{"y' },
      { type: "tool-input-delta", toolCallId: "a", inputTextDelta: '":1}' },
      { type: "tool-input-delta", toolCallId: "b", inputTextDelta: '":2}' },
      {
        type: "tool-input-available",
        toolCallId: "a",
        toolName: "alpha",
        input: { x: 1 }
      },
      {
        type: "tool-input-available",
        toolCallId: "b",
        toolName: "beta",
        input: { y: 2 }
      }
    ]);
    const startA = events.findIndex(
      (e) => e.type === "TOOL_CALL_START" && e.toolCallId === "a"
    );
    const startB = events.findIndex(
      (e) => e.type === "TOOL_CALL_START" && e.toolCallId === "b"
    );
    const endA = events.findIndex(
      (e) => e.type === "TOOL_CALL_END" && e.toolCallId === "a"
    );
    const endB = events.findIndex(
      (e) => e.type === "TOOL_CALL_END" && e.toolCallId === "b"
    );
    expect(startA).toBeGreaterThanOrEqual(0);
    expect(startB).toBeGreaterThanOrEqual(0);
    expect(endA).toBeGreaterThanOrEqual(0);
    expect(endB).toBeGreaterThanOrEqual(0);
    // Each tool received exactly two args events
    const aArgs = events.filter(
      (e) => e.type === "TOOL_CALL_ARGS" && e.toolCallId === "a"
    );
    const bArgs = events.filter(
      (e) => e.type === "TOOL_CALL_ARGS" && e.toolCallId === "b"
    );
    expect(aArgs).toHaveLength(2);
    expect(bArgs).toHaveLength(2);
  });
});

describe("ChunkToEventProjector — data chunks and metadata", () => {
  it("data-foo → CUSTOM name=data.foo", () => {
    const events = project([
      { type: "data-foo", data: { hello: "world" } } as UIMessageChunk
    ]);
    // The value is wrapped so the part id / transient flag round-trip.
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "data.foo",
      value: { data: { hello: "world" } }
    });
  });

  it("source-url → CUSTOM cf.agents.source", () => {
    const events = project([
      { type: "source-url", sourceId: "s1", url: "https://x", title: "x" }
    ]);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "cf.agents.source",
      value: { kind: "url", sourceId: "s1", url: "https://x" }
    });
  });

  it("file → CUSTOM cf.agents.file", () => {
    const events = project([
      { type: "file", url: "https://x/y.png", mediaType: "image/png" }
    ]);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "cf.agents.file",
      value: { url: "https://x/y.png", mediaType: "image/png" }
    });
  });

  it("message-metadata → CUSTOM cf.agents.message_metadata", () => {
    const events = project([
      { type: "message-metadata", messageMetadata: { foo: 1 } as unknown }
    ]);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "cf.agents.message_metadata"
    });
  });
});
