import { describe, expect, it } from "vitest";
import type { AGUIMessage } from "agents/chat/agui-types";
import { toModelMessages } from "../to-model-messages";

describe("toModelMessages", () => {
  it("passes a plain user turn through unchanged", () => {
    const { messages, systemPrompts } = toModelMessages([
      { id: "u1", role: "user", content: "hello" }
    ] satisfies AGUIMessage[]);

    expect(messages).toEqual([{ role: "user", content: "hello" }]);
    expect(systemPrompts).toEqual([]);
  });

  it("lifts system and developer turns into systemPrompts", () => {
    const { messages, systemPrompts } = toModelMessages([
      { id: "s1", role: "system", content: "be brief" },
      { id: "d1", role: "developer", content: "internal note" },
      { id: "u1", role: "user", content: "hi" }
    ] satisfies AGUIMessage[]);

    expect(systemPrompts).toEqual(["be brief", "internal note"]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("keeps assistant tool calls as-is", () => {
    const { messages } = toModelMessages([
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

    expect(messages[0]).toEqual({
      role: "assistant",
      content: "checking",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "getWeather", arguments: '{"city":"Sydney"}' }
        }
      ]
    });
  });

  it("represents a tool-only assistant turn with null content", () => {
    const { messages } = toModelMessages([
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

    expect(messages[0].content).toBeNull();
  });

  it("keeps tool results as standalone messages, unlike the Vercel shape", () => {
    const { messages } = toModelMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "getWeather", arguments: "{}" }
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

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: "tool",
      content: '{"temperature":21}',
      toolCallId: "call-1"
    });
  });

  it("prefers the error text when a tool result carries one", () => {
    const { messages } = toModelMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "call-1",
        content: "",
        error: "exploded"
      }
    ] satisfies AGUIMessage[]);

    expect(messages[0].content).toBe("exploded");
  });

  it("renames only the text field when projecting multimodal content", () => {
    const { messages } = toModelMessages([
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
          }
        ]
      }
    ] satisfies AGUIMessage[]);

    expect(messages[0].content).toEqual([
      { type: "text", content: "what is this" },
      {
        type: "image",
        source: {
          type: "url",
          value: "https://x/y.png",
          mimeType: "image/png"
        },
        metadata: undefined
      }
    ]);
  });

  it("carries the optional speaker name through", () => {
    const { messages } = toModelMessages([
      { id: "u1", role: "user", content: "hi", name: "tom" }
    ] satisfies AGUIMessage[]);

    expect(messages[0].name).toBe("tom");
  });

  it("drops reasoning and activity messages", () => {
    const { messages } = toModelMessages([
      { id: "r1", role: "reasoning", content: "thinking" },
      { id: "x1", role: "activity", content: { pct: 50 } },
      { id: "u1", role: "user", content: "hi" }
    ] satisfies AGUIMessage[]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("preserves order across a multi-turn exchange", () => {
    const { messages } = toModelMessages([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
      { id: "u2", role: "user", content: "bye" }
    ] satisfies AGUIMessage[]);

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
