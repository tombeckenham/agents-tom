import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aguiBroadcastTransition,
  type AGUIBroadcastStreamState
} from "../agui-broadcast-state";
import type { AGUIMessage, AssistantMessage, UserMessage } from "../agui-types";

const IDLE: AGUIBroadcastStreamState = { status: "idle", accumulator: null };

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("aguiBroadcastTransition", () => {
  it("idle + RUN_STARTED transitions to streaming and broadcasts current snapshot", () => {
    const result = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }
    });
    expect(result.nextState.status).toBe("streaming");
    expect(result.broadcast).toEqual([]);
  });

  it("streaming + TEXT_MESSAGE_CONTENT broadcasts updated assistant message", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    const next = aguiBroadcastTransition(started.nextState, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m-1",
        delta: "hello"
      }
    });

    expect(next.nextState.status).toBe("streaming");
    expect(next.broadcast).not.toBeNull();
    const msgs = next.broadcast as AGUIMessage[];
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as AssistantMessage).content).toBe("hello");
  });

  it("streaming + RAW event suppresses broadcast (noop)", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    const raw = aguiBroadcastTransition(started.nextState, {
      type: "response",
      event: { type: "RAW", event: { provider: "x" } }
    });
    expect(raw.nextState.status).toBe("streaming");
    expect(raw.broadcast).toBeNull();
  });

  it("streaming + non-cf CUSTOM event suppresses broadcast (noop)", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    const custom = aguiBroadcastTransition(started.nextState, {
      type: "response",
      event: { type: "CUSTOM", name: "user.toast", value: { ok: true } }
    });
    expect(custom.broadcast).toBeNull();
    expect(custom.nextState.status).toBe("streaming");
  });

  it("streaming + end transitions to idle with null broadcast", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    const ended = aguiBroadcastTransition(started.nextState, { type: "end" });
    expect(ended.nextState.status).toBe("idle");
    expect(ended.nextState.accumulator).toBeNull();
    expect(ended.broadcast).toBeNull();
  });

  it("streaming + snapshot-request returns mergeInto over currentMessages without leaving streaming", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    const contentApplied = aguiBroadcastTransition(started.nextState, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m-1",
        delta: "hi"
      }
    });

    const existing: AGUIMessage[] = [
      { id: "u-1", role: "user", content: "hello" } satisfies UserMessage
    ];

    const snap = aguiBroadcastTransition(contentApplied.nextState, {
      type: "snapshot-request",
      currentMessages: existing
    });

    expect(snap.nextState.status).toBe("streaming");
    expect(snap.nextState).toBe(contentApplied.nextState);
    expect(snap.broadcast).not.toBeNull();
    const merged = snap.broadcast as AGUIMessage[];
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("u-1");
    expect(merged[1].id).toBe("m-1");
    expect((merged[1] as AssistantMessage).content).toBe("hi");
  });

  it("idle + reset stays idle with null broadcast", () => {
    const result = aguiBroadcastTransition(IDLE, { type: "reset" });
    expect(result.nextState.status).toBe("idle");
    expect(result.nextState.accumulator).toBeNull();
    expect(result.broadcast).toBeNull();
  });

  it("streaming + reset transitions to idle and drops accumulator", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    expect(started.nextState.status).toBe("streaming");

    const reset = aguiBroadcastTransition(started.nextState, { type: "reset" });
    expect(reset.nextState.status).toBe("idle");
    expect(reset.nextState.accumulator).toBeNull();
    expect(reset.broadcast).toBeNull();
  });

  it("malformed event is a no-op with current state preserved and a warn logged", () => {
    const started = aguiBroadcastTransition(IDLE, {
      type: "response",
      event: {
        type: "TEXT_MESSAGE_START",
        messageId: "m-1",
        role: "assistant"
      }
    });
    const before = started.nextState;
    const bogus = aguiBroadcastTransition(before, {
      type: "garbage"
    } as unknown as Parameters<typeof aguiBroadcastTransition>[1]);
    expect(bogus.nextState).toBe(before);
    expect(bogus.broadcast).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
