/**
 * Durable chat recovery — incident budgets, stable-state give-up, the
 * "recovering…" status (#1620), and the durable terminal record (#1645).
 * Port of `packages/ai-chat/src/tests/durable-chat-recovery.test.ts` on the
 * AG-UI shape.
 *
 * The legacy file has 64 legs; 36 are ported here. What is NOT, and why:
 * - Terminal replay to a reconnecting client (#1645 / #1575) — moved wholesale
 *   to `resume-handshake.test.ts`, which owns that wiring.
 * - The stall-watchdog block (#1626) — moved to `stall-watchdog.test.ts`.
 * - The #1691 orphan-merge matrix (which assistant message a recovered partial
 *   merges into: new turn vs continuation, missing provider id, legacy rows) —
 *   NOT PORTED, and not covered elsewhere for AG-UI. It is the largest
 *   remaining gap in this file.
 * - Alarm/give-up transients (#1730 deferred terminal write, superseded
 *   isolate, storage failure during seal) — these moved into the shared,
 *   host-agnostic engine and are unit-tested in
 *   `chat/__tests__/recovery-engine.test.ts`; re-driving them per host would
 *   test the same code twice.
 * - Incident-scoring legs (#1628 compaction, sub-agent N9 crediting, the
 *   work-budget wall clock) — likewise owned by
 *   `chat/__tests__/recovery-incident.test.ts` and, for the AG-UI chunk
 *   vocabulary, `chat/__tests__/agui-recovery-codec.test.ts`.
 * - Assertions written against `UIMessage` parts (`input-streaming` /
 *   `output-available` tool-part states, `persist: false` part skipping,
 *   `_getPartialStreamText` part shapes) — not portable as written: AG-UI
 *   models those states as separate `ToolMessage` rows. The AG-UI equivalents
 *   live in `tool-call-persistence.test.ts` and
 *   `chat/__tests__/repair-transcript.test.ts`.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { AGUIMessage } from "../chat/agui-types";
import type { ChatRecoveryConfig } from "../chat/lifecycle";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import { connectChatWS, recordFrames } from "./test-utils";

/** RPC surface of `RecoveryAguiAgent` (complex types don't survive stub typing). */
interface RecoveryStub {
  setRecoveryOverride(options: {
    persist?: boolean;
    continue?: boolean;
  }): Promise<void>;
  setRecoveryShouldThrowForTest(shouldThrow: boolean): Promise<void>;
  setChatRecoveryConfigForTest(config: ChatRecoveryConfig): Promise<void>;
  setShouldKeepRecoveringForTest(keepRecovering: boolean): Promise<void>;
  enableThrowingOnExhaustedForTest(
    maxAttempts: number,
    terminalMessage: string
  ): Promise<void>;
  getOnExhaustedCallsForTest(): Promise<number>;
  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): Promise<void>;
  getExhaustedContextsForTest(): Promise<
    Array<{
      recoveryRootRequestId: string;
      recoveryKind: "retry" | "continue";
      reason: string;
      terminalMessage: string;
    }>
  >;
  setForceStableTimeoutForTest(value: boolean): Promise<void>;
  setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: Array<{ name: string; description?: string }>
  ): Promise<void>;
  getRecoveryContexts(): Promise<
    Array<{
      streamId: string;
      requestId: string;
      partialText: string;
      recoveryData: unknown;
      createdAt: number;
      lastBody?: Record<string, unknown>;
    }>
  >;
  getPersistedMessages(): Promise<AGUIMessage[]>;
  getOnChatMessageCallCount(): Promise<number>;
  getOnChatMessageBodies(): Promise<Array<Record<string, unknown> | undefined>>;
  getOnChatMessageClientTools(): Promise<
    Array<Array<{ name: string; description?: string }> | undefined>
  >;
  getScheduleCountForCallback(callback: string): Promise<number>;
  waitForIdleForTest(): Promise<void>;
  continueLastTurnForTest(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }>;
  continueLastTurnSupersededForTest(): Promise<{
    requestId: string;
    status: string;
  }>;
  persistMessages(messages: AGUIMessage[]): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs?: number
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
  runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  runChatRecoveryRetryDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  preScheduleRecoveryRetryForTest(data: Record<string, unknown>): Promise<void>;
  runScheduledRecoveryContinueForTest(): Promise<void>;
  runScheduledRecoveryRetryForTest(): Promise<void>;
  beginIncidentForTest(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: "retry" | "continue";
    nowMs?: number;
  }): Promise<{
    incidentId: string;
    attempt: number;
    exhausted: boolean;
    reason?: string;
  }>;
  ageIncidentForTest(incidentId: string, ms: number): Promise<void>;
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
  getIncidentForTest(incidentId: string): Promise<{
    attempt: number;
    status: string;
    reason?: string;
  } | null>;
  updateIncidentForTest(
    incidentId: string,
    status: string,
    reason?: string
  ): Promise<void>;
  bumpRecoveryProgressForTest(): Promise<void>;
  probeProgressReconnectImmunityForTest(): Promise<{
    start: number;
    afterFlush: number;
    afterPersist: number;
  }>;
  getChatRecoveringForTest(): Promise<{ requestId?: string } | null>;
  getRecoveringConnectFrameForTest(): Promise<Record<string, unknown> | null>;
  getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null>;
  persistPendingToolCallForTest(
    messageId: string,
    toolName: string
  ): Promise<void>;
  driveSuccessfulTurnForTest(): Promise<string>;
  driveAbortedTurnForTest(): Promise<string>;
  driveErroredTurnForTest(message: string): Promise<string>;
}

async function getTestAgent(room: string): Promise<RecoveryStub> {
  return (await getAgentByName(
    env.RecoveryAguiAgent,
    room
  )) as unknown as RecoveryStub;
}

/**
 * Reconnect a fresh client to `room` and run the standard resume probe.
 * Returns the `STREAM_RESUME_NONE` reason, or `"resuming"` if the server
 * offered a stream instead — which, once the terminal record is gone, would
 * mean a stale terminal is still queued for replay (#1645).
 */
async function probeResumeReason(room: string): Promise<string> {
  const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
  const rec = recordFrames(ws);
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
      probeId: "probe-after-clear"
    })
  );
  const frame = await rec.waitFor(
    (f) =>
      f.probeId === "probe-after-clear" &&
      (f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE ||
        f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING)
  );
  ws.close(1000);
  return frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
    ? (frame.reason ?? "")
    : "resuming";
}

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

describe("onChatRecovery (AG-UI)", () => {
  it("fires onChatRecovery for an orphaned stream's fiber with createdAt", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setRecoveryOverride({ continue: false });

    const before = Date.now();
    await stub.insertInterruptedStream(
      "stream-createdat",
      "req-createdat",
      makeChunks(["Hello ", "world"])
    );
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-createdat");
    await stub.triggerFiberRecovery();

    const contexts = await stub.getRecoveryContexts();
    const match = contexts.find((c) => c.requestId === "req-createdat");
    expect(match).toBeDefined();
    expect(match!.streamId).toBe("stream-createdat");
    expect(match!.partialText).toBe("Hello world");
    expect(typeof match!.createdAt).toBe("number");
    expect(match!.createdAt).toBeGreaterThanOrEqual(before);
    expect(match!.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("passes incident metadata and exhausts after maxAttempts", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({
      maxAttempts: 1,
      terminalMessage: "gave up"
    });
    await stub.setRecoveryOverride({ continue: false });

    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-cap");
    await stub.triggerFiberRecovery();

    const contexts = await stub.getRecoveryContexts();
    expect(contexts.at(-1)).toMatchObject({
      incidentId: "req-cap:",
      attempt: 1,
      maxAttempts: 1,
      recoveryKind: "continue"
    });

    // Age past the alarm-debounce window so the second recovery counts as a
    // genuinely separate attempt (#1637).
    await stub.ageIncidentForTest("req-cap:", 40_000);
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-cap");
    await stub.triggerFiberRecovery();

    const incidents = (await stub.getChatRecoveryIncidentsForTest()) as Array<{
      attempt: number;
      maxAttempts: number;
      status: string;
      reason?: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      attempt: 2,
      maxAttempts: 1,
      status: "exhausted",
      reason: "max_attempts_exceeded"
    });
  });

  it("resets the attempt budget when recovery makes forward progress", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const baseInput = {
      requestId: "req-prog",
      recoveryRootRequestId: "req-prog",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    // Space attempts >30s apart so alarm-debounce doesn't collapse them.
    let t = 1_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...baseInput, nowMs };
    };

    expect((await stub.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await stub.beginIncidentForTest(at())).attempt).toBe(2);

    // Forward progress resets the budget — the deploy-churn fix.
    await stub.bumpRecoveryProgressForTest();
    const afterProgress = await stub.beginIncidentForTest(at());
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);

    // Without further progress it climbs again and exhausts at the cap.
    expect((await stub.beginIncidentForTest(at())).attempt).toBe(2);
    const exhausted = await stub.beginIncidentForTest(at());
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.exhausted).toBe(true);
  });

  it("seals a content-emitting runaway via the work budget", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({
      maxAttempts: 100,
      maxRecoveryWork: 2
    });

    const base = {
      requestId: "req-runaway",
      recoveryRootRequestId: "req-runaway",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 5_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    expect((await stub.beginIncidentForTest(at())).attempt).toBe(1);

    await stub.bumpRecoveryProgressForTest();
    await stub.bumpRecoveryProgressForTest();
    await stub.bumpRecoveryProgressForTest();
    const next = await stub.beginIncidentForTest(at());
    expect(next.exhausted).toBe(true);
    expect(next.reason).toBe("work_budget_exceeded");
  });

  it("seals when the shouldKeepRecovering predicate returns false (recovery_aborted)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setShouldKeepRecoveringForTest(false);

    const base = {
      requestId: "req-abort",
      recoveryRootRequestId: "req-abort",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 6_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    // First detection opens the incident (predicate not consulted on open).
    expect((await stub.beginIncidentForTest(at())).exhausted).toBe(false);

    const next = await stub.beginIncidentForTest(at());
    expect(next.exhausted).toBe(true);
    expect(next.reason).toBe("recovery_aborted");
  });

  it("seals an incident after the no-progress window even below the attempt cap (#1637)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({ maxAttempts: 100 });

    const base = {
      requestId: "req-np",
      recoveryRootRequestId: "req-np",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 2_000_000;
    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    const past = await stub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 6 * 60 * 1000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("honors a custom noProgressTimeoutMs override", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({
      maxAttempts: 100,
      noProgressTimeoutMs: 60_000
    });

    const base = {
      requestId: "req-np-cfg",
      recoveryRootRequestId: "req-np-cfg",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 8_000_000;
    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    const past = await stub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 90_000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("does NOT seal on no-progress while a CLIENT interaction is pending (HITL)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({
      maxAttempts: 2,
      noProgressTimeoutMs: 60_000
    });

    // `chooseOption` is a registered CLIENT tool; an assistant parked on its
    // unresolved tool call is waiting on the human, not stuck.
    await stub.setRequestContextForTest(undefined, [{ name: "chooseOption" }]);
    await stub.persistPendingToolCallForTest("assistant-hitl", "chooseOption");

    const base = {
      requestId: "req-hitl",
      recoveryRootRequestId: "req-hitl",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 6_000_000;
    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    const later = await stub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 10 * 60 * 1000
    });
    expect(later.exhausted).toBe(false);
    expect(later.reason).toBeUndefined();
  });

  it("STILL seals a dead SERVER-tool orphan on no-progress (exemption is client-only)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({
      maxAttempts: 100,
      noProgressTimeoutMs: 60_000
    });

    // `previewTool` is NOT a registered client tool — its unresolved tool call
    // is a dead server orphan and must not get the HITL exemption.
    await stub.setRequestContextForTest(undefined, [{ name: "chooseOption" }]);
    await stub.persistPendingToolCallForTest("assistant-server", "previewTool");

    const base = {
      requestId: "req-srv",
      recoveryRootRequestId: "req-srv",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 7_000_000;
    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);
    const past = await stub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 90_000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("collapses a rollout's reconnect storm into one attempt via debounce (#1637)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-db",
      recoveryRootRequestId: "req-db",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 3_000_000;

    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 })).attempt
    ).toBe(1);
    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 + 5_000 })).attempt
    ).toBe(1);
    expect(
      (await stub.beginIncidentForTest({ ...base, nowMs: t0 + 20_000 })).attempt
    ).toBe(1);
    const later = await stub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 60_000
    });
    expect(later.attempt).toBe(2);
    expect(later.exhausted).toBe(false);
  });

  it("advances progress on streamed content but not on an orphan re-persist (#1637)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    const { start, afterFlush, afterPersist } =
      await stub.probeProgressReconnectImmunityForTest();

    expect(afterFlush).toBeGreaterThan(start);
    expect(afterPersist).toBe(afterFlush);
  });

  it("shares one attempt budget when an incident flips between retry and continue", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    const first = await stub.beginIncidentForTest({
      requestId: "req-flip",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "retry",
      nowMs: 1_000_000
    });
    const second = await stub.beginIncidentForTest({
      requestId: "req-flip-2",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "continue",
      nowMs: 1_040_000
    });

    expect(first.incidentId).toBe("req-flip:user-flip");
    expect(second.incidentId).toBe("req-flip:user-flip");
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    expect(await stub.getChatRecoveryIncidentsForTest()).toHaveLength(1);
  });

  it("deletes the incident record once recovery completes", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    const incident = await stub.beginIncidentForTest({
      requestId: "req-done",
      recoveryRootRequestId: "req-done",
      latestUserMessageId: "user-done",
      recoveryKind: "continue"
    });
    expect(await stub.getChatRecoveryIncidentsForTest()).toHaveLength(1);

    await stub.updateIncidentForTest(incident.incidentId, "completed");
    expect(await stub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
  });

  it("sweeps incidents inactive past the TTL on the next incident", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    const staleAt = Date.now() - 2 * 60 * 60 * 1000;
    await stub.seedIncidentForTest({
      incidentId: "stale:user",
      requestId: "stale",
      recoveryKind: "continue",
      attempt: 3,
      maxAttempts: 6,
      status: "failed",
      firstSeenAt: staleAt,
      lastAttemptAt: staleAt
    });
    expect(await stub.getChatRecoveryIncidentsForTest()).toHaveLength(1);

    await stub.beginIncidentForTest({
      requestId: "req-fresh",
      recoveryRootRequestId: "req-fresh",
      latestUserMessageId: "user-fresh",
      recoveryKind: "continue"
    });

    const incidents = (await stub.getChatRecoveryIncidentsForTest()) as Array<{
      incidentId: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].incidentId).toBe("req-fresh:user-fresh");
  });

  it("marks the incident failed when onChatRecovery throws", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setRecoveryShouldThrowForTest(true);

    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-throw");
    await stub.triggerFiberRecovery();

    const incidents = (await stub.getChatRecoveryIncidentsForTest()) as Array<{
      status: string;
      reason?: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("failed");
    expect(incidents[0].reason).toContain("onChatRecovery boom");
  });

  it("still delivers terminal UX when onExhausted throws", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.enableThrowingOnExhaustedForTest(1, "gave up");
    await stub.setRecoveryOverride({ continue: false });

    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-ex-throw");
    await stub.triggerFiberRecovery();
    await stub.ageIncidentForTest("req-ex-throw:", 40_000);
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-ex-throw");
    await stub.triggerFiberRecovery();

    expect(await stub.getOnExhaustedCallsForTest()).toBe(1);
    const incidents = (await stub.getChatRecoveryIncidentsForTest()) as Array<{
      status: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("exhausted");
  });

  it("persists the partial by default (persist !== false)", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setRecoveryOverride({ continue: false });

    await stub.persistMessages([{ id: "user-1", role: "user", content: "Hi" }]);
    await stub.insertInterruptedStream(
      "stream-persist",
      "req-persist",
      makeChunks(["Partial response"], "assistant-persist")
    );
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-persist");
    await stub.triggerFiberRecovery();

    const messages = await stub.getPersistedMessages();
    const assistant = messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].id).toBe("assistant-persist");
  });

  it("does not double-recover when _checkRunFibers runs from both onStart and alarm", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);
    await stub.setRecoveryOverride({ continue: false });

    await stub.persistMessages([{ id: "user-1", role: "user", content: "Hi" }]);
    await stub.insertInterruptedStream(
      "stream-double",
      "req-double",
      makeChunks(["Double recovery text"], "assistant-double")
    );
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-double");

    await stub.triggerFiberRecovery();
    await stub.triggerFiberRecovery();

    const contexts = await stub.getRecoveryContexts();
    const doubleContexts = contexts.filter(
      (c) => c.streamId === "stream-double"
    );
    expect(doubleContexts).toHaveLength(1);
    expect(doubleContexts[0].partialText).toBe("Double recovery text");

    const messages = await stub.getPersistedMessages();
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("retries a pre-stream interrupted user turn by default", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    await stub.persistMessages([
      { id: "user-retry", role: "user", content: "Retry this" }
    ]);

    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-retry", {
      __cfAIChatFiberSnapshot: {
        kind: "ai-chat-turn",
        version: 1,
        requestId: "req-retry",
        continuation: false,
        latestMessageId: "user-retry",
        latestMessageRole: "user",
        latestUserMessageId: "user-retry",
        startedAt: Date.now(),
        lastBody: { mode: "snapshot" }
      },
      user: { responseId: "pre-stream" }
    });

    await stub.triggerFiberRecovery();
    const retryScheduleCount =
      await stub.getScheduleCountForCallback("_chatRecoveryRetry");
    if (retryScheduleCount > 0) {
      await stub.runScheduledRecoveryRetryForTest();
    }
    await stub.waitForIdleForTest();

    const contexts = await stub.getRecoveryContexts();
    const ctx = contexts[contexts.length - 1];
    expect(ctx.streamId).toBe("");
    expect(ctx.partialText).toBe("");
    expect(ctx.recoveryData).toEqual({ responseId: "pre-stream" });
    expect(ctx.lastBody).toEqual({ mode: "snapshot" });

    const messages = await stub.getPersistedMessages();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(messages[0].id).toBe("user-retry");
    expect(await stub.getOnChatMessageBodies()).toEqual([{ mode: "snapshot" }]);
  });

  it("continues a partial stream with request context from the recovered snapshot", async () => {
    const room = crypto.randomUUID();
    const stub = await getTestAgent(room);

    await stub.persistMessages([
      { id: "user-continue", role: "user", content: "Continue this" }
    ]);
    await stub.insertInterruptedStream(
      "stream-continue",
      "req-continue",
      makeChunks(["Partial answer"], "assistant-continue")
    );
    await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-continue", {
      __cfAIChatFiberSnapshot: {
        kind: "ai-chat-turn",
        version: 1,
        requestId: "req-continue",
        continuation: false,
        latestMessageId: "user-continue",
        latestMessageRole: "user",
        latestUserMessageId: "user-continue",
        startedAt: Date.now(),
        lastBody: { mode: "snapshot" },
        lastClientTools: [{ name: "snapshotTool", description: "Snapshot" }]
      },
      user: null
    });

    await stub.triggerFiberRecovery();
    const continueScheduleCount = await stub.getScheduleCountForCallback(
      "_chatRecoveryContinue"
    );

    // Stale in-memory context the snapshot must override.
    await stub.setRequestContextForTest({ mode: "stale" }, [
      { name: "staleTool", description: "Stale" }
    ]);
    if (continueScheduleCount > 0) {
      await stub.runScheduledRecoveryContinueForTest();
    }
    await stub.waitForIdleForTest();

    expect(await stub.getOnChatMessageBodies()).toEqual([{ mode: "snapshot" }]);
    expect(await stub.getOnChatMessageClientTools()).toEqual([
      [{ name: "snapshotTool", description: "Snapshot" }]
    ]);
  });

  it("reschedules a continuation that times out waiting for stable state, within budget", async () => {
    const stub = await getTestAgent(`stable-retry-${crypto.randomUUID()}`);
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-retry",
      requestId: "root-retry",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const continueData = {
      incidentId: "inc-retry",
      originalRequestId: "root-retry",
      targetAssistantId: "a-x"
    };
    // Simulate the executing one-shot row `alarm()` deletes after return.
    await stub.preScheduleRecoveryContinueForTest(continueData);
    await stub.runChatRecoveryContinueDirectForTest(continueData);

    // The reschedule must create a NEW row (2 total), not dedup onto the
    // executing one — otherwise the retry silently never fires.
    expect(
      await stub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(2);
    const incident = await stub.getIncidentForTest("inc-retry");
    expect(incident?.attempt).toBe(2);
    expect(incident?.status).toBe("scheduled");
  });

  it("PARKS a continuation (no reschedule, no budget spent) while a CLIENT interaction is pending", async () => {
    const stub = await getTestAgent(`stable-park-${crypto.randomUUID()}`);
    await stub.setForceStableTimeoutForTest(true);

    await stub.setRequestContextForTest(undefined, [{ name: "chooseOption" }]);
    await stub.persistPendingToolCallForTest("assistant-park", "chooseOption");

    await stub.seedIncidentForTest({
      incidentId: "inc-park",
      requestId: "root-park",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const continueData = {
      incidentId: "inc-park",
      originalRequestId: "root-park",
      targetAssistantId: "assistant-park"
    };
    await stub.preScheduleRecoveryContinueForTest(continueData);
    await stub.runChatRecoveryContinueDirectForTest(continueData);

    expect(
      await stub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(1);
    const parked = await stub.getIncidentForTest("inc-park");
    expect(parked?.attempt).toBe(1);
    expect(parked?.status).toBe("skipped");
    expect(parked?.reason).toBe("awaiting_client_interaction");
  });

  it("RECOVERS a dead SERVER-tool orphan on continue (repairs to errored, then continues)", async () => {
    const stub = await getTestAgent(`stable-recover-${crypto.randomUUID()}`);
    await stub.setForceStableTimeoutForTest(false);

    // `previewTool` is NOT a registered client tool, so its unresolved tool
    // call is a dead SERVER orphan — it must be repaired + continued rather
    // than parked or exhausted.
    await stub.setRequestContextForTest(undefined, [{ name: "chooseOption" }]);
    await stub.persistPendingToolCallForTest(
      "assistant-recover",
      "previewTool"
    );

    await stub.seedIncidentForTest({
      incidentId: "inc-recover",
      requestId: "root-recover",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-recover",
      originalRequestId: "root-recover",
      targetAssistantId: "assistant-recover"
    });
    await stub.waitForIdleForTest();

    // The orphaned server-tool call was repaired to an errored ToolMessage.
    const messages = await stub.getPersistedMessages();
    const repair = messages.find(
      (m) => m.role === "tool" && m.toolCallId === "call_assistant-recover"
    );
    expect(repair).toBeDefined();
    expect((repair as { error?: string }).error).toContain("interrupted");

    // It CONTINUED (ran inference) and the incident terminalized as
    // completed (deleted), not a stable-timeout give-up.
    expect(await stub.getOnChatMessageCallCount()).toBe(1);
    expect(await stub.getIncidentForTest("inc-recover")).toBeNull();
  });

  it("PARKS a retry (no reschedule, no budget spent) while a CLIENT interaction is pending", async () => {
    const stub = await getTestAgent(`stable-retry-park-${crypto.randomUUID()}`);
    await stub.setForceStableTimeoutForTest(true);

    await stub.setRequestContextForTest(undefined, [{ name: "chooseOption" }]);
    await stub.persistPendingToolCallForTest(
      "assistant-retry-park",
      "chooseOption"
    );

    await stub.seedIncidentForTest({
      incidentId: "inc-retry-park",
      requestId: "root-retry-park",
      recoveryKind: "retry",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const retryData = {
      incidentId: "inc-retry-park",
      originalRequestId: "root-retry-park",
      targetUserId: "u-x"
    };
    await stub.preScheduleRecoveryRetryForTest(retryData);
    await stub.runChatRecoveryRetryDirectForTest(retryData);

    expect(await stub.getScheduleCountForCallback("_chatRecoveryRetry")).toBe(
      1
    );
    const parked = await stub.getIncidentForTest("inc-retry-park");
    expect(parked?.attempt).toBe(1);
    expect(parked?.status).toBe("skipped");
    expect(parked?.reason).toBe("awaiting_client_interaction");
  });

  it("exhausts via onExhausted once the stable-state continue budget is spent", async () => {
    const stub = await getTestAgent(`stable-exhaust-${crypto.randomUUID()}`);
    await stub.enableExhaustedCaptureForTest(6, "the assistant gave up");
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-exhaust",
      requestId: "root-exhaust",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-exhaust",
      originalRequestId: "root-exhaust",
      targetAssistantId: "a-x"
    });

    expect(
      await stub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
    const incident = await stub.getIncidentForTest("inc-exhaust");
    expect(incident?.status).toBe("exhausted");
    expect(incident?.reason).toBe("stable_timeout");
    const exhausted = await stub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("stable_timeout");
    expect(exhausted[0].recoveryKind).toBe("continue");
    expect(exhausted[0].terminalMessage).toBe("the assistant gave up");
  });

  it("exhausts via onExhausted once the stable-state retry budget is spent", async () => {
    const stub = await getTestAgent(
      `stable-exhaust-retry-${crypto.randomUUID()}`
    );
    await stub.enableExhaustedCaptureForTest(6, "retry gave up");
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-exhaust-retry",
      requestId: "root-exhaust-retry",
      recoveryKind: "retry",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await stub.runChatRecoveryRetryDirectForTest({
      incidentId: "inc-exhaust-retry",
      originalRequestId: "root-exhaust-retry",
      targetUserId: "u-x"
    });

    expect(await stub.getScheduleCountForCallback("_chatRecoveryRetry")).toBe(
      0
    );
    const incident = await stub.getIncidentForTest("inc-exhaust-retry");
    expect(incident?.status).toBe("exhausted");
    expect(incident?.reason).toBe("stable_timeout");
    const exhausted = await stub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("stable_timeout");
    expect(exhausted[0].recoveryKind).toBe("retry");
    expect(exhausted[0].terminalMessage).toBe("retry gave up");
  });

  it("terminalizes a stable-state give-up even when the incident record is missing", async () => {
    const stub = await getTestAgent(
      `stable-silent-drop-${crypto.randomUUID()}`
    );
    await stub.enableExhaustedCaptureForTest(6, "lost incident gave up");
    await stub.setForceStableTimeoutForTest(true);
    // No incident seeded: a stale alarm after the record was swept must STILL
    // terminalize rather than drop the turn into an eternal spinner.

    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-gone",
      originalRequestId: "root-missing",
      targetAssistantId: "a-x"
    });

    const exhausted = await stub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("stable_timeout");
    expect(exhausted[0].recoveryRootRequestId).toBe("root-missing");
    expect(exhausted[0].terminalMessage).toBe("lost incident gave up");
  });

  it("does not re-fire onExhausted when a duplicate stale alarm runs after exhaustion", async () => {
    const stub = await getTestAgent(
      `stable-exhaust-dup-${crypto.randomUUID()}`
    );
    await stub.enableExhaustedCaptureForTest(6, "gave up once");
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-dup",
      requestId: "root-dup",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const data = {
      incidentId: "inc-dup",
      originalRequestId: "root-dup",
      targetAssistantId: "a-x"
    };
    await stub.runChatRecoveryContinueDirectForTest(data);
    await stub.runChatRecoveryContinueDirectForTest(data);

    const exhausted = await stub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    const incident = await stub.getIncidentForTest("inc-dup");
    expect(incident?.status).toBe("exhausted");
  });

  it("tracks a durable 'recovering…' record, cleared on terminal (#1620)", async () => {
    const stub = await getTestAgent(`recovering-${crypto.randomUUID()}`);
    const begun = await stub.beginIncidentForTest({
      requestId: "root-rec",
      recoveryRootRequestId: "root-rec",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });

    await stub.updateIncidentForTest(begun.incidentId, "scheduled");
    expect((await stub.getChatRecoveringForTest())?.requestId).toBe("root-rec");

    await stub.updateIncidentForTest(begun.incidentId, "failed", "boom");
    expect(await stub.getChatRecoveringForTest()).toBeNull();
  });

  it("replays the 'recovering…' status on connect, cleared on terminal (#1620)", async () => {
    const stub = await getTestAgent(
      `recovering-connect-${crypto.randomUUID()}`
    );
    const begun = await stub.beginIncidentForTest({
      requestId: "root-rec",
      recoveryRootRequestId: "root-rec",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });

    expect(await stub.getRecoveringConnectFrameForTest()).toBeNull();

    await stub.updateIncidentForTest(begun.incidentId, "scheduled");
    const frame = await stub.getRecoveringConnectFrameForTest();
    expect(frame?.type).toBe(CHAT_MESSAGE_TYPES.CHAT_RECOVERING);
    expect(frame?.recovering).toBe(true);
    expect(frame?.id).toBe("root-rec");

    await stub.updateIncidentForTest(begun.incidentId, "failed", "boom");
    expect(await stub.getRecoveringConnectFrameForTest()).toBeNull();
  });

  it("records a durable terminal on exhaustion, cleared by a later successful server-side turn (#1645)", async () => {
    const room = `terminal-cleared-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const TERMINAL = "Recovery exhausted — the assistant could not finish.";

    await stub.enableExhaustedCaptureForTest(6, TERMINAL);
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-cleared",
      requestId: "root-cleared",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-cleared",
      originalRequestId: "root-cleared",
      targetAssistantId: "a-cleared"
    });

    expect(await stub.getPendingChatTerminalForTest()).toMatchObject({
      body: TERMINAL
    });

    // A later turn succeeds, driven purely server-side — only the response
    // drain loop can supersede the record.
    await stub.setForceStableTimeoutForTest(false);
    expect(await stub.driveSuccessfulTurnForTest()).toBe("completed");
    expect(await stub.getPendingChatTerminalForTest()).toBeNull();

    // The record being gone from storage is only half the contract: a client
    // reconnecting now must get a plain "nothing to resume", not the resume
    // handshake that would replay the superseded terminal as a live error.
    expect(await probeResumeReason(room)).toBe("idle");
  });

  it("clears the terminal record when a later server-side turn is aborted (#1645)", async () => {
    const stub = await getTestAgent(`terminal-aborted-${crypto.randomUUID()}`);
    const TERMINAL = "Recovery exhausted — the assistant could not finish.";

    await stub.enableExhaustedCaptureForTest(6, TERMINAL);
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-aborted",
      requestId: "root-aborted",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-aborted",
      originalRequestId: "root-aborted",
      targetAssistantId: "a-aborted"
    });
    expect(await stub.getPendingChatTerminalForTest()).toMatchObject({
      body: TERMINAL
    });

    await stub.setForceStableTimeoutForTest(false);
    expect(await stub.driveAbortedTurnForTest()).toBe("aborted");
    expect(await stub.getPendingChatTerminalForTest()).toBeNull();
  });

  it("records a durable terminal for a non-exhaustion stream error (#1645)", async () => {
    const stub = await getTestAgent(`terminal-error-${crypto.randomUUID()}`);
    const STREAM_ERROR = "Provider returned HTTP 500.";

    expect(await stub.driveErroredTurnForTest(STREAM_ERROR)).toBe("error");
    expect(await stub.getPendingChatTerminalForTest()).toMatchObject({
      body: STREAM_ERROR
    });
  });

  it("drops the terminal record when the conversation is cleared (#1645)", async () => {
    const room = `terminal-chatclear-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const TERMINAL = "Recovery exhausted — the assistant could not finish.";

    await stub.enableExhaustedCaptureForTest(6, TERMINAL);
    await stub.setForceStableTimeoutForTest(true);
    await stub.seedIncidentForTest({
      incidentId: "inc-chatclear",
      requestId: "root-chatclear",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-chatclear",
      originalRequestId: "root-chatclear",
      targetAssistantId: "a-chatclear"
    });
    expect(await stub.getPendingChatTerminalForTest()).toMatchObject({
      body: TERMINAL
    });

    // Clear the conversation over the real WS protocol.
    const ws = await connectChatWS(`/agents/recovery-agui-agent/${room}`);
    ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }));
    await new Promise((r) => setTimeout(r, 200));
    ws.close(1000);

    expect(await stub.getPendingChatTerminalForTest()).toBeNull();

    // …and a client reconnecting AFTER the clear must be told there is nothing
    // to resume, not handed the terminal that was just dropped.
    expect(await probeResumeReason(room)).toBe("idle");
  });

  // `continueLastTurn` re-enters inference against the existing transcript, so
  // both of its guards exist to stop it re-running a turn that no longer makes
  // sense. Neither is reachable from the wire — the barrier only calls it when
  // its own preconditions hold — so they are driven directly.
  describe("continueLastTurn guards", () => {
    it("skips when there is no assistant message to continue from", async () => {
      const stub = await getTestAgent(
        `cont-noassistant-${crypto.randomUUID()}`
      );

      // Only a user message: there is no partial assistant turn to extend, and
      // continuing would silently turn into "answer this again".
      await stub.persistMessages([
        { id: "u1", role: "user", content: "hello" }
      ]);

      expect(await stub.continueLastTurnForTest()).toEqual({
        requestId: "",
        status: "skipped"
      });
      expect(await stub.getOnChatMessageCallCount()).toBe(0);
    });

    it("skips when the turn-queue generation moved on before it ran", async () => {
      const stub = await getTestAgent(`cont-superseded-${crypto.randomUUID()}`);
      await stub.persistMessages([
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "partial" }
      ]);

      // A reset (chat clear, a new user submit under `latest`) between enqueue
      // and dequeue invalidates the epoch the continuation captured.
      const result = await stub.continueLastTurnSupersededForTest();

      expect(result.status).toBe("skipped");
      expect(await stub.getOnChatMessageCallCount()).toBe(0);
    });
  });
});
