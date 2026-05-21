import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoTransformAGUIMessages,
  isLegacyUIMessage,
  isPersistedAGUIMessage,
  migrateUIMessageToAGUI
} from "../agui-migration";
import { PERSISTED_MESSAGE_SCHEMA_VERSION } from "../agui-types";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("agui-migration", () => {
  it("passes through already-AG-UI rows with the _v marker (identity, marker stripped)", () => {
    const persisted = {
      _v: PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: "m1",
      role: "user",
      content: "hi"
    };
    expect(isPersistedAGUIMessage(persisted)).toBe(true);
    const out = autoTransformAGUIMessages([persisted]);
    expect(out).toEqual([{ id: "m1", role: "user", content: "hi" }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("isLegacyUIMessage matches the v5 UIMessage shape", () => {
    expect(isLegacyUIMessage({ id: "x", role: "user", parts: [] })).toBe(true);
    expect(isLegacyUIMessage({ id: "x", role: "user" })).toBe(false);
    expect(isLegacyUIMessage(null)).toBe(false);
  });

  it("migrates a pure-text v5 user message into a single UserMessage with string content", () => {
    const ui = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hello world" }]
    };
    expect(migrateUIMessageToAGUI(ui)).toEqual([
      { id: "u1", role: "user", content: "hello world" }
    ]);
  });

  it("migrates a multimodal v5 user message into a UserMessage with InputContent[]", () => {
    const ui = {
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "look at this" },
        {
          type: "file",
          mediaType: "image/png",
          url: "https://example.com/cat.png"
        }
      ]
    };
    expect(migrateUIMessageToAGUI(ui)).toEqual([
      {
        id: "u2",
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.com/cat.png",
              mimeType: "image/png"
            }
          }
        ]
      }
    ]);
  });

  it("migrates a pure-text v5 assistant message into an AssistantMessage with content and no toolCalls", () => {
    const ui = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "result" }]
    };
    expect(migrateUIMessageToAGUI(ui)).toEqual([
      { id: "a1", role: "assistant", content: "result" }
    ]);
  });

  it("migrates an assistant with one output-available tool part into AssistantMessage + ToolMessage", () => {
    const ui = {
      id: "a2",
      role: "assistant",
      parts: [
        { type: "text", text: "calling tool" },
        {
          type: "tool-search",
          toolCallId: "call_1",
          state: "output-available",
          input: { q: "agents" },
          output: { hits: 3 }
        }
      ]
    };
    expect(migrateUIMessageToAGUI(ui)).toEqual([
      {
        id: "a2",
        role: "assistant",
        content: "calling tool",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "search",
              arguments: JSON.stringify({ q: "agents" })
            }
          }
        ]
      },
      {
        id: "a2-tool-0",
        role: "tool",
        toolCallId: "call_1",
        content: JSON.stringify({ hits: 3 })
      }
    ]);
  });

  it("emits only a ToolCall (no ToolMessage) for an incomplete tool part in input-available", () => {
    const ui = {
      id: "a3",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "call_2",
          state: "input-available",
          input: { q: "incomplete" }
        }
      ]
    };
    const result = migrateUIMessageToAGUI(ui);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "a3",
      role: "assistant",
      toolCalls: [
        {
          id: "call_2",
          type: "function",
          function: {
            name: "search",
            arguments: JSON.stringify({ q: "incomplete" })
          }
        }
      ]
    });
  });

  it("places reasoning before the assistant when migrating reasoning + text + tool", () => {
    const ui = {
      id: "a4",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "answer" },
        {
          type: "tool-lookup",
          toolCallId: "call_3",
          state: "output-available",
          input: { k: "v" },
          output: "done"
        }
      ]
    };
    const result = migrateUIMessageToAGUI(ui);
    expect(result.map((m) => m.role)).toEqual([
      "reasoning",
      "assistant",
      "tool"
    ]);
    expect(result[0]).toMatchObject({
      role: "reasoning",
      content: "thinking..."
    });
    expect(result[1]).toMatchObject({
      id: "a4",
      role: "assistant",
      content: "answer"
    });
    expect(result[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_3"
    });
  });

  it("migrates a v5 system message with metadata.aguiRole='developer' into a DeveloperMessage", () => {
    const ui = {
      id: "s1",
      role: "system",
      parts: [{ type: "text", text: "be brief" }],
      metadata: { aguiRole: "developer" }
    };
    expect(migrateUIMessageToAGUI(ui)).toEqual([
      { id: "s1", role: "developer", content: "be brief" }
    ]);
  });

  it("skips a malformed row with no role and warns", () => {
    const result = autoTransformAGUIMessages([{ id: "x", parts: [] }]);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("handles a mixed list with one legacy UIMessage and one AG-UI envelope", () => {
    const legacy = {
      id: "u9",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    };
    const native = {
      _v: PERSISTED_MESSAGE_SCHEMA_VERSION,
      id: "a9",
      role: "assistant",
      content: "yo"
    };
    const result = autoTransformAGUIMessages([legacy, native]);
    expect(result).toEqual([
      { id: "u9", role: "user", content: "hi" },
      { id: "a9", role: "assistant", content: "yo" }
    ]);
  });
});
