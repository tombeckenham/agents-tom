import { describe, it, expect } from "vitest";
import { AGUIRecoveryCodec, aguiRecoveryCodec } from "../agui-recovery-codec";
import { shouldCreditStreamProgress } from "../recovery-codec";
import type { AGUIEvent } from "../agui-types";

/** One stored SSE chunk body, the way `cf_ai_chat_stream_chunks` holds it. */
const chunk = (event: AGUIEvent): string => JSON.stringify(event);

describe("AGUIRecoveryCodec.isProgressChunk", () => {
  const codec = new AGUIRecoveryCodec();

  // The AG-UI half of the load-bearing list (#1637): a STARTED text/reasoning
  // segment and a SETTLED tool input/output are the only event types that
  // credit forward progress unconditionally. This set is the AG-UI mirror of
  // `AISDKRecoveryCodec`'s — a regression here silently shifts the recovery
  // no-progress window for AG-UI hosts only, which no cross-host test catches.
  const PROGRESS_TYPES = [
    "TEXT_MESSAGE_START",
    "REASONING_MESSAGE_START",
    "REASONING_START",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT"
  ];

  for (const type of PROGRESS_TYPES) {
    it(`credits "${type}" as progress`, () => {
      expect(codec.isProgressChunk(type)).toBe(true);
    });
  }

  // Deltas credit only through the time throttle (see `isStreamingContentChunk`);
  // ends, opens and lifecycle frames carry no produced content and never credit.
  // `TOOL_CALL_START` is deliberately here: a tool call is a milestone when its
  // input SETTLES (`TOOL_CALL_END`), not when the model starts naming it.
  const NON_PROGRESS_TYPES = [
    "TEXT_MESSAGE_CONTENT",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_CHUNK",
    "TOOL_CALL_ARGS",
    "TEXT_MESSAGE_END",
    "REASONING_MESSAGE_END",
    "REASONING_END",
    "TOOL_CALL_START",
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "STEP_STARTED",
    "STEP_FINISHED",
    "MESSAGES_SNAPSHOT",
    "STATE_SNAPSHOT",
    "CUSTOM",
    "RAW",
    "unknown-type"
  ];

  for (const type of NON_PROGRESS_TYPES) {
    it(`does not credit "${type}"`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }

  it("treats an undefined (non-JSON / typeless) body as non-progress", () => {
    expect(codec.isProgressChunk(undefined)).toBe(false);
  });

  it("exposes a shared stateless singleton", () => {
    expect(aguiRecoveryCodec).toBeInstanceOf(AGUIRecoveryCodec);
    expect(aguiRecoveryCodec.isProgressChunk("TEXT_MESSAGE_START")).toBe(true);
  });
});

describe("AGUIRecoveryCodec.isStreamingContentChunk", () => {
  const codec = new AGUIRecoveryCodec();

  // Mid-segment deltas: too granular to credit per token, but a long single
  // segment that emits only these must still register progress across crashes
  // (throttled). Disjoint from the milestone set above.
  const STREAMING_CONTENT_TYPES = [
    "TEXT_MESSAGE_CONTENT",
    "REASONING_MESSAGE_CONTENT",
    "TOOL_CALL_ARGS"
  ];

  for (const type of STREAMING_CONTENT_TYPES) {
    it(`classifies "${type}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(true);
    });
    it(`does not also classify "${type}" as a milestone`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }

  const NON_STREAMING_TYPES = [
    "TEXT_MESSAGE_START",
    "REASONING_MESSAGE_START",
    "REASONING_START",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    "TEXT_MESSAGE_END",
    "RUN_STARTED",
    "RUN_FINISHED",
    "unknown-type"
  ];

  for (const type of NON_STREAMING_TYPES) {
    it(`does not classify "${type}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(false);
    });
  }

  it("treats an undefined body as non-streaming-content", () => {
    expect(codec.isStreamingContentChunk(undefined)).toBe(false);
  });

  // `REASONING_MESSAGE_CHUNK` is a reducer-level convenience (start+content in
  // one frame) that the codec classifies as neither — it credits nothing. Pinned
  // so a future codec edit has to decide deliberately rather than by accident.
  it("classifies REASONING_MESSAGE_CHUNK as neither milestone nor streaming content", () => {
    expect(codec.isProgressChunk("REASONING_MESSAGE_CHUNK")).toBe(false);
    expect(codec.isStreamingContentChunk("REASONING_MESSAGE_CHUNK")).toBe(
      false
    );
  });
});

describe("AGUIRecoveryCodec through shouldCreditStreamProgress", () => {
  const openThrottle = { shouldCredit: () => true };
  const closedThrottle = { shouldCredit: () => false };

  it("credits an AG-UI milestone unconditionally — even when the throttle is closed", () => {
    expect(
      shouldCreditStreamProgress({
        codec: aguiRecoveryCodec,
        type: "TEXT_MESSAGE_START",
        throttle: closedThrottle,
        now: 0
      })
    ).toBe(true);
    expect(
      shouldCreditStreamProgress({
        codec: aguiRecoveryCodec,
        type: "TOOL_CALL_RESULT",
        throttle: closedThrottle,
        now: 0
      })
    ).toBe(true);
  });

  it("gates AG-UI deltas on the throttle", () => {
    expect(
      shouldCreditStreamProgress({
        codec: aguiRecoveryCodec,
        type: "TEXT_MESSAGE_CONTENT",
        throttle: openThrottle,
        now: 0
      })
    ).toBe(true);
    expect(
      shouldCreditStreamProgress({
        codec: aguiRecoveryCodec,
        type: "TEXT_MESSAGE_CONTENT",
        throttle: closedThrottle,
        now: 0
      })
    ).toBe(false);
  });

  it("never credits a lifecycle/typeless chunk, regardless of throttle", () => {
    for (const type of ["TEXT_MESSAGE_END", "RUN_FINISHED", undefined]) {
      expect(
        shouldCreditStreamProgress({
          codec: aguiRecoveryCodec,
          type,
          throttle: openThrottle,
          now: 0
        })
      ).toBe(false);
    }
  });
});

describe("AGUIRecoveryCodec.toRecoveryPartial", () => {
  const codec = new AGUIRecoveryCodec();

  it("returns an empty partial for no chunks", () => {
    expect(codec.toRecoveryPartial([])).toEqual({
      text: "",
      parts: [],
      hasSettledToolResults: false
    });
  });

  it("replays a text run into an assistant snapshot", () => {
    const partial = codec.toRecoveryPartial([
      chunk({ type: "RUN_STARTED", threadId: "t1", runId: "r1" }),
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      chunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "Hello " }),
      chunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "world" })
    ]);

    expect(partial.text).toBe("Hello world");
    // Interrupted mid-text (no TEXT_MESSAGE_END): the snapshot is partial.
    expect(partial.parts).toEqual([
      { id: "a1", role: "assistant", content: "Hello world", partial: true }
    ]);
    expect(partial.hasSettledToolResults).toBe(false);
  });

  // The continuation-recovery shape: the interrupted turn already produced a
  // full assistant + tool round-trip and was part-way into a SECOND assistant
  // message when the isolate died. `text` must be the concatenation of every
  // assistant segment (the engine hands it to `onChatRecovery.partialText`),
  // and `parts` must carry the whole ordered snapshot so the continuation
  // re-anchors onto it instead of regenerating from scratch.
  it("concatenates a multi-assistant snapshot and keeps the tool round-trip", () => {
    const partial = codec.toRecoveryPartial([
      chunk({ type: "RUN_STARTED", threadId: "t1", runId: "r1" }),
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      chunk({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a1",
        delta: "Let me check. "
      }),
      chunk({
        type: "TOOL_CALL_START",
        toolCallId: "tc-1",
        toolCallName: "getWeather",
        parentMessageId: "a1"
      }),
      chunk({ type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: '{"city":' }),
      chunk({ type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: '"Sydney"}' }),
      chunk({ type: "TOOL_CALL_END", toolCallId: "tc-1" }),
      chunk({
        type: "TOOL_CALL_RESULT",
        messageId: "tool-1",
        toolCallId: "tc-1",
        content: '{"temp":21}'
      }),
      chunk({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" }),
      chunk({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a2",
        delta: "It is 21"
      })
      // …interrupted here: no TEXT_MESSAGE_END, no RUN_FINISHED.
    ]);

    expect(partial.text).toBe("Let me check. It is 21");
    expect(partial.parts).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: "Let me check. ",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"Sydney"}' }
          }
        ]
      },
      {
        id: "tool-1",
        role: "tool",
        toolCallId: "tc-1",
        content: '{"temp":21}'
      },
      { id: "a2", role: "assistant", content: "It is 21", partial: true }
    ]);
    expect(partial.hasSettledToolResults).toBe(true);
  });

  // #1631: `hasSettledToolResults` is what stops a `{ persist: false }`
  // recovery return from dropping completed, often non-idempotent tool work.
  it("reports hasSettledToolResults only once a ToolMessage exists", () => {
    const upToToolEnd = [
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      chunk({
        type: "TOOL_CALL_START",
        toolCallId: "tc-1",
        toolCallName: "wipeDisk",
        parentMessageId: "a1"
      }),
      chunk({ type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: "{}" }),
      chunk({ type: "TOOL_CALL_END", toolCallId: "tc-1" })
    ];
    // Input settled but the tool never returned — nothing to protect yet.
    expect(codec.toRecoveryPartial(upToToolEnd).hasSettledToolResults).toBe(
      false
    );

    expect(
      codec.toRecoveryPartial([
        ...upToToolEnd,
        chunk({
          type: "TOOL_CALL_RESULT",
          messageId: "tool-1",
          toolCallId: "tc-1",
          content: "ok"
        })
      ]).hasSettledToolResults
    ).toBe(true);
  });

  it("omits assistant messages that carry no text from `text`", () => {
    // A tool-only assistant has `content: undefined`, not "" — it must not
    // contribute (nor throw) when the text is joined.
    const partial = codec.toRecoveryPartial([
      chunk({
        type: "TOOL_CALL_START",
        toolCallId: "tc-1",
        toolCallName: "ping",
        parentMessageId: "a1"
      }),
      chunk({ type: "TOOL_CALL_END", toolCallId: "tc-1" })
    ]);
    expect(partial.text).toBe("");
    expect(partial.parts).toHaveLength(1);
  });

  it("replays a reasoning run alongside the assistant text", () => {
    const partial = codec.toRecoveryPartial([
      chunk({
        type: "REASONING_MESSAGE_START",
        messageId: "r1",
        role: "reasoning"
      }),
      chunk({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: "r1",
        delta: "thinking"
      }),
      chunk({ type: "REASONING_MESSAGE_END", messageId: "r1" }),
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      chunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "answer" })
    ]);

    // Reasoning is carried in `parts` but is NOT assistant text.
    expect(partial.text).toBe("answer");
    expect(partial.parts).toEqual([
      { id: "r1", role: "reasoning", content: "thinking" },
      { id: "a1", role: "assistant", content: "answer", partial: true }
    ]);
  });

  // A truncated write, a half-flushed chunk, or an event the reducer does not
  // know must never abort the replay — the surrounding real content is what
  // recovery anchors on.
  it("skips malformed chunks and keeps replaying the rest", () => {
    const partial = codec.toRecoveryPartial([
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      "{not json",
      "",
      chunk({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a1",
        delta: "before "
      }),
      '{"type":"NOT_AN_AGUI_EVENT"}',
      chunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "after" })
    ]);

    expect(partial.text).toBe("before after");
    expect(partial.parts).toHaveLength(1);
  });

  it("adopts a MESSAGES_SNAPSHOT as the settled prefix", () => {
    const partial = codec.toRecoveryPartial([
      chunk({
        type: "MESSAGES_SNAPSHOT",
        messages: [
          { id: "u1", role: "user", content: "hi" },
          { id: "a1", role: "assistant", content: "earlier" }
        ]
      }),
      chunk({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" }),
      chunk({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: " now" })
    ]);

    expect(partial.text).toBe("earlier now");
    expect(partial.parts.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
  });
});
