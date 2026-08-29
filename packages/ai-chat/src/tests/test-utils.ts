import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { EventToChunkProjector } from "@cloudflare/ai-chat-vercel";
import { toUIMessages } from "agents/chat";
import type { AGUIEvent, AGUIMessage } from "agents/chat/agui-types";
import { MessageType, type OutgoingMessage } from "../types";

/**
 * Translate one AG-UI wire frame into zero or more legacy-shaped frames
 * (UIMessageChunk bodies, UIMessage lists) — the same projection the client
 * runs. The suite predates the cutover and asserts the legacy wire; this
 * keeps it running byte-meaningfully against the AG-UI engine.
 */
function createFrameTranslator(): (raw: string) => string[] {
  const projectors = new Map<string, EventToChunkProjector>();
  return (raw) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [raw];
    }
    if (
      frame.type === MessageType.CF_AGENT_CHAT_MESSAGES &&
      Array.isArray(frame.messages)
    ) {
      return [
        JSON.stringify({
          ...frame,
          messages: toUIMessages(frame.messages as AGUIMessage[])
        })
      ];
    }
    if (
      frame.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
      typeof frame.body !== "string" ||
      frame.body.length === 0
    ) {
      return [raw];
    }
    let event: AGUIEvent;
    try {
      event = JSON.parse(frame.body) as AGUIEvent;
    } catch {
      return [raw];
    }
    const eventType = (event as { type?: unknown }).type;
    // AG-UI event types are SCREAMING_SNAKE; anything else (already-legacy
    // bodies seeded by fixtures) passes through untouched.
    if (typeof eventType !== "string" || !/^[A-Z_]+$/.test(eventType)) {
      return [raw];
    }
    const key = String(frame.id ?? "");
    if (event.type === "RUN_STARTED" || !projectors.has(key)) {
      projectors.set(key, new EventToChunkProjector());
    }
    const projector = projectors.get(key) as EventToChunkProjector;
    return projector
      .project(event)
      .map((chunk) =>
        JSON.stringify({ ...frame, body: JSON.stringify(chunk) })
      );
  };
}

/**
 * Wrap a WebSocket so inbound frames are translated to the legacy wire before
 * listeners see them. Outbound frames pass through (the `CF_AGENT_*` envelope
 * is identical on both wires).
 */
export function wrapLegacyWireWS(ws: WebSocket): WebSocket {
  const translate = createFrameTranslator();
  const wrapped = new Map<
    (event: MessageEvent) => void,
    (event: MessageEvent) => void
  >();
  return new Proxy(ws, {
    get(target, prop, receiver) {
      if (prop === "addEventListener") {
        return (type: string, listener: (event: MessageEvent) => void) => {
          if (type !== "message") {
            return target.addEventListener(type as "close", listener as never);
          }
          const inner = (event: MessageEvent) => {
            if (typeof event.data !== "string") return listener(event);
            for (const data of translate(event.data)) {
              listener({ data } as MessageEvent);
            }
          };
          wrapped.set(listener, inner);
          return target.addEventListener("message", inner);
        };
      }
      if (prop === "removeEventListener") {
        return (type: string, listener: (event: MessageEvent) => void) => {
          const inner = type === "message" ? wrapped.get(listener) : undefined;
          return target.removeEventListener(
            type as "message",
            (inner ?? listener) as never
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/**
 * Connects to the chat agent and returns the WebSocket. Inbound frames are
 * projected to the legacy wire — see {@link wrapLegacyWireWS}.
 */
export async function connectChatWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws: wrapLegacyWireWS(ws) };
}

/**
 * Type guard for CF_AGENT_USE_CHAT_RESPONSE messages
 */
export function isUseChatResponseMessage(
  m: unknown
): m is Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_USE_CHAT_RESPONSE }
> {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
  );
}

export function waitForChatClearBroadcast(
  ws: WebSocket,
  timeoutMs = 3000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for chat clear broadcast"));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      const data = JSON.parse(event.data as string);
      if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
    }

    ws.addEventListener("message", onMessage);
  });
}
