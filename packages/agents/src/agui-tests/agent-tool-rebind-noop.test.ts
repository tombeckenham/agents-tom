/**
 * Agent-tool rebind: no-op safety on non-child recovery. Port of
 * `packages/ai-chat/src/tests/agent-tool-rebind-noop.test.ts`: the
 * re-attach-budget rebind runs on EVERY recovery continuation, so it must be
 * an unambiguous no-op when this recovery is NOT for a live agent-tool child
 * run. (AGUIChatAgent always has the `cf_ai_chat_agent_tool_runs` table —
 * created in the constructor — so the "no table" case is Think-only.)
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import type { Env } from "./worker";

interface RebindStub {
  seedAgentToolChildRunForTest(
    runId: string,
    requestId: string,
    startedAt?: number
  ): Promise<void>;
  seedSettledAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void>;
  rebindAgentToolChildRunRequestIdForTest(requestId: string): Promise<void>;
  getAgentToolChildRunRequestIdForTest(runId: string): Promise<string | null>;
  resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null>;
}

async function freshRecoveryAgent(name: string): Promise<RebindStub> {
  const stub = await getAgentByName((env as Env).RecoveryAguiAgent, name);
  return stub as unknown as RebindStub;
}

describe("agent-tool rebind: no-op safety on non-child recovery (AG-UI)", () => {
  it("does not rewrite a SETTLED child-run row during an unrelated recovery", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-settled-${crypto.randomUUID()}`
    );

    await agent.seedSettledAgentToolChildRunForTest(
      "run-settled",
      "old-settled-req"
    );

    await agent.rebindAgentToolChildRunRequestIdForTest("normal-turn-req");

    expect(
      await agent.getAgentToolChildRunRequestIdForTest("run-settled")
    ).toBe("old-settled-req");
    expect(
      await agent.resolveAgentToolRunForRequestForTest("normal-turn-req")
    ).toBeNull();
  });

  it("rebinds only the newest active row when several are non-terminal (defensive)", async () => {
    const agent = await freshRecoveryAgent(
      `rebind-noop-multi-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest("run-old", "old-req", 1_000);
    await agent.seedAgentToolChildRunForTest("run-new", "new-req", 2_000);

    await agent.rebindAgentToolChildRunRequestIdForTest("recovery-req");

    expect(await agent.getAgentToolChildRunRequestIdForTest("run-new")).toBe(
      "recovery-req"
    );
    expect(await agent.getAgentToolChildRunRequestIdForTest("run-old")).toBe(
      "old-req"
    );
    expect(
      await agent.resolveAgentToolRunForRequestForTest("recovery-req")
    ).toBe("run-new");
  });
});
