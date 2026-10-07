/**
 * Shared helpers for the AGUIChatAgent server suite. Mirrors the shape of
 * `packages/ai-chat/src/tests/test-utils.ts` on the AG-UI wire protocol.
 */

import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { AGUIEvent, AGUIMessage } from "../chat/agui-types";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";

export type WireFrame = {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
  messages?: AGUIMessage[];
  message?: AGUIMessage;
};

export async function connectChatWS(path: string): Promise<WebSocket> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

/**
 * Attach a frame recorder to a WebSocket. Frames are pushed to `frames` in
 * arrival order; `waitFor` resolves once a matching frame arrives (frames
 * received before the call are checked first).
 */
export function recordFrames(ws: WebSocket) {
  const frames: WireFrame[] = [];
  const waiters: Array<{
    predicate: (f: WireFrame) => boolean;
    resolve: (f: WireFrame) => void;
  }> = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    let frame: WireFrame;
    try {
      frame = JSON.parse(event.data as string) as WireFrame;
    } catch {
      return;
    }
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(frame)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(frame);
      }
    }
  });
  return {
    frames,
    waitFor(
      predicate: (f: WireFrame) => boolean,
      timeoutMs = 5000
    ): Promise<WireFrame> {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for frame")),
          timeoutMs
        );
        waiters.push({
          predicate,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          }
        });
      });
    }
  };
}

export function sendChatRequest(
  ws: WebSocket,
  requestId: string,
  messages: AGUIMessage[],
  extraBody: Record<string, unknown> = {}
) {
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extraBody })
      }
    })
  );
}

export function isResponseFrame(f: WireFrame): boolean {
  return f.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
}

export function isDoneFrame(requestId: string) {
  return (f: WireFrame) =>
    isResponseFrame(f) && f.id === requestId && f.done === true;
}

/** Decode the AG-UI events carried by USE_CHAT_RESPONSE frames for one request. */
export function eventsForRequest(
  frames: WireFrame[],
  requestId: string
): AGUIEvent[] {
  return frames
    .filter(
      (f) =>
        isResponseFrame(f) &&
        f.id === requestId &&
        typeof f.body === "string" &&
        f.body.length > 0 &&
        !f.error
    )
    .map((f) => JSON.parse(f.body as string) as AGUIEvent);
}

export async function fetchPersistedMessages(
  path: string
): Promise<Array<AGUIMessage & { _v?: string }>> {
  const res = await exports.default.fetch(
    `http://example.com${path}/get-messages`
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Array<AGUIMessage & { _v?: string }>;
}

/**
 * Poll `/get-messages` until the predicate holds. The done:true wire frame
 * is broadcast before the turn's messages are persisted, so tests that
 * assert on persistence right after a done frame must poll.
 */
export async function waitForPersisted(
  path: string,
  predicate: (messages: Array<AGUIMessage & { _v?: string }>) => boolean,
  timeoutMs = 5000
): Promise<Array<AGUIMessage & { _v?: string }>> {
  const deadline = Date.now() + timeoutMs;
  let last: Array<AGUIMessage & { _v?: string }> = [];
  while (Date.now() < deadline) {
    last = await fetchPersistedMessages(path);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for persisted messages; last: ${JSON.stringify(last)}`
  );
}

export function userMessage(id: string, content: string): AGUIMessage {
  return { id, role: "user", content };
}
