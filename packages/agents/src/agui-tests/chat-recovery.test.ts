/**
 * Durable chat recovery — fiber wrapping, cleanup, stash, and the
 * settled-work preservation invariants (#1631). Port of
 * `packages/ai-chat/src/tests/chat-recovery.test.ts` on the AG-UI shape.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { AGUIMessage } from "../chat/agui-types";
import type { ChatRecoveryConfig } from "../chat/lifecycle";
import {
  connectChatWS,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

/** RPC surface of `RecoveryAguiAgent` (complex types don't survive stub typing). */
interface RecoveryStub {
  setShouldThrow(value: boolean): Promise<void>;
  setStashData(data: unknown): Promise<void>;
  getStashResult(): Promise<{ success: boolean; error?: string } | null>;
  setRecoveryOverride(options: {
    persist?: boolean;
    continue?: boolean;
  }): Promise<void>;
  setChatRecoveryConfigForTest(config: ChatRecoveryConfig): Promise<void>;
  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): Promise<void>;
  getExhaustedContextsForTest(): Promise<
    Array<{
      recoveryRootRequestId: string;
      terminalMessage: string;
      partialText: string;
      reason: string;
      streamId: string;
      createdAt: number;
    }>
  >;
  getRecoveryContexts(): Promise<
    Array<{
      streamId: string;
      requestId: string;
      partialText: string;
      recoveryData: unknown;
      recoveryRootRequestId: string;
    }>
  >;
  getPersistedMessages(): Promise<AGUIMessage[]>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  getAbortControllerCount(): Promise<number>;
  getOnChatMessageCallCount(): Promise<number>;
  waitForIdleForTest(): Promise<void>;
  persistMessages(messages: AGUIMessage[]): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs?: number
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
  seedIncidentForTest(incident: {
    incidentId: string;
    requestId: string;
    recoveryKind: "retry" | "continue";
    attempt: number;
    maxAttempts: number;
    status: string;
    firstSeenAt: number;
    lastAttemptAt: number;
  }): Promise<void>;
  getChatRecoveryIncidentsForTest(): Promise<unknown[]>;
  saveSyntheticUserMessage(
    text: string
  ): Promise<{ requestId: string; status: string }>;
}

async function getTestAgent(room: string): Promise<RecoveryStub> {
  return (await getAgentByName(
    env.RecoveryAguiAgent,
    room
  )) as unknown as RecoveryStub;
}

/** AG-UI text-run chunk bodies for an interrupted stream. */
function makeChunks(
  texts: string[],
  messageId = "orphan-assistant"
): Array<{ body: string; index: number }> {
  const chunks: Array<{ body: string; index: number }> = [
    {
      body: JSON.stringify({
        type: "TEXT_MESSAGE_START",
        messageId,
        role: "assistant"
      }),
      index: 0
    }
  ];
  texts.forEach((text, i) => {
    chunks.push({
      body: JSON.stringify({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: text
      }),
      index: i + 1
    });
  });
  return chunks;
}

/** Settled tool work: a completed tool call plus its result message. */
function makeSettledToolChunks(
  messageId: string,
  toolCallId: string
): Array<{ body: string; index: number }> {
  return [
    {
      body: JSON.stringify({
        type: "TEXT_MESSAGE_START",
        messageId,
        role: "assistant"
      }),
      index: 0
    },
    {
      body: JSON.stringify({
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: "writeFile",
        parentMessageId: messageId
      }),
      index: 1
    },
    {
      body: JSON.stringify({
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: '{"path":"out.txt"}'
      }),
      index: 2
    },
    { body: JSON.stringify({ type: "TOOL_CALL_END", toolCallId }), index: 3 },
    {
      body: JSON.stringify({
        type: "TOOL_CALL_RESULT",
        messageId: `tool-${toolCallId}`,
        toolCallId,
        content: JSON.stringify({ bytesWritten: 12 })
      }),
      index: 4
    },
    {
      body: JSON.stringify({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: "did real work"
      }),
      index: 5
    }
  ];
}

function assistantText(messages: AGUIMessage[]): string {
  return messages
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("");
}

describe("chatRecovery (AG-UI)", () => {
  it("persists messages and cleans up fibers after a WebSocket chat turn", async () => {
    const room = crypto.randomUUID();
    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req-1", [userMessage("user-1", "Hello")]);
    await rec.waitFor(isDoneFrame("req-1"));

    const stub = await getTestAgent(room);
    await stub.waitForIdleForTest();

    const messages = await stub.getPersistedMessages();
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(assistantText(messages)).toContain("Continued response.");

    expect(await stub.getActiveFibers()).toHaveLength(0);
    expect(await stub.getOnChatMessageCallCount()).toBe(1);

    ws.close(1000);
  });

  it("uses durable recovery despite a legacy runtime chatRecovery=false", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    // Previously-compiled JS could still assign `false`; the resolver treats
    // it as the defaults, so turns stay fiber-wrapped.
    await stub.setChatRecoveryConfigForTest(
      false as unknown as ChatRecoveryConfig
    );

    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    const rec = recordFrames(ws);
    sendChatRequest(ws, "req-1", [userMessage("user-1", "Hello")]);
    await rec.waitFor(isDoneFrame("req-1"));
    await stub.waitForIdleForTest();

    const messages = await stub.getPersistedMessages();
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(await stub.getActiveFibers()).toHaveLength(0);
    expect(await stub.getRecoveryContexts()).toHaveLength(0);

    ws.close(1000);
  });

  it("cleans up fibers and abort controllers when onChatMessage throws", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setShouldThrow(true);

    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    const rec = recordFrames(ws);
    sendChatRequest(ws, "req-err", [userMessage("user-1", "Hello")]);
    await rec.waitFor((f) => isDoneFrame("req-err")(f) && f.error === true);
    await stub.waitForIdleForTest();

    expect(await stub.getOnChatMessageCallCount()).toBe(1);
    expect(await stub.getActiveFibers()).toHaveLength(0);
    expect(await stub.getAbortControllerCount()).toBe(0);

    ws.close(1000);
  });

  it("still works for subsequent requests after an error", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    const rec = recordFrames(ws);

    await stub.setShouldThrow(true);
    sendChatRequest(ws, "req-fail", [userMessage("user-1", "Hello")]);
    await rec.waitFor((f) => isDoneFrame("req-fail")(f) && f.error === true);
    await stub.waitForIdleForTest();
    expect(await stub.getAbortControllerCount()).toBe(0);

    await stub.setShouldThrow(false);
    sendChatRequest(ws, "req-ok", [userMessage("user-1", "Hello")]);
    await rec.waitFor(isDoneFrame("req-ok"));
    await stub.waitForIdleForTest();

    expect(await stub.getOnChatMessageCallCount()).toBe(2);
    const messages = await stub.getPersistedMessages();
    expect(
      messages.filter((m) => m.role === "assistant").length
    ).toBeGreaterThanOrEqual(1);
    expect(await stub.getActiveFibers()).toHaveLength(0);
    expect(await stub.getAbortControllerCount()).toBe(0);

    ws.close(1000);
  });

  it("handles sequential chat turns without fiber leaks", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    const rec = recordFrames(ws);

    const msg1 = userMessage("user-1", "First message");
    sendChatRequest(ws, "req-1", [msg1]);
    await rec.waitFor(isDoneFrame("req-1"));
    await stub.waitForIdleForTest();

    const midMessages = await stub.getPersistedMessages();
    const firstAssistant = midMessages.find((m) => m.role === "assistant")!;

    const msg2 = userMessage("user-2", "Second message");
    sendChatRequest(ws, "req-2", [msg1, firstAssistant, msg2]);
    await rec.waitFor(isDoneFrame("req-2"));
    await stub.waitForIdleForTest();

    const messages = await stub.getPersistedMessages();
    expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(await stub.getActiveFibers()).toHaveLength(0);
    expect(await stub.getOnChatMessageCallCount()).toBe(2);

    ws.close(1000);
  });

  it("stash() is callable from onChatMessage during a durable chat turn", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setStashData({ responseId: "resp-123", provider: "openai" });

    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    const rec = recordFrames(ws);
    sendChatRequest(ws, "req-1", [userMessage("user-1", "Hello")]);
    await rec.waitFor(isDoneFrame("req-1"));
    await stub.waitForIdleForTest();

    const stashResult = await stub.getStashResult();
    expect(stashResult).not.toBeNull();
    expect(stashResult!.success).toBe(true);
    expect(await stub.getActiveFibers()).toHaveLength(0);

    ws.close(1000);
  });

  it("stashed data round-trips through fiber recovery via onChatRecovery", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setRecoveryOverride({ continue: false });
    await stub.persistMessages([userMessage("user-1", "Hello")]);

    const stashedData = { responseId: "openai-resp-xyz", provider: "openai" };
    await stub.insertInterruptedStream(
      "stream-stash",
      "req-stash",
      makeChunks(["Partial with stash"], "assistant-stash")
    );
    await stub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-stash",
      stashedData
    );
    await stub.triggerFiberRecovery();

    const contexts = await stub.getRecoveryContexts();
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    const lastCtx = contexts[contexts.length - 1];
    expect(lastCtx.recoveryData).toEqual(stashedData);
    expect(lastCtx.partialText).toBe("Partial with stash");
    expect(lastCtx.streamId).toBe("stream-stash");
  });

  describe("recovery preserves settled work (#1631)", () => {
    it("persists the settled partial when the recovery budget is exhausted", async () => {
      const room = crypto.randomUUID();
      const stub = await getTestAgent(room);
      await stub.setChatRecoveryConfigForTest({ maxAttempts: 1 });

      await stub.insertInterruptedStream(
        "stream-exh",
        "req-exh",
        makeSettledToolChunks("a-exh", "tc-exh")
      );
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-exh");
      // Seed an incident already at the cap, aged past the alarm-debounce
      // window, so this wake counts as a genuine new attempt and exhausts.
      await stub.seedIncidentForTest({
        incidentId: "req-exh:",
        requestId: "req-exh",
        recoveryKind: "continue",
        attempt: 1,
        maxAttempts: 1,
        status: "scheduled",
        firstSeenAt: Date.now() - 60_000,
        lastAttemptAt: Date.now() - 60_000
      });

      await stub.triggerFiberRecovery();

      // Exhaustion seals the turn but must NOT discard the settled partial.
      const messages = await stub.getPersistedMessages();
      const assistant = messages.filter((m) => m.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistantText(messages)).toContain("did real work");
      expect(
        messages.some((m) => m.role === "tool" && m.toolCallId === "tc-exh")
      ).toBe(true);

      const incidents = (await stub.getChatRecoveryIncidentsForTest()) as [
        { status: string }
      ];
      expect(incidents[0]?.status).toBe("exhausted");
    });

    it("never drops settled tool results on { persist: false }", async () => {
      const room = crypto.randomUUID();
      const stub = await getTestAgent(room);
      await stub.setRecoveryOverride({ persist: false, continue: false });

      await stub.insertInterruptedStream(
        "stream-settled",
        "req-settled",
        makeSettledToolChunks("a-settled", "tc-settled")
      );
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-settled");
      await stub.triggerFiberRecovery();

      // Settled work is preserved regardless of `persist: false`.
      const messages = await stub.getPersistedMessages();
      expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
      expect(
        messages.some((m) => m.role === "tool" && m.toolCallId === "tc-settled")
      ).toBe(true);
    });

    it("honors { persist: false } for a text-only partial with no settled work", async () => {
      const room = crypto.randomUUID();
      const stub = await getTestAgent(room);
      await stub.setRecoveryOverride({ persist: false, continue: false });

      await stub.insertInterruptedStream(
        "stream-textonly",
        "req-textonly",
        makeChunks(["just prose, no tools"], "a-textonly")
      );
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-textonly");
      await stub.triggerFiberRecovery();

      const messages = await stub.getPersistedMessages();
      expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    });
  });

  it("exposes recoveryRootRequestId on the onChatRecovery context", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setRecoveryOverride({ continue: false });

    await stub.insertInterruptedStream(
      "stream-root",
      "req-root",
      makeChunks(["partial"], "a-root")
    );
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-root");
    await stub.triggerFiberRecovery();

    const contexts = await stub.getRecoveryContexts();
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    expect(contexts[0]?.recoveryRootRequestId).toBe("req-root");
  });

  it("onExhausted context carries terminalMessage, recoveryRootRequestId, and the partial", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.enableExhaustedCaptureForTest(1);

    await stub.insertInterruptedStream(
      "stream-exctx",
      "req-exctx",
      makeChunks(["work before giving up"], "a-exctx")
    );
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-exctx");
    await stub.seedIncidentForTest({
      incidentId: "req-exctx:",
      requestId: "req-exctx",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 1,
      status: "scheduled",
      firstSeenAt: Date.now() - 60_000,
      lastAttemptAt: Date.now() - 60_000
    });

    await stub.triggerFiberRecovery();

    const exhausted = await stub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    const ctx = exhausted[0];
    expect(ctx.recoveryRootRequestId).toBe("req-exctx");
    expect(ctx.terminalMessage.length).toBeGreaterThan(0);
    expect(ctx.partialText).toContain("work before giving up");
    expect(ctx.reason).toBe("max_attempts_exceeded");
    expect(ctx.streamId).toBe("stream-exctx");
    expect(typeof ctx.createdAt).toBe("number");
  });

  it("wraps a saveMessages-triggered turn in a fiber and cleans up", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    const result = await stub.saveSyntheticUserMessage(
      "Hello from programmatic turn"
    );
    await stub.waitForIdleForTest();
    expect(result.status).toBe("completed");

    const messages = await stub.getPersistedMessages();
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(assistantText(messages)).toContain("Continued response.");
    expect(await stub.getActiveFibers()).toHaveLength(0);
    expect(await stub.getOnChatMessageCallCount()).toBe(1);
  });
});
