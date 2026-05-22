/**
 * End-to-end integration: a real `AGUIChatAgent` subclass returns
 * `toAGUIResponse(asyncIterableOfAGUIEvents)`; the
 * `WebSocketChatTransport` consumes the `CF_AGENT_USE_CHAT_RESPONSE`
 * frames over a workers-pool DO WebSocket and yields events directly to
 * its async iterable (no projection layer).
 */

import { exports as workerExports } from "cloudflare:workers";
import type { AGUIEvent } from "agents/chat/agui-types";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import {
  WebSocketChatTransport,
  type AgentConnection
} from "../ws-chat-transport";

function wsToAgentConnection(ws: WebSocket): AgentConnection {
  // The transport only uses send / addEventListener / removeEventListener.
  // Cast to the structural shape because the workers WebSocket type and
  // DOM WebSocket type diverge slightly in generics.
  const target = ws as unknown as {
    send: (data: string) => void;
    addEventListener: (
      type: string,
      listener: (event: MessageEvent) => void,
      options?: { signal?: AbortSignal }
    ) => void;
    removeEventListener: (
      type: string,
      listener: (event: MessageEvent) => void
    ) => void;
  };
  return {
    send: (data) => target.send(data),
    addEventListener: (type, listener, options) =>
      target.addEventListener(type, listener, options),
    removeEventListener: (type, listener) =>
      target.removeEventListener(type, listener)
  };
}

async function openAgent(path: string): Promise<WebSocket> {
  const handler = workerExports.default as {
    fetch: (request: string, init?: RequestInit) => Promise<Response>;
  };
  const res = await handler.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("missing webSocket on upgrade response");
  ws.accept();
  return ws as unknown as WebSocket;
}

async function drain(iterable: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> {
  const out: AGUIEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

describe("AGUIChatAgent + WebSocketChatTransport — end to end (TanStack)", () => {
  it("forwards an agent's AG-UI SSE stream as identity events on the transport", async () => {
    const room = crypto.randomUUID();
    const ws = await openAgent(`/agents/test-tanstack-agent/${room}`);
    const transport = new WebSocketChatTransport({
      agent: wsToAgentConnection(ws)
    });

    const iterable = transport.streamFactory([{ role: "user", content: "Hi" }]);
    const events = await drain(iterable);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED"
    ]);
    const textContent = events
      .filter(
        (e): e is Extract<AGUIEvent, { type: "TEXT_MESSAGE_CONTENT" }> =>
          e.type === "TEXT_MESSAGE_CONTENT"
      )
      .map((e) => e.delta)
      .join("");
    expect(textContent).toBe("Hello world");
  });

  it("cancelActiveServerTurn sends CF_AGENT_CHAT_REQUEST_CANCEL over a real WS", async () => {
    const room = crypto.randomUUID();
    const ws = await openAgent(`/agents/cancellable-tanstack-agent/${room}`);
    const sentByClient: string[] = [];
    const inner = wsToAgentConnection(ws);
    const wrapped: AgentConnection = {
      send: (data) => {
        sentByClient.push(data);
        inner.send(data);
      },
      addEventListener: inner.addEventListener,
      removeEventListener: inner.removeEventListener
    };
    const transport = new WebSocketChatTransport({ agent: wrapped });

    const iterable = transport.streamFactory([{ role: "user", content: "Hi" }]);
    const iterator = iterable[Symbol.asyncIterator]();

    // First event arrives before we cancel.
    const first = await iterator.next();
    expect(first.done).toBe(false);

    expect(transport.cancelActiveServerTurn()).toBe(true);

    const cancelFrame = sentByClient
      .map((s) => JSON.parse(s) as { type: string })
      .find((f) => f.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
    expect(cancelFrame).toBeDefined();

    // Subsequent read fails with AbortError.
    await expect(iterator.next()).rejects.toThrow();
  });
});
