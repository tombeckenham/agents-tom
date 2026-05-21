import { describe, expect, it, vi } from "vitest";
import type {
  AGUIMessage,
  AssistantMessage,
  ReasoningMessage,
  ToolMessage
} from "../agui-types";
import {
  byteLength,
  enforceRowSizeLimit,
  isEmptyReasoningMessage,
  ROW_MAX_BYTES,
  sanitizeAGUIMessage,
  truncateToolMessageContent
} from "../agui-sanitize";

function assistant(
  content: string,
  extras: Partial<AssistantMessage> = {}
): AssistantMessage {
  return { id: "a1", role: "assistant", content, ...extras };
}

function tool(content: string, extras: Partial<ToolMessage> = {}): ToolMessage {
  return {
    id: "t1",
    role: "tool",
    toolCallId: "call_1",
    content,
    ...extras
  };
}

function reasoning(
  content: string,
  extras: Partial<ReasoningMessage> = {}
): ReasoningMessage {
  return { id: "r1", role: "reasoning", content, ...extras };
}

describe("sanitizeAGUIMessage", () => {
  it("returns identity on a clean assistant + tool message pair", () => {
    const a = assistant("hello world");
    const t = tool('{"ok":true}');
    expect(sanitizeAGUIMessage(a)).toBe(a);
    expect(sanitizeAGUIMessage(t)).toBe(t);
  });

  it("flags empty reasoning messages for filtering", () => {
    const empty = reasoning("");
    const blank = reasoning("   ");
    const kept = reasoning("thought");
    const encrypted = reasoning("", { encryptedValue: "abc" });

    expect(isEmptyReasoningMessage(sanitizeAGUIMessage(empty))).toBe(true);
    expect(isEmptyReasoningMessage(sanitizeAGUIMessage(blank))).toBe(true);
    expect(isEmptyReasoningMessage(sanitizeAGUIMessage(kept))).toBe(false);
    expect(isEmptyReasoningMessage(sanitizeAGUIMessage(encrypted))).toBe(false);
  });

  it("strips ephemeral OpenAI keys from reasoning and assistant tool calls", () => {
    const dirty = {
      id: "r1",
      role: "reasoning" as const,
      content: "thinking",
      encryptedValue: "keep-me",
      itemId: "rs_abc"
    } as ReasoningMessage & { itemId: string };

    const cleaned = sanitizeAGUIMessage(dirty) as ReasoningMessage & {
      itemId?: string;
    };
    expect(cleaned.itemId).toBeUndefined();
    expect(cleaned.encryptedValue).toBe("keep-me");
    expect(cleaned.content).toBe("thinking");
  });
});

describe("enforceRowSizeLimit", () => {
  it("truncates ToolMessage.content over the threshold with a marker", () => {
    const big = "x".repeat(ROW_MAX_BYTES + 100);
    const t = tool(big);
    const out = enforceRowSizeLimit(t);
    expect(out).not.toBe(t);
    expect((out as ToolMessage).content.length).toBeLessThan(big.length);
    expect((out as ToolMessage).content).toContain("truncated");
    expect(byteLength(JSON.stringify(out))).toBeLessThanOrEqual(ROW_MAX_BYTES);
  });

  it("truncates large AssistantMessage.content with the storage marker", () => {
    const big = "y".repeat(ROW_MAX_BYTES + 100);
    const a = assistant(big);
    const out = enforceRowSizeLimit(a) as AssistantMessage;
    expect(out.content).toBeDefined();
    expect(out.content?.length).toBeLessThan(big.length);
    expect(out.content).toContain("Text truncated for storage");
    expect(out.content).toContain("First 500 chars");
  });

  it("compacts multiple large tool-call arguments within ROW_MAX_BYTES", () => {
    const huge = "z".repeat(700_000);
    const a: AssistantMessage = {
      id: "a1",
      role: "assistant",
      content: "calling tools",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "search", arguments: huge }
        },
        {
          id: "c2",
          type: "function",
          function: { name: "search", arguments: huge }
        },
        {
          id: "c3",
          type: "function",
          function: { name: "search", arguments: huge }
        }
      ]
    };
    const out = enforceRowSizeLimit(a);
    expect(byteLength(JSON.stringify(out))).toBeLessThanOrEqual(ROW_MAX_BYTES);
  });

  it("is idempotent for both sanitize and enforce", () => {
    const big = "q".repeat(ROW_MAX_BYTES + 100);
    const a = assistant(big);
    const once = enforceRowSizeLimit(sanitizeAGUIMessage(a));
    const twice = enforceRowSizeLimit(sanitizeAGUIMessage(once));
    expect(twice).toEqual(once);
  });
});

describe("malformed input", () => {
  it("passes through and warns on malformed messages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { id: "x", content: "no role here" } as unknown as AGUIMessage;
    const out = sanitizeAGUIMessage(bad);
    expect(out).toBe(bad);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("truncateToolMessageContent", () => {
  it("is a no-op when under the limit", () => {
    const s = "hello";
    expect(truncateToolMessageContent(s, 500)).toBe(s);
  });

  it("truncates when over the limit", () => {
    const s = "a".repeat(2000);
    const out = truncateToolMessageContent(s, 500);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain("truncated");
  });
});
