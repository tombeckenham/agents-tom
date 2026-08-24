/**
 * Streamed USE_CHAT_RESPONSE frames are broadcast to every connected
 * client, while the CHAT_MESSAGES echo of the submitted user turn is
 * suppressed for the sender and delivered to peers.
 */

import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  eventsForRequest,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

describe("AGUIChatAgent — multi-client broadcast", () => {
  it("delivers stream frames to both clients and the user-turn sync to the peer", async () => {
    const path = `/agents/echo-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);
    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);

    sendChatRequest(ws, "req1", [userMessage("u1", "Hello")]);
    await rec.waitFor(isDoneFrame("req1"));
    await rec2.waitFor(isDoneFrame("req1"));

    // Both clients observed the same AG-UI event sequence.
    expect(eventsForRequest(rec2.frames, "req1")).toEqual(
      eventsForRequest(rec.frames, "req1")
    );

    // The peer received the submitted user turn via CHAT_MESSAGES.
    const peerSync = rec2.frames.find(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.CHAT_MESSAGES &&
        f.messages?.some((m) => m.id === "u1")
    );
    expect(peerSync).toBeDefined();
    ws.close(1000);
    ws2.close(1000);
  });
});
