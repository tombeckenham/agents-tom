/**
 * Request context (`_lastBody` / `_lastClientTools`) across turns.
 *
 * The custom body and client-tool schemas a client sends with a chat request
 * are stored on the agent and REPLAYED into every continuation the server
 * drives on its own (the client is not in that loop, so it cannot resend
 * them). They are also persisted to `cf_ai_chat_request_context` so a
 * hibernated agent restores them on a cold start.
 *
 * Both halves need pinning: replaying them is the feature, and DROPPING them on
 * chat-clear is the safety property — otherwise a cleared conversation's next
 * continuation runs with the previous conversation's model/tool config, from
 * memory AND from disk. Port of
 * `packages/ai-chat/src/tests/custom-body-continuation.test.ts` on the AG-UI
 * shape.
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

const CLIENT_TOOLS = [
  { name: "testTool", description: "a client-resolved tool" }
];
const CUSTOM_BODY = { model: "gpt-4", temperature: 0.7 };

interface RequestContextStub {
  persistParallelToolCallsForTest(
    messageId: string,
    toolCallIds: string[]
  ): Promise<void>;
  getCapturedBodiesForTest(): Promise<
    Array<Record<string, unknown> | undefined>
  >;
  getCapturedClientToolsForTest(): Promise<
    Array<Array<{ name: string; description?: string }> | undefined>
  >;
  clearCapturedContextForTest(): Promise<void>;
  getPersistedRequestContextForTest(): Promise<Record<string, string>>;
  reloadRequestContextForTest(): Promise<void>;
  getStartedRequestIds(): Promise<string[]>;
  waitUntilStableForTest(timeout?: number): Promise<boolean>;
}

async function getTestAgent(room: string): Promise<RequestContextStub> {
  return (await getAgentByName(
    env.AutoContinueAguiAgent,
    room
  )) as unknown as RequestContextStub;
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

function sendToolResult(ws: WebSocket, toolCallId: string) {
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
      toolCallId,
      toolName: "testTool",
      output: { ok: true },
      state: "output-available",
      autoContinue: true
    })
  );
}

describe("AGUIChatAgent — request context across continuations", () => {
  it("replays the request body and clientTools into a live auto-continuation", async () => {
    const room = `ctx-continuation-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req-ctx", [userMessage("u1", "hello")], {
      clientTools: CLIENT_TOOLS,
      ...CUSTOM_BODY
    });
    await rec.waitFor(isDoneFrame("req-ctx"));

    // `clientTools` is a reserved top-level field: it is lifted out of the body
    // rather than forwarded as a custom key.
    expect(await stub.getCapturedBodiesForTest()).toEqual([CUSTOM_BODY]);
    expect(await stub.getCapturedClientToolsForTest()).toEqual([CLIENT_TOOLS]);

    // A client tool answered with `autoContinue` — the continuation is driven
    // entirely server-side, so the only source for body/clientTools is the
    // stored context.
    await stub.persistParallelToolCallsForTest("assistant-batch", ["call_ctx"]);
    await stub.clearCapturedContextForTest();
    sendToolResult(ws, "call_ctx");
    await waitUntil(
      async () => (await stub.getStartedRequestIds()).length === 1
    );
    await stub.waitUntilStableForTest(10_000);

    expect(await stub.getCapturedBodiesForTest()).toEqual([CUSTOM_BODY]);
    expect(await stub.getCapturedClientToolsForTest()).toEqual([CLIENT_TOOLS]);

    ws.close(1000);
  });

  it("drops body and clientTools on chat-clear — in memory, on disk, and after a cold start", async () => {
    const room = `ctx-clear-${crypto.randomUUID()}`;
    const stub = await getTestAgent(room);
    const ws = await connectChatWS(`/agents/auto-continue-agui-agent/${room}`);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req-ctx", [userMessage("u1", "hello")], {
      clientTools: CLIENT_TOOLS,
      ...CUSTOM_BODY
    });
    await rec.waitFor(isDoneFrame("req-ctx"));

    expect(
      Object.keys(await stub.getPersistedRequestContextForTest()).sort()
    ).toEqual(["lastBody", "lastClientTools"]);

    ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }));
    await waitUntil(
      async () =>
        Object.keys(await stub.getPersistedRequestContextForTest()).length === 0
    );

    // A cold start rehydrates from exactly the rows the clear just deleted, so
    // the restored context must come back empty too.
    await stub.reloadRequestContextForTest();

    await stub.persistParallelToolCallsForTest("assistant-batch", [
      "call_after_clear"
    ]);
    await stub.clearCapturedContextForTest();
    sendToolResult(ws, "call_after_clear");
    await waitUntil(
      async () => (await stub.getStartedRequestIds()).length === 1
    );
    await stub.waitUntilStableForTest(10_000);

    expect(await stub.getCapturedBodiesForTest()).toEqual([undefined]);
    expect(await stub.getCapturedClientToolsForTest()).toEqual([undefined]);

    ws.close(1000);
  });
});
