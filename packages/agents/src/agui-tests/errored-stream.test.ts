/**
 * A stream that errors mid-flight must surface as a USE_CHAT_RESPONSE frame
 * with error:true carrying the error text, terminating the request.
 */

import { describe, expect, it } from "vitest";
import {
  connectChatWS,
  isResponseFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

describe("AGUIChatAgent — errored stream", () => {
  it("broadcasts an error:true done frame when the SSE body throws", async () => {
    const path = `/agents/error-stream-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "boom please")]);
    const errorFrame = await rec.waitFor(
      (f) => isResponseFrame(f) && f.id === "req1" && f.error === true
    );
    expect(errorFrame.done).toBe(true);
    expect(errorFrame.body).toContain("boom mid-stream");
    ws.close(1000);
  });
});
