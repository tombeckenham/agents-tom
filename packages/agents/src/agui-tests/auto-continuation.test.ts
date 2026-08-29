/**
 * Auto-continuation barrier (#1649 / #1650) on the AG-UI shape.
 *
 * `AGUIChatAgent` drives the shared `AutoContinuationController`: a tool
 * result/approval that opts in with `autoContinue` schedules a continuation,
 * rapid siblings coalesce into one fire, and the fire is gated on a complete
 * parallel tool batch with no stream in flight. Port of the barrier scenarios
 * in `packages/ai-chat/src/tests/client-tools-continuation.test.ts`,
 * `chat-turn-serialization.test.ts` and `pending-interaction.test.ts`.
 *
 * AG-UI note: the legacy suite seeds `UIMessage` tool parts and reads their
 * `state`; here a batch is an assistant message with several `toolCalls` and a
 * call is answered when a standalone `role: "tool"` message carries its
 * `toolCallId`.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { AGUIMessage } from "../chat/agui-types";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

interface AutoContinueStub {
  persistParallelToolCallsForTest(
    messageId: string,
    toolCallIds: string[]
  ): Promise<void>;
  getContinuationStateForTest(): Promise<{
    hasPending: boolean;
    hasDeferred: boolean;
    pastCoalesce: boolean;
    armed: boolean;
    activeRequestId: string | null;
  }>;
  getStartedRequestIds(): Promise<string[]>;
  getPersistedMessages(): Promise<AGUIMessage[]>;
  hasPendingInteractionForTest(): Promise<boolean>;
  getQueuedTurnCountForTest(): Promise<number>;
  waitUntilStableForTest(timeout?: number): Promise<boolean>;
  resetTurnStateForTest(): Promise<void>;
  testInteractionApplySerialization(): Promise<number>;
}

async function getTestAgent(room: string): Promise<AutoContinueStub> {
  return (await getAgentByName(
    env.AutoContinueAguiAgent,
    room
  )) as unknown as AutoContinueStub;
}

function sendToolResult(
  ws: WebSocket,
  toolCallId: string,
  options: { autoContinue?: boolean } = {}
) {
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
      toolCallId,
      toolName: "testTool",
      output: { ok: toolCallId },
      state: "output-available",
      ...(options.autoContinue && { autoContinue: true })
    })
  );
}

function sendToolApproval(
  ws: WebSocket,
  toolCallId: string,
  options: { approved?: boolean; autoContinue?: boolean } = {}
) {
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
      toolCallId,
      approved: options.approved ?? true,
      ...(options.autoContinue && { autoContinue: true })
    })
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, so tests never race a fixed sleep. */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

describe("auto-continuation barrier (AG-UI)", () => {
  it("parks a parallel-batch continuation until the last sibling lands, then fires once (#1650)", async () => {
    const room = `park-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_first",
      "call_second"
    ]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolResult(ws, "call_first", { autoContinue: true });

    // Well past the coalesce window: the barrier holds because `call_second` is
    // still unanswered. There is no orphan timeout — it parks indefinitely.
    await sleep(500);
    const parked = await stub.getContinuationStateForTest();
    expect(parked.hasPending).toBe(true);
    expect(parked.activeRequestId).toBeNull();
    expect(await stub.getStartedRequestIds()).toHaveLength(0);
    expect(await stub.hasPendingInteractionForTest()).toBe(true);

    sendToolResult(ws, "call_second", { autoContinue: true });
    await stub.waitUntilStableForTest(10_000);

    // Exactly one continuation turn — the two results coalesced.
    expect(await stub.getStartedRequestIds()).toHaveLength(1);
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false,
      activeRequestId: null
    });

    ws.close(1000);
  });

  it("lets a sibling result WITHOUT autoContinue complete a parked batch (#1650)", async () => {
    const room = `rearm-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_opted_in",
      "call_plain"
    ]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolResult(ws, "call_opted_in", { autoContinue: true });
    await sleep(300);
    expect(await stub.getStartedRequestIds()).toHaveLength(0);

    // No `autoContinue` on this one — it must not CREATE a continuation, but it
    // completes the batch a sibling already opted into, so the parked
    // continuation fires.
    sendToolResult(ws, "call_plain");
    await stub.waitUntilStableForTest(10_000);

    expect(await stub.getStartedRequestIds()).toHaveLength(1);
    ws.close(1000);
  });

  it("never continues for a lone result that did not opt in", async () => {
    const room = `no-optin-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_only"
    ]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolResult(ws, "call_only");
    await sleep(400);

    expect(await stub.getStartedRequestIds()).toHaveLength(0);
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    ws.close(1000);
  });

  it("never continues for an approval that did not opt in", async () => {
    // The approval mirror of the result case above. Approvals take a separate
    // path into the barrier (`_handleToolApproval` / the decision ledger), so a
    // missing `autoContinue` guard there would fire an unrequested turn — and
    // for an approval that turn is the one that EXECUTES the tool.
    const room = `approval-no-optin-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_approve_only"
    ]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolApproval(ws, "call_approve_only");
    await sleep(400);

    expect(await stub.getStartedRequestIds()).toHaveLength(0);
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false,
      armed: false
    });
    ws.close(1000);
  });

  it("holds the barrier while a turn streams, then fires one coalesced continuation", async () => {
    const room = `coalesce-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    const rec = recordFrames(ws);

    // A slow turn keeps the stream-active gate closed while both results land.
    sendChatRequest(ws, "req-live", [userMessage("user-1", "hello")], {
      streamChunks: 10,
      streamDelayMs: 80
    });
    await waitUntil(
      async () => (await stub.getStartedRequestIds()).length === 1
    );
    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_a",
      "call_b"
    ]);

    sendToolResult(ws, "call_a", { autoContinue: true });
    sendToolResult(ws, "call_b", { autoContinue: true });

    await rec.waitFor(isDoneFrame("req-live"));
    await stub.waitUntilStableForTest(10_000);

    // One live turn + exactly one continuation: the barrier held through the
    // stream and the two results coalesced into a single fire.
    expect(await stub.getStartedRequestIds()).toHaveLength(2);
    ws.close(1000);
  });

  it("holds the barrier for the whole streaming turn, enqueuing nothing mid-stream (#1650)", async () => {
    const room = `stream-gate-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", ["call_one"]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    const rec = recordFrames(ws);
    sendChatRequest(ws, "req-live", [userMessage("user-1", "hello")], {
      streamChunks: 10,
      streamDelayMs: 80
    });
    await waitUntil(
      async () => (await stub.getStartedRequestIds()).length === 1
    );

    sendToolResult(ws, "call_one", { autoContinue: true });
    // Well past the coalesce window but still mid-stream: the batch cannot be
    // known complete while the model may yet emit more tool calls, so the
    // barrier must not have enqueued a continuation turn — the live turn is
    // still the only one the queue knows about.
    await sleep(300);
    expect(await stub.getQueuedTurnCountForTest()).toBe(1);
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: true,
      pastCoalesce: false
    });

    // Stream finalize re-runs the barrier — nothing else re-arms it, so without
    // that hook this continuation would never fire.
    await rec.waitFor(isDoneFrame("req-live"));
    await stub.waitUntilStableForTest(10_000);
    expect(await stub.getStartedRequestIds()).toHaveLength(2);

    ws.close(1000);
  });

  it("defers a result that arrives after the continuation started into a follow-up turn", async () => {
    const room = `deferred-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    const rec = recordFrames(ws);

    // The request body is replayed into every continuation, so each
    // continuation spends 400ms accepted-but-not-yet-streaming — the window in
    // which a further result must be deferred rather than coalesced.
    sendChatRequest(ws, "req-live", [userMessage("user-1", "hello")], {
      responseDelayMs: 400
    });
    await rec.waitFor(isDoneFrame("req-live"));

    await stub.persistParallelToolCallsForTest("assistant-batch", ["call_one"]);
    sendToolResult(ws, "call_one", { autoContinue: true });

    // Wait until the continuation is past the coalesce window and running.
    await waitUntil(
      async () => (await stub.getContinuationStateForTest()).pastCoalesce
    );

    await stub.persistParallelToolCallsForTest("assistant-batch-2", [
      "call_two"
    ]);
    sendToolResult(ws, "call_two", { autoContinue: true });
    await waitUntil(
      async () => (await stub.getContinuationStateForTest()).hasDeferred
    );

    await stub.waitUntilStableForTest(10_000);
    // Live turn + first continuation + the deferred follow-up.
    expect(await stub.getStartedRequestIds()).toHaveLength(3);
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });

    // …and the transcript those three turns leave behind is clean. A defer that
    // re-applied the result instead of rescheduling it, or a continuation that
    // re-ran the batch, shows up here as a duplicated row — invisible to the
    // barrier-state assertions above but corrupting for the next turn's prompt.
    const persisted = await stub.getPersistedMessages();
    const ids = persisted.map((m) => m.id);
    expect(new Set(ids).size, `duplicate ids in ${JSON.stringify(ids)}`).toBe(
      ids.length
    );
    expect(
      persisted
        .filter((m) => m.role === "tool")
        .map((m) => (m as { toolCallId: string }).toolCallId)
        .sort()
    ).toEqual(["call_one", "call_two"]);

    ws.close(1000);
  });

  it("treats a decided approval as answered so it cannot park its own batch", async () => {
    const room = `approval-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    // A batch mixing a tool result with an approval: AG-UI records approval
    // decisions as CUSTOM events, not message state, so without the decision
    // ledger the approved call would look forever-unanswered.
    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_result",
      "call_approve"
    ]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolResult(ws, "call_result", { autoContinue: true });
    await sleep(200);
    expect(await stub.getStartedRequestIds()).toHaveLength(0);

    // An approved call never gains a `ToolMessage` of its own (the continuation
    // executes it), so `waitUntilStable` would keep reporting a pending
    // interaction — poll the fire itself instead.
    sendToolApproval(ws, "call_approve", { autoContinue: true });
    await waitUntil(
      async () => (await stub.getStartedRequestIds()).length === 1
    );

    ws.close(1000);
  });

  it("clears pending and deferred state after a continuation stream errors", async () => {
    const room = `cont-error-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    const rec = recordFrames(ws);

    // Only continuation turns error; the priming turn stores the knob in
    // `_lastBody`.
    sendChatRequest(ws, "req-live", [userMessage("user-1", "hello")], {
      continuationStreamError: "continuation boom"
    });
    await rec.waitFor(isDoneFrame("req-live"));

    await stub.persistParallelToolCallsForTest("assistant-batch", ["call_one"]);
    sendToolResult(ws, "call_one", { autoContinue: true });

    await waitUntil(
      async () => (await stub.getStartedRequestIds()).length === 2
    );
    await stub.waitUntilStableForTest(10_000);

    // No leaked pending/deferred continuation and no armed timer — the barrier
    // is re-armable rather than wedged by the failed turn. `activeRequestId`
    // must be released too: an errored continuation gives up ownership exactly
    // like a completed one, so nothing later reads a dead turn as the owner.
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false,
      armed: false,
      activeRequestId: null
    });
    ws.close(1000);
  });

  it("resetTurnState cancels an armed continuation before it fires", async () => {
    const room = `reset-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", ["call_one"]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolResult(ws, "call_one", { autoContinue: true });
    // Inside the coalesce window — the timer is armed but has not fired.
    await stub.resetTurnStateForTest();
    await sleep(400);

    expect(await stub.getStartedRequestIds()).toHaveLength(0);
    expect(await stub.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false,
      armed: false
    });
    ws.close(1000);
  });

  it("waitUntilStable does not report stable while the barrier is armed", async () => {
    const room = `stable-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await stub.persistParallelToolCallsForTest("assistant-batch", ["call_one"]);

    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    sendToolResult(ws, "call_one", { autoContinue: true });

    // Stability must cover the whole barrier → continuation pipeline, not just
    // the turn queue: by the time it resolves the continuation has run.
    expect(await stub.waitUntilStableForTest(10_000)).toBe(true);
    expect(await stub.getStartedRequestIds()).toHaveLength(1);
    ws.close(1000);
  });

  it("serializes overlapping interaction applies so neither clobbers the other (#1649)", async () => {
    const stub = await getTestAgent(`serialize-${crypto.randomUUID()}`);
    // Unserialized read-modify-writes would leave 1; the apply chain gives 2.
    expect(await stub.testInteractionApplySerialization()).toBe(2);
  });
});
