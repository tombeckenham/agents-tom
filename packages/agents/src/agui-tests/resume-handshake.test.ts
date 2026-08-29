/**
 * Resume handshake — terminal replay to reconnecting clients.
 *
 * `AGUIChatAgent` drives the shared `ResumeHandshake`, so a turn that
 * terminalized while nobody was connected is replayed over the standard
 * reconnect probe: RESUME_REQUEST → STREAM_RESUMING → ACK → the pre-error
 * partial content (#1575) followed by the durable terminal frame (#1645).
 * Ports the `#1645` reconnect leg of
 * `packages/ai-chat/src/tests/durable-chat-recovery.test.ts` and the whole of
 * `packages/ai-chat/src/tests/errored-stream-replay.test.ts` on the AG-UI
 * shape. The decision tree itself is unit-tested in
 * `packages/agents/src/chat/__tests__/resume-handshake.test.ts`; these legs
 * prove the wiring end-to-end over a real DO WebSocket.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { AGUIEvent } from "../chat/agui-types";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import { connectChatWS, recordFrames, type WireFrame } from "./test-utils";

const TERMINAL = "Recovery exhausted — the assistant could not finish.";

/** The subset of `RecoveryAguiAgent`'s test RPC surface these legs drive. */
interface RecoveryStub {
  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): Promise<void>;
  setForceStableTimeoutForTest(value: boolean): Promise<void>;
  seedIncidentForTest(incident: Record<string, unknown>): Promise<void>;
  runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  getExhaustedContextsForTest(): Promise<unknown[]>;
  getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null>;
  driveErroredTurnForTest(
    message: string,
    afterChunks?: number
  ): Promise<string>;
}

async function getTestAgent(room: string): Promise<RecoveryStub> {
  return (await getAgentByName(
    env.RecoveryAguiAgent,
    room
  )) as unknown as RecoveryStub;
}

/** Drive a recovery to exhaustion with no client attached. */
async function exhaustWithNoClient(stub: RecoveryStub, tag: string) {
  await stub.enableExhaustedCaptureForTest(6, TERMINAL);
  await stub.setForceStableTimeoutForTest(true);
  await stub.seedIncidentForTest({
    incidentId: `inc-${tag}`,
    requestId: `root-${tag}`,
    recoveryKind: "continue",
    attempt: 6,
    maxAttempts: 6,
    status: "scheduled",
    firstSeenAt: Date.now(),
    lastAttemptAt: Date.now()
  });
  await stub.runChatRecoveryContinueDirectForTest({
    incidentId: `inc-${tag}`,
    originalRequestId: `root-${tag}`,
    targetAssistantId: `a-${tag}`
  });
  expect(await stub.getExhaustedContextsForTest()).toHaveLength(1);
}

/**
 * Run the reconnect probe exactly as `WebSocketChatTransport` does: send
 * RESUME_REQUEST, ACK any STREAM_RESUMING offer, and settle once a terminal
 * done frame or a RESUME_NONE arrives.
 */
async function reconnectAndProbe(
  path: string,
  probeId?: string
): Promise<{ frames: WireFrame[] }> {
  const ws = await connectChatWS(path);
  const rec = recordFrames(ws);
  ws.addEventListener("message", (event: MessageEvent) => {
    let frame: WireFrame;
    try {
      frame = JSON.parse(event.data as string) as WireFrame;
    } catch {
      return;
    }
    if (frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING) {
      ws.send(
        JSON.stringify({
          type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
          id: frame.id
        })
      );
    }
  });
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
      ...(probeId ? { probeId } : {})
    })
  );
  await rec.waitFor(
    (f) =>
      (f.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && f.done === true) ||
      f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
  );
  ws.close(1000);
  return { frames: rec.frames };
}

function terminalFrame(frames: WireFrame[]): WireFrame | undefined {
  return frames.find(
    (f) =>
      f.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE &&
      f.error === true &&
      f.done === true
  );
}

/** Text deltas carried by replayed (non-error) response frames, in order. */
function replayedDeltas(frames: WireFrame[]): string[] {
  return frames
    .filter(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE &&
        f.replay === true &&
        !f.error &&
        !!f.body?.length
    )
    .map((f) => JSON.parse(f.body as string) as AGUIEvent)
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => (e as { delta: string }).delta);
}

describe("AGUIChatAgent — resume handshake", () => {
  it("replays the terminal exhaustion to a client that reconnects after it ended (#1645)", async () => {
    const room = `terminal-reconnect-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await exhaustWithNoClient(stub, "reconnect");

    const { frames } = await reconnectAndProbe(
      `/agents/recovery-agui-agent/${room}`
    );

    const terminal = terminalFrame(frames);
    expect(
      terminal,
      `expected a terminal error frame; got types: ${JSON.stringify(
        frames.map((f) => f.type)
      )}`
    ).toBeTruthy();
    expect(terminal?.body).toBe(TERMINAL);
  });

  it("echoes the probe id on the resume offer and its terminal replay (#1733)", async () => {
    const room = `terminal-probe-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await exhaustWithNoClient(stub, "probe");

    const { frames } = await reconnectAndProbe(
      `/agents/recovery-agui-agent/${room}`,
      "probe-7"
    );

    const resuming = frames.find(
      (f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING
    );
    expect(resuming?.probeId).toBe("probe-7");
    expect(terminalFrame(frames)?.body).toBe(TERMINAL);
  });

  it("retains the terminal record so a second reconnect also learns the outcome (#1645)", async () => {
    const room = `terminal-twice-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    await exhaustWithNoClient(stub, "twice");

    const path = `/agents/recovery-agui-agent/${room}`;
    expect(terminalFrame((await reconnectAndProbe(path)).frames)?.body).toBe(
      TERMINAL
    );
    // A second tab reconnecting must see it too — the record is cleared only
    // when a later turn supersedes it.
    expect(terminalFrame((await reconnectAndProbe(path)).frames)?.body).toBe(
      TERMINAL
    );
    expect(await stub.getPendingChatTerminalForTest()).toMatchObject({
      body: TERMINAL
    });
  });

  it("replays pre-error partial content before the terminal error (#1575)", async () => {
    const room = `errored-partial-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const STREAM_ERROR = "in-band boom";

    expect(await stub.driveErroredTurnForTest(STREAM_ERROR, 3)).toBe("error");

    const { frames } = await reconnectAndProbe(
      `/agents/recovery-agui-agent/${room}`
    );

    expect(replayedDeltas(frames)).toEqual([
      "partial-0 ",
      "partial-1 ",
      "partial-2 "
    ]);
    const terminal = terminalFrame(frames);
    expect(terminal?.body).toBe(STREAM_ERROR);
    // The terminal frame is last — a reconnecting client observes the same
    // sequence a live one did: content, then the error.
    const responses = frames.filter(
      (f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    );
    expect(responses[responses.length - 1]).toBe(terminal);
  });

  it("delivers only the terminal error when the error preceded any content (#1527)", async () => {
    const room = `errored-early-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const STREAM_ERROR = "early in-band boom";

    expect(await stub.driveErroredTurnForTest(STREAM_ERROR)).toBe("error");

    const { frames } = await reconnectAndProbe(
      `/agents/recovery-agui-agent/${room}`
    );

    expect(replayedDeltas(frames)).toEqual([]);
    expect(terminalFrame(frames)?.body).toBe(STREAM_ERROR);
  });

  it("answers an idle probe with STREAM_RESUME_NONE carrying reason and probe id (#1914)", async () => {
    const room = `idle-probe-${crypto.randomUUID()}`;
    const path = `/agents/recovery-agui-agent/${room}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
        probeId: "probe-idle"
      })
    );
    const none = await rec.waitFor(
      (f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
    );
    ws.close(1000);

    expect(none.reason).toBe("idle");
    expect(none.probeId).toBe("probe-idle");
  });
});
