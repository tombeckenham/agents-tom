/**
 * `maxPersistedMessages` trims the oldest rows so the persisted history
 * never exceeds the configured cap.
 */

import { describe, expect, it } from "vitest";
import {
  connectChatWS,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage,
  waitForPersisted
} from "./test-utils";

describe("AGUIChatAgent — maxPersistedMessages", () => {
  it("keeps at most the configured number of rows, dropping the oldest", async () => {
    const path = `/agents/max-persisted-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "first")]);
    await rec.waitFor(isDoneFrame("req1"));
    const mid = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "assistant")
    );
    expect(mid.length).toBeLessThanOrEqual(2);

    sendChatRequest(ws, "req2", [...mid, userMessage("u2", "second")] as never);
    await rec.waitFor(isDoneFrame("req2"));
    ws.close(1000);

    const persisted = await waitForPersisted(
      path,
      (ms) => !ms.some((m) => m.id === "u1")
    );
    expect(persisted.length).toBeLessThanOrEqual(2);
  });
});
