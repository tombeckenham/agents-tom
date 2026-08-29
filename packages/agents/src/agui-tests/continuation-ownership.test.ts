/**
 * Continuation affinity on resume (#1914 / #1784).
 *
 * A continuation turn is driven on behalf of ONE client — the one that answered
 * the tool call. While its stream is live, a resume probe from a DIFFERENT
 * client must be denied with `reason: "continuation-owned"` rather than handed
 * the stream, so a second tab cannot steal a continuation the first tab is
 * still reading. The denial is conditional on the owner still being connected:
 * if it vanished on an abrupt (1006) close, the replacement connection must be
 * allowed to resume instead of being locked out forever.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  connectChatWS,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage
} from "./test-utils";

interface OwnershipStub {
  persistParallelToolCallsForTest(
    messageId: string,
    toolCallIds: string[]
  ): Promise<void>;
  hasActiveStreamForTest(): Promise<boolean>;
  setContinuationOwnerForTest(connectionId: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

/**
 * Drive client A to the point where it owns a LIVE continuation stream:
 * a priming turn stores the body, then a client tool answered with
 * `autoContinue` fires a continuation whose stream is deliberately slow.
 */
async function startOwnedContinuation(): Promise<{
  path: string;
  stub: OwnershipStub;
  wsA: WebSocket;
}> {
  const room = `cont-owned-${crypto.randomUUID()}`;
  const path = `/agents/auto-continue-agui-agent/${room}`;
  const stub = (await getAgentByName(
    env.AutoContinueAguiAgent,
    room
  )) as unknown as OwnershipStub;

  const wsA = await connectChatWS(path);
  const recA = recordFrames(wsA);
  sendChatRequest(wsA, "req-prime", [userMessage("u1", "hello")], {
    continuationStreamChunks: 25
  });
  await recA.waitFor(isDoneFrame("req-prime"));

  await stub.persistParallelToolCallsForTest("assistant-batch", ["call_own"]);
  wsA.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
      toolCallId: "call_own",
      toolName: "testTool",
      output: { ok: true },
      state: "output-available",
      autoContinue: true
    })
  );
  await waitUntil(() => stub.hasActiveStreamForTest());
  return { path, stub, wsA };
}

describe("AGUIChatAgent — continuation ownership on resume", () => {
  it("denies a second client's resume probe with reason continuation-owned", async () => {
    const { path, wsA } = await startOwnedContinuation();

    const wsB = await connectChatWS(path);
    const recB = recordFrames(wsB);
    wsB.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
        probeId: "probe-b"
      })
    );

    // Only the EXPLICIT probe is subject to the affinity check — onConnect's
    // proactive (probe-less) STREAM_RESUMING is sent regardless, so the probe
    // id is what distinguishes the answer to B's question.
    const none = await recB.waitFor(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE &&
        f.probeId === "probe-b"
    );
    expect(none.reason).toBe("continuation-owned");

    wsA.close(1000);
    wsB.close(1000);
  });

  it("lets a replacement client resume once the owner connection is gone (#1784)", async () => {
    const { path, stub, wsA } = await startOwnedContinuation();

    // The state an abrupt 1006 close leaves: the owner id is still recorded
    // (onClose never ran to null it) but no such connection is attached any
    // more. Without the `_isConnectionPresent` check the handshake would keep
    // denying every reconnect for the rest of the stream.
    await stub.setContinuationOwnerForTest("ghost-connection-id");

    const wsB = await connectChatWS(path);
    const recB = recordFrames(wsB);
    wsB.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
        probeId: "probe-ghost"
      })
    );

    const resuming = await recB.waitFor(
      (f) =>
        f.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING &&
        f.probeId === "probe-ghost"
    );
    expect(resuming.type).toBe(CHAT_MESSAGE_TYPES.STREAM_RESUMING);
    expect(
      recB.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE)
    ).toBe(false);

    wsA.close(1000);
    wsB.close(1000);
  });
});
