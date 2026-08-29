import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoTransformAGUIMessages,
  isCleanAGUIMessage,
  isLegacyUIMessage,
  isPersistedAGUIMessage,
  migrateUIMessageToAGUI
} from "../agui-migration";
import { toUIMessages } from "../agui-to-ui-messages";
import {
  PERSISTED_MESSAGE_SCHEMA_VERSION,
  type AGUIMessage
} from "../agui-types";

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

  it("isCleanAGUIMessage accepts plain AG-UI shapes without _v or parts", () => {
    expect(isCleanAGUIMessage({ id: "u1", role: "user", content: "hi" })).toBe(
      true
    );
    expect(
      isCleanAGUIMessage({ id: "a1", role: "assistant", content: "hi" })
    ).toBe(true);
    expect(
      isCleanAGUIMessage({
        id: "t1",
        role: "tool",
        toolCallId: "tc",
        content: "{}"
      })
    ).toBe(true);
    expect(isCleanAGUIMessage({ id: "x", role: "user", parts: [] })).toBe(
      false
    );
    expect(isCleanAGUIMessage({ id: "x", role: "bogus" })).toBe(false);
    expect(isCleanAGUIMessage({ role: "user", content: "hi" })).toBe(false);
    expect(isCleanAGUIMessage(null)).toBe(false);
  });

  it("autoTransformAGUIMessages accepts wire-incoming clean AG-UI rows without warning", () => {
    const wire = [
      { id: "u-wire", role: "user", content: "hello" },
      { id: "a-wire", role: "assistant", content: "world" }
    ];
    const result = autoTransformAGUIMessages(wire);
    expect(result).toEqual(wire);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("migrates a reasoning-only assistant into one ReasoningMessage with a stable id", () => {
    const ui = {
      id: "r-standalone",
      role: "assistant",
      parts: [{ type: "reasoning", text: "thinking" }]
    };
    // No `-reasoning-N` suffix, no fabricated empty assistant row.
    expect(migrateUIMessageToAGUI(ui)).toEqual([
      { id: "r-standalone", role: "reasoning", content: "thinking" }
    ]);
  });

  it("migrates output-error tool parts into an errored ToolMessage", () => {
    const ui = {
      id: "a-err",
      role: "assistant",
      parts: [
        {
          type: "tool-boom",
          toolCallId: "c-1",
          state: "output-error",
          input: {},
          errorText: "exploded"
        }
      ]
    };
    const result = migrateUIMessageToAGUI(ui);
    expect(result[1]).toEqual({
      id: "a-err-tool-0",
      role: "tool",
      toolCallId: "c-1",
      content: JSON.stringify({ error: "exploded" }),
      error: "exploded"
    });
  });

  it("carries approval state, metadata, and extra parts across migration", () => {
    const ui = {
      id: "a-ap",
      role: "assistant",
      metadata: { model: "m" },
      parts: [
        {
          type: "tool-riskyTool",
          toolCallId: "c-1",
          state: "output-denied",
          input: { level: 9 },
          approval: { id: "ap-1", approved: false }
        },
        {
          type: "file",
          mediaType: "text/plain",
          url: "data:text/plain;base64,aGk="
        }
      ]
    };
    const [assistant, ...rest] = migrateUIMessageToAGUI(ui);
    // Denied calls carry no ToolMessage — the approval record is durable.
    expect(rest).toEqual([]);
    expect(assistant).toMatchObject({
      role: "assistant",
      metadata: { model: "m" },
      toolApprovals: { "c-1": { approvalId: "ap-1", approved: false } },
      extraParts: [{ type: "file" }]
    });
  });

  describe("migrate→project→migrate is a fixed point", () => {
    const roundTrip = (transcript: unknown[]) => {
      const first = transcript.flatMap((m) => migrateUIMessageToAGUI(m));
      const projected = toUIMessages(first as AGUIMessage[]);
      const second = projected.flatMap((m) => migrateUIMessageToAGUI(m));
      return { first, second };
    };

    it("holds for a [reasoning, assistant, tool] transcript", () => {
      const { first, second } = roundTrip([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking" },
            {
              type: "tool-search",
              toolCallId: "c-1",
              state: "output-available",
              input: { q: "x" },
              output: { hits: 3 }
            },
            { type: "text", text: "answer" }
          ]
        }
      ]);
      expect(second).toEqual(first);
    });

    it("holds across three passes with no id growth or fabricated rows", () => {
      const transcript = [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "reasoning", text: "only thinking" }]
        }
      ];
      let rows = transcript.flatMap((m) => migrateUIMessageToAGUI(m));
      for (let pass = 0; pass < 3; pass++) {
        const next = toUIMessages(rows as AGUIMessage[]).flatMap((m) =>
          migrateUIMessageToAGUI(m)
        );
        expect(next).toEqual(rows);
        rows = next;
      }
      expect(rows).toEqual([
        { id: "a1", role: "reasoning", content: "only thinking" }
      ]);
    });

    it("holds for approval and error tool states", () => {
      const { first, second } = roundTrip([
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-riskyTool",
              toolCallId: "c-deny",
              state: "output-denied",
              input: { level: 9 },
              approval: { id: "ap-1", approved: false }
            },
            {
              type: "tool-boom",
              toolCallId: "c-err",
              state: "output-error",
              input: {},
              errorText: "exploded"
            }
          ]
        }
      ]);
      expect(second).toEqual(first);
    });
  });
});
