/**
 * Conformance scenario matrix, run against BOTH stacks:
 *
 * - legacy `AIChatAgent` (`../index.ts`): traces snapshot to `./goldens/`.
 *   Re-record with `UPDATE_GOLDENS=1 pnpm test:conformance`.
 * - projected `AIChatAgent` (`../agent.ts`, AG-UI engine underneath): traces
 *   are projected back to legacy shape (see harness) and diffed against the
 *   SAME goldens. A mismatch is divergent unless the scenario has a
 *   `goldens/<name>.allowlist.md` documenting the semantic equivalence, in
 *   which case the projected trace pins to `goldens/<name>.projected.json`.
 */

import { env } from "cloudflare:workers";
import { describe, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import {
  type Client,
  type Trace,
  connectClient,
  expectGolden,
  expectProjectedGolden,
  fetchClientView,
  finishTrace,
  isAnyDone,
  isDone,
  isTextDelta,
  projectViewToLegacy,
  sendCancel,
  sendChatRequest,
  sendToolApproval,
  sendToolResult,
  userMessage
} from "./harness";

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

/**
 * Ack a server-initiated continuation stream so its chunks replay to the
 * client (real clients always ack). The scripted continuation completes
 * before the ack round-trip, so the replay ends with a replayed done frame
 * (no replayComplete, which only live streams send).
 */
async function ackContinuation(client: Client): Promise<void> {
  const resuming = await client.waitFor(
    (f) => f.type === MessageType.CF_AGENT_STREAM_RESUMING
  );
  client.ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
      id: resuming.id
    })
  );
  await client.waitFor(
    (f) => isDone(resuming.id as string)(f) && f.replay === true
  );
}

/** The RPC surface every fixture DO exposes (see ./worker.ts bases). */
type FixtureStub = {
  stable(timeout?: number): Promise<boolean>;
  calls(): Promise<number>;
  hooks(): Promise<unknown>;
  rows(): Promise<unknown>;
  queueDepth(): Promise<number>;
  overlapping(): Promise<number>;
  release(): Promise<void>;
  programmaticTurn(text: string): Promise<unknown>;
};

type Family =
  | "scripted"
  | "gated"
  | "latestGated"
  | "dropGated"
  | "mergeGated"
  | "debounceGated"
  | "maxPersisted";

type Stack = {
  name: string;
  projected: boolean;
  agents: Record<Family, { ns: unknown; kebab: string }>;
};

// Post-swap both rows run the AG-UI engine: the first through the package's
// legacy entry point (`../` — what users import), the second through the
// sidecar fixtures built directly on `../agent`. Both diff against the
// goldens recorded from the pre-cutover legacy implementation.
const stacks: Stack[] = [
  {
    name: "swapped AIChatAgent (legacy entry point)",
    projected: true,
    agents: {
      scripted: { ns: env.ScriptedAgent, kebab: "scripted-agent" },
      gated: { ns: env.GatedAgent, kebab: "gated-agent" },
      latestGated: { ns: env.LatestGatedAgent, kebab: "latest-gated-agent" },
      dropGated: { ns: env.DropGatedAgent, kebab: "drop-gated-agent" },
      mergeGated: { ns: env.MergeGatedAgent, kebab: "merge-gated-agent" },
      debounceGated: {
        ns: env.DebounceGatedAgent,
        kebab: "debounce-gated-agent"
      },
      maxPersisted: { ns: env.MaxPersistedAgent, kebab: "max-persisted-agent" }
    }
  },
  {
    name: "projected AIChatAgent",
    projected: true,
    agents: {
      scripted: {
        ns: env.ProjectedScriptedAgent,
        kebab: "projected-scripted-agent"
      },
      gated: { ns: env.ProjectedGatedAgent, kebab: "projected-gated-agent" },
      latestGated: {
        ns: env.ProjectedLatestGatedAgent,
        kebab: "projected-latest-gated-agent"
      },
      dropGated: {
        ns: env.ProjectedDropGatedAgent,
        kebab: "projected-drop-gated-agent"
      },
      mergeGated: {
        ns: env.ProjectedMergeGatedAgent,
        kebab: "projected-merge-gated-agent"
      },
      debounceGated: {
        ns: env.ProjectedDebounceGatedAgent,
        kebab: "projected-debounce-gated-agent"
      },
      maxPersisted: {
        ns: env.ProjectedMaxPersistedAgent,
        kebab: "projected-max-persisted-agent"
      }
    }
  }
];

for (const stack of stacks) {
  const open = async (family: Family) => {
    const { ns, kebab } = stack.agents[family];
    const room = crypto.randomUUID();
    const path = `/agents/${kebab}/${room}`;
    const stub = (await getAgentByName(
      ns as DurableObjectNamespace<never>,
      room
    )) as unknown as FixtureStub;
    return { path, stub } as const;
  };

  const expectScenario = (name: string, trace: Trace) =>
    stack.projected
      ? expectProjectedGolden(name, trace)
      : expectGolden(name, trace);

  const finish = (options: {
    scenario: string;
    path: string;
    stub: FixtureStub;
    clients: Client[];
    sortFramesByRequestId?: boolean;
  }) => finishTrace({ ...options, projected: stack.projected });

  /** Client-visible list in legacy shape on either stack. */
  const legacyView = async (path: string): Promise<ChatMessage[]> => {
    const view = await fetchClientView(path);
    return (
      stack.projected ? projectViewToLegacy(view) : view
    ) as ChatMessage[];
  };

  /** Single-client scripted turn: send one request, wait for done, snapshot. */
  async function runScriptedScenario(golden: string, scenario: string) {
    const { path, stub } = await open("scripted");
    const client = await connectClient(path);
    sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
      scenario
    });
    await client.waitFor(
      (f) => f.id === "req-1" && (f.done === true || f.error === true)
    );
    const trace = await finish({
      scenario: golden,
      path,
      stub,
      clients: [client]
    });
    await expectScenario(golden, trace);
  }

  describe(`conformance: ${stack.name}`, () => {
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

    it("empty response body", async () => {
      await runScriptedScenario("empty-response-body", "empty-response-body");
    });

    it("no response", async () => {
      // onChatMessage returns undefined — legacy broadcasts a "No response was
      // generated" done frame to OTHER clients (the requester is excluded).
      const { path, stub } = await open("scripted");
      const c1 = await connectClient(path);
      const c2 = await connectClient(path);
      sendChatRequest(c1, "req-1", [userMessage("u-1", "hello")], {
        scenario: "no-response"
      });
      await c2.waitFor(isDone("req-1"));
      const trace = await finish({
        scenario: "no-response",
        path,
        stub,
        clients: [c1, c2]
      });
      await expectScenario("no-response", trace);
    });

    it("error mid-stream", async () => {
      await runScriptedScenario("error-midstream", "error-mid");
    });

    it("pre-Response throw", async () => {
      // Legacy behavior: an onChatMessage throw before a Response is produced
      // sends NO wire frame to the requesting client — the trace pins that
      // silence. The AG-UI engine intentionally improves on this (terminal
      // error:true done frame): allowlisted.
      const { path, stub } = await open("scripted");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
        scenario: "pre-throw"
      });
      await waitUntil(async () => (await stub.calls()) >= 1);
      const trace = await finish({
        scenario: "pre-response-throw",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("pre-response-throw", trace);
    });

    it("client tool + continuation", async () => {
      const { path, stub } = await open("scripted");
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
      await ackContinuation(client);
      const trace = await finish({
        scenario: "client-tool-continuation",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("client-tool-continuation", trace);
    });

    it("tool approval: approve", async () => {
      const { path, stub } = await open("scripted");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "do it")], {
        scenario: "approval"
      });
      await client.waitFor(isDone("req-1"));
      sendToolApproval(client, "call-approval-1", true);
      await ackContinuation(client);
      const trace = await finish({
        scenario: "tool-approval-approve",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("tool-approval-approve", trace);
    });

    it("tool approval: deny", async () => {
      const { path, stub } = await open("scripted");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "do it")], {
        scenario: "approval"
      });
      await client.waitFor(isDone("req-1"));
      sendToolApproval(client, "call-approval-1", false);
      await ackContinuation(client);
      const trace = await finish({
        scenario: "tool-approval-deny",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("tool-approval-deny", trace);
    });

    it("cancel mid-stream", async () => {
      const { path, stub } = await open("gated");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "hello")]);
      await client.waitFor(isTextDelta);
      sendCancel(client, "req-1");
      await client.waitFor(isDone("req-1"));
      await stub.release();
      const trace = await finish({
        scenario: "cancel-midstream",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("cancel-midstream", trace);
    });

    it("resume mid-stream (second client)", async () => {
      const { path, stub } = await open("gated");
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
      const trace = await finish({
        scenario: "resume-midstream",
        path,
        stub,
        clients: [c1, c2]
      });
      await expectScenario("resume-midstream", trace);
    });

    it("multi-client broadcast", async () => {
      const { path, stub } = await open("scripted");
      const c1 = await connectClient(path);
      const c2 = await connectClient(path);
      sendChatRequest(c1, "req-1", [userMessage("u-1", "hello")], {
        scenario: "plain-text"
      });
      await c1.waitFor(isDone("req-1"));
      await c2.waitFor(isDone("req-1"));
      const trace = await finish({
        scenario: "multi-client-broadcast",
        path,
        stub,
        clients: [c1, c2]
      });
      await expectScenario("multi-client-broadcast", trace);
    });

    it("regenerate", async () => {
      const { path, stub } = await open("scripted");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "hello")], {
        scenario: "plain-text"
      });
      await client.waitFor(isDone("req-1"));

      // Regenerate: client resends the list without the assistant reply.
      const view = await legacyView(path);
      const withoutAssistant = view.filter((m) => m.role !== "assistant");
      sendChatRequest(client, "req-2", withoutAssistant, {
        scenario: "plain-text",
        trigger: "regenerate-message"
      });
      await client.waitFor(isDone("req-2"));
      const trace = await finish({
        scenario: "regenerate",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("regenerate", trace);
    });

    it("maxPersistedMessages trimming", async () => {
      const { path, stub } = await open("maxPersisted");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "first")], {
        scenario: "plain-text"
      });
      await client.waitFor(isDone("req-1"));

      const view = await legacyView(path);
      sendChatRequest(
        client,
        "req-2",
        [...view, userMessage("u-2", "second")],
        {
          scenario: "plain-text"
        }
      );
      await client.waitFor(isDone("req-2"));
      const trace = await finish({
        scenario: "max-persisted",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("max-persisted", trace);
    });

    it("messageConcurrency: queue (default)", async () => {
      const { path, stub } = await open("gated");
      const client = await connectClient(path);
      sendChatRequest(client, "req-a", [userMessage("u-a", "first")]);
      await client.waitFor(isTextDelta);
      sendChatRequest(client, "req-b", [
        userMessage("u-a", "first"),
        userMessage("u-b", "second")
      ]);
      await waitUntil(async () => (await stub.queueDepth()) >= 1);
      await stub.release();
      await client.waitFor(isDone("req-a"));
      await client.waitFor(isDone("req-b"));
      const trace = await finish({
        scenario: "concurrency-queue",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("concurrency-queue", trace);
    });

    it("messageConcurrency: latest", async () => {
      // `latest` lets the active turn finish and runs only the NEWEST queued
      // overlapping submit — here req-b is superseded by req-c.
      const { path, stub } = await open("latestGated");
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
      const trace = await finish({
        scenario: "concurrency-latest",
        path,
        stub,
        clients: [client],
        sortFramesByRequestId: true
      });
      await expectScenario("concurrency-latest", trace);
    });

    it("messageConcurrency: drop", async () => {
      const { path, stub } = await open("dropGated");
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
      // No frame sorting: the gate makes drop's interleaving deterministic,
      // and arrival order is what shows the drop (done-b lands mid-stream
      // of a).
      const trace = await finish({
        scenario: "concurrency-drop",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("concurrency-drop", trace);
    });

    it("messageConcurrency: merge", async () => {
      // `merge` keeps every queued user message but runs only the newest
      // queued overlapping submit, rewriting persisted rows (_deleteStaleRows).
      const { path, stub } = await open("mergeGated");
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
      const trace = await finish({
        scenario: "concurrency-merge",
        path,
        stub,
        clients: [client],
        sortFramesByRequestId: true
      });
      await expectScenario("concurrency-merge", trace);
    });

    it("messageConcurrency: debounce", async () => {
      // 1ms debounce window; the gate holds the queue busy, so both
      // overlapping submits are queued before the window can resolve —
      // outcome is timing-independent.
      const { path, stub } = await open("debounceGated");
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
      const trace = await finish({
        scenario: "concurrency-debounce",
        path,
        stub,
        clients: [client],
        sortFramesByRequestId: true
      });
      await expectScenario("concurrency-debounce", trace);
    });

    it("maxPersistedMessages trimming across a tool turn", async () => {
      // Trimming to 2 rows after a client-tool continuation drops the user
      // row and can sever tool context — the golden pins exactly what
      // survives.
      const { path, stub } = await open("maxPersisted");
      const client = await connectClient(path);
      sendChatRequest(client, "req-1", [userMessage("u-1", "use the tool")], {
        scenario: "client-tool"
      });
      await client.waitFor(isDone("req-1"));
      sendToolResult(client, "call-client-1", "clientEcho", { echoed: "hi" });
      await ackContinuation(client);
      const trace = await finish({
        scenario: "max-persisted-tool-pair",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("max-persisted-tool-pair", trace);
    });

    it("saveMessages programmatic turn", async () => {
      const { path, stub } = await open("scripted");
      const client = await connectClient(path);
      await stub.programmaticTurn("from the server");
      await client.waitFor(isAnyDone);
      const trace = await finish({
        scenario: "save-messages",
        path,
        stub,
        clients: [client]
      });
      await expectScenario("save-messages", trace);
    });

    it("clear history", async () => {
      const { path, stub } = await open("scripted");
      const c1 = await connectClient(path);
      const c2 = await connectClient(path);
      sendChatRequest(c1, "req-1", [userMessage("u-1", "hello")], {
        scenario: "plain-text"
      });
      await c1.waitFor(isDone("req-1"));
      c1.ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
      await c2.waitFor((f) => f.type === MessageType.CF_AGENT_CHAT_CLEAR);
      const trace = await finish({
        scenario: "clear-history",
        path,
        stub,
        clients: [c1, c2]
      });
      await expectScenario("clear-history", trace);
    });
  });
}
