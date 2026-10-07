/**
 * Shared helpers for `WebSocketChatTransport` unit tests: a mock
 * `AgentConnection` plus emitters for the CF_AGENT_USE_CHAT_RESPONSE wire
 * frames the transport consumes.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import { MessageType } from "../types";

export function createMockAgent() {
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
    /** Dispatch a message event whose data is not a string. */
    dispatchRaw(data: unknown) {
      dispatch("message", data);
    },
    dispatchClose() {
      dispatch("close", undefined);
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
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

export type MockAgent = ReturnType<typeof createMockAgent>;

export function emitAGUIFrame(
  agent: MockAgent,
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

export function emitDone(agent: MockAgent, requestId: string) {
  agent.dispatchMessage(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: "",
      done: true
    })
  );
}

export function emitError(
  agent: MockAgent,
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

export async function drain(
  iterable: AsyncIterable<AGUIEvent>
): Promise<AGUIEvent[]> {
  const out: AGUIEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

export async function waitForSend(agent: MockAgent) {
  // prepareBody is async; the request frame lands on a microtask. Yield
  // a few times so the request id is observable in `agent.sent`.
  for (let i = 0; i < 5 && agent.sent.length === 0; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Parse every sent frame and return those matching `type`. */
export function sentFrames(
  agent: MockAgent,
  type: string
): Array<{ type: string; id?: string }> {
  return agent.sent
    .map((s) => JSON.parse(s) as { type: string; id?: string })
    .filter((f) => f.type === type);
}
