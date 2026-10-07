import { describe, expect, it } from "vitest";
import type { AGUIEvent } from "../agui-types";
import { AGUIWebSocketTransport } from "../agui-ws-transport";
import { CHAT_MESSAGE_TYPES } from "../protocol";

/**
 * Teardown invariants of the shared transport, driven through a fake
 * `AgentConnection`. The adapter suites (`@cloudflare/ai-chat-tanstack` /
 * `-vercel`) cover the happy paths; this file pins the failure edges that
 * leak state when they go wrong — a throwing send, a socket close, a
 * connection swapped mid-stream, and a continuation finishing after a newer
 * resume took over the handshake slot.
 */

type Sent = Record<string, unknown>;

function makeAgent(options?: { failSend?: (frame: Sent) => boolean }) {
  const sent: Sent[] = [];
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  return {
    sent,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    dispatch(type: string, data?: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ data } as MessageEvent);
      }
    },
    send(raw: string) {
      const frame = JSON.parse(raw) as Sent;
      if (options?.failSend?.(frame)) throw new Error("socket closed");
      sent.push(frame);
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

type FakeAgent = ReturnType<typeof makeAgent>;

const framesOf = (agent: FakeAgent, type: string) =>
  agent.sent.filter((f) => f.type === type);

async function collect(events: AsyncIterable<AGUIEvent>) {
  const seen: AGUIEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/** Open a request stream and read back the id it put on the wire. */
async function openRequest(
  transport: AGUIWebSocketTransport,
  agent: FakeAgent
) {
  const { events, sent } = transport.openRequestStream({
    buildBody: () => "{}"
  });
  await sent;
  const requestId = framesOf(agent, CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST)[0]
    ?.id as string;
  return { events, requestId };
}

describe("AGUIWebSocketTransport — resume ack on a dead socket", () => {
  it("finishes the stream instead of leaking listeners, ids and the turn", async () => {
    const agent = makeAgent({
      failSend: (frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK
    });
    const activeRequestIds = new Set<string>();
    const transport = new AGUIWebSocketTransport({ agent, activeRequestIds });

    const pending = transport.reconnectToEventStream();
    transport.handleStreamResuming({ id: "resumed-1" });
    const events = await pending;
    if (!events) throw new Error("expected a resumed stream");

    expect(await collect(events)).toEqual([]);
    expect(agent.listenerCount("message")).toBe(0);
    expect(agent.listenerCount("close")).toBe(0);
    expect(activeRequestIds.size).toBe(0);
    expect(transport.cancelActiveServerTurn()).toBe(false);
  });
});

describe("AGUIWebSocketTransport — socket close", () => {
  it("keeps the server turn armed so a later stop() still cancels it", async () => {
    const agent = makeAgent();
    const transport = new AGUIWebSocketTransport({ agent });
    const { events, requestId } = await openRequest(transport, agent);

    const drained = collect(events);
    agent.dispatch("close");
    expect(await drained).toEqual([]);

    // The server may still be running the turn — cancelling must reach it.
    expect(transport.cancelActiveServerTurn()).toBe(true);
    expect(framesOf(agent, CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL)[0]?.id).toBe(
      requestId
    );
  });

  it("clears the turn when the server itself ended it", async () => {
    const agent = makeAgent();
    const transport = new AGUIWebSocketTransport({ agent });
    const { events, requestId } = await openRequest(transport, agent);

    const drained = collect(events);
    agent.dispatch(
      "message",
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      })
    );

    expect(await drained).toEqual([]);
    expect(transport.cancelActiveServerTurn()).toBe(false);
    expect(framesOf(agent, CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL)).toEqual([]);
  });
});

describe("AGUIWebSocketTransport — connection swapped mid-stream", () => {
  it("removes its listeners from the socket it attached to", async () => {
    const first = makeAgent();
    const second = makeAgent();
    const transport = new AGUIWebSocketTransport({ agent: first });
    const { events } = await openRequest(transport, first);
    expect(first.listenerCount("message")).toBe(1);

    // The React layers reassign `.agent` on every render.
    transport.agent = second;
    await events[Symbol.asyncIterator]().return?.();

    expect(first.listenerCount("message")).toBe(0);
    expect(first.listenerCount("close")).toBe(0);
    expect(second.listenerCount("message")).toBe(0);
  });
});

describe("AGUIWebSocketTransport — continuation teardown", () => {
  it("does not clobber a newer resume's handshake slot", async () => {
    const agent = makeAgent();
    const transport = new AGUIWebSocketTransport({ agent });

    transport.expectToolContinuation();
    const continuation = await transport.reconnectToEventStream();
    if (!continuation) throw new Error("expected a continuation stream");

    // A newer resume probe claims the handshake slot...
    const pending = transport.reconnectToEventStream();
    expect(transport.isAwaitingResume()).toBe(true);

    // ...and the older continuation finishing must not steal it.
    await continuation[Symbol.asyncIterator]().return?.();
    expect(transport.isAwaitingResume()).toBe(true);

    expect(transport.handleStreamResumeNone()).toBe(true);
    expect(await pending).toBeNull();
  });
});
