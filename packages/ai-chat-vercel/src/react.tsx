/**
 * React hook bridging an `AGUIChatAgent` to `@ai-sdk/react`'s `useChat`.
 *
 * Preserves the public API of `@cloudflare/ai-chat/react`'s `useAgentChat`
 * so an existing consumer can flip one import path and keep their code
 * working unchanged. The internal transport is replaced with
 * {@link WebSocketChatTransport} from this package, which speaks AG-UI on
 * the wire and projects to `UIMessageChunk` for the AI SDK.
 *
 * Out-of-scope features (deferred to a future minor): client-side tool
 * `execute` registration, `experimental_automaticToolResolution`, and
 * cross-tab broadcast reconciliation. The `onToolCall` callback path —
 * the supported v6 entry point — is fully wired.
 */

import { useChat, type UseChatOptions } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import type { ChatInit, UIMessage } from "ai";
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

type AddToolOutputOptions = {
  toolCallId: string;
  toolName?: string;
  output?: unknown;
  state?: "output-available" | "output-error";
  errorText?: string;
};

export type OnToolCallCallback = (options: {
  toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  addToolOutput: (options: Omit<AddToolOutputOptions, "toolName">) => void;
}) => void | Promise<void>;

type UseChatParams<M extends UIMessage = UIMessage> = ChatInit<M> &
  UseChatOptions<M>;

export type UseAgentChatOptions<ChatMessage extends UIMessage = UIMessage> =
  Omit<UseChatParams<ChatMessage>, "fetch" | "onToolCall"> & {
    agent: AgentConnection & {
      agent?: string;
      name?: string;
      getHttpUrl?: () => string;
    };
    onToolCall?: OnToolCallCallback;
    autoContinueAfterToolResult?: boolean;
    resume?: boolean;
    cancelOnClientAbort?: boolean;
    body?:
      | Record<string, unknown>
      | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  };

export function useAgentChat<ChatMessage extends UIMessage = UIMessage>(
  options: UseAgentChatOptions<ChatMessage>
): Omit<ReturnType<typeof useChat<ChatMessage>>, "addToolOutput"> & {
  clearHistory: () => void;
  addToolOutput: (opts: AddToolOutputOptions) => void;
  isServerStreaming: boolean;
  isStreaming: boolean;
  isToolContinuation: boolean;
} {
  const {
    agent,
    onToolCall,
    autoContinueAfterToolResult = true,
    resume = true,
    cancelOnClientAbort = false,
    body: bodyOption,
    messages: initialMessagesOption,
    ...rest
  } = options;

  const agentRef = useRef(agent);
  agentRef.current = agent;
  const onToolCallRef = useRef(onToolCall);
  onToolCallRef.current = onToolCall;
  const bodyOptionRef = useRef(bodyOption);
  bodyOptionRef.current = bodyOption;

  const localRequestIdsRef = useRef<Set<string>>(new Set());

  const transportRef = useRef<WebSocketChatTransport<ChatMessage> | null>(null);
  if (transportRef.current === null) {
    transportRef.current = new WebSocketChatTransport<ChatMessage>({
      agent: agentRef.current,
      activeRequestIds: localRequestIdsRef.current,
      cancelOnClientAbort,
      prepareBody: async ({ messages, trigger, messageId }) => {
        let extra: Record<string, unknown> = {};
        const currentBody = bodyOptionRef.current;
        if (currentBody) {
          extra =
            typeof currentBody === "function"
              ? { ...(await currentBody()) }
              : { ...currentBody };
        }
        // exposed for downstream wrappers that override prepareBody via
        // a custom transport; the messages / trigger / messageId are
        // passed through unchanged.
        void messages;
        void trigger;
        void messageId;
        return extra;
      }
    });
  }
  transportRef.current.agent = agentRef.current;
  transportRef.current.setCancelOnClientAbort(cancelOnClientAbort);
  const transport = transportRef.current;

  const chatHelpers = useChat<ChatMessage>({
    ...rest,
    messages: initialMessagesOption,
    transport,
    resume
  });

  const {
    messages: chatMessages,
    setMessages,
    addToolResult,
    sendMessage,
    resumeStream,
    status,
    stop
  } = chatHelpers;

  const [isServerStreaming, setIsServerStreaming] = useState(false);
  const [isToolContinuation, setIsToolContinuation] = useState(false);
  const resumingToolContinuationRef = useRef(false);
  const continuationGenerationRef = useRef(0);

  const resetToolContinuation = useCallback(() => {
    continuationGenerationRef.current++;
    resumingToolContinuationRef.current = false;
    setIsToolContinuation(false);
  }, []);

  const startToolContinuation = useCallback(() => {
    if (!autoContinueAfterToolResult || resumingToolContinuationRef.current) {
      return;
    }
    const generation = ++continuationGenerationRef.current;
    resumingToolContinuationRef.current = true;
    setIsToolContinuation(true);
    transport.expectToolContinuation();
    void resumeStream().finally(() => {
      if (continuationGenerationRef.current !== generation) return;
      resumingToolContinuationRef.current = false;
      setIsToolContinuation(false);
    });
  }, [autoContinueAfterToolResult, transport, resumeStream]);

  const stopWithCancel: typeof stop = useCallback(async () => {
    try {
      transport.cancelActiveServerTurn();
      await stop();
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

  const processedToolCalls = useRef(new Set<string>());

  useEffect(() => {
    const currentOnToolCall = onToolCallRef.current;
    if (!currentOnToolCall) return;
    const lastMsg = chatMessages[chatMessages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    const pending = lastMsg.parts.filter(
      (part) =>
        isToolUIPart(part) &&
        part.state === "input-available" &&
        !processedToolCalls.current.has(part.toolCallId)
    );
    for (const part of pending) {
      if (!isToolUIPart(part)) continue;
      const toolCallId = part.toolCallId;
      const toolName = getToolName(part);
      processedToolCalls.current.add(toolCallId);
      const addToolOutput = (opts: AddToolOutputOptions) => {
        sendToolOutputToServer(
          opts.toolCallId,
          toolName,
          opts.output,
          opts.state,
          opts.errorText
        );
        addToolResult({
          tool: toolName,
          toolCallId: opts.toolCallId,
          output:
            opts.state === "output-error"
              ? (opts.errorText ?? "Tool execution denied by user")
              : opts.output
        });
      };
      currentOnToolCall({
        toolCall: { toolCallId, toolName, input: part.input },
        addToolOutput
      });
    }
  }, [chatMessages, sendToolOutputToServer, addToolResult]);

  useEffect(() => {
    function onAgentMessage(event: MessageEvent) {
      if (typeof event.data !== "string") return;
      let data: { type?: string; id?: string; done?: boolean };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (data.type) {
        case MessageType.CF_AGENT_CHAT_CLEAR:
          resetToolContinuation();
          setMessages([]);
          processedToolCalls.current.clear();
          setIsServerStreaming(false);
          break;
        case MessageType.CF_AGENT_STREAM_RESUME_NONE:
          transport.handleStreamResumeNone();
          break;
        case MessageType.CF_AGENT_STREAM_RESUMING: {
          const id = data.id;
          if (typeof id !== "string") break;
          if (transport.handleStreamResuming({ id })) break;
          if (localRequestIdsRef.current.has(id)) break;
          setIsServerStreaming(true);
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
            if (!localRequestIdsRef.current.has(data.id)) {
              setIsServerStreaming(false);
            }
          }
          break;
      }
    }
    agent.addEventListener("message", onAgentMessage);
    return () => {
      agent.removeEventListener("message", onAgentMessage);
      setIsServerStreaming(false);
    };
  }, [agent, setMessages, transport, resetToolContinuation]);

  const addToolOutput = useCallback(
    (opts: AddToolOutputOptions) => {
      const toolName = opts.toolName ?? "";
      sendToolOutputToServer(
        opts.toolCallId,
        toolName,
        opts.output,
        opts.state,
        opts.errorText
      );
      addToolResult({
        tool: toolName,
        toolCallId: opts.toolCallId,
        output:
          opts.state === "output-error"
            ? (opts.errorText ?? "Tool execution denied by user")
            : opts.output
      });
    },
    [sendToolOutputToServer, addToolResult]
  );

  const isStreaming = useMemo(
    () => status === "streaming" || isServerStreaming,
    [status, isServerStreaming]
  );

  return {
    ...chatHelpers,
    isServerStreaming,
    isStreaming,
    isToolContinuation,
    sendMessage,
    stop: stopWithCancel,
    addToolOutput,
    clearHistory: () => {
      resetToolContinuation();
      setMessages([]);
      processedToolCalls.current.clear();
      agent.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    },
    setMessages
  };
}
