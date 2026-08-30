import { describe, expect, it } from "vitest";
import type { AGUIMessage } from "agents/chat/agui-types";
import { toUIMessages } from "../to-ui-messages";

function partsOf(message: { parts: unknown[] }) {
  return message.parts as Array<Record<string, unknown>>;
}

describe("toUIMessages", () => {
  it("projects a plain text user turn", () => {
    const ui = toUIMessages([
      { id: "u1", role: "user", content: "hello" }
    ] satisfies AGUIMessage[]);

    expect(ui).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }
    ]);
  });

  it("drops empty user turns rather than emitting a partless message", () => {
    expect(toUIMessages([{ id: "u1", role: "user", content: "" }])).toEqual([]);
  });

  it("maps system and developer roles onto system", () => {
    const ui = toUIMessages([
      { id: "s1", role: "system", content: "be brief" },
      { id: "d1", role: "developer", content: "internal note" }
    ] satisfies AGUIMessage[]);

    expect(ui.map((m) => m.role)).toEqual(["system", "system"]);
    expect(partsOf(ui[1])[0]).toEqual({ type: "text", text: "internal note" });
  });

  it("carries assistant text and tool calls onto one message", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: "checking",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"Sydney"}' }
          }
        ]
      }
    ] satisfies AGUIMessage[]);

    expect(ui).toHaveLength(1);
    const parts = partsOf(ui[0]);
    // Tool parts precede text — matching the legacy persisted part order.
    expect(parts[0]).toMatchObject({
      type: "tool-getWeather",
      toolCallId: "call-1",
      toolName: "getWeather",
      state: "input-available",
      input: { city: "Sydney" }
    });
    expect(parts[1]).toEqual({ type: "text", text: "checking", state: "done" });
  });

  it("emits a tool-only assistant turn with no text part", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "ping", arguments: "{}" }
          }
        ]
      }
    ] satisfies AGUIMessage[]);

    expect(partsOf(ui[0])).toHaveLength(1);
    expect(partsOf(ui[0])[0]).toMatchObject({ type: "tool-ping" });
  });

  it("folds a tool result back onto the call that issued it", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"Sydney"}' }
          }
        ]
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call-1",
        content: '{"temperature":21}'
      }
    ] satisfies AGUIMessage[]);

    // The result is folded onto the assistant turn, not emitted separately.
    expect(ui).toHaveLength(1);
    expect(partsOf(ui[0])[0]).toMatchObject({
      state: "output-available",
      output: { temperature: 21 }
    });
  });

  it("marks an errored tool result as output-error", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "boom", arguments: "{}" }
          }
        ]
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call-1",
        content: "",
        error: "exploded"
      }
    ] satisfies AGUIMessage[]);

    expect(partsOf(ui[0])[0]).toMatchObject({
      state: "output-error",
      errorText: "exploded"
    });
  });

  it("skips a tool result whose call is absent", () => {
    const ui = toUIMessages([
      { id: "u1", role: "user", content: "hi" },
      { id: "t1", role: "tool", toolCallId: "missing", content: "{}" }
    ] satisfies AGUIMessage[]);

    expect(ui).toHaveLength(1);
    expect(ui[0].role).toBe("user");
  });

  it("matches results by id, not by position", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "a", arguments: "{}" }
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "b", arguments: "{}" }
          }
        ]
      },
      { id: "t2", role: "tool", toolCallId: "call-2", content: '{"n":2}' },
      { id: "t1", role: "tool", toolCallId: "call-1", content: '{"n":1}' }
    ] satisfies AGUIMessage[]);

    const parts = partsOf(ui[0]);
    expect(parts[0]).toMatchObject({ toolCallId: "call-1", output: { n: 1 } });
    expect(parts[1]).toMatchObject({ toolCallId: "call-2", output: { n: 2 } });
  });

  it("passes through a non-JSON tool result as a raw string", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "echo", arguments: "not json" }
          }
        ]
      },
      { id: "t1", role: "tool", toolCallId: "call-1", content: "plain text" }
    ] satisfies AGUIMessage[]);

    expect(partsOf(ui[0])[0]).toMatchObject({
      input: "not json",
      output: "plain text"
    });
  });

  it("projects multimodal user content into text and file parts", () => {
    const ui = toUIMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            source: {
              type: "url",
              value: "https://x/y.png",
              mimeType: "image/png"
            }
          },
          {
            type: "audio",
            source: { type: "data", value: "AAA", mimeType: "audio/mpeg" }
          }
        ]
      }
    ] satisfies AGUIMessage[]);

    const parts = partsOf(ui[0]);
    expect(parts[0]).toEqual({ type: "text", text: "what is this" });
    expect(parts[1]).toEqual({
      type: "file",
      mediaType: "image/png",
      url: "https://x/y.png"
    });
    expect(parts[2]).toEqual({
      type: "file",
      mediaType: "audio/mpeg",
      url: "data:audio/mpeg;base64,AAA"
    });
  });

  it("folds a reasoning row onto the following assistant message", () => {
    const ui = toUIMessages([
      { id: "r1", role: "reasoning", content: "thinking" },
      { id: "a1", role: "assistant", content: "answer" }
    ] satisfies AGUIMessage[]);

    // Legacy shape: ONE assistant message with [reasoning, text] parts.
    expect(ui).toEqual([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking", state: "done" },
          { type: "text", text: "answer", state: "done" }
        ]
      }
    ]);
  });

  it("falls back to a standalone part for reasoning with no following assistant", () => {
    const ui = toUIMessages([
      { id: "r1", role: "reasoning", content: "thinking" }
    ] satisfies AGUIMessage[]);

    expect(ui[0]).toEqual({
      id: "r1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "thinking", state: "done" }]
    });
  });

  it("does not fold reasoning across a user boundary", () => {
    const ui = toUIMessages([
      { id: "r1", role: "reasoning", content: "thinking" },
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" }
    ] satisfies AGUIMessage[]);

    expect(ui.map((m) => m.id)).toEqual(["r1", "u1", "a1"]);
  });

  it("projects tool approval states from the toolApprovals extension", () => {
    const call = (id: string) => ({
      id,
      type: "function" as const,
      function: { name: "riskyTool", arguments: '{"level":9}' }
    });
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [call("c-req"), call("c-yes"), call("c-no")],
        toolApprovals: {
          "c-req": { approvalId: "ap-1" },
          "c-yes": { approvalId: "ap-2", approved: true },
          "c-no": { approvalId: "ap-3", approved: false }
        }
      }
    ] satisfies AGUIMessage[]);

    const parts = partsOf(ui[0]);
    expect(parts[0]).toMatchObject({
      state: "approval-requested",
      approval: { id: "ap-1" }
    });
    expect(parts[1]).toMatchObject({
      state: "approval-responded",
      approval: { id: "ap-2", approved: true }
    });
    expect(parts[2]).toMatchObject({
      state: "output-denied",
      approval: { id: "ap-3", approved: false }
    });
  });

  it("keeps the approval field when an approved call's output lands", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "c-1",
            type: "function",
            function: { name: "riskyTool", arguments: "{}" }
          }
        ],
        toolApprovals: { "c-1": { approvalId: "ap-1", approved: true } }
      },
      { id: "t1", role: "tool", toolCallId: "c-1", content: '{"ran":true}' }
    ] satisfies AGUIMessage[]);

    expect(partsOf(ui[0])[0]).toMatchObject({
      state: "output-available",
      output: { ran: true },
      approval: { id: "ap-1", approved: true }
    });
  });

  it("emits extraParts and metadata verbatim", () => {
    const ui = toUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: "with extras",
        metadata: { model: "fixture-model" },
        extraParts: [
          { type: "data-weather", data: { temp: 21 } },
          {
            type: "file",
            mediaType: "text/plain",
            url: "data:text/plain;base64,aGk="
          },
          { type: "source-url", sourceId: "s1", url: "https://x", title: "Doc" }
        ]
      }
    ] satisfies AGUIMessage[]);

    expect(ui[0].metadata).toEqual({ model: "fixture-model" });
    expect(partsOf(ui[0]).map((p) => p.type)).toEqual([
      "data-weather",
      "file",
      "source-url",
      "text"
    ]);
  });

  it("drops activity messages, which have no UIMessage counterpart", () => {
    expect(
      toUIMessages([{ id: "x1", role: "activity", content: { pct: 50 } }])
    ).toEqual([]);
  });

  it("preserves conversation order across a multi-turn exchange", () => {
    const ui = toUIMessages([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
      { id: "u2", role: "user", content: "bye" }
    ] satisfies AGUIMessage[]);

    expect(ui.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });
});
