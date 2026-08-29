/**
 * Drives the existing `use-agent-chat.test.tsx` suite against the AG-UI hook.
 *
 * The suite is the Phase-4 gate and must not be edited (it is also the Phase-5
 * differential baseline for the legacy hook), but every frame it dispatches
 * carries a `UIMessageChunk` body — the legacy wire. This shim is aliased in
 * for `../react` by `vitest.agui.config.ts` and wraps the agent connection so
 * inbound `CF_AGENT_USE_CHAT_RESPONSE` frames are re-framed as AG-UI events
 * (via the same `chunk-to-event` projection the server uses) before the hook
 * sees them. Outbound frames pass through untouched — the `CF_AGENT_*`
 * envelope is identical on both wires.
 *
 * Test-only: production hosts emit AG-UI directly.
 */

import type { UIMessage, UIMessageChunk } from "ai";
import { ChunkToEventProjector } from "@cloudflare/ai-chat-vercel";
import {
  useAgentChat as useAGUIAgentChat,
  type UseAgentChatOptions
} from "../react-agui";

export * from "../react-agui";

type Listener = (event: MessageEvent) => void;

type ResponseFrame = {
  type?: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
  continuation?: boolean;
};

const RESPONSE = "cf_agent_use_chat_response";

/**
 * Chunk frame → zero or more AG-UI frames. Stateful per request id, mirroring
 * how a server projects one turn.
 */
function createFrameCodec() {
  const projectors = new Map<string, ChunkToEventProjector>();
  const runMessageIds = new Map<string, string>();

  return function translate(raw: string): string[] {
    let frame: ResponseFrame;
    try {
      frame = JSON.parse(raw) as ResponseFrame;
    } catch {
      return [raw];
    }
    if (frame.type !== RESPONSE || typeof frame.id !== "string") return [raw];
    // Error bodies are diagnostics, not chunks — both wires pass them through.
    if (frame.error) return [raw];

    const body = frame.body?.trim();
    if (!body) return [raw];

    let chunk: UIMessageChunk;
    try {
      chunk = JSON.parse(body) as UIMessageChunk;
    } catch {
      return [raw];
    }

    const requestId = frame.id;
    let projector = projectors.get(requestId);
    if (!projector || chunk.type === "start") {
      projector = new ChunkToEventProjector();
      projectors.set(requestId, projector);
      const messageId = (chunk as { messageId?: unknown }).messageId;
      if (typeof messageId === "string")
        runMessageIds.set(requestId, messageId);
    }

    // AG-UI has no run-level message id: the assistant id IS the text /
    // reasoning message id. A real server therefore emits its persisted
    // assistant id on TEXT_MESSAGE_START; pin the suite's synthetic part ids
    // to the run's `start.messageId` so the same identity reaches the hook.
    const runMessageId = runMessageIds.get(requestId);
    if (
      runMessageId &&
      (chunk.type.startsWith("text-") || chunk.type.startsWith("reasoning-"))
    ) {
      chunk = { ...chunk, id: runMessageId } as UIMessageChunk;
    }

    const events = projector.project(chunk);
    if (events.length === 0) {
      // Nothing goes on the wire for this chunk (e.g. a buffered `start`);
      // a terminal frame still has to land.
      return frame.done || frame.replayComplete
        ? [JSON.stringify({ ...frame, body: "" })]
        : [];
    }

    if (frame.done || frame.replayComplete) {
      projectors.delete(requestId);
      runMessageIds.delete(requestId);
    }

    return events.map((event, index) => {
      const isLast = index === events.length - 1;
      return JSON.stringify({
        ...frame,
        body: JSON.stringify(event),
        done: isLast ? frame.done : false,
        ...(frame.replayComplete !== undefined
          ? { replayComplete: isLast ? frame.replayComplete : false }
          : {})
      });
    });
  };
}

/**
 * One wrapper per underlying agent — the hook uses reference identity to
 * detect a genuine chat switch, so wrapping must be stable.
 */
const wrappers = new WeakMap<object, unknown>();

function wrapAgent<T extends object>(agent: T): T {
  const cached = wrappers.get(agent);
  if (cached) return cached as T;

  const translate = createFrameCodec();
  const translated = new Map<Listener, Listener>();
  // The hook and the transport each register a listener, and both receive the
  // same MessageEvent. The codec is stateful per turn, so translate a given
  // event once and replay the result — re-running it per listener would feed
  // each one a different projection of the same frame.
  const translations = new WeakMap<MessageEvent, string[]>();

  const addEventListener = (
    type: string,
    listener: Listener,
    options?: { signal?: AbortSignal }
  ) => {
    if (type !== "message") {
      (
        agent as unknown as { addEventListener: typeof addEventListener }
      ).addEventListener(type, listener, options);
      return;
    }
    const wrapped: Listener = (event) => {
      if (typeof event.data !== "string") {
        listener(event);
        return;
      }
      let frames = translations.get(event);
      if (!frames) {
        frames = translate(event.data);
        translations.set(event, frames);
      }
      for (const data of frames) {
        listener(new MessageEvent("message", { data }));
      }
    };
    translated.set(listener, wrapped);
    (
      agent as unknown as { addEventListener: typeof addEventListener }
    ).addEventListener(type, wrapped, options);
  };

  const removeEventListener = (type: string, listener: Listener) => {
    const target = type === "message" ? translated.get(listener) : listener;
    if (!target) return;
    if (type === "message") translated.delete(listener);
    (
      agent as unknown as { removeEventListener: typeof removeEventListener }
    ).removeEventListener(type, target);
  };

  const wrapper = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === "addEventListener") return addEventListener;
      if (prop === "removeEventListener") return removeEventListener;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  wrappers.set(agent, wrapper);
  return wrapper as T;
}

export function useAgentChat<
  // oxlint-disable-next-line no-unused-vars -- mirrors the legacy signature
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(options: UseAgentChatOptions<State, ChatMessage>) {
  return useAGUIAgentChat<State, ChatMessage>({
    ...options,
    agent: wrapAgent(options.agent)
  });
}
