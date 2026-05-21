/**
 * End-to-end integration: a real `AGUIChatAgent` test fixture emits AG-UI
 * SSE, the `WebSocketChatTransport` consumes the
 * `CF_AGENT_USE_CHAT_RESPONSE` frames over a workers-pool DO WebSocket and
 * projects them to `UIMessageChunk`s. Verifies the projection wiring at
 * the boundary that matters most for adopters.
 */

import { exports as workerExports } from "cloudflare:workers";
import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import {
  WebSocketChatTransport,
  type AgentConnection
} from "../ws-chat-transport";

function wsToAgentConnection(ws: WebSocket): AgentConnection {
  // The transport only uses `send` / `addEventListener` / `removeEventListener`.
  // Cast to the structural EventTarget shape because the workers `WebSocket`
  // type and DOM `WebSocket` type both extend `EventTarget` but vary in
  // how event-listener generics are inferred.
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

async function drain(
  stream: ReadableStream<UIMessageChunk>
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const userMessage: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Hi" }]
};

describe("AGUIChatAgent + WebSocketChatTransport — end to end", () => {
  it("projects an agent's AG-UI SSE stream into the expected UIMessageChunk sequence", async () => {
    const room = crypto.randomUUID();
    const ws = await openAgent(`/agents/test-agui-agent/${room}`);
    // class name `TestAguiAgent` → kebab `test-agui-agent`
    const transport = new WebSocketChatTransport({
      agent: wsToAgentConnection(ws)
    });

    const stream = await transport.sendMessages({
      chatId: room,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    const chunks = await drain(stream);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("start");
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types).toContain("finish");
    const textDeltas = chunks.filter(
      (c): c is Extract<UIMessageChunk, { type: "text-delta" }> =>
        c.type === "text-delta"
    );
    expect(textDeltas.map((c) => c.delta).join("")).toBe("Hello world");
  });

  it("cancelActiveServerTurn over a real WS sends CF_AGENT_CHAT_REQUEST_CANCEL", async () => {
    const room = crypto.randomUUID();
    const ws = await openAgent(`/agents/tool-approval-agui-agent/${room}`);
    // class name `ToolApprovalAguiAgent` → kebab `tool-approval-agui-agent`
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

    const stream = await transport.sendMessages({
      chatId: room,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    // Wait briefly so the request arrives at the server before we cancel.
    await new Promise((r) => setTimeout(r, 75));
    expect(transport.cancelActiveServerTurn()).toBe(true);

    const cancelFrame = sentByClient
      .map((s) => JSON.parse(s))
      .find((f) => f.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
    expect(cancelFrame).toBeDefined();

    // Reader sees an AbortError once the stream errors.
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow();
  });
});
