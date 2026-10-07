/**
 * A non-SSE Response from onChatMessage is wrapped in a synthetic
 * TEXT_MESSAGE_START / CONTENT / END run so plaintext producers flow
 * through the same AG-UI lifecycle, and the text persists as the assistant
 * message content.
 */

import { describe, expect, it } from "vitest";
import {
  connectChatWS,
  eventsForRequest,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage,
  waitForPersisted
} from "./test-utils";

describe("AGUIChatAgent — plaintext response", () => {
  it("wraps a text/plain body in a synthetic TEXT_MESSAGE run", async () => {
    const path = `/agents/plaintext-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "Hello")]);
    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);

    const events = eventsForRequest(rec.frames, "req1");
    expect(events[0]?.type).toBe("TEXT_MESSAGE_START");
    expect(events.at(-1)?.type).toBe("TEXT_MESSAGE_END");
    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("plain answer");

    const persisted = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "assistant")
    );
    const assistant = persisted.find((m) => m.role === "assistant");
    expect((assistant as { content?: string })?.content).toBe("plain answer");
  });
});
