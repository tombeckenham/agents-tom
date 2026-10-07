/**
 * Incoming CF_AGENT_CHAT_MESSAGES persists the supplied list and broadcasts
 * the update to the other connected clients (not the sender).
 */

import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  fetchPersistedMessages,
  recordFrames,
  userMessage
} from "./test-utils";

describe("AGUIChatAgent — client message sync", () => {
  it("persists an incoming CHAT_MESSAGES list and broadcasts it to peers", async () => {
    const path = `/agents/echo-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
        messages: [userMessage("u1", "synced"), userMessage("u2", "pair")]
      })
    );

    const broadcast = await rec2.waitFor(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.CHAT_MESSAGES &&
        (f.messages?.length ?? 0) === 2
    );
    expect(broadcast.messages?.map((m) => m.id)).toEqual(["u1", "u2"]);
    ws.close(1000);
    ws2.close(1000);

    const persisted = await fetchPersistedMessages(path);
    expect(persisted.map((m) => m.id)).toEqual(["u1", "u2"]);
  });
});
