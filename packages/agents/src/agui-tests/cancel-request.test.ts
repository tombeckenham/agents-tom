/**
 * CF_AGENT_CHAT_REQUEST_CANCEL aborts the abortSignal passed to
 * onChatMessage and terminates the stream with a done frame before the
 * fixture's full event sequence has been streamed.
 */

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
});
