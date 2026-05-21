import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { AGUIEvent, AGUIMessage } from "../chat/agui-types";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";

export type AGUIUseChatResponseFrame = {
  type: typeof CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
  id: string;
  body: string;
  done: boolean;
  error?: boolean;
  continuation?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
};

export type AGUIChatMessagesFrame = {
  type: typeof CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
  messages: AGUIMessage[];
};

export type AGUIChatClearFrame = {
  type: typeof CHAT_MESSAGE_TYPES.CHAT_CLEAR;
};

export type AGUIStreamResumingFrame = {
  type: typeof CHAT_MESSAGE_TYPES.STREAM_RESUMING;
  id: string;
};

export type AGUIStreamResumeNoneFrame = {
  type: typeof CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;
};

export type AGUIMessageUpdatedFrame = {
  type: typeof CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;
  message: AGUIMessage;
};

export type IncomingAGUIWireFrame =
  | AGUIUseChatResponseFrame
  | AGUIChatMessagesFrame
  | AGUIChatClearFrame
  | AGUIStreamResumingFrame
  | AGUIStreamResumeNoneFrame
  | AGUIMessageUpdatedFrame;

export async function connectChatWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

export function isUseChatResponseMessage(
  m: unknown
): m is AGUIUseChatResponseFrame {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    (m as { type: unknown }).type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
  );
}

export function isChatMessagesFrame(m: unknown): m is AGUIChatMessagesFrame {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    (m as { type: unknown }).type === CHAT_MESSAGE_TYPES.CHAT_MESSAGES
  );
}

export function isStreamResumingFrame(
  m: unknown
): m is AGUIStreamResumingFrame {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    (m as { type: unknown }).type === CHAT_MESSAGE_TYPES.STREAM_RESUMING
  );
}

export function isStreamResumeNoneFrame(
  m: unknown
): m is AGUIStreamResumeNoneFrame {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    (m as { type: unknown }).type === CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
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
      const data = JSON.parse(event.data as string) as { type?: unknown };
      if (data.type === CHAT_MESSAGE_TYPES.CHAT_CLEAR) {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
    }

    ws.addEventListener("message", onMessage);
  });
}

export function collectUntilDone(
  ws: WebSocket,
  requestId: string,
  timeoutMs = 5000
): Promise<{ frames: IncomingAGUIWireFrame[]; timedOut: boolean }> {
  const frames: IncomingAGUIWireFrame[] = [];
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve({ frames, timedOut: true });
    }, timeoutMs);

    function handler(event: MessageEvent) {
      const parsed = JSON.parse(event.data as string) as IncomingAGUIWireFrame;
      frames.push(parsed);
      if (
        isUseChatResponseMessage(parsed) &&
        parsed.id === requestId &&
        parsed.done
      ) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve({ frames, timedOut: false });
      }
    }

    ws.addEventListener("message", handler);
  });
}

export function parseEventFromFrame(
  frame: AGUIUseChatResponseFrame
): AGUIEvent | null {
  if (frame.body.length === 0) return null;
  const payload = frame.body.startsWith("data: ")
    ? frame.body.slice(6)
    : frame.body;
  try {
    return JSON.parse(payload) as AGUIEvent;
  } catch {
    return null;
  }
}

export function sendChatRequest(
  ws: WebSocket,
  requestId: string,
  body: Record<string, unknown>
): void {
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      id: requestId,
      init: { method: "POST", body: JSON.stringify(body) }
    })
  );
}

export function sendClearRequest(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }));
}

export function sendCancel(ws: WebSocket, requestId: string): void {
  ws.send(
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
      id: requestId
    })
  );
}
