/**
 * Coverage for `AGUIEvent → UIMessageChunk` projection.
 * Each `describe` corresponds to a row in the projection table in
 * `design/discovery-agui-types.md` §§ "AG-UI Event → UIMessageChunk".
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import {
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_REQUEST
} from "agents/chat/agui-types";
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { EventToChunkProjector } from "../event-to-chunk";

function project(events: AGUIEvent[]): UIMessageChunk[] {
  const projector = new EventToChunkProjector();
  const out: UIMessageChunk[] = [];
  for (const event of events) out.push(...projector.project(event));
  return out;
}

describe("EventToChunkProjector — lifecycle", () => {
  it("RUN_STARTED alone does NOT emit a `start` chunk (no messageId yet)", () => {
    const chunks = project([
      { type: "RUN_STARTED", threadId: "t", runId: "r" }
    ]);
    expect(chunks).toEqual([]);
  });

  it("RUN_STARTED + TEXT_MESSAGE_START → leading start{messageId} + text-start", () => {
    const chunks = project([
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }
    ]);
    expect(chunks).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "m1" }
    ]);
  });

  it("RUN_FINISHED → finish", () => {
    const chunks = project([
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ]);
    expect(chunks).toEqual([{ type: "finish" }]);
  });

  it("RUN_ERROR → error", () => {
    const chunks = project([{ type: "RUN_ERROR", message: "boom" }]);
    expect(chunks).toEqual([{ type: "error", errorText: "boom" }]);
  });

  it("STEP_STARTED / FINISHED → start-step / finish-step", () => {
    const chunks = project([
      { type: "STEP_STARTED", stepName: "x" },
      { type: "STEP_FINISHED", stepName: "x" }
    ]);
    expect(chunks).toEqual([{ type: "start-step" }, { type: "finish-step" }]);
  });
});

describe("EventToChunkProjector — text", () => {
  it("CONTENT / END → text-delta / text-end", () => {
    const chunks = project([
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" }
    ]);
    expect(chunks).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "hi" },
      { type: "text-end", id: "m1" }
    ]);
  });
});

describe("EventToChunkProjector — reasoning", () => {
  it("REASONING_MESSAGE_* → reasoning-* chunks", () => {
    const chunks = project([
      { type: "REASONING_MESSAGE_START", messageId: "r1", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "thinking" },
      { type: "REASONING_MESSAGE_END", messageId: "r1" }
    ]);
    expect(chunks).toContainEqual({ type: "reasoning-start", id: "r1" });
    expect(chunks).toContainEqual({
      type: "reasoning-delta",
      id: "r1",
      delta: "thinking"
    });
    expect(chunks).toContainEqual({ type: "reasoning-end", id: "r1" });
  });

  it("REASONING_MESSAGE_CHUNK switching messageId emits end of previous + start of new", () => {
    const projector = new EventToChunkProjector();
    projector.project({
      type: "REASONING_MESSAGE_START",
      messageId: "r1",
      role: "reasoning"
    });
    const chunks = projector.project({
      type: "REASONING_MESSAGE_CHUNK",
      messageId: "r2",
      delta: "x"
    });
    const types = chunks.map((c) => c.type);
    expect(types).toContain("reasoning-end");
    expect(types).toContain("reasoning-start");
    expect(types).toContain("reasoning-delta");
  });
});

describe("EventToChunkProjector — tool args buffering", () => {
  it("START / ARGS×2 / END → tool-input-start + 2 deltas + tool-input-available", () => {
    const chunks = project([
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"' },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: 'x":1}' },
      { type: "TOOL_CALL_END", toolCallId: "tc1" }
    ]);
    expect(chunks).toEqual([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "search" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '{"' },
      {
        type: "tool-input-delta",
        toolCallId: "tc1",
        inputTextDelta: 'x":1}'
      },
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "search",
        input: { x: 1 }
      }
    ]);
  });

  it("TOOL_CALL_RESULT → tool-output-available", () => {
    const chunks = project([
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tm1",
        toolCallId: "tc1",
        content: JSON.stringify({ result: "ok" })
      }
    ]);
    expect(chunks).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "tc1",
        output: { result: "ok" }
      }
    ]);
  });

  it("TOOL_CALL_RESULT with non-JSON content → output as raw string", () => {
    const chunks = project([
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tm1",
        toolCallId: "tc1",
        content: "literal"
      }
    ]);
    expect(chunks).toEqual([
      { type: "tool-output-available", toolCallId: "tc1", output: "literal" }
    ]);
  });
});

describe("EventToChunkProjector — tool approval round-trip", () => {
  it("CUSTOM tool_approval.request → tool-approval-request chunk", () => {
    const chunks = project([
      {
        type: "CUSTOM",
        name: CF_TOOL_APPROVAL_REQUEST,
        value: {
          toolCallId: "tc1",
          toolName: "deleteFile",
          input: { path: "/x" },
          approvalId: "ap1"
        }
      }
    ]);
    expect(chunks).toEqual([
      { type: "tool-approval-request", toolCallId: "tc1", approvalId: "ap1" }
    ]);
  });

  it("CUSTOM tool_approval.decision approved:false → tool-output-denied chunk", () => {
    const chunks = project([
      {
        type: "CUSTOM",
        name: CF_TOOL_APPROVAL_DECISION,
        value: { toolCallId: "tc1", approvalId: "ap1", approved: false }
      }
    ]);
    expect(chunks).toEqual([{ type: "tool-output-denied", toolCallId: "tc1" }]);
  });

  it("CUSTOM tool_approval.decision approved:true → no chunks (handled out-of-band by TOOL_CALL_RESULT)", () => {
    const chunks = project([
      {
        type: "CUSTOM",
        name: CF_TOOL_APPROVAL_DECISION,
        value: { toolCallId: "tc1", approvalId: "ap1", approved: true }
      }
    ]);
    expect(chunks).toEqual([]);
  });

  it("unknown CUSTOM → data-${name} chunk", () => {
    const chunks = project([
      { type: "CUSTOM", name: "myapp.special", value: { foo: 1 } }
    ]);
    expect(chunks).toEqual([{ type: "data-myapp.special", data: { foo: 1 } }]);
  });
});

describe("EventToChunkProjector — STATE/ACTIVITY/RAW pass-through to data chunks", () => {
  it("STATE_SNAPSHOT → data-cf.state", () => {
    const chunks = project([
      { type: "STATE_SNAPSHOT", snapshot: { counter: 1 } }
    ]);
    expect(chunks[0]).toMatchObject({
      type: "data-cf.state",
      id: "snapshot",
      data: { counter: 1 }
    });
  });

  it("STATE_DELTA → data-cf.state-delta (transient)", () => {
    const chunks = project([
      {
        type: "STATE_DELTA",
        delta: [{ op: "add", path: "/x", value: 1 }]
      }
    ]);
    expect(chunks[0]).toMatchObject({
      type: "data-cf.state-delta",
      transient: true
    });
  });

  it("RAW → data-cf.raw (transient)", () => {
    const chunks = project([
      { type: "RAW", event: { provider: "anthropic", payload: {} } }
    ]);
    expect(chunks[0]).toMatchObject({
      type: "data-cf.raw",
      transient: true
    });
  });
});

describe("EventToChunkProjector — MESSAGES_SNAPSHOT expansion", () => {
  it("expands assistant + tool messages into synthetic chunk stream", () => {
    const chunks = project([
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "hello",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "search", arguments: '{"q":"x"}' }
              }
            ]
          },
          {
            id: "t1",
            role: "tool",
            toolCallId: "tc1",
            content: JSON.stringify({ result: "y" })
          }
        ]
      }
    ]);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("start");
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types).toContain("tool-input-start");
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
  });
});
