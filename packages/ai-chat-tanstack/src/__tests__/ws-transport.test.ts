/**
 * WebSocketChatTransport unit tests (mock AgentConnection).
 *
 * Drives the transport's `streamFactory` directly, mocking the agent's
 * WebSocket. Verifies AG-UI events pass through unchanged, that cancel /
 * reconnect handshakes match the wire protocol, and that errors on the
 * wire surface as rejected reads on the async iterator.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { WebSocketChatTransport } from "../ws-chat-transport";

function createMockAgent() {
  const sent: string[] = [];
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
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
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

function emitError(
  agent: ReturnType<typeof createMockAgent>,
  requestId: string,
  message: string
) {
  agent.dispatchMessage(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: message,
      error: true,
      done: false
    })
  );
}

async function drain(iterable: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> {
  const out: AGUIEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

async function waitForSend(agent: ReturnType<typeof createMockAgent>) {
  // prepareBody is async; the request frame lands on a microtask. Yield
  // a few times so the request id is observable in `agent.sent`.
  for (let i = 0; i < 5 && agent.sent.length === 0; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("WebSocketChatTransport — streamFactory (identity adapter)", () => {
  it("passes AG-UI events through to the async iterable unchanged", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory([{ role: "user", content: "Hi" }]);
    // start consuming so listeners are set
    const consumer = drain(iterable);

    await waitForSend(agent);
    expect(agent.sent.length).toBe(1);
    const outer = JSON.parse(agent.sent[0]) as {
      type: string;
      id: string;
      init: { body: string };
    };
    expect(outer.type).toBe(MessageType.CF_AGENT_USE_CHAT_REQUEST);
    const requestId = outer.id;
    const innerBody = JSON.parse(outer.init.body) as { messages: unknown[] };
    expect(innerBody.messages).toEqual([{ role: "user", content: "Hi" }]);

    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hi" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ];
    for (const e of events) emitAGUIFrame(agent, requestId, e);
    emitDone(agent, requestId);

    expect(await consumer).toEqual(events);
  });

  it("forwards CUSTOM events including tool-approval requests untouched", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory([{ role: "user", content: "x" }]);
    const consumer = drain(iterable);

    await waitForSend(agent);
    const outer = JSON.parse(agent.sent[0]) as { id: string };
    const requestId = outer.id;

    const approvalReq: AGUIEvent = {
      type: "CUSTOM",
      name: "cf.agents.tool_approval.request",
      value: { toolCallId: "tc-1", approvalId: "ap-1", toolName: "delete" }
    };
    emitAGUIFrame(agent, requestId, approvalReq);
    emitDone(agent, requestId);

    const events = await consumer;
    expect(events).toContainEqual(approvalReq);
  });

  it("surfaces a wire error as a rejected iterator read", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory([{ role: "user", content: "x" }]);
    const iterator = iterable[Symbol.asyncIterator]();

    await waitForSend(agent);
    const outer = JSON.parse(agent.sent[0]) as { id: string };
    emitError(agent, outer.id, "boom");

    await expect(iterator.next()).rejects.toThrow("boom");
  });

  it("ignores frames whose id does not match the in-flight request", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory([{ role: "user", content: "x" }]);
    const consumer = drain(iterable);

    await waitForSend(agent);
    const outer = JSON.parse(agent.sent[0]) as { id: string };
    const requestId = outer.id;

    // unrelated id — should be dropped
    emitAGUIFrame(agent, "other-id", {
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r"
    });
    // matching id — should arrive
    emitAGUIFrame(agent, requestId, {
      type: "RUN_FINISHED",
      threadId: "t",
      runId: "r"
    });
    emitDone(agent, requestId);
    const events = await consumer;
    expect(events).toEqual([
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ]);
  });

  it("includes prepareBody output in the request payload", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      prepareBody: () => ({ provider: "openai", temperature: 0.7 })
    });

    const iterable = transport.streamFactory([{ role: "user", content: "x" }]);
    void drain(iterable);

    await waitForSend(agent);
    const outer = JSON.parse(agent.sent[0]) as { init: { body: string } };
    const body = JSON.parse(outer.init.body) as Record<string, unknown>;
    expect(body.provider).toBe("openai");
    expect(body.temperature).toBe(0.7);
  });
});

describe("WebSocketChatTransport — cancel", () => {
  it("cancelActiveServerTurn sends CF_AGENT_CHAT_REQUEST_CANCEL and errors the iterator", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory([{ role: "user", content: "x" }]);
    const iterator = iterable[Symbol.asyncIterator]();

    await waitForSend(agent);
    const outer = JSON.parse(agent.sent[0]) as { id: string };
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
      .map((s) => JSON.parse(s) as { type: string; id?: string })
      .filter((f) => f.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
    expect(cancelFrames.length).toBe(1);
    expect(cancelFrames[0].id).toBe(requestId);

    // First read returns the buffered TEXT_MESSAGE_START.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Next read either rejects (AbortError) or signals done — both are
    // valid clean terminations.
    await expect(iterator.next()).rejects.toThrow();
  });
});

describe("WebSocketChatTransport — reconnectToStream", () => {
  it("resolves null when server replies STREAM_RESUME_NONE", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const pending = transport.reconnectToStream();

    expect(
      agent.sent.some(
        (s) =>
          (JSON.parse(s) as { type: string }).type ===
          MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      )
    ).toBe(true);

    transport.handleStreamResumeNone();
    const result = await pending;
    expect(result).toBeNull();
  });

  it("returns an iterable of replayed events when server replies STREAM_RESUMING", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const pending = transport.reconnectToStream();

    transport.handleStreamResuming({ id: "resumed-1" });

    const iterable = await pending;
    expect(iterable).not.toBeNull();
    if (!iterable) return;

    const ack = agent.sent
      .map((s) => JSON.parse(s) as { type: string; id?: string })
      .find((f) => f.type === MessageType.CF_AGENT_STREAM_RESUME_ACK);
    expect(ack?.id).toBe("resumed-1");

    const replay: AGUIEvent[] = [
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "resumed" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" }
    ];
    for (const e of replay) emitAGUIFrame(agent, "resumed-1", e);
    emitDone(agent, "resumed-1");

    const events = await drain(iterable);
    expect(events).toEqual(replay);
  });
});
