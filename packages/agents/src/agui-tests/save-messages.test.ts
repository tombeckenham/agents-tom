/**
 * The programmatic `saveMessages` entry point persists the supplied list,
 * runs a full chat turn (onChatMessage → streamed reply), and broadcasts
 * the results to connected clients.
 */

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  fetchPersistedMessages,
  recordFrames,
  userMessage
} from "./test-utils";

describe("AGUIChatAgent — saveMessages", () => {
  it("persists messages, runs a turn, and broadcasts to connected clients", async () => {
    const path = `/agents/save-messages-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    const res = await exports.default.fetch(
      `http://example.com${path}/trigger-save`,
      {
        method: "POST",
        body: JSON.stringify([userMessage("u1", "programmatic")])
      }
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { status: string; requestId: string };
    expect(result.status).toBe("completed");

    // The connected client saw both the saved user turn and the streamed
    // assistant reply.
    await rec.waitFor(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.CHAT_MESSAGES &&
        (f.messages?.some((m) => m.id === "u1") ?? false)
    );
    await rec.waitFor(
      (f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && f.done === true
    );
    ws.close(1000);

    const persisted = await fetchPersistedMessages(path);
    expect(persisted.some((m) => m.id === "u1")).toBe(true);
    const assistant = persisted.find((m) => m.role === "assistant");
    expect((assistant as { content?: string })?.content).toBe("saved-reply");
  });
});
