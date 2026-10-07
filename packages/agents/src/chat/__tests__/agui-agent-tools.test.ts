import { describe, expect, it, vi } from "vitest";
import {
  applyAGUIAgentToolEvent,
  createAGUIAgentToolEventState,
  getAGUIAgentToolMessages,
  type AGUIAgentToolEvent
} from "../agui-agent-tools";
import type { AGUIEvent } from "../agui-types";

function encode(event: AGUIEvent): string {
  return JSON.stringify(event);
}

function frame(
  runId: string,
  sequence: number,
  body: string,
  overrides: Partial<AGUIAgentToolEvent> = {}
): AGUIAgentToolEvent {
  return {
    runId,
    parentToolCallId: "tool-1",
    body,
    sequence,
    ...overrides
  };
}

describe("AG-UI agent tool event reducer", () => {
  it("groups runs by parent tool call and preserves insertion order", () => {
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(state, frame("a", 0, ""));
    applyAGUIAgentToolEvent(state, frame("b", 0, ""));

    const messages = getAGUIAgentToolMessages(state);
    expect(messages.map((m) => m.runId)).toEqual(["a", "b"]);
    expect(messages.every((m) => m.parentToolCallId === "tool-1")).toBe(true);
  });

  it("applies opaque AGUIEvent JSON bodies into the per-run snapshot", () => {
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(
      state,
      frame(
        "r",
        0,
        encode({
          type: "TEXT_MESSAGE_START",
          messageId: "m-1",
          role: "assistant"
        })
      )
    );
    applyAGUIAgentToolEvent(
      state,
      frame(
        "r",
        1,
        encode({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m-1",
          delta: "hello"
        })
      )
    );

    const [message] = getAGUIAgentToolMessages(state);
    expect(message.messages).toHaveLength(1);
    const assistant = message.messages[0];
    expect(assistant.role).toBe("assistant");
    if (assistant.role === "assistant") {
      expect(assistant.content).toBe("hello");
    }
  });

  it("tracks unbound imperative runs separately from scoped ones", () => {
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(state, frame("scoped", 0, ""));
    applyAGUIAgentToolEvent(state, {
      runId: "imperative",
      body: "",
      sequence: 0
    });

    const messages = getAGUIAgentToolMessages(state);
    const scoped = messages.find((m) => m.runId === "scoped");
    const imperative = messages.find((m) => m.runId === "imperative");
    expect(scoped?.parentToolCallId).toBe("tool-1");
    expect(imperative?.parentToolCallId).toBeUndefined();
  });

  it("records distinct terminal states", () => {
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(
      state,
      frame("ok", 0, "", { terminal: "completed" })
    );
    applyAGUIAgentToolEvent(
      state,
      frame("bad", 0, "", { terminal: "error", error: "boom" })
    );
    applyAGUIAgentToolEvent(
      state,
      frame("cancel", 0, "", { terminal: "aborted" })
    );

    const byId = new Map(
      getAGUIAgentToolMessages(state).map((m) => [m.runId, m])
    );
    expect(byId.get("ok")?.state).toBe("completed");
    expect(byId.get("bad")?.state).toBe("error");
    expect(byId.get("bad")?.error).toBe("boom");
    expect(byId.get("cancel")?.state).toBe("aborted");
  });

  it("drops out-of-order sequences", () => {
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(
      state,
      frame(
        "r",
        5,
        encode({
          type: "TEXT_MESSAGE_START",
          messageId: "m",
          role: "assistant"
        })
      )
    );
    // Sequence 3 < 5, must be dropped — no CONTENT applied.
    applyAGUIAgentToolEvent(
      state,
      frame(
        "r",
        3,
        encode({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "x" })
      )
    );

    const [message] = getAGUIAgentToolMessages(state);
    const assistant = message.messages[0];
    if (assistant.role === "assistant") {
      expect(assistant.content).toBe("");
    }
    expect(message.lastSequence).toBe(5);
  });

  it("ignores events that arrive after a terminal", () => {
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(
      state,
      frame("r", 0, "", { terminal: "completed" })
    );
    applyAGUIAgentToolEvent(
      state,
      frame(
        "r",
        1,
        encode({
          type: "TEXT_MESSAGE_START",
          messageId: "m",
          role: "assistant"
        })
      )
    );

    const [message] = getAGUIAgentToolMessages(state);
    expect(message.state).toBe("completed");
    expect(message.messages).toEqual([]);
  });

  it("warns and skips malformed body JSON without losing sequence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createAGUIAgentToolEventState();
    applyAGUIAgentToolEvent(state, frame("r", 0, "{not json"));
    applyAGUIAgentToolEvent(
      state,
      frame(
        "r",
        1,
        encode({
          type: "TEXT_MESSAGE_START",
          messageId: "m",
          role: "assistant"
        })
      )
    );

    expect(warn).toHaveBeenCalled();
    const [message] = getAGUIAgentToolMessages(state);
    expect(message.lastSequence).toBe(1);
    expect(message.messages).toHaveLength(1);
    warn.mockRestore();
  });
});
