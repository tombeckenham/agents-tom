/**
 * Agent-tool child re-attach: request_id rebinding across recovery. Port of
 * `packages/ai-chat/src/tests/agent-tool-reattach-recovery.test.ts` on the
 * AG-UI shape: when an AGUIChatAgent facet running as an agent-tool child is
 * interrupted mid-run and recovers, its recovery turn mints a NEW request id.
 * If `cf_ai_chat_agent_tool_runs.request_id` is not re-bound, the parent's
 * re-attach tail can no longer attribute the recovered turn's frames, so a
 * healthy long-running child is abandoned as `interrupted` once the
 * no-progress budget elapses. The fix re-binds on both recovery paths.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { AGUIMessage } from "../chat/agui-types";
import type { Env } from "./worker";

interface ReattachStub {
  seedAgentToolChildRunForTest(runId: string, requestId: string): Promise<void>;
  getAgentToolChildRunRequestIdForTest(runId: string): Promise<string | null>;
  resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null>;
  persistMessages(messages: AGUIMessage[]): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
  runScheduledRecoveryContinueForTest(): Promise<void>;
  runScheduledRecoveryRetryForTest(): Promise<void>;
}

async function getStub(room: string): Promise<ReattachStub> {
  const stub = await getAgentByName((env as Env).RecoveryAguiAgent, room);
  return stub as unknown as ReattachStub;
}

describe("agent-tool child re-attach: request_id rebinding across recovery", () => {
  it("re-binds the child-run request_id on a CONTINUE recovery so frames stay attributable", async () => {
    const agent = await getStub(`reattach-continue-${crypto.randomUUID()}`);

    await agent.seedAgentToolChildRunForTest(
      "run-continue",
      "old-req-continue"
    );

    await agent.persistMessages([
      { id: "u-reattach-continue", role: "user", content: "do the long job" },
      {
        id: "a-reattach-continue",
        role: "assistant",
        content: "Partial answer"
      }
    ]);

    await agent.insertInterruptedStream(
      "stream-reattach-continue",
      "req-reattach-continue",
      [
        {
          body: JSON.stringify({
            type: "RUN_STARTED",
            threadId: "t1",
            runId: "r1"
          }),
          index: 0
        },
        {
          body: JSON.stringify({
            type: "TEXT_MESSAGE_START",
            messageId: "a-reattach-continue",
            role: "assistant"
          }),
          index: 1
        },
        {
          body: JSON.stringify({
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "a-reattach-continue",
            delta: "Partial answer"
          }),
          index: 2
        }
      ]
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-continue"
    );

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryContinueForTest();

    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-continue");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-continue");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-continue");
  });

  it("re-binds the child-run request_id on a RETRY recovery so frames stay attributable", async () => {
    const agent = await getStub(`reattach-retry-${crypto.randomUUID()}`);

    await agent.seedAgentToolChildRunForTest("run-retry", "old-req-retry");

    await agent.persistMessages([
      { id: "u-reattach-retry", role: "user", content: "do the long job" }
    ]);

    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-retry",
      {
        __cfAIChatFiberSnapshot: {
          kind: "ai-chat-turn",
          version: 1,
          requestId: "req-reattach-retry",
          continuation: false,
          latestMessageId: "u-reattach-retry",
          latestMessageRole: "user",
          latestUserMessageId: "u-reattach-retry",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryRetryForTest();

    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-retry");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-retry");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-retry");
  });
});
