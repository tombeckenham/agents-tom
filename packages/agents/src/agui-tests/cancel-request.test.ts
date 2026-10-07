/**
 * CF_AGENT_CHAT_REQUEST_CANCEL aborts the abortSignal passed to
 * onChatMessage and terminates the stream with a done frame before the
 * fixture's full event sequence has been streamed.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  eventsForRequest,
  isDoneFrame,
  isResponseFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

interface CancelRecoveryStub {
  waitForIdleForTest(): Promise<void>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  getAbortControllerCount(): Promise<number>;
}

describe("AGUIChatAgent — cancel", () => {
  it("aborts the turn mid-stream and completes with a done frame", async () => {
    const path = `/agents/slow-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "go")]);
    // Wait for the first streamed event, then cancel.
    await rec.waitFor(
      (f) => isResponseFrame(f) && f.id === "req1" && !!f.body?.length
    );
    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
        id: "req1"
      })
    );

    await rec.waitFor(isDoneFrame("req1"));
    // The fixture streams 12 deltas at 100ms; a prompt cancel must cut the
    // sequence well short of the full run.
    const events = eventsForRequest(rec.frames, "req1");
    expect(events.length).toBeLessThan(14);
    ws.close(1000);

    // The abortSignal handed to onChatMessage must have fired.
    const probe = await exports.default.fetch(
      `http://example.com${path}/probe`
    );
    expect(((await probe.json()) as { sawAbort: boolean }).sawAbort).toBe(true);
  });

  it("leaks no fiber or abort controller when cancelling a recovery-wrapped turn", async () => {
    // On a recovery-enabled agent every turn runs inside a durable fiber and
    // registers an abort controller. A cancel unwinds through more layers than
    // a plain turn (watchdog, fiber, registry), so this is where a missed
    // cleanup would strand a `cf_agents_runs` row and have the next isolate
    // "recover" a turn the user deliberately killed.
    // Port of `packages/ai-chat/src/tests/chat-recovery.test.ts` "cancellation
    // with durable chat recovery".
    const room = crypto.randomUUID();
    const path = `/agents/recovery-agui-agent/${room}`;
    const stub = (await getAgentByName(
      env.RecoveryAguiAgent,
      room
    )) as unknown as CancelRecoveryStub;

    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);
    sendChatRequest(ws, "req-cancel", [userMessage("u1", "go")], {
      streamChunks: 100,
      streamDelayMs: 50
    });

    await rec.waitFor(
      (f) => isResponseFrame(f) && f.id === "req-cancel" && !!f.body?.length
    );
    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
        id: "req-cancel"
      })
    );
    await rec.waitFor(isDoneFrame("req-cancel"));
    expect(eventsForRequest(rec.frames, "req-cancel").length).toBeLessThan(100);
    ws.close(1000);

    await stub.waitForIdleForTest();
    expect(await stub.getActiveFibers()).toEqual([]);
    expect(await stub.getAbortControllerCount()).toBe(0);
  });
});
