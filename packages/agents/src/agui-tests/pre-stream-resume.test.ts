/**
 * Pre-stream resume window (#1784).
 *
 * A turn is accepted (`_preStream.begin`) but its resumable stream has not
 * started yet — here `PreStreamAguiAgent`'s `responseDelayMs` holds
 * `onChatMessage` before it returns a Response. A client that connects or
 * probes in that window must be told to KEEP WAITING (`STREAM_PENDING`) rather
 * than "nothing to resume" (`STREAM_RESUME_NONE`), then flushed into
 * `STREAM_RESUMING` once the stream actually starts.
 *
 * Port of `packages/ai-chat/src/tests/pre-stream-resume.test.ts` on the AG-UI
 * shape. The container itself is unit-tested in
 * `packages/agents/src/chat/__tests__/pre-stream-turns.test.ts`; these legs
 * prove the `AGUIChatAgent` wiring end-to-end over a real DO WebSocket
 * (accept → begin → onConnect/handleResumeRequest park → _startStream flush).
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  recordFrames,
  sendChatRequest,
  userMessage,
  type WireFrame
} from "./test-utils";

/** The `PreStreamAguiAgent` test RPC surface these legs drive. */
interface PreStreamStub {
  getStartedRequestIds(): Promise<string[]>;
}

/** Wait until `onChatMessage` has entered for `requestId` — i.e. the turn is
 * accepted and now sitting in the pre-stream window. */
async function waitForHandlerEntered(
  stub: PreStreamStub,
  requestId: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await stub.getStartedRequestIds()).includes(requestId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${requestId} to enter onChatMessage`);
}

function hasType(frames: WireFrame[], type: string): boolean {
  return frames.some((f) => f.type === type);
}

describe("AGUIChatAgent — pre-stream resume window (#1784)", () => {
  it("parks a client that connects mid pre-stream window, then resumes it when the stream starts", async () => {
    const room = `pre-stream-connect-${crypto.randomUUID()}`;
    const path = `/agents/pre-stream-agui-agent/${room}`;
    const stub = (await getAgentByName(
      env.PreStreamAguiAgent,
      room
    )) as unknown as PreStreamStub;

    const ws1 = await connectChatWS(path);
    const requestId = "req-pre-stream-connect";
    sendChatRequest(ws1, requestId, [userMessage("u1", "hi")], {
      responseDelayMs: 1000
    });
    await waitForHandlerEntered(stub, requestId);

    // A NEW connection joins while the turn is accepted but not streaming.
    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);

    await rec2.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_PENDING);
    expect(hasType(rec2.frames, CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE)).toBe(
      false
    );

    // Once the delay elapses and the stream starts, the parked connection is
    // flushed into the normal resume handshake.
    await rec2.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING);

    ws1.close(1000);
    ws2.close(1000);
  });

  it("answers a resume probe during the pre-stream window with STREAM_PENDING, not RESUME_NONE", async () => {
    const room = `pre-stream-probe-${crypto.randomUUID()}`;
    const path = `/agents/pre-stream-agui-agent/${room}`;
    const stub = (await getAgentByName(
      env.PreStreamAguiAgent,
      room
    )) as unknown as PreStreamStub;

    const ws1 = await connectChatWS(path);
    const requestId = "req-pre-stream-probe";
    sendChatRequest(ws1, requestId, [userMessage("u1", "hi")], {
      responseDelayMs: 1000
    });
    await waitForHandlerEntered(stub, requestId);

    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);
    ws2.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
        probeId: "probe-pre-stream"
      })
    );

    // onConnect already parked ws2 (an un-echoed STREAM_PENDING); the explicit
    // probe gets its own PENDING with the probe id echoed back so the client's
    // `reconnectToStream` can match it.
    const pending = await rec2.waitFor(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.STREAM_PENDING &&
        f.probeId === "probe-pre-stream"
    );
    expect(pending.id).toBe(requestId);
    expect(hasType(rec2.frames, CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE)).toBe(
      false
    );

    ws1.close(1000);
    ws2.close(1000);
  });

  it("releases a parked client with STREAM_RESUME_NONE when the turn settles without ever streaming", async () => {
    // `PreThrowAguiAgent` throws before returning a Response, so the turn is
    // accepted, parks the reconnecting client, and then settles with no stream
    // — the release leg the `_settlePreStreamTurn` backstop covers.
    const room = `pre-stream-no-stream-${crypto.randomUUID()}`;
    const path = `/agents/pre-throw-agui-agent/${room}`;

    const ws1 = await connectChatWS(path);
    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);

    sendChatRequest(ws1, "req-no-stream", [userMessage("u1", "hi")]);

    // ws2 was already connected, so it is not parked by onConnect; probe it
    // into the park instead, racing the turn. It parks and is released, or the
    // turn already settled and it is answered straight away — with RESUME_NONE
    // if nothing is left to say, or with the resume handshake that carries the
    // recorded terminal (#1645), since a pre-Response throw is a terminal turn.
    // All three end at "not waiting forever", which is the contract.
    ws2.send(
      JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST })
    );
    await rec2.waitFor(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE ||
        f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING
    );

    ws1.close(1000);
    ws2.close(1000);
  });

  it("keeps a client parked across overlapping submits until a turn streams, never cutting it loose early", async () => {
    const room = `pre-stream-overlap-${crypto.randomUUID()}`;
    const path = `/agents/pre-stream-latest-agui-agent/${room}`;
    const stub = (await getAgentByName(
      env.PreStreamLatestAguiAgent,
      room
    )) as unknown as PreStreamStub;

    const ws1 = await connectChatWS(path);
    const firstId = "req-first";
    sendChatRequest(ws1, firstId, [userMessage("u1", "hi")], {
      responseDelayMs: 1000
    });
    await waitForHandlerEntered(stub, firstId);

    const ws2 = await connectChatWS(path);
    const rec2 = recordFrames(ws2);
    await rec2.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_PENDING);

    // A second overlapping submit lands while the first is still pre-stream.
    // Whatever the `latest` policy decides, the parked client must resume onto
    // whichever turn actually streams — it must NOT receive a premature
    // RESUME_NONE while a turn is still in flight (the supersede/settle race
    // the `releaseParked: false` skip-path guard closes).
    sendChatRequest(ws1, "req-second", [userMessage("u2", "again")], {
      responseDelayMs: 10
    });

    await rec2.waitFor((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING);

    const firstResuming = rec2.frames.findIndex(
      (f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING
    );
    expect(
      hasType(
        rec2.frames.slice(0, firstResuming),
        CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
      )
    ).toBe(false);

    ws1.close(1000);
    ws2.close(1000);
  });
});
