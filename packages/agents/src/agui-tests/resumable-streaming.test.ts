/**
 * Resumable streaming over the AG-UI wire protocol.
 *
 * - A client connecting while a stream is active is told CF_AGENT_STREAM_RESUMING.
 * - Sending CF_AGENT_STREAM_RESUME_REQUEST while active gets STREAM_RESUMING;
 *   ACKing replays the buffered chunks (replay: true) and then the live tail
 *   through to done.
 * - When the agent is idle, a resume request gets CF_AGENT_STREAM_RESUME_NONE.
 */

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

describe("AGUIChatAgent — resumable streaming", () => {
  it("notifies a late-joining client with STREAM_RESUMING", async () => {
    const path = `/agents/slow-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "go")]);
    await rec.waitFor(
      (f) => isResponseFrame(f) && f.id === "req1" && !!f.body?.length
    );

    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);
    const resuming = await rec2.waitFor(
      (f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING
    );
    expect(resuming.id).toBe("req1");

    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);
    ws2.close(1000);
  });

  it("replays buffered chunks to an ACKed connection and streams to done", async () => {
    const path = `/agents/slow-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "go")]);
    // Let a few chunks accumulate before the second client joins.
    await rec.waitFor(
      (f) => isResponseFrame(f) && f.id === "req1" && !!f.body?.length
    );

    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);
    const resuming = await rec2.waitFor(
      (f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING
    );
    ws2.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
        id: resuming.id
      })
    );

    await rec2.waitFor(isDoneFrame("req1"), 8000);
    const replayFrames = rec2.frames.filter(
      (f) => isResponseFrame(f) && f.id === "req1" && f.replay === true
    );
    expect(replayFrames.length).toBeGreaterThan(0);
    // The resumed client must end up with the same event sequence the
    // original client saw: a full RUN_STARTED → RUN_FINISHED run.
    const resumedEvents = eventsForRequest(rec2.frames, "req1");
    expect(resumedEvents[0]?.type).toBe("RUN_STARTED");
    expect(resumedEvents.at(-1)?.type).toBe("RUN_FINISHED");
    ws.close(1000);
    ws2.close(1000);
  });

  it("answers STREAM_RESUME_NONE when no stream is active", async () => {
    const path = `/agents/slow-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST }));
    await rec.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE);
    ws.close(1000);
  });
});
