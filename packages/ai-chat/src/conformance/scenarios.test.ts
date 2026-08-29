/**
 * Conformance scenario matrix for the legacy `AIChatAgent`.
 *
 * Each test drives one scenario family over WebSocket against a fixture DO,
 * records the normalized trace, and diffs it against the committed golden in
 * `./goldens/`. Re-record with `UPDATE_GOLDENS=1 pnpm test:conformance`.
 */

import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Agent, getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import {
  connectClient,
  expectGolden,
  fetchClientView,
  finishTrace,
  isAnyDone,
  isDone,
  isTextDelta,
  sendCancel,
  sendChatRequest,
  sendToolApproval,
  sendToolResult,
  userMessage
} from "./harness";

// Warm up the worker module graph before tests run (mirrors src/tests/setup.ts).
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 30_000);

afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

async function scripted<T extends Agent<Cloudflare.Env>>(
  namespace: DurableObjectNamespace<T>,
  kebab: string
) {
  const room = crypto.randomUUID();
  const path = `/agents/${kebab}/${room}`;
  const stub = await getAgentByName(namespace, room);
  return { path, stub } as const;
}

/** Single-client scripted turn: send one request, wait for done, snapshot. */
async function runScriptedScenario(golden: string, scenario: string) {
  const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
  const client = await connectClient(path);
  sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
    scenario
  });
  await client.waitFor(
    (f) => f.id === "req-1" && (f.done === true || f.error === true)
  );
  const trace = await finishTrace({
    scenario: golden,
    path,
    stub,
    clients: [client]
  });
  await expectGolden(golden, trace);
}

describe("conformance: legacy AIChatAgent", () => {
  it("plain text turn", async () => {
    await runScriptedScenario("plain-text", "plain-text");
  });

  it("reasoning", async () => {
    await runScriptedScenario("reasoning", "reasoning");
  });

  it("single tool call", async () => {
    await runScriptedScenario("tool-single", "tool-single");
  });

  it("parallel tool calls", async () => {
    await runScriptedScenario("tool-parallel", "tool-parallel");
  });

  it("metadata, data parts, files, sources", async () => {
    await runScriptedScenario("metadata-parts", "metadata");
  });

  it("plaintext (non-SSE) response", async () => {
    await runScriptedScenario("plaintext-response", "plaintext");
  });

  it("no response body", async () => {
    await runScriptedScenario("no-response", "no-response");
  });

  it("error mid-stream", async () => {
    await runScriptedScenario("error-midstream", "error-mid");
  });

  it("pre-Response throw", async () => {
    // Legacy behavior: an onChatMessage throw before a Response is produced
    // sends NO wire frame to the requesting client — the trace pins that.
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
      scenario: "pre-throw"
    });
    await waitUntil(async () => (await stub.calls()) >= 1);
    const trace = await finishTrace({
      scenario: "pre-response-throw",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("pre-response-throw", trace);
  });

  it("client tool + continuation", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
      scenario: "client-tool",
      clientTools: [
        {
          name: "clientEcho",
          description: "Echoes on the client",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } }
          }
        }
      ]
    });
    await client.waitFor(isDone("req-1"));
    sendToolResult(client, "call-client-1", "clientEcho", { echoed: "hi" });
    await client.waitFor((f) => isAnyDone(f) && f.id !== "req-1");
    const trace = await finishTrace({
      scenario: "client-tool-continuation",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("client-tool-continuation", trace);
  });

  it("tool approval: approve", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "do it")], {
      scenario: "approval"
    });
    await client.waitFor(isDone("req-1"));
    sendToolApproval(client, "call-approval-1", true);
    await client.waitFor((f) => isAnyDone(f) && f.id !== "req-1");
    const trace = await finishTrace({
      scenario: "tool-approval-approve",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("tool-approval-approve", trace);
  });

  it("tool approval: deny", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "do it")], {
      scenario: "approval"
    });
    await client.waitFor(isDone("req-1"));
    sendToolApproval(client, "call-approval-1", false);
    await client.waitFor((f) => isAnyDone(f) && f.id !== "req-1");
    const trace = await finishTrace({
      scenario: "tool-approval-deny",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("tool-approval-deny", trace);
  });

  it("cancel mid-stream", async () => {
    const { path, stub } = await scripted(env.GatedAgent, "gated-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "hello")]);
    await client.waitFor(isTextDelta);
    sendCancel(client, "req-1");
    await client.waitFor(isDone("req-1"));
    await stub.release();
    const trace = await finishTrace({
      scenario: "cancel-midstream",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("cancel-midstream", trace);
  });

  it("resume mid-stream (second client)", async () => {
    const { path, stub } = await scripted(env.GatedAgent, "gated-agent");
    const c1 = await connectClient(path);
    sendChatRequest(c1, "req-1", [userMessage("u-1", "hello")]);
    await c1.waitFor(isTextDelta);

    const c2 = await connectClient(path);
    await c2.waitFor((f) => f.type === MessageType.CF_AGENT_STREAM_RESUMING);
    c2.ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: "req-1"
      })
    );
    await c2.waitFor((f) => f.replayComplete === true);
    await stub.release();
    await c1.waitFor(isDone("req-1"));
    await c2.waitFor(isDone("req-1"));
    const trace = await finishTrace({
      scenario: "resume-midstream",
      path,
      stub,
      clients: [c1, c2]
    });
    await expectGolden("resume-midstream", trace);
  });

  it("multi-client broadcast", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const c1 = await connectClient(path);
    const c2 = await connectClient(path);
    sendChatRequest(c1, "req-1", [userMessage("u-1", "hello")], {
      scenario: "plain-text"
    });
    await c1.waitFor(isDone("req-1"));
    await c2.waitFor(isDone("req-1"));
    const trace = await finishTrace({
      scenario: "multi-client-broadcast",
      path,
      stub,
      clients: [c1, c2]
    });
    await expectGolden("multi-client-broadcast", trace);
  });

  it("regenerate", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
      scenario: "plain-text"
    });
    await client.waitFor(isDone("req-1"));

    // Regenerate: client resends the list without the assistant reply.
    const view = (await fetchClientView(path)) as ChatMessage[];
    const withoutAssistant = view.filter((m) => m.role !== "assistant");
    sendChatRequest(client, "req-2", withoutAssistant, {
      scenario: "plain-text",
      trigger: "regenerate-message"
    });
    await client.waitFor(isDone("req-2"));
    const trace = await finishTrace({
      scenario: "regenerate",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("regenerate", trace);
  });

  it("maxPersistedMessages trimming", async () => {
    const { path, stub } = await scripted(
      env.MaxPersistedAgent,
      "max-persisted-agent"
    );
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "first")], {
      scenario: "plain-text"
    });
    await client.waitFor(isDone("req-1"));

    const view = (await fetchClientView(path)) as ChatMessage[];
    sendChatRequest(client, "req-2", [...view, userMessage("u-2", "second")], {
      scenario: "plain-text"
    });
    await client.waitFor(isDone("req-2"));
    const trace = await finishTrace({
      scenario: "max-persisted",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("max-persisted", trace);
  });

  it("messageConcurrency: queue (default)", async () => {
    const { path, stub } = await scripted(env.GatedAgent, "gated-agent");
    const client = await connectClient(path);
    sendChatRequest(client, "req-a", [userMessage("u-a", "first")]);
    await client.waitFor(isTextDelta);
    sendChatRequest(client, "req-b", [
      userMessage("u-a", "first"),
      userMessage("u-b", "second")
    ]);
    await stub.release();
    await client.waitFor(isDone("req-a"));
    await client.waitFor(isDone("req-b"));
    const trace = await finishTrace({
      scenario: "concurrency-queue",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("concurrency-queue", trace);
  });

  it("messageConcurrency: latest", async () => {
    // `latest` lets the active turn finish and runs only the NEWEST queued
    // overlapping submit — here req-b is superseded by req-c.
    const { path, stub } = await scripted(
      env.LatestGatedAgent,
      "latest-gated-agent"
    );
    const client = await connectClient(path);
    sendChatRequest(client, "req-a", [userMessage("u-a", "first")]);
    await client.waitFor(isTextDelta);
    sendChatRequest(client, "req-b", [
      userMessage("u-a", "first"),
      userMessage("u-b", "second")
    ]);
    sendChatRequest(client, "req-c", [
      userMessage("u-a", "first"),
      userMessage("u-b", "second"),
      userMessage("u-c", "third")
    ]);
    await waitUntil(async () => (await stub.overlapping()) >= 2);
    await stub.release();
    await client.waitFor(isDone("req-a"));
    await client.waitFor(isDone("req-c"));
    const trace = await finishTrace({
      scenario: "concurrency-latest",
      path,
      stub,
      clients: [client],
      sortFramesByRequestId: true
    });
    await expectGolden("concurrency-latest", trace);
  });

  it("messageConcurrency: drop", async () => {
    const { path, stub } = await scripted(
      env.DropGatedAgent,
      "drop-gated-agent"
    );
    const client = await connectClient(path);
    sendChatRequest(client, "req-a", [userMessage("u-a", "first")]);
    await client.waitFor(isTextDelta);
    sendChatRequest(client, "req-b", [
      userMessage("u-a", "first"),
      userMessage("u-b", "second")
    ]);
    await client.waitFor(isDone("req-b"));
    await stub.release();
    await client.waitFor(isDone("req-a"));
    const trace = await finishTrace({
      scenario: "concurrency-drop",
      path,
      stub,
      clients: [client],
      sortFramesByRequestId: true
    });
    await expectGolden("concurrency-drop", trace);
  });

  it("saveMessages programmatic turn", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const client = await connectClient(path);
    await stub.programmaticTurn("from the server");
    await client.waitFor(isAnyDone);
    const trace = await finishTrace({
      scenario: "save-messages",
      path,
      stub,
      clients: [client]
    });
    await expectGolden("save-messages", trace);
  });

  it("clear history", async () => {
    const { path, stub } = await scripted(env.ScriptedAgent, "scripted-agent");
    const c1 = await connectClient(path);
    const c2 = await connectClient(path);
    sendChatRequest(c1, "req-1", [userMessage("u-1", "hello")], {
      scenario: "plain-text"
    });
    await c1.waitFor(isDone("req-1"));
    c1.ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await c2.waitFor((f) => f.type === MessageType.CF_AGENT_CHAT_CLEAR);
    const trace = await finishTrace({
      scenario: "clear-history",
      path,
      stub,
      clients: [c1, c2]
    });
    await expectGolden("clear-history", trace);
  });
});
