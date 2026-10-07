/**
 * Live-stream inactivity watchdog (#1626). With `chatStreamStallTimeoutMs > 0`
 * a model/transport stream that parks between chunks is aborted and routed into
 * the SAME bounded-recovery machinery a deploy/eviction interruption uses,
 * instead of leaving the turn hung forever. Port of the "stall watchdog"
 * describe block in `packages/ai-chat/src/tests/durable-chat-recovery.test.ts`
 * on the AG-UI shape.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { AGUIMessage } from "../chat/agui-types";

interface StallStub {
  setChatStreamStallTimeoutForTest(ms: number): Promise<void>;
  driveStallingTurnForTest(options?: {
    timeoutMs?: number;
    hangTurns?: number;
  }): Promise<string>;
  driveSuccessfulTurnForTest(): Promise<string>;
  getChatRecoveryIncidentsForTest(): Promise<
    Array<{ recoveryKind: string; status: string }>
  >;
  getScheduleCountForCallback(callback: string): Promise<number>;
  getPersistedMessages(): Promise<AGUIMessage[]>;
}

async function getTestAgent(room: string): Promise<StallStub> {
  return (await getAgentByName(
    env.RecoveryAguiAgent,
    room
  )) as unknown as StallStub;
}

describe("stall watchdog (chatStreamStallTimeoutMs)", () => {
  it("routes a stalled live stream into bounded recovery (schedules a continuation)", async () => {
    const room = `stall-route-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // The model streams a partial then hangs; the watchdog trips after the gap.
    const status = await agentStub.driveStallingTurnForTest({
      timeoutMs: 150,
      hangTurns: 1
    });

    // This attempt did not terminalize — the scheduled continuation owns the
    // real outcome, so the server-side turn reports "aborted".
    expect(status).toBe("aborted");

    // The stall opened a bounded-recovery incident through the shared engine —
    // a `continue` incident, exactly like a deploy interruption (rather than
    // leaking a terminal error). The scheduled `_chatRecoveryContinue` row is
    // consumed by the delay-0 alarm, so the durable incident (not the transient
    // schedule row) is the stable evidence the stall was routed.
    // Exactly one: a single stall must open a single incident. More than one
    // means the watchdog fired again on the same turn (or the continuation
    // opened its own), which silently burns the attempt budget.
    const incidents = await agentStub.getChatRecoveryIncidentsForTest();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].recoveryKind).toBe("continue");

    // The partial generated before the stall was persisted (not lost), so the
    // continuation re-anchors onto it rather than re-running from scratch.
    const messages = await agentStub.getPersistedMessages();
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant, `messages=${JSON.stringify(messages)}`).toBeTruthy();
    expect(
      messages.some(
        (m) =>
          m.role === "assistant" &&
          (m.content ?? "").includes("partial before stall")
      )
    ).toBe(true);
  });

  it("passes a healthy (non-stalling) stream through unchanged when the watchdog is armed", async () => {
    const room = `stall-healthy-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // Arm the watchdog with a timeout comfortably above the (effectively
    // instant) inter-chunk gap of a healthy SSE stream. The guarded read path
    // must pass a non-stalling stream through unchanged — the turn completes
    // normally, with no recovery incident and no continuation scheduled, and
    // the watchdog timer must be cleared on completion (no spurious late trip).
    await agentStub.setChatStreamStallTimeoutForTest(1000);
    expect(await agentStub.driveSuccessfulTurnForTest()).toBe("completed");

    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
  });

  it("does not arm the watchdog when the stall timeout is 0 (default, opt-in)", async () => {
    const room = `stall-off-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // Timeout 0 => watchdog disabled. A normal (non-hanging) turn completes as
    // usual with no recovery incident and no continuation scheduled.
    await agentStub.setChatStreamStallTimeoutForTest(0);
    expect(await agentStub.driveSuccessfulTurnForTest()).toBe("completed");

    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
  });
});
