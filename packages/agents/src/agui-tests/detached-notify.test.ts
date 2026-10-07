/**
 * Detached notify / milestone injection — port of
 * `packages/ai-chat/src/tests/detached-notify.test.ts` on the AG-UI shape.
 * The injected notification is a plain user/assistant message with string
 * `content` (AG-UI has no `parts`); `metadata` rides as an extra persisted
 * property.
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "../index";
import { describe, expect, it } from "vitest";
import type { AGUIMessage } from "../chat/agui-types";
import type { Env } from "./worker";

function getParent(name = crypto.randomUUID()) {
  return getAgentByName((env as Env).DetachedNotifyAguiAgent, name);
}

function textOf(message: AGUIMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function metadataOf(message: AGUIMessage): Record<string, unknown> | undefined {
  return (message as { metadata?: Record<string, unknown> }).metadata;
}

describe("AGUIChatAgent detached notify / milestones", () => {
  it("notify injects a user turn the model reacts to, and is idempotent across re-delivery", async () => {
    const parent = await getParent();

    await parent.notifyDetachedFinishForTest({
      runId: "notify-run",
      notifySource: "research-background",
      times: 2
    });

    const messages = (await parent.getMessagesForTest()) as AGUIMessage[];
    const injected = messages.filter(
      (message) => message.id === "detached-finish:notify-run:completed"
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]?.role).toBe("user");
    expect(textOf(injected[0]!)).toContain("detached summary");
    expect(metadataOf(injected[0]!)).toMatchObject({
      source: "research-background",
      runId: "notify-run",
      agentType: "Researcher",
      status: "completed"
    });

    // Exactly one model turn despite two deliveries (the second is deduped on
    // id before it can persist or trigger inference).
    expect(await parent.getChatMessageCallCountForTest()).toBe(1);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("narrate milestone injects a synthetic assistant line with no model turn", async () => {
    const parent = await getParent();

    await parent.notifyDetachedMilestoneForTest({
      runId: "ms-narrate",
      name: "sources-gathered",
      notifySource: "research-background",
      times: 2,
      mode: "narrate"
    });

    const messages = (await parent.getMessagesForTest()) as AGUIMessage[];
    const injected = messages.filter(
      (message) => message.id === "detached-ms:ms-narrate:sources-gathered"
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]?.role).toBe("assistant");
    expect(textOf(injected[0]!)).toContain("sources-gathered");
    expect(metadataOf(injected[0]!)).toMatchObject({
      source: "research-background",
      runId: "ms-narrate",
      milestone: "sources-gathered"
    });

    // narrate must NOT run inference — the assistant line is injected directly.
    expect(await parent.getChatMessageCallCountForTest()).toBe(0);
  });

  it("react milestone injects a user turn and triggers a single reply, idempotent across re-delivery", async () => {
    const parent = await getParent();

    await parent.notifyDetachedMilestoneForTest({
      runId: "ms-react",
      name: "preview-ready",
      times: 2,
      mode: "react"
    });

    const messages = (await parent.getMessagesForTest()) as AGUIMessage[];
    const injected = messages.filter(
      (message) => message.id === "detached-ms:ms-react:preview-ready"
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]?.role).toBe("user");

    expect(await parent.getChatMessageCallCountForTest()).toBe(1);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
  });
});
