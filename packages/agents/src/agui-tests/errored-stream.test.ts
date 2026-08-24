/**
 * A stream that errors mid-flight must surface as a USE_CHAT_RESPONSE frame
 * with error:true carrying the error text, terminating the request. The same
 * terminal frame must arrive when `onChatMessage` throws before producing a
 * Response at all — otherwise the client's request stream hangs forever.
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

  it("broadcasts an error:true done frame when onChatMessage throws before a Response", async () => {
    const path = `/agents/pre-throw-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "explode early")]);
    const errorFrame = await rec.waitFor(
      (f) => isResponseFrame(f) && f.id === "req1" && f.error === true
    );
    expect(errorFrame.done).toBe(true);
    expect(errorFrame.body).toContain("boom before response");
    ws.close(1000);
  });
});
