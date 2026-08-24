/**
 * CF_AGENT_CHAT_CLEAR wipes the persisted rows and in-memory list, and the
 * clear is broadcast to the other connected clients (not the sender).
 */

import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  fetchPersistedMessages,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

describe("AGUIChatAgent — clear history", () => {
  it("clears persisted messages and broadcasts CHAT_CLEAR to other clients", async () => {
    const path = `/agents/echo-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);
    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);

    sendChatRequest(ws, "req1", [userMessage("u1", "Hello")]);
    await rec.waitFor(isDoneFrame("req1"));
    expect((await fetchPersistedMessages(path)).length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }));
    await rec2.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.CHAT_CLEAR);
    ws.close(1000);
    ws2.close(1000);

    expect(await fetchPersistedMessages(path)).toEqual([]);
  });
});
