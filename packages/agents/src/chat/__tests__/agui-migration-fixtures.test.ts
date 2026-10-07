/**
 * Fixture-level validation of the v5 → AG-UI migration.
 *
 * The sibling `agui-migration.test.ts` covers each message shape in
 * isolation. This file works on whole conversations in the exact JSON form
 * they are persisted in `cf_ai_chat_agent_messages`, and asserts the
 * properties that matter when an existing deployment loads old rows:
 * ordering survives, tool calls stay paired with their results, nothing is
 * silently dropped, and re-running the migration is a no-op.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoTransformAGUIMessages } from "../agui-migration";
import { PERSISTED_MESSAGE_SCHEMA_VERSION } from "../agui-types";
import type { AGUIMessage } from "../agui-types";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/**
 * A v5 conversation as `examples/ai-chat` would have persisted it: a text
 * turn, a server tool round trip, a client tool round trip, and a final
 * assistant summary.
 */
const TOOL_CONVERSATION = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "what's the weather in Sydney?" }]
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Let me check." },
      {
        type: "tool-getWeather",
        toolCallId: "call-w1",
        state: "output-available",
        input: { city: "Sydney" },
        output: { city: "Sydney", temperature: 21, condition: "sunny" }
      }
    ]
  },
  {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "and what time is it here?" }]
  },
  {
    id: "a2",
    role: "assistant",
    parts: [
      {
        type: "tool-getUserTimezone",
        toolCallId: "call-t1",
        state: "output-available",
        input: {},
        output: { timezone: "Australia/Sydney", localTime: "14:03:00" }
      }
    ]
  },
  {
    id: "a3",
    role: "assistant",
    parts: [{ type: "text", text: "It's 21°C and sunny, and 14:03 local." }]
  }
];

/** A reasoning-model transcript, where reasoning precedes the answer. */
const REASONING_CONVERSATION = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "is 91 prime?" }]
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "91 = 7 × 13, so it is composite." },
      { type: "text", text: "No — 91 is 7 × 13." }
    ]
  }
];

/** A turn interrupted mid-tool-call, as an eviction would leave it. */
const INTERRUPTED_CONVERSATION = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "look up the docs" }]
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-browser_markdown",
        toolCallId: "call-b1",
        state: "input-available",
        input: { url: "https://developers.cloudflare.com" }
      }
    ]
  }
];

function rolesOf(messages: AGUIMessage[]) {
  return messages.map((m) => m.role);
}

function textOf(messages: AGUIMessage[]) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ("content" in m ? m.content : undefined))
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

/** Re-persist migrated output the way the agent writes rows back to SQL. */
function repersist(messages: AGUIMessage[]) {
  return messages.map((m) => ({
    _v: PERSISTED_MESSAGE_SCHEMA_VERSION,
    ...m
  }));
}

describe("agui-migration fixtures", () => {
  describe("tool conversation", () => {
    const migrated = autoTransformAGUIMessages(TOOL_CONVERSATION);

    it("expands each completed tool call into an assistant turn plus a tool result", () => {
      expect(rolesOf(migrated)).toEqual([
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
        "tool",
        "assistant"
      ]);
    });

    it("pairs every tool result with a preceding call of the same id", () => {
      const callIds = new Set(
        migrated.flatMap((m) =>
          m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : []
        )
      );
      const resultIds = migrated
        .filter((m) => m.role === "tool")
        .map((m) => m.toolCallId);

      expect(resultIds).toEqual(["call-w1", "call-t1"]);
      for (const id of resultIds) expect(callIds.has(id)).toBe(true);
    });

    it("preserves tool arguments and results as JSON-encoded strings", () => {
      const call = migrated.find(
        (m) => m.role === "assistant" && m.toolCalls?.length
      );
      const args = (
        call as { toolCalls: Array<{ function: { arguments: string } }> }
      ).toolCalls[0].function.arguments;
      expect(JSON.parse(args)).toEqual({ city: "Sydney" });

      const result = migrated.find((m) => m.role === "tool");
      expect(JSON.parse((result as { content: string }).content)).toEqual({
        city: "Sydney",
        temperature: 21,
        condition: "sunny"
      });
    });

    it("keeps user-visible text in conversation order", () => {
      expect(textOf(migrated)).toEqual([
        "what's the weather in Sydney?",
        "Let me check.",
        "and what time is it here?",
        "It's 21°C and sunny, and 14:03 local."
      ]);
    });

    it("carries the original message ids across", () => {
      const ids = migrated.map((m) => m.id);
      for (const original of ["u1", "a1", "u2", "a2", "a3"]) {
        expect(ids).toContain(original);
      }
    });

    it("assigns every message a non-empty id", () => {
      for (const m of migrated) {
        expect(typeof m.id).toBe("string");
        expect(m.id.length).toBeGreaterThan(0);
      }
    });

    it("migrates without warning", () => {
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("reasoning conversation", () => {
    const migrated = autoTransformAGUIMessages(REASONING_CONVERSATION);

    it("splits reasoning out ahead of the assistant answer", () => {
      expect(rolesOf(migrated)).toEqual(["user", "reasoning", "assistant"]);
    });

    it("keeps the reasoning text intact", () => {
      const reasoning = migrated.find((m) => m.role === "reasoning");
      expect((reasoning as { content?: string }).content).toBe(
        "91 = 7 × 13, so it is composite."
      );
    });
  });

  describe("interrupted turn", () => {
    const migrated = autoTransformAGUIMessages(INTERRUPTED_CONVERSATION);

    it("emits the call with no result, rather than fabricating one", () => {
      expect(rolesOf(migrated)).toEqual(["user", "assistant"]);
      expect(migrated.some((m) => m.role === "tool")).toBe(false);
    });

    it("still records the tool call so the turn can be resumed", () => {
      const assistant = migrated.find((m) => m.role === "assistant");
      const calls = (assistant as { toolCalls?: Array<{ id: string }> })
        .toolCalls;
      expect(calls).toHaveLength(1);
      expect(calls?.[0].id).toBe("call-b1");
    });
  });

  describe("idempotence", () => {
    it.each([
      ["tool conversation", TOOL_CONVERSATION],
      ["reasoning conversation", REASONING_CONVERSATION],
      ["interrupted turn", INTERRUPTED_CONVERSATION]
    ])("re-migrating persisted %s output is a no-op", (_name, fixture) => {
      const once = autoTransformAGUIMessages(fixture);
      const twice = autoTransformAGUIMessages(repersist(once));
      expect(twice).toEqual(once);
    });
  });

  describe("mixed-vintage history", () => {
    it("migrates legacy rows while passing AG-UI rows through untouched", () => {
      const mixed = [
        ...TOOL_CONVERSATION.slice(0, 1),
        {
          _v: PERSISTED_MESSAGE_SCHEMA_VERSION,
          id: "native-1",
          role: "assistant",
          content: "written after the cutover"
        }
      ];

      const migrated = autoTransformAGUIMessages(mixed);

      expect(rolesOf(migrated)).toEqual(["user", "assistant"]);
      expect(migrated[1]).toEqual({
        id: "native-1",
        role: "assistant",
        content: "written after the cutover"
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("skips an unrecognized row without dropping the rows around it", () => {
      const withGarbage = [
        TOOL_CONVERSATION[0],
        { id: "junk", somethingElse: true },
        TOOL_CONVERSATION[4]
      ];

      const migrated = autoTransformAGUIMessages(withGarbage);

      expect(rolesOf(migrated)).toEqual(["user", "assistant"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
