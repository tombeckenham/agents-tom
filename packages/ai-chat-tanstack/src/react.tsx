/**
 * React hook bridging an `AGUIChatAgent` (over WebSocket) to
 * `@tanstack/ai-react`'s `useChat`.
 *
 * Preserves the public-API surface of `@cloudflare/ai-chat/react`'s
 * `useAgentChat` as closely as the TanStack hook semantics allow so the
 * migration story per the AG-UI canonical RFC is "flip one import."
 *
 * What's identical to the Vercel adapter:
 *   - `clearHistory()` broadcasts `CF_AGENT_CHAT_CLEAR` to the agent.
 *   - `addToolOutput()` posts `CF_AGENT_TOOL_RESULT` to the agent and
 *     mirrors the result into the local chat state via
 *     `addToolResult`.
 *   - `stop()` cancels both the active server turn and any in-flight
 *     tool continuation.
 *   - `resume` opt-in (the underlying TanStack `useChat` doesn't have a
 *     built-in resume flag; we drive `reconnectToStream()` on mount when
 *     enabled).
 *
 * Gaps relative to the Vercel adapter (intentional — TanStack `useChat`
 * surfaces semantics differently):
 *   - `isStreaming` / `isServerStreaming` / `isToolContinuation` are
 *     derived from TanStack's `isLoading` + `sessionGenerating`. The
 *     three flags collapse to two on this adapter (`isStreaming` and
 *     `isToolContinuation`). The Vercel `isServerStreaming` (a flag for
 *     "another tab is streaming") maps to TanStack's `sessionGenerating`
 *     and is exposed under both names.
 *   - `body` accepts a static record or a thunk (matching Vercel) and is
 *     wired into TanStack's `forwardedProps`.
 *   - `onToolCall` is not wired here — TanStack handles client-tool
 *     execution natively via the `tools` option on `useChat`.
 */

import { stream, type ConnectionAdapter } from "@tanstack/ai-client";
import type { StreamChunk } from "@tanstack/ai";
import { useChat } from "@tanstack/ai-react";
import type { UseChatOptions, UseChatReturn } from "@tanstack/ai-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageType } from "./types";
import {
  WebSocketChatTransport,
  type AgentConnection
} from "./ws-chat-transport";

export {
  WebSocketChatTransport,
  type AgentConnection,
  type WebSocketChatTransportOptions
} from "./ws-chat-transport";

export type UseAgentChatOptions = Omit<UseChatOptions, "connection"> & {
  agent: AgentConnection & {
    agent?: string;
    name?: string;
    getHttpUrl?: () => string;
  };
  /**
   * Auto-issue a `reconnectToStream()` when the hook mounts so a refresh
   * mid-run picks up the server's in-flight stream. Defaults to `true`.
   */
  resume?: boolean;
  /**
   * When true, an in-flight client-side `stop()` (or React unmount)
   * forwards a `CF_AGENT_CHAT_REQUEST_CANCEL` to the server. Defaults to
   * `false` so other listeners (e.g. another tab) keep streaming.
   */
  cancelOnClientAbort?: boolean;
  /**
   * Auto-resume after `addToolOutput()` sends a `CF_AGENT_TOOL_RESULT`.
   * Defaults to `true` to match the legacy behaviour.
   */
  autoContinueAfterToolResult?: boolean;
  /**
   * Per-request extra body, merged on top of the
   * `messages` payload sent to the agent. Can be a static record or a
   * thunk that returns one (sync or async).
   */
  body?:
    | Record<string, unknown>
    | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
};

type AddToolOutputOptions = {
  toolCallId: string;
  toolName: string;
  output?: unknown;
  state?: "output-available" | "output-error";
  errorText?: string;
};

export type UseAgentChatReturn = UseChatReturn & {
  /**
   * Clear all messages locally and broadcast `CF_AGENT_CHAT_CLEAR` to the
   * agent so the durable session resets.
   */
  clearHistory: () => void;
  /**
   * Submit a client-side tool result to the agent. Wraps the underlying
   * TanStack `addToolResult` with a `CF_AGENT_TOOL_RESULT` send to the
   * agent's WebSocket so the durable session sees the result.
   */
  addToolOutput: (opts: AddToolOutputOptions) => Promise<void>;
  /**
   * Whether the *shared* session is currently generating — true even
   * when this client did not initiate the run. Wraps TanStack's
   * `sessionGenerating`.
   */
  isServerStreaming: boolean;
  /**
   * Convenience flag — true while either this client is streaming or
   * another tab on the same session is.
   */
  isStreaming: boolean;
  /**
   * True while a tool continuation stream (re-attached after
   * `CF_AGENT_TOOL_RESULT`) is being consumed.
   */
  isToolContinuation: boolean;
};

export function useAgentChat(options: UseAgentChatOptions): UseAgentChatReturn {
  const {
    agent,
    resume = true,
    cancelOnClientAbort = false,
    autoContinueAfterToolResult = true,
    body: bodyOption,
    forwardedProps: forwardedPropsOption,
    ...rest
  } = options;

  const agentRef = useRef(agent);
  agentRef.current = agent;
  const bodyOptionRef = useRef(bodyOption);
  bodyOptionRef.current = bodyOption;

  const localRequestIdsRef = useRef<Set<string>>(new Set());

  const transportRef = useRef<WebSocketChatTransport | null>(null);
  if (transportRef.current === null) {
    transportRef.current = new WebSocketChatTransport({
      agent: agentRef.current,
      activeRequestIds: localRequestIdsRef.current,
      cancelOnClientAbort,
      prepareBody: async () => {
        const currentBody = bodyOptionRef.current;
        if (!currentBody) return {};
        return typeof currentBody === "function"
          ? await currentBody()
          : currentBody;
      }
    });
  }
  transportRef.current.agent = agentRef.current;
  transportRef.current.setCancelOnClientAbort(cancelOnClientAbort);
  const transport = transportRef.current;

  const connection = useMemo<ConnectionAdapter>(
    () =>
      stream(
        (messages, data) =>
          // The Cloudflare agents AGUIEvent union is a superset of TanStack's
          // (it includes `ActivityDelta` / `RawEvent` etc. that TanStack
          // doesn't model). The JSON wire payloads are byte-identical, so the
          // structural mismatch is safe to bridge here at the connection
          // boundary.
          transport.streamFactory(
            messages,
            data
          ) as unknown as AsyncIterable<StreamChunk>
      ),
    [transport]
  );

  const chatHelpers = useChat({
    ...rest,
    forwardedProps: forwardedPropsOption,
    connection
  });

  const { addToolResult, setMessages, stop, sessionGenerating, isLoading } =
    chatHelpers;

  const [isToolContinuation, setIsToolContinuation] = useState(false);
  const resumingToolContinuationRef = useRef(false);

  // Drive an initial reconnectToStream() if `resume` is on. We do this
  // exactly once per mount; subsequent reconnects come from explicit
  // STREAM_RESUMING / RESUME_NONE frames the agent broadcasts.
  const triedInitialResumeRef = useRef(false);
  useEffect(() => {
    if (!resume) return;
    if (triedInitialResumeRef.current) return;
    triedInitialResumeRef.current = true;
    void transport.reconnectToStream();
  }, [resume, transport]);

  const startToolContinuation = useCallback(() => {
    if (!autoContinueAfterToolResult) return;
    if (resumingToolContinuationRef.current) return;
    resumingToolContinuationRef.current = true;
    setIsToolContinuation(true);
    transport.expectToolContinuation();
    void transport
      .reconnectToStream()
      .catch(() => undefined)
      .finally(() => {
        resumingToolContinuationRef.current = false;
        setIsToolContinuation(false);
      });
  }, [autoContinueAfterToolResult, transport]);

  const stopWithCancel = useCallback(() => {
    try {
      transport.cancelActiveServerTurn();
      stop();
    } finally {
      transport.abortActiveToolContinuation();
    }
  }, [stop, transport]);

  const sendToolOutputToServer = useCallback(
    (
      toolCallId: string,
      toolName: string,
      output: unknown,
      state?: "output-available" | "output-error",
      errorText?: string
    ) => {
      const shouldAutoContinue =
        state === "output-error" ? false : autoContinueAfterToolResult;
      agentRef.current.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_RESULT,
          toolCallId,
          toolName,
          output,
          ...(state ? { state } : {}),
          ...(errorText !== undefined ? { errorText } : {}),
          autoContinue: shouldAutoContinue
        })
      );
      if (shouldAutoContinue) startToolContinuation();
    },
    [autoContinueAfterToolResult, startToolContinuation]
  );

  const addToolOutput = useCallback(
    async (opts: AddToolOutputOptions) => {
      sendToolOutputToServer(
        opts.toolCallId,
        opts.toolName,
        opts.output,
        opts.state,
        opts.errorText
      );
      await addToolResult({
        toolCallId: opts.toolCallId,
        tool: opts.toolName,
        output:
          opts.state === "output-error"
            ? (opts.errorText ?? "Tool execution denied by user")
            : opts.output,
        state: opts.state,
        errorText: opts.errorText
      });
    },
    [sendToolOutputToServer, addToolResult]
  );

  useEffect(() => {
    function onAgentMessage(event: MessageEvent) {
      if (typeof event.data !== "string") return;
      let data: { type?: string; id?: string; done?: boolean };
      try {
        data = JSON.parse(event.data) as {
          type?: string;
          id?: string;
          done?: boolean;
        };
      } catch {
        return;
      }
      switch (data.type) {
        case MessageType.CF_AGENT_CHAT_CLEAR:
          setMessages([]);
          break;
        case MessageType.CF_AGENT_STREAM_RESUME_NONE:
          transport.handleStreamResumeNone();
          break;
        case MessageType.CF_AGENT_STREAM_RESUMING: {
          const id = data.id;
          if (typeof id !== "string") break;
          if (transport.handleStreamResuming({ id })) break;
          if (localRequestIdsRef.current.has(id)) break;
          // unsolicited resume notification from the server — ACK so the
          // server starts streaming (the existing transport listeners on
          // the agent will route the frames to whoever is reading).
          agentRef.current.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
              id
            })
          );
          break;
        }
        case MessageType.CF_AGENT_USE_CHAT_RESPONSE:
          if (data.done && typeof data.id === "string") {
            transport.handleServerTurnCompleted(data.id);
          }
          break;
      }
    }
    agent.addEventListener("message", onAgentMessage);
    return () => {
      agent.removeEventListener("message", onAgentMessage);
    };
  }, [agent, setMessages, transport]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    agentRef.current.send(
      JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR })
    );
  }, [setMessages]);

  const isServerStreaming = sessionGenerating;
  const isStreaming = isLoading || sessionGenerating;

  return {
    ...chatHelpers,
    clearHistory,
    addToolOutput,
    stop: stopWithCancel,
    isServerStreaming,
    isStreaming,
    isToolContinuation
  };
}
