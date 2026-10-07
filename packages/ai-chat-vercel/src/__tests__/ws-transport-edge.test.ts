/**
 * WebSocketChatTransport edge-case tests (mock AgentConnection).
 *
 * Complements ws-transport.test.ts (happy path / cancel / resume) with the
 * remaining transport paths: external abort signals, consumer-side stream
 * cancellation, socket close, malformed frames, prepareBody failures,
 * `activeRequestIds` bookkeeping, server-turn observation, resumed-stream
 * errors, and the tool-continuation handshake.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { WebSocketChatTransport } from "../ws-chat-transport";

function createMockAgent() {
  const sent: string[] = [];
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  const dispatch = (type: string, data: unknown) => {
    const event = { data } as MessageEvent;
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  return {
    sent,
    dispatchMessage(payload: unknown) {
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
      options?: { signal?: AbortSignal }
    ) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      // The transport removes listeners by aborting the signal it passed,
      // never via removeEventListener — honor that so leak assertions work.
      options?.signal?.addEventListener("abort", () => set.delete(listener), {
        once: true
      });
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

type MockAgent = ReturnType<typeof createMockAgent>;

function sentFrames(agent: MockAgent): Array<Record<string, unknown>> {
  return agent.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

function cancelFrames(agent: MockAgent) {
  return sentFrames(agent).filter(
    (f) => f.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
  );
}

function requestIdOf(agent: MockAgent): string {
  const frame = sentFrames(agent).find(
    (f) => f.type === MessageType.CF_AGENT_USE_CHAT_REQUEST
  );
  if (!frame) throw new Error("no CF_AGENT_USE_CHAT_REQUEST frame sent");
  return frame.id as string;
}

function emitAGUIFrame(agent: MockAgent, requestId: string, event: AGUIEvent) {
  agent.dispatchMessage(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: JSON.stringify(event),
      done: false
    })
  );
}

function emitDone(agent: MockAgent, requestId: string) {
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

function sendOptions(overrides?: {
  abortSignal?: AbortSignal;
}): Parameters<WebSocketChatTransport["sendMessages"]>[0] {
  return {
    chatId: "c1",
    messages: [userMessage],
    abortSignal: overrides?.abortSignal,
    trigger: "submit-message"
  };
}

describe("WebSocketChatTransport — external abort", () => {
  it("a pre-aborted signal produces an errored stream and sends no request frame", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      cancelOnClientAbort: true
    });

    const controller = new AbortController();
    controller.abort();

    const stream = await transport.sendMessages(
      sendOptions({ abortSignal: controller.signal })
    );

    // Request was never sent, so no cancel frame either.
    expect(agent.sent.length).toBe(0);
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("mid-stream abort with cancelOnClientAbort=false tears down locally without a cancel frame", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });

    const controller = new AbortController();
    const stream = await transport.sendMessages(
      sendOptions({ abortSignal: controller.signal })
    );
    const requestId = requestIdOf(agent);
    expect(activeRequestIds.has(requestId)).toBe(true);

    emitAGUIFrame(agent, requestId, {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    controller.abort();

    expect(cancelFrames(agent).length).toBe(0);
    expect(activeRequestIds.has(requestId)).toBe(false);
    await expect(drain(stream)).rejects.toMatchObject({ name: "AbortError" });
    expect(agent.listenerCount("message")).toBe(0);
    expect(agent.listenerCount("close")).toBe(0);
  });

  it("mid-stream abort with cancelOnClientAbort=true sends a cancel frame and keeps the request id", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({
      agent,
      activeRequestIds,
      cancelOnClientAbort: true
    });

    const controller = new AbortController();
    const stream = await transport.sendMessages(
      sendOptions({ abortSignal: controller.signal })
    );
    const requestId = requestIdOf(agent);

    controller.abort();

    const cancels = cancelFrames(agent);
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe(requestId);
    // The id is kept so a server-fired resume notification for this
    // request can still be deduplicated by the hook layer.
    expect(activeRequestIds.has(requestId)).toBe(true);
    await expect(drain(stream)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("WebSocketChatTransport — consumer-side stream cancel", () => {
  it("cancelling the stream removes listeners and sends no cancel frame by default", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    expect(agent.listenerCount("message")).toBe(1);
    expect(agent.listenerCount("close")).toBe(1);

    await stream.cancel();

    expect(cancelFrames(agent).length).toBe(0);
    expect(agent.listenerCount("message")).toBe(0);
    expect(agent.listenerCount("close")).toBe(0);
  });

  it("cancelling the stream sends a cancel frame when cancelOnClientAbort=true", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      cancelOnClientAbort: true
    });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    await stream.cancel();

    const cancels = cancelFrames(agent);
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe(requestId);
    expect(agent.listenerCount("message")).toBe(0);
  });
});

describe("WebSocketChatTransport — wire robustness", () => {
  it("ignores malformed JSON, non-string data and other request ids", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    agent.dispatchMessage("{not json");
    agent.dispatchMessage(new ArrayBuffer(4));
    emitAGUIFrame(agent, "someone-else", {
      type: "TEXT_MESSAGE_START",
      messageId: "mx",
      role: "assistant"
    });

    emitAGUIFrame(agent, requestId, {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    emitDone(agent, requestId);

    const chunks = await drain(stream);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-start"]);
    expect(agent.listenerCount("message")).toBe(0);
  });

  it("skips a frame whose AG-UI body is malformed and keeps streaming", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    agent.dispatchMessage(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        body: "{broken agui",
        done: false
      })
    );
    emitAGUIFrame(agent, requestId, {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    emitAGUIFrame(agent, requestId, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "ok"
    });
    emitDone(agent, requestId);

    const chunks = await drain(stream);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-start",
      "text-delta"
    ]);
  });

  it("an empty-body done frame closes the stream with zero chunks", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    emitDone(agent, requestIdOf(agent));

    expect(await drain(stream)).toEqual([]);
  });

  it("a wire error frame rejects the reader and clears bookkeeping", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    agent.dispatchMessage(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        body: "boom",
        error: true,
        done: false
      })
    );

    await expect(drain(stream)).rejects.toThrow("boom");
    expect(activeRequestIds.size).toBe(0);
    expect(agent.listenerCount("message")).toBe(0);
    // The errored turn no longer counts as active.
    expect(transport.cancelActiveServerTurn()).toBe(false);
  });

  it("socket close mid-stream ends the stream cleanly with the chunks so far", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    emitAGUIFrame(agent, requestId, {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    agent.dispatchClose();

    const chunks = await drain(stream);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-start"]);
  });

  it("a throwing prepareBody rejects sendMessages before anything hits the wire", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      prepareBody: () => {
        throw new Error("no body for you");
      }
    });

    await expect(transport.sendMessages(sendOptions())).rejects.toThrow(
      "no body for you"
    );
    expect(agent.sent.length).toBe(0);
  });

  it("tracks activeRequestIds across a successful turn", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);
    expect(activeRequestIds.has(requestId)).toBe(true);

    emitDone(agent, requestId);
    await drain(stream);
    expect(activeRequestIds.size).toBe(0);
  });
});

describe("WebSocketChatTransport — server-turn observation", () => {
  it("observeServerTurn arms cancelActiveServerTurn for a server-initiated request", () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.observeServerTurn("server-req");
    expect(transport.cancelActiveServerTurn()).toBe(true);

    const cancels = cancelFrames(agent);
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe("server-req");

    // The turn is cleared — a second cancel is a no-op.
    expect(transport.cancelActiveServerTurn()).toBe(false);
    expect(cancelFrames(agent).length).toBe(1);
  });

  it("handleServerTurnCompleted disarms the observed turn", () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.observeServerTurn("server-req");
    transport.handleServerTurnCompleted("server-req");

    expect(transport.cancelActiveServerTurn()).toBe(false);
    expect(agent.sent.length).toBe(0);
  });
});

describe("WebSocketChatTransport — resumed stream", () => {
  async function resume(transport: WebSocketChatTransport, id: string) {
    const pending = transport.reconnectToStream({ chatId: "c1" });
    transport.handleStreamResuming({ id });
    const stream = await pending;
    if (!stream) throw new Error("expected a resumed stream");
    return stream;
  }

  it("isAwaitingResume flips true during the handshake and false after", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    expect(transport.isAwaitingResume()).toBe(false);
    const pending = transport.reconnectToStream({ chatId: "c1" });
    expect(transport.isAwaitingResume()).toBe(true);

    transport.handleStreamResumeNone();
    expect(await pending).toBeNull();
    expect(transport.isAwaitingResume()).toBe(false);
    // With no handshake pending the dispatch helpers report unhandled.
    expect(transport.handleStreamResumeNone()).toBe(false);
    expect(transport.handleStreamResuming({ id: "x" })).toBe(false);
  });

  it("an error frame on the resumed stream rejects the reader", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });
    const stream = await resume(transport, "resumed-1");

    agent.dispatchMessage(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: "resumed-1",
        body: "resume blew up",
        error: true,
        done: false
      })
    );

    await expect(drain(stream)).rejects.toThrow("resume blew up");
  });

  it("cancelActiveServerTurn cancels a resumed stream by its server request id", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });
    const stream = await resume(transport, "resumed-2");

    expect(transport.cancelActiveServerTurn()).toBe(true);
    const cancels = cancelFrames(agent);
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe("resumed-2");
    await expect(drain(stream)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("socket close ends a resumed stream cleanly", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });
    const stream = await resume(transport, "resumed-3");

    emitAGUIFrame(agent, "resumed-3", {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    agent.dispatchClose();

    const chunks = await drain(stream);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-start"]);
  });
});

describe("WebSocketChatTransport — tool continuation", () => {
  it("expectToolContinuation routes reconnectToStream into the continuation handshake", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });

    transport.expectToolContinuation();
    const stream = await transport.reconnectToStream({ chatId: "c1" });
    expect(stream).not.toBeNull();
    if (!stream) return;
    const consumer = drain(stream);

    expect(
      sentFrames(agent).some(
        (f) => f.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      )
    ).toBe(true);

    transport.handleStreamResuming({ id: "cont-1" });
    const ack = sentFrames(agent).find(
      (f) => f.type === MessageType.CF_AGENT_STREAM_RESUME_ACK
    );
    expect(ack?.id).toBe("cont-1");
    expect(activeRequestIds.has("cont-1")).toBe(true);

    emitAGUIFrame(agent, "cont-1", {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant"
    });
    emitAGUIFrame(agent, "cont-1", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "continued"
    });
    emitDone(agent, "cont-1");

    const chunks = await consumer;
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-start",
      "text-delta"
    ]);
    expect(activeRequestIds.size).toBe(0);
    // The flag is one-shot: the next reconnect is a plain resume handshake.
    const next = transport.reconnectToStream({ chatId: "c1" });
    transport.handleStreamResumeNone();
    expect(await next).toBeNull();
  });

  it("closes the continuation stream empty when the server has nothing to resume", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.expectToolContinuation();
    const stream = await transport.reconnectToStream({ chatId: "c1" });
    if (!stream) throw new Error("expected a continuation stream");
    const consumer = drain(stream);

    transport.handleStreamResumeNone();
    expect(await consumer).toEqual([]);
  });

  it("abortActiveToolContinuation before the handshake errors the stream without a cancel frame", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.expectToolContinuation();
    const stream = await transport.reconnectToStream({ chatId: "c1" });
    if (!stream) throw new Error("expected a continuation stream");
    const consumer = drain(stream);

    expect(transport.abortActiveToolContinuation()).toBe(true);
    await expect(consumer).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelFrames(agent).length).toBe(0);
    // Once aborted there is nothing left to abort.
    expect(transport.abortActiveToolContinuation()).toBe(false);
  });

  it("abortActiveToolContinuation after resuming sends a cancel frame for the resumed id", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.expectToolContinuation();
    const stream = await transport.reconnectToStream({ chatId: "c1" });
    if (!stream) throw new Error("expected a continuation stream");
    const consumer = drain(stream);

    transport.handleStreamResuming({ id: "cont-2" });
    expect(transport.abortActiveToolContinuation()).toBe(true);

    const cancels = cancelFrames(agent);
    expect(cancels.length).toBe(1);
    expect(cancels[0].id).toBe("cont-2");
    await expect(consumer).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("WebSocketChatTransport — projection wiring", () => {
  it("projects interleaved parallel tool calls and reasoning through the transport", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "REASONING_MESSAGE_START", messageId: "rm1", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "rm1", delta: "think" },
      { type: "REASONING_MESSAGE_END", messageId: "rm1" },
      { type: "TOOL_CALL_START", toolCallId: "a", toolCallName: "alpha" },
      { type: "TOOL_CALL_START", toolCallId: "b", toolCallName: "beta" },
      { type: "TOOL_CALL_ARGS", toolCallId: "b", delta: '{"n":2}' },
      { type: "TOOL_CALL_ARGS", toolCallId: "a", delta: '{"n":1}' },
      { type: "TOOL_CALL_END", toolCallId: "a" },
      { type: "TOOL_CALL_END", toolCallId: "b" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ];
    for (const e of events) emitAGUIFrame(agent, requestId, e);
    emitDone(agent, requestId);

    const chunks = await drain(stream);
    const inputAvailable = chunks.filter(
      (c): c is Extract<UIMessageChunk, { type: "tool-input-available" }> =>
        c.type === "tool-input-available"
    );
    expect(inputAvailable).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "a",
        toolName: "alpha",
        input: { n: 1 }
      },
      {
        type: "tool-input-available",
        toolCallId: "b",
        toolName: "beta",
        input: { n: 2 }
      }
    ]);
    expect(chunks.map((c) => c.type)).toContain("reasoning-delta");
  });

  it("projects STATE_SNAPSHOT and STATE_DELTA to cf.state data chunks through the transport", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const stream = await transport.sendMessages(sendOptions());
    const requestId = requestIdOf(agent);

    emitAGUIFrame(agent, requestId, {
      type: "STATE_SNAPSHOT",
      snapshot: { counter: 1 }
    });
    emitAGUIFrame(agent, requestId, {
      type: "STATE_DELTA",
      delta: [{ op: "replace", path: "/counter", value: 2 }]
    });
    emitDone(agent, requestId);

    const chunks = await drain(stream);
    const dataTypes = chunks.map((c) => c.type);
    expect(dataTypes).toContain("data-cf.state");
    expect(dataTypes).toContain("data-cf.state-delta");
  });
});
