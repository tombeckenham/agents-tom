/**
 * WebSocketChatTransport integration tests.
 *
 * Uses a mock `AgentConnection` to drive the transport directly. The
 * server-side `AGUIChatAgent` end-to-end path is covered by Phase 4's
 * agui-chat-agent.test.ts suite; this file focuses on the transport's
 * projection from AG-UI wire frames to `UIMessageChunk` (and the
 * resume / cancel handshakes).
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { WebSocketChatTransport } from "../ws-chat-transport";

type SentFrame = string;

function createMockAgent() {
  const sent: SentFrame[] = [];
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  const dispatch = (type: string, data: unknown) => {
    const event = { data } as MessageEvent;
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  return {
    sent,
    dispatchMessage(payload: string) {
      dispatch("message", payload);
    },
    dispatchClose() {
      dispatch("close", undefined);
    },
    send(data: string) {
      sent.push(data);
    },
    addEventListener(
      type: string,
      listener: (event: MessageEvent) => void,
      _options?: { signal?: AbortSignal }
    ) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    }
  };
}

function emitAGUIFrame(
  agent: ReturnType<typeof createMockAgent>,
  requestId: string,
  event: AGUIEvent
) {
  agent.dispatchMessage(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: JSON.stringify(event),
      done: false
    })
  );
}

function emitDone(
  agent: ReturnType<typeof createMockAgent>,
  requestId: string
) {
  agent.dispatchMessage(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: "",
      done: true
    })
  );
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

describe("WebSocketChatTransport — sendMessages", () => {
  it("projects AG-UI frames to UIMessageChunks end-to-end", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages({
      chatId: "c1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    expect(agent.sent.length).toBe(1);
    const outer = JSON.parse(agent.sent[0]);
    const requestId = outer.id;

    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ];
    for (const e of events) emitAGUIFrame(agent, requestId, e);
    emitDone(agent, requestId);

    const chunks = await drain(stream);
    const types = chunks.map((c) => c.type);
    expect(types).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish"
    ]);
  });

  it("forwards tool argument buffering correctly", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages({
      chatId: "c1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    const outer = JSON.parse(agent.sent[0]);
    const requestId = outer.id;

    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"q":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '"hi"}' },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ];
    for (const e of events) emitAGUIFrame(agent, requestId, e);
    emitDone(agent, requestId);

    const chunks = await drain(stream);
    const inputAvailable = chunks.find(
      (c) => c.type === "tool-input-available"
    );
    expect(inputAvailable).toEqual({
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "search",
      input: { q: "hi" }
    });
  });
});

describe("WebSocketChatTransport — cancel", () => {
  it("cancelActiveServerTurn sends CF_AGENT_CHAT_REQUEST_CANCEL and errors the stream", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages({
      chatId: "c1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    const outer = JSON.parse(agent.sent[0]);
    const requestId = outer.id;

    // mid-stream
    emitAGUIFrame(agent, requestId, {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });

    const cancelled = transport.cancelActiveServerTurn();
    expect(cancelled).toBe(true);

    const cancelFrames = agent.sent
      .map((s) => JSON.parse(s))
      .filter((f) => f.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
    expect(cancelFrames.length).toBe(1);
    expect(cancelFrames[0].id).toBe(requestId);

    // The stream errored, so reading after cancel yields an error
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow();
  });
});

describe("WebSocketChatTransport — reconnectToStream", () => {
  it("resolves null when server replies STREAM_RESUME_NONE", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const pending = transport.reconnectToStream({ chatId: "c1" });

    // The transport should have sent STREAM_RESUME_REQUEST.
    expect(
      agent.sent.some(
        (s) => JSON.parse(s).type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      )
    ).toBe(true);

    // Simulate server's no-stream reply via the dispatcher path.
    transport.handleStreamResumeNone();

    const result = await pending;
    expect(result).toBeNull();
  });

  it("returns a stream when server replies STREAM_RESUMING and projects replayed events", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const pending = transport.reconnectToStream({ chatId: "c1" });

    // Server announces a stream and the transport produces a stream that
    // ingests replayed frames.
    transport.handleStreamResuming({ id: "resumed-1" });

    const stream = await pending;
    expect(stream).not.toBeNull();
    if (!stream) return;

    // Verify an ACK was sent.
    const ack = agent.sent
      .map((s) => JSON.parse(s))
      .find((f) => f.type === MessageType.CF_AGENT_STREAM_RESUME_ACK);
    expect(ack?.id).toBe("resumed-1");

    // Drive replayed events through the stream.
    emitAGUIFrame(agent, "resumed-1", {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    emitAGUIFrame(agent, "resumed-1", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "resumed"
    });
    emitAGUIFrame(agent, "resumed-1", {
      type: "TEXT_MESSAGE_END",
      messageId: "m1"
    });
    emitDone(agent, "resumed-1");

    const chunks = await drain(stream);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end"
    ]);
  });
});
