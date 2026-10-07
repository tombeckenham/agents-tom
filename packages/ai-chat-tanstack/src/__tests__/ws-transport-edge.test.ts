/**
 * WebSocketChatTransport edge-case unit tests (mock AgentConnection).
 *
 * Covers the paths the happy-path suite in `ws-transport.test.ts` leaves
 * out: external abort signals, early iterator exit, socket close and
 * malformed frames, `prepareBody` failure, `activeRequestIds` lifecycle,
 * tool-continuation streams, resumed-stream errors and cancellation, and
 * the active-server-turn bookkeeping.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import { describe, expect, it, vi } from "vitest";
import { MessageType } from "../types";
import { WebSocketChatTransport } from "../ws-chat-transport";
import {
  createMockAgent,
  drain,
  emitAGUIFrame,
  emitDone,
  emitError,
  sentFrames,
  waitForSend
} from "./test-helpers";

const USER_TURN = [{ role: "user", content: "x" }];

async function requestIdOf(agent: ReturnType<typeof createMockAgent>) {
  await waitForSend(agent);
  return (JSON.parse(agent.sent[0]) as { id: string }).id;
}

describe("WebSocketChatTransport — external abort signal", () => {
  it("a pre-aborted signal finishes with AbortError and never sends the request", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });
    const controller = new AbortController();
    controller.abort();

    const iterable = transport.streamFactory(
      USER_TURN,
      undefined,
      controller.signal
    );
    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      name: "AbortError"
    });

    // Give the async send path a chance to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.sent.length).toBe(0);
    expect(activeRequestIds.size).toBe(0);
  });

  it("abort mid-stream with cancelOnClientAbort: true sends a cancel frame", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      cancelOnClientAbort: true
    });
    const controller = new AbortController();

    const iterable = transport.streamFactory(
      USER_TURN,
      undefined,
      controller.signal
    );
    const iterator = iterable[Symbol.asyncIterator]();
    const requestId = await requestIdOf(agent);

    controller.abort();
    const cancels = sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL);
    expect(cancels).toEqual([
      { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: requestId }
    ]);
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("abort mid-stream with the default policy tears down locally without a cancel frame", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });
    const controller = new AbortController();

    const iterable = transport.streamFactory(
      USER_TURN,
      undefined,
      controller.signal
    );
    const iterator = iterable[Symbol.asyncIterator]();
    await requestIdOf(agent);

    controller.abort();
    expect(sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL)).toEqual(
      []
    );
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("setCancelOnClientAbort(true) mid-flight makes a later abort send the cancel frame", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });
    const controller = new AbortController();

    const iterable = transport.streamFactory(
      USER_TURN,
      undefined,
      controller.signal
    );
    void iterable[Symbol.asyncIterator]();
    const requestId = await requestIdOf(agent);

    transport.setCancelOnClientAbort(true);
    controller.abort();
    expect(
      sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL)[0]?.id
    ).toBe(requestId);
  });
});

describe("WebSocketChatTransport — early iterator exit", () => {
  it("iterator.return() with cancelOnClientAbort: true sends a cancel frame and removes listeners", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      cancelOnClientAbort: true
    });

    const iterable = transport.streamFactory(USER_TURN);
    const iterator = iterable[Symbol.asyncIterator]();
    const requestId = await requestIdOf(agent);
    expect(agent.listenerCount("message")).toBe(1);
    expect(agent.listenerCount("close")).toBe(1);

    const result = await iterator.return?.();
    expect(result?.done).toBe(true);
    expect(
      sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL)[0]?.id
    ).toBe(requestId);
    expect(agent.listenerCount("message")).toBe(0);
    expect(agent.listenerCount("close")).toBe(0);

    // Late frames are ignored, not queued.
    emitAGUIFrame(agent, requestId, {
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r"
    });
    const next = await iterator.next();
    expect(next.done).toBe(true);
  });

  it("iterator.throw() rejects a pending read with the thrown error", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory(USER_TURN);
    const iterator = iterable[Symbol.asyncIterator]();
    await requestIdOf(agent);

    const pending = expect(iterator.next()).rejects.toThrow("consumer bailed");
    await iterator.throw?.(new Error("consumer bailed"));
    await pending;
  });

  it("socket close mid-stream ends the iterator cleanly", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory(USER_TURN);
    const consumer = drain(iterable);
    const requestId = await requestIdOf(agent);

    emitAGUIFrame(agent, requestId, {
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r"
    });
    agent.dispatchClose();

    const events = await consumer;
    expect(events).toEqual([
      { type: "RUN_STARTED", threadId: "t", runId: "r" }
    ]);
  });
});

describe("WebSocketChatTransport — hostile frames", () => {
  it("ignores malformed JSON, non-string data, and unparseable bodies", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory(USER_TURN);
    const consumer = drain(iterable);
    const requestId = await requestIdOf(agent);

    agent.dispatchMessage("{not json");
    agent.dispatchRaw(new ArrayBuffer(4));
    agent.dispatchRaw(undefined);
    // Well-framed envelope with a malformed AG-UI body — dropped.
    agent.dispatchMessage(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        body: "{broken",
        done: false
      })
    );
    emitAGUIFrame(agent, requestId, {
      type: "RUN_FINISHED",
      threadId: "t",
      runId: "r"
    });
    emitDone(agent, requestId);

    expect(await consumer).toEqual([
      { type: "RUN_FINISHED", threadId: "t", runId: "r" }
    ]);
  });

  it("a done frame with an empty body terminates without yielding an event", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    const iterable = transport.streamFactory(USER_TURN);
    const consumer = drain(iterable);
    const requestId = await requestIdOf(agent);
    emitDone(agent, requestId);
    expect(await consumer).toEqual([]);
  });
});

describe("WebSocketChatTransport — prepareBody failure", () => {
  it("a throwing prepareBody rejects the read and never sends the request", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({
      agent,
      prepareBody: () => {
        throw new Error("body assembly failed");
      }
    });

    const iterable = transport.streamFactory(USER_TURN);
    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("body assembly failed");
    expect(agent.sent.length).toBe(0);
  });
});

describe("WebSocketChatTransport — activeRequestIds lifecycle", () => {
  async function idsAfter(
    end: (
      agent: ReturnType<typeof createMockAgent>,
      requestId: string,
      controller: AbortController
    ) => void
  ): Promise<Set<string>> {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });
    const controller = new AbortController();
    const iterable = transport.streamFactory(
      USER_TURN,
      undefined,
      controller.signal
    );
    const consumer = drain(iterable).catch(() => {});
    const requestId = await requestIdOf(agent);
    expect(activeRequestIds.has(requestId)).toBe(true);
    end(agent, requestId, controller);
    await consumer;
    return activeRequestIds;
  }

  it("removes the id on success", async () => {
    const ids = await idsAfter((agent, requestId) =>
      emitDone(agent, requestId)
    );
    expect(ids.size).toBe(0);
  });

  it("removes the id on a wire error", async () => {
    const ids = await idsAfter((agent, requestId) =>
      emitError(agent, requestId, "boom")
    );
    expect(ids.size).toBe(0);
  });

  it("removes the id on abort", async () => {
    const ids = await idsAfter((_agent, _requestId, controller) =>
      controller.abort()
    );
    expect(ids.size).toBe(0);
  });
});

describe("WebSocketChatTransport — tool-continuation stream", () => {
  it("expectToolContinuation + reconnectToStream performs the resume handshake and yields events", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({ agent, activeRequestIds });

    transport.expectToolContinuation();
    const iterable = await transport.reconnectToStream();
    expect(iterable).not.toBeNull();
    if (!iterable) return;

    expect(
      sentFrames(agent, MessageType.CF_AGENT_STREAM_RESUME_REQUEST).length
    ).toBe(1);
    expect(transport.isAwaitingResume()).toBe(true);

    transport.handleStreamResuming({ id: "cont-1" });
    expect(
      sentFrames(agent, MessageType.CF_AGENT_STREAM_RESUME_ACK)[0]?.id
    ).toBe("cont-1");
    expect(activeRequestIds.has("cont-1")).toBe(true);

    const events: AGUIEvent[] = [
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" }
    ];
    for (const e of events) emitAGUIFrame(agent, "cont-1", e);
    emitDone(agent, "cont-1");

    expect(await drain(iterable)).toEqual(events);
    expect(activeRequestIds.size).toBe(0);
  });

  it("abortActiveToolContinuation sends a cancel frame and aborts the stream", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.expectToolContinuation();
    const iterable = await transport.reconnectToStream();
    if (!iterable) throw new Error("expected continuation stream");
    transport.handleStreamResuming({ id: "cont-2" });

    const iterator = iterable[Symbol.asyncIterator]();
    const pending = expect(iterator.next()).rejects.toMatchObject({
      name: "AbortError"
    });

    expect(transport.abortActiveToolContinuation()).toBe(true);
    expect(
      sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL)[0]?.id
    ).toBe("cont-2");
    await pending;
    // Idempotent once the stream is finished.
    expect(transport.abortActiveToolContinuation()).toBe(false);
  });

  it("handleStreamResumeNone ends the continuation stream cleanly", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.expectToolContinuation();
    const iterable = await transport.reconnectToStream();
    if (!iterable) throw new Error("expected continuation stream");

    transport.handleStreamResumeNone();
    expect(await drain(iterable)).toEqual([]);
  });
});

describe("WebSocketChatTransport — resumed stream failure paths", () => {
  async function resumedStream(agent: ReturnType<typeof createMockAgent>) {
    const transport = new WebSocketChatTransport({ agent });
    const pending = transport.reconnectToStream();
    transport.handleStreamResuming({ id: "resumed-1" });
    const iterable = await pending;
    if (!iterable) throw new Error("expected resumed stream");
    return { transport, iterable };
  }

  it("an error frame on a resumed stream rejects the iterator", async () => {
    const agent = createMockAgent();
    const { iterable } = await resumedStream(agent);
    const iterator = iterable[Symbol.asyncIterator]();
    emitError(agent, "resumed-1", "replay failed");
    await expect(iterator.next()).rejects.toThrow("replay failed");
  });

  it("cancelActiveServerTurn during a resumed stream cancels the resumed id", async () => {
    const agent = createMockAgent();
    const { transport, iterable } = await resumedStream(agent);
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = expect(iterator.next()).rejects.toMatchObject({
      name: "AbortError"
    });

    expect(transport.cancelActiveServerTurn()).toBe(true);
    expect(
      sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL)[0]?.id
    ).toBe("resumed-1");
    await pending;
  });
});

describe("WebSocketChatTransport — active-server-turn bookkeeping", () => {
  it("observeServerTurn makes a server-initiated turn cancellable; completion clears it", () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.observeServerTurn("server-1");
    expect(transport.cancelActiveServerTurn()).toBe(true);
    expect(
      sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL)[0]?.id
    ).toBe("server-1");

    transport.observeServerTurn("server-2");
    transport.handleServerTurnCompleted("server-2");
    expect(transport.cancelActiveServerTurn()).toBe(false);
    expect(
      sentFrames(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL).length
    ).toBe(1);
  });

  it("completion of a different request id does not clear the active turn", () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport({ agent });

    transport.observeServerTurn("server-3");
    transport.handleServerTurnCompleted("other");
    expect(transport.cancelActiveServerTurn()).toBe(true);
  });
});

describe("WebSocketChatTransport — resume timeout", () => {
  it("reconnectToStream resolves null when no decision arrives within 5s", async () => {
    vi.useFakeTimers();
    try {
      const agent = createMockAgent();
      const transport = new WebSocketChatTransport({ agent });
      const pending = transport.reconnectToStream();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
      expect(transport.isAwaitingResume()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
