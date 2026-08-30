/**
 * `useAgentChat` reimplemented as a projection layer over the AG-UI wire.
 *
 * Phase-4 sidecar: `src/react.tsx` (which re-exports the legacy hook from
 * `agents/chat/react`) is untouched until the Phase-5 differential cutover.
 *
 * The public API is the legacy one, verbatim — the options type, the pure
 * helpers (`extractClientToolSchemas`, `getToolPartState`, …) and the return
 * shape are imported/re-exported from `agents/chat/react` rather than
 * redeclared, so the surface cannot drift. What changes is everything below
 * the surface:
 *
 * - the transport is the shared `AGUIWebSocketTransport`
 *   (`agents/chat/agui-ws-transport`) wearing the AI SDK's `ChatTransport`
 *   shape via `event-to-chunk` — i.e. `@cloudflare/ai-chat-vercel`'s
 *   `WebSocketChatTransport`, whose React hook this file absorbs;
 * - `CF_AGENT_USE_CHAT_RESPONSE` bodies carry AG-UI events, not
 *   `UIMessageChunk`s, so the cross-tab/resume observer path projects each
 *   frame through a per-request `EventToChunkProjector` before feeding the
 *   (format-agnostic once projected) broadcast accumulator.
 *
 * Everything else — the `CF_AGENT_*` envelope, initial-message hydration and
 * caching, the resume serialization gate (#1837), tool continuations, the
 * streaming-tail protection, `clearHistory`/`setMessages` sync — is the legacy
 * behaviour, ported unchanged.
 */

import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  autoTransformAGUIMessages,
  broadcastTransition,
  MessageType,
  STREAM_RESUME_NONE_REASONS,
  toUIMessages,
  type BroadcastStreamState,
  type OutgoingMessage
} from "agents/chat";
import type {
  AGUIEvent,
  AGUIMessage,
  ToolMessage
} from "agents/chat/agui-types";
import { EventToChunkProjector } from "@cloudflare/ai-chat-vercel";
import { WebSocketChatTransport } from "@cloudflare/ai-chat-vercel/react";
import {
  extractClientToolSchemas,
  type UseAgentChatOptions
} from "agents/chat/react";

// The public surface is the legacy one; re-export rather than redeclare so
// the two hooks cannot drift apart before the Phase-5 swap.
export {
  extractClientToolSchemas,
  detectToolsRequiringConfirmation,
  getToolPartState,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolApproval,
  getAgentMessages
} from "agents/chat/react";
export type {
  JSONSchemaType,
  AITool,
  ClientToolSchema,
  UseAgentChatOptions,
  PrepareSendMessagesRequestOptions,
  PrepareSendMessagesRequestResult,
  OnToolCallCallback
} from "agents/chat/react";
export {
  WebSocketChatTransport,
  type AgentConnection
} from "@cloudflare/ai-chat-vercel/react";

type AnyAgent = UseAgentChatOptions<unknown, UIMessage>["agent"];
type AgentConnectionErrorLike = NonNullable<AnyAgent["connectionError"]>;

type GetInitialMessagesOptions = {
  agent: string;
  name: string;
  url?: string;
};

type AddToolOutputOptions = {
  toolCallId: string;
  toolName?: string;
  output?: unknown;
  state?: "output-available" | "output-error";
  errorText?: string;
};

/**
 * One-shot deprecation warnings (warns once per key per session).
 */
const _deprecationWarnings = new Set<string>();
function warnDeprecated(id: string, message: string) {
  if (!_deprecationWarnings.has(id)) {
    _deprecationWarnings.add(id);
    console.warn(`[agents/chat] Deprecated: ${message}`);
  }
}

/**
 * Module-level cache for initial message fetches, shared across all hook
 * instances to deduplicate requests during StrictMode double-renders.
 */
const requestCache = new Map<string, Promise<UIMessage[]>>();

function findLastAssistantMessage<ChatMessage extends UIMessage>(
  messages: ChatMessage[]
): { index: number; message: ChatMessage } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant") return { index, message };
  }
  return null;
}

function moveMessageToEnd<ChatMessage extends UIMessage>(
  messages: ChatMessage[],
  messageId: string
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0 || idx === messages.length - 1) return messages;

  const result = [...messages];
  const [msg] = result.splice(idx, 1);
  if (!msg) return messages;

  result.push(msg);
  return result;
}

function prependMissingHydratedMessages<ChatMessage extends UIMessage>(
  hydratedMessages: ChatMessage[],
  currentMessages: ChatMessage[]
): ChatMessage[] {
  if (currentMessages.length === 0) return hydratedMessages;

  const currentMessageIds = new Set(
    currentMessages.map((message) => message.id)
  );
  const missingHydratedMessages = hydratedMessages.filter(
    (message) => !currentMessageIds.has(message.id)
  );
  if (missingHydratedMessages.length === 0) return currentMessages;

  // History fetched after mount predates messages already rendered locally.
  // Keep current copies for matching IDs — they may hold newer stream state.
  return [...missingHydratedMessages, ...currentMessages];
}

/**
 * Per-request AG-UI → `UIMessageChunk` projection for the observer path.
 *
 * The transport owns its own projector for streams it drives; this one covers
 * the frames the hook reads directly (cross-tab broadcasts, fallback resume
 * replays, and the `start`-chunk bookkeeping on locally-owned turns).
 * `RUN_STARTED` restarts a run — including on replay — so it restarts the
 * projector with it.
 */
class FrameProjectors {
  private projectors = new Map<string, EventToChunkProjector>();
  /** Runs whose projector threw. Their remaining frames are not projected. */
  private failed = new Set<string>();

  constructor(private onError: (error: Error) => void) {}

  project(requestId: string, body: string | undefined): UIMessageChunk[] {
    if (this.failed.has(requestId)) return [];
    if (!body?.trim()) return [];
    let event: AGUIEvent;
    try {
      event = JSON.parse(body) as AGUIEvent;
    } catch (parseError) {
      console.warn(
        "[useAgentChat] Failed to parse AG-UI frame:",
        parseError instanceof Error ? parseError.message : parseError,
        "body:",
        body.slice(0, 100)
      );
      return [];
    }

    let projector = this.projectors.get(requestId);
    if (!projector || event.type === "RUN_STARTED") {
      projector = new EventToChunkProjector();
      this.projectors.set(requestId, projector);
    }
    try {
      return projector.project(event);
    } catch (projectionError) {
      // A throw leaves the projector mid-event, so every later frame for this
      // run would render as silent truncation. Fail the run and surface it,
      // matching how the transport path errors a turn it cannot project.
      this.failed.add(requestId);
      this.projectors.delete(requestId);
      this.onError(
        projectionError instanceof Error
          ? projectionError
          : new Error(String(projectionError))
      );
      return [];
    }
  }

  release(requestId: string) {
    this.projectors.delete(requestId);
    this.failed.delete(requestId);
  }

  clear() {
    this.projectors.clear();
    this.failed.clear();
  }
}

/**
 * `CF_AGENT_CHAT_MESSAGES` / `CF_AGENT_MESSAGE_UPDATED` carry AG-UI rows on
 * this wire. Rows that already have `parts` are legacy `UIMessage`s (a host
 * that hasn't migrated, or a test fixture) and pass through untouched.
 */
function toChatMessages<ChatMessage extends UIMessage>(
  messages: readonly (ChatMessage | AGUIMessage)[]
): ChatMessage[] {
  if (messages.every((message) => "parts" in message)) {
    return [...(messages as readonly ChatMessage[])];
  }
  const projected = toUIMessages(
    messages as readonly AGUIMessage[]
  ) as ChatMessage[];
  if (projected.length < messages.length) {
    // Rows with no `UIMessage` counterpart (`activity`, an orphan `tool` row)
    // are dropped by design — the documented lossy edge of the reverse
    // projection. They cannot be carried through: a raw AG-UI row in this
    // list would not render and would be written back as-is.
    //
    // HAZARD: with `syncMessagesToServer` (default), a later `setMessages`
    // echoes this shorter list back as CF_AGENT_CHAT_MESSAGES and persists
    // the deletion. Hosts that store activity rows should pass
    // `syncMessagesToServer: false` (server-authoritative, as the option's
    // docs describe).
    console.warn(
      `[useAgentChat] ${messages.length - projected.length} AG-UI row(s) have no UIMessage counterpart and were dropped; ` +
        "with syncMessagesToServer they can be persisted away."
    );
  }
  return projected;
}

/** An AG-UI `role:"tool"` row, as `CF_AGENT_MESSAGE_UPDATED` carries it. */
function isAGUIToolRow(message: unknown): message is ToolMessage {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "tool" &&
    typeof (message as { toolCallId?: unknown }).toolCallId === "string"
  );
}

/**
 * Apply a tool result / approval decision onto the tool part already in the
 * transcript. Mirrors `toUIMessages`' `case "tool"`, which is unreachable for
 * a standalone row, and is exported for the test that drives this frame.
 */
export function applyToolRowUpdate<ChatMessage extends UIMessage>(
  prevMessages: ChatMessage[],
  row: ToolMessage
): ChatMessage[] {
  const messageIdx = prevMessages.findIndex((message) =>
    message.parts.some(
      (part) =>
        "toolCallId" in part &&
        (part as { toolCallId: string }).toolCallId === row.toolCallId
    )
  );
  // Never append: an unknown tool call arrives via the stream or
  // CF_AGENT_CHAT_MESSAGES; appending here duplicates it (#1094).
  if (messageIdx < 0) return prevMessages;

  const message = prevMessages[messageIdx];
  const parts = message.parts.map((part) => {
    if (
      !("toolCallId" in part) ||
      (part as { toolCallId: string }).toolCallId !== row.toolCallId
    ) {
      return part;
    }
    return row.error
      ? { ...part, state: "output-error", errorText: row.error }
      : { ...part, state: "output-available", output: parseToolContent(row) };
  }) as ChatMessage["parts"];

  const next = [...prevMessages];
  next[messageIdx] = { ...message, parts };
  return next;
}

/** Tool output travels as a JSON string; non-JSON stays a raw string. */
function parseToolContent(row: ToolMessage): unknown {
  try {
    return JSON.parse(row.content);
  } catch {
    return row.content;
  }
}

/** The leading `{ type: "start", messageId }` chunk of a projected run. */
function findStartChunk(
  chunks: UIMessageChunk[]
): { messageId: string } | null {
  for (const chunk of chunks) {
    if (
      chunk.type === "start" &&
      typeof (chunk as { messageId?: unknown }).messageId === "string"
    ) {
      return { messageId: (chunk as { messageId: string }).messageId };
    }
  }
  return null;
}

/**
 * React hook for building AI chat interfaces using an Agent.
 *
 * Same options and return shape as `@cloudflare/ai-chat/react`'s
 * `useAgentChat`; speaks AG-UI on the wire.
 */
export function useAgentChat<
  // oxlint-disable-next-line no-unused-vars -- kept for backward compat
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(
  options: UseAgentChatOptions<State, ChatMessage>
): Omit<ReturnType<typeof useChat<ChatMessage>>, "addToolOutput"> & {
  clearHistory: () => void;
  addToolOutput: (opts: AddToolOutputOptions) => void;
  isServerStreaming: boolean;
  isStreaming: boolean;
  isRecovering: boolean;
  isToolContinuation: boolean;
  connectionError: AgentConnectionErrorLike | null;
} {
  const {
    agent,
    getInitialMessages,
    messages: optionsInitialMessages,
    onToolCall,
    onData,
    experimental_automaticToolResolution,
    tools,
    toolsRequiringConfirmation: manualToolsRequiringConfirmation,
    autoContinueAfterToolResult = true,
    autoSendAfterAllConfirmationsResolved = true,
    resume = true,
    cancelOnClientAbort = false,
    syncMessagesToServer = true,
    body: bodyOption,
    prepareSendMessagesRequest,
    ...rest
  } = options;

  if (manualToolsRequiringConfirmation) {
    warnDeprecated(
      "useAgentChat.toolsRequiringConfirmation",
      "The 'toolsRequiringConfirmation' option is deprecated. Use needsApproval on server-side tools instead. Will be removed in the next major version."
    );
  }
  if (experimental_automaticToolResolution) {
    warnDeprecated(
      "useAgentChat.experimental_automaticToolResolution",
      "The 'experimental_automaticToolResolution' option is deprecated. Use the onToolCall callback instead. Will be removed in the next major version."
    );
  }
  if (options.autoSendAfterAllConfirmationsResolved !== undefined) {
    warnDeprecated(
      "useAgentChat.autoSendAfterAllConfirmationsResolved",
      "The 'autoSendAfterAllConfirmationsResolved' option is deprecated. Use sendAutomaticallyWhen from AI SDK instead. Will be removed in the next major version."
    );
  }

  // ── DEPRECATED: client-side tool confirmation ──────────────────────
  const toolsRequiringConfirmation = useMemo(() => {
    if (manualToolsRequiringConfirmation)
      return manualToolsRequiringConfirmation;
    // Inlined so providing `tools` alone doesn't emit a deprecation warning.
    if (!tools) return [];
    return Object.entries(tools)
      .filter(([_name, tool]) => !tool.execute)
      .map(([name]) => name);
  }, [manualToolsRequiringConfirmation, tools]);

  const onToolCallRef = useRef(onToolCall);
  onToolCallRef.current = onToolCall;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  // `onError` stays in `rest` (it belongs to `useChat`); the observer path
  // reports projection failures through the same callback.
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const rawHttpUrl = agent.getHttpUrl();
  const agentUrl = rawHttpUrl ? new URL(rawHttpUrl) : null;
  if (agentUrl) agentUrl.searchParams.delete("_pk");
  const agentUrlString = agentUrl?.toString() ?? null;

  const agentAddressKey = Array.isArray(agent.path)
    ? JSON.stringify(agent.path.map((step) => [step.agent, step.name]))
    : JSON.stringify([[agent.agent ?? "", agent.name ?? ""]]);

  // Query params (auth tokens) must not bust the cache, and the socket URL can
  // transition empty → resolved on the second render; keying on the agent
  // address alone keeps Suspense from re-triggering (#1223, #1356).
  const resolvedInitialMessagesCacheKey = agentUrl
    ? `${agentUrl.origin}${agentUrl.pathname}|${agentAddressKey}`
    : null;
  const initialMessagesCacheKey = agentAddressKey;

  // Stable Chat id: the AI SDK recreates Chat when `id` changes, which would
  // abort an in-flight resume without re-firing the resume effect (#1356).
  // Only a genuinely different `agent` object (or sub-agent address) is a
  // chat switch.
  const stableChatIdRef = useRef<string | null>(null);
  const previousAgentRef = useRef<typeof agent | null>(null);
  const previousAgentAddressKeyRef = useRef<string | null>(null);
  const fallbackChatId = agentAddressKey;
  const agentPathChanged =
    Array.isArray(agent.path) &&
    previousAgentAddressKeyRef.current !== null &&
    previousAgentAddressKeyRef.current !== agentAddressKey;

  if (stableChatIdRef.current === null) {
    stableChatIdRef.current = resolvedInitialMessagesCacheKey ?? fallbackChatId;
  } else if (previousAgentRef.current !== agent || agentPathChanged) {
    stableChatIdRef.current = resolvedInitialMessagesCacheKey ?? fallbackChatId;
  }

  previousAgentRef.current = agent;
  previousAgentAddressKeyRef.current = agentAddressKey;

  // Updated during render (not in an effect) so the transport never sends
  // through a stale socket after a `_pk` change (#929).
  const agentRef = useRef(agent);
  agentRef.current = agent;

  async function defaultGetInitialMessagesFetch({
    url
  }: GetInitialMessagesOptions) {
    if (!url) return [];
    const getMessagesUrl = new URL(url);
    getMessagesUrl.pathname += "/get-messages";
    const response = await fetch(getMessagesUrl.toString(), {
      credentials: options.credentials,
      headers: options.headers
    });

    if (!response.ok) {
      console.warn(
        `Failed to fetch initial messages: ${response.status} ${response.statusText}`
      );
      return [];
    }

    const text = await response.text();
    if (!text.trim()) return [];

    try {
      // `/get-messages` serves persisted rows verbatim: AG-UI rows (with the
      // `_v` marker), legacy `UIMessage` rows from an unmigrated store, or a
      // mix. Normalize to AG-UI, then project to the hook's UIMessage shape.
      return toChatMessages<ChatMessage>(
        autoTransformAGUIMessages(JSON.parse(text) as unknown[])
      );
    } catch (error) {
      console.warn("Failed to parse initial messages JSON:", error);
      return [];
    }
  }

  const getInitialMessagesFetch =
    getInitialMessages || defaultGetInitialMessagesFetch;

  function doGetInitialMessages(
    getInitialMessagesOptions: GetInitialMessagesOptions,
    cacheKey: string
  ) {
    if (requestCache.has(cacheKey)) {
      return requestCache.get(cacheKey)! as Promise<ChatMessage[]>;
    }
    const promise = getInitialMessagesFetch(getInitialMessagesOptions);
    requestCache.set(cacheKey, promise as Promise<UIMessage[]>);
    return promise;
  }

  const shouldFetchInitialMessages =
    getInitialMessages === null
      ? false
      : getInitialMessages
        ? true
        : !!agentUrlString;
  const initialMessagesPromise = !shouldFetchInitialMessages
    ? null
    : doGetInitialMessages(
        {
          agent: agent.agent,
          name: agent.name,
          url: agentUrlString ?? undefined
        },
        initialMessagesCacheKey
      );
  const initialMessages = initialMessagesPromise
    ? use(initialMessagesPromise)
    : ((optionsInitialMessages as ChatMessage[] | undefined) ?? []);

  useEffect(() => {
    if (!initialMessagesPromise) return;
    requestCache.set(
      initialMessagesCacheKey,
      initialMessagesPromise as Promise<UIMessage[]>
    );
    return () => {
      if (
        requestCache.get(initialMessagesCacheKey) === initialMessagesPromise
      ) {
        requestCache.delete(initialMessagesCacheKey);
      }
    };
  }, [initialMessagesCacheKey, initialMessagesPromise]);

  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const prepareSendMessagesRequestRef = useRef(prepareSendMessagesRequest);
  prepareSendMessagesRequestRef.current = prepareSendMessagesRequest;

  const bodyOptionRef = useRef(bodyOption);
  bodyOptionRef.current = bodyOption;

  /** Request ids this tab owns via the transport (skipped by onAgentMessage). */
  const localRequestIdsRef = useRef<Set<string>>(new Set());
  const pendingReplayResumeRequestIdsRef = useRef<Set<string>>(new Set());
  const replayHydratedAssistantMessageIdsRef = useRef<Set<string>>(new Set());
  /**
   * Ids already ACKed via the fallback resume path. The server sends
   * STREAM_RESUMING from both onConnect and its RESUME_REQUEST handler
   * (#1733); re-ACKing would replay the buffer twice.
   */
  const fallbackAckedResumeRequestIdsRef = useRef<Set<string>>(new Set());
  const frameProjectorsRef = useRef<FrameProjectors>(null as never);
  if (frameProjectorsRef.current === null) {
    frameProjectorsRef.current = new FrameProjectors((error) => {
      console.error("[useAgentChat] AG-UI projection failed:", error);
      onErrorRef.current?.(error);
    });
  }

  // Singleton transport: its resume resolver and the hook's
  // handleStreamResuming call must always target the SAME instance, even
  // across `_pk` changes and StrictMode double-mounts. Only `.agent` moves.
  const customTransportRef = useRef<WebSocketChatTransport<ChatMessage> | null>(
    null
  );

  if (customTransportRef.current === null) {
    customTransportRef.current = new WebSocketChatTransport<ChatMessage>({
      agent: agentRef.current,
      activeRequestIds: localRequestIdsRef.current,
      cancelOnClientAbort,
      prepareBody: async ({ messages: msgs, trigger, messageId }) => {
        let extraBody: Record<string, unknown> = {};
        const currentBody = bodyOptionRef.current;
        if (currentBody) {
          const resolved =
            typeof currentBody === "function"
              ? await currentBody()
              : currentBody;
          extraBody = { ...resolved };
        }

        // Deprecated client tools: ship their schemas with every request.
        if (toolsRef.current) {
          const clientToolSchemas = extractClientToolSchemas(toolsRef.current);
          if (clientToolSchemas) extraBody.clientTools = clientToolSchemas;
        }

        if (prepareSendMessagesRequestRef.current) {
          const userResult = await prepareSendMessagesRequestRef.current({
            id: (agentRef.current as unknown as { _pk: string })._pk,
            messages: msgs,
            trigger,
            messageId
          });
          if (userResult.body) Object.assign(extraBody, userResult.body);
        }

        return extraBody;
      }
    });
  }
  customTransportRef.current.setAgent(agentRef.current);
  customTransportRef.current.setCancelOnClientAbort(cancelOnClientAbort);
  const customTransport = customTransportRef.current;

  const useChatHelpers = useChat<ChatMessage>({
    ...rest,
    onData,
    messages: initialMessages,
    transport: customTransport,
    id: stableChatIdRef.current,
    // The hook owns the mount effect below so every resume entry point shares
    // one full-lifetime serialization gate (#1837).
    resume: false
  });

  const {
    messages: chatMessages,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    sendMessage,
    resumeStream: rawResumeStream,
    status,
    stop
  } = useChatHelpers;

  const statusRef = useRef(status);
  statusRef.current = status;

  // AI SDK `Chat.makeRequest` has one mutable activeResponse and no resume
  // concurrency guard (#1837). Serialize the complete AI SDK promise across
  // mount, reconnect, tool and public entry points.
  const resumeGenerationRef = useRef(0);
  const resumeOperationRef = useRef<{
    generation: number;
    promise: Promise<void>;
  } | null>(null);
  const reconnectProbePendingRef = useRef(false);
  const reconnectProbeRunnerRef = useRef<(() => void) | null>(null);
  const invalidateResumeGeneration = useCallback(() => {
    resumeGenerationRef.current++;
    resumeOperationRef.current = null;
  }, []);

  // #1620: a durable turn is being recovered — "working, not frozen",
  // distinct from active streaming. Declared here so the resume gate below
  // can retire the hint when a recovery never materializes.
  const [isRecovering, setIsRecovering] = useState(false);

  const resumeStream = useCallback(
    (...args: Parameters<typeof rawResumeStream>): Promise<void> => {
      const active = resumeOperationRef.current;
      if (active) return active.promise;

      const operation = {
        generation: resumeGenerationRef.current,
        promise: Promise.resolve()
      };
      // Publish ownership before invoking, but invoke synchronously so
      // StrictMode cleanup can always cancel the resolver it creates.
      resumeOperationRef.current = operation;
      try {
        operation.promise = rawResumeStream(...args).finally(() => {
          if (
            resumeOperationRef.current !== operation ||
            resumeGenerationRef.current !== operation.generation
          ) {
            return;
          }
          resumeOperationRef.current = null;
          // The resume settled without a live stream: whatever the server
          // said was recovering never arrived (a give-up on the #1784
          // pending backstop looks exactly like this). Retire the hint
          // instead of leaving a permanent "recovering…" spinner.
          if (statusRef.current !== "streaming") setIsRecovering(false);
          // An open event suppressed while this operation ran is
          // edge-triggered; retry it now rather than losing it.
          reconnectProbeRunnerRef.current?.();
        });
      } catch (error) {
        // A synchronous throw would leave the gate held forever, wedging
        // every later resume entry point behind a promise that never settles.
        if (resumeOperationRef.current === operation) {
          resumeOperationRef.current = null;
        }
        return Promise.reject(error);
      }
      return operation.promise;
    },
    [rawResumeStream]
  );

  const resumeStreamRef = useRef(resumeStream);
  resumeStreamRef.current = resumeStream;

  const resumingToolContinuationRef = useRef(false);
  const pendingToolContinuationRef = useRef(false);
  const observedToolContinuationRequestIdRef = useRef<string | null>(null);
  const continuationLaunchTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // Bumped on every continuation start and on every external reset; a
  // `.finally()` only applies its cleanup if its captured generation still
  // matches.
  const continuationGenerationRef = useRef(0);
  const [isToolContinuation, setIsToolContinuation] = useState(false);

  const resetToolContinuation = useCallback(() => {
    continuationGenerationRef.current++;
    pendingToolContinuationRef.current = false;
    resumingToolContinuationRef.current = false;
    observedToolContinuationRequestIdRef.current = null;
    if (continuationLaunchTimerRef.current) {
      clearTimeout(continuationLaunchTimerRef.current);
      continuationLaunchTimerRef.current = null;
    }
    setIsToolContinuation(false);
  }, []);

  const scheduleToolContinuationLaunch = useCallback(() => {
    if (
      !pendingToolContinuationRef.current ||
      statusRef.current !== "ready" ||
      continuationLaunchTimerRef.current
    ) {
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        // A mount/reconnect resume may still own the AI SDK activeResponse
        // while status lags at ready.
        while (resumeOperationRef.current) {
          await resumeOperationRef.current.promise.catch(() => {});
        }

        if (continuationLaunchTimerRef.current === timer) {
          continuationLaunchTimerRef.current = null;
        }
        if (
          !pendingToolContinuationRef.current ||
          statusRef.current !== "ready"
        ) {
          return;
        }

        pendingToolContinuationRef.current = false;
        const myGeneration = continuationGenerationRef.current;
        customTransport.expectToolContinuation();

        await resumeStream()
          .catch((error) => {
            console.error(
              "[useAgentChat] Tool continuation resume failed:",
              error
            );
          })
          .finally(() => {
            if (continuationGenerationRef.current !== myGeneration) return;
            resumingToolContinuationRef.current = false;
            setIsToolContinuation(false);
          });
      })();
    }, 0);
    continuationLaunchTimerRef.current = timer;
  }, [customTransport, resumeStream]);

  const startToolContinuation = useCallback(() => {
    if (!autoContinueAfterToolResult || resumingToolContinuationRef.current) {
      return;
    }

    ++continuationGenerationRef.current;
    resumingToolContinuationRef.current = true;
    pendingToolContinuationRef.current = true;
    setIsToolContinuation(true);
    scheduleToolContinuationLaunch();
  }, [autoContinueAfterToolResult, scheduleToolContinuationLaunch]);

  useEffect(() => {
    if (status === "error" && pendingToolContinuationRef.current) {
      resetToolContinuation();
      return;
    }
    scheduleToolContinuationLaunch();
  }, [resetToolContinuation, scheduleToolContinuationLaunch, status]);

  const stopWithToolContinuationAbort: typeof stop = useCallback(async () => {
    try {
      customTransport.cancelActiveServerTurn();
      await stop();
    } finally {
      customTransport.abortActiveToolContinuation();
    }
  }, [stop, customTransport]);

  const processedToolCalls = useRef(new Set<string>());
  const isResolvingToolsRef = useRef(false);
  // Forces the deprecated tool-resolution effect to re-run after a batch, so
  // calls that arrived while it was busy get picked up.
  const [toolResolutionTrigger, setToolResolutionTrigger] = useState(0);

  // #728: mirror client-side tool results locally so tool parts show
  // output-available immediately after execution.
  const [clientToolResults, setClientToolResults] = useState<
    Map<string, unknown>
  >(new Map());

  const messagesRef = useRef(chatMessages);
  messagesRef.current = chatMessages;
  const initialMessagesRef = useRef(initialMessages);
  initialMessagesRef.current = initialMessages;

  const seededInitialMessagesKeyRef = useRef<string | null>(null);
  const markInitialMessagesSeeded = useCallback(() => {
    seededInitialMessagesKeyRef.current = initialMessagesCacheKey;
  }, [initialMessagesCacheKey]);

  // Late-seed: when the initial-messages promise resolves AFTER Chat mounted,
  // `useChat({ messages })` won't re-ingest it. Apply it once per cache key,
  // prepending only history the client doesn't already hold. Marking the key
  // on every observation stops a later clear from resurrecting it.
  useEffect(() => {
    if (!initialMessagesPromise) return;
    if (seededInitialMessagesKeyRef.current === initialMessagesCacheKey) return;

    markInitialMessagesSeeded();
    setMessages((prevMessages: ChatMessage[]) =>
      prependMissingHydratedMessages(initialMessagesRef.current, prevMessages)
    );
  }, [
    initialMessagesCacheKey,
    initialMessagesPromise,
    markInitialMessagesSeeded,
    setMessages
  ]);

  const localResponseMessageIdsRef = useRef(new Map<string, string>());
  const protectedStreamingAssistantRef = useRef<{
    assistantId: string;
    anchorMessageId: string | null;
  } | null>(null);

  const preserveProtectedStreamingAssistant = useCallback(
    (messages: readonly ChatMessage[]): ChatMessage[] => {
      const protection = protectedStreamingAssistantRef.current;
      if (!protection) return [...messages];

      // If the snapshot already holds the protected assistant AND a later
      // assistant, the transcript has moved past it — trust the snapshot
      // rather than reordering it (#1778).
      const protectedIndex = messages.findIndex(
        (message) => message.id === protection.assistantId
      );
      if (
        protectedIndex >= 0 &&
        messages
          .slice(protectedIndex + 1)
          .some((message) => message.role === "assistant")
      ) {
        protectedStreamingAssistantRef.current = null;
        return [...messages];
      }

      const protectedAssistant =
        messagesRef.current.find(
          (message) => message.id === protection.assistantId
        ) ?? messages.find((message) => message.id === protection.assistantId);
      if (!protectedAssistant) return [...messages];

      return [
        ...messages.filter((message) => message.id !== protection.assistantId),
        protectedAssistant
      ];
    },
    []
  );

  const protectStreamingAssistantTail = useCallback(() => {
    if (statusRef.current !== "streaming") return;

    const assistantInfo = findLastAssistantMessage(messagesRef.current);
    if (!assistantInfo) return;

    if (
      protectedStreamingAssistantRef.current?.assistantId !==
      assistantInfo.message.id
    ) {
      protectedStreamingAssistantRef.current = {
        assistantId: assistantInfo.message.id,
        anchorMessageId:
          messagesRef.current[assistantInfo.index - 1]?.id ?? null
      };
    }

    setMessages((prevMessages: ChatMessage[]) => {
      const protection = protectedStreamingAssistantRef.current;
      if (!protection) return prevMessages;
      return moveMessageToEnd(prevMessages, protection.assistantId);
    });
  }, [setMessages]);

  const restoreProtectedStreamingAssistant = useCallback(
    (assistantId?: string) => {
      const protection = protectedStreamingAssistantRef.current;
      if (
        !protection ||
        (assistantId !== undefined && protection.assistantId !== assistantId)
      ) {
        return;
      }

      protectedStreamingAssistantRef.current = null;
      setMessages((prevMessages: ChatMessage[]) => {
        const sourceIdx = prevMessages.findIndex(
          (m) => m.id === protection.assistantId
        );
        if (sourceIdx < 0) return prevMessages;

        const result = [...prevMessages];
        const [msg] = result.splice(sourceIdx, 1);
        if (!msg) return prevMessages;

        if (protection.anchorMessageId === null) {
          result.unshift(msg);
        } else {
          const anchorIdx = result.findIndex(
            (m) => m.id === protection.anchorMessageId
          );
          result.splice(anchorIdx >= 0 ? anchorIdx + 1 : sourceIdx, 0, msg);
        }

        return result;
      });
    },
    [setMessages]
  );

  const resetMatchingHydratedAssistantForReplay = useCallback(
    (messageId: string) => {
      setMessages((prevMessages: ChatMessage[]) => {
        const lastMessage = prevMessages[prevMessages.length - 1];
        if (
          !lastMessage ||
          lastMessage.role !== "assistant" ||
          lastMessage.id !== messageId
        ) {
          return prevMessages;
        }

        // Hydration can already hold the partially persisted assistant. Clear
        // it only once replay proves it is rebuilding the same message.
        replayHydratedAssistantMessageIdsRef.current.add(messageId);
        const next = [...prevMessages];
        next[next.length - 1] = { ...lastMessage, parts: [] };
        return next;
      });
    },
    [setMessages]
  );

  const collapseHydratedReplayTextParts = useCallback(
    (message: ChatMessage): ChatMessage => {
      const parts = message.parts;
      const nextParts = parts.filter((part, index) => {
        if (part.type !== "text" || !("text" in part) || !part.text)
          return true;

        // Replay rebuilds from the first chunk; if the hydrated assistant
        // already had the prefix, replay can produce a second text part.
        return !parts.some((candidate, candidateIndex) => {
          if (candidateIndex <= index) return false;
          if (
            candidate.type !== "text" ||
            !("text" in candidate) ||
            !candidate.text
          ) {
            return false;
          }
          return candidate.text.startsWith(part.text);
        });
      });

      return nextParts.length === parts.length
        ? message
        : { ...message, parts: nextParts };
    },
    []
  );

  useEffect(() => {
    if (replayHydratedAssistantMessageIdsRef.current.size === 0) return;

    const idsToCollapse = new Set(
      chatMessages
        .filter(
          (message) =>
            replayHydratedAssistantMessageIdsRef.current.has(message.id) &&
            message.role === "assistant" &&
            collapseHydratedReplayTextParts(message) !== message
        )
        .map((message) => message.id)
    );
    if (idsToCollapse.size === 0) return;

    setMessages((prevMessages: ChatMessage[]) => {
      let changed = false;
      const nextMessages = prevMessages.map((message) => {
        if (!idsToCollapse.has(message.id)) return message;
        const nextMessage = collapseHydratedReplayTextParts(message);
        if (nextMessage !== message) changed = true;
        return nextMessage;
      });
      return changed ? nextMessages : prevMessages;
    });
  }, [chatMessages, collapseHydratedReplayTextParts, setMessages]);

  // Shared reset for every path that wipes chat history — keep in sync
  // between `clearHistory()` and the CF_AGENT_CHAT_CLEAR handler.
  const resetLocalChatState = useCallback(() => {
    markInitialMessagesSeeded();
    setMessages([]);
    setClientToolResults(new Map());
    setPendingOnToolCallIds(new Set());
    resetToolContinuation();
    processedToolCalls.current.clear();
    localResponseMessageIdsRef.current.clear();
    pendingReplayResumeRequestIdsRef.current.clear();
    fallbackAckedResumeRequestIdsRef.current.clear();
    replayHydratedAssistantMessageIdsRef.current.clear();
    frameProjectorsRef.current.clear();
    protectedStreamingAssistantRef.current = null;
  }, [markInitialMessagesSeeded, setMessages, resetToolContinuation]);

  const sendMessageWithStreamingProtection: typeof sendMessage = useCallback(
    async (message, sendOptions) => {
      const request = sendMessage(message, sendOptions);

      if (
        message !== undefined &&
        !(
          typeof message === "object" &&
          message !== null &&
          "messageId" in message &&
          message.messageId != null
        )
      ) {
        protectStreamingAssistantTail();
      }

      return request;
    },
    [sendMessage, protectStreamingAssistantTail]
  );

  const lastMessage = chatMessages[chatMessages.length - 1];

  const pendingConfirmations = (() => {
    if (!lastMessage || lastMessage.role !== "assistant") {
      return { messageId: undefined, toolCallIds: new Set<string>() };
    }

    const pendingIds = new Set<string>();
    for (const part of lastMessage.parts ?? []) {
      if (
        isToolUIPart(part) &&
        part.state === "input-available" &&
        toolsRequiringConfirmation.includes(getToolName(part))
      ) {
        pendingIds.add(part.toolCallId);
      }
    }
    return { messageId: lastMessage.id, toolCallIds: pendingIds };
  })();

  const pendingConfirmationsRef = useRef(pendingConfirmations);
  pendingConfirmationsRef.current = pendingConfirmations;
  const [pendingOnToolCallIds, setPendingOnToolCallIds] = useState<Set<string>>(
    () => new Set()
  );

  const finishOnToolCall = useCallback((toolCallId: string) => {
    setPendingOnToolCallIds((prev) => {
      if (!prev.has(toolCallId)) return prev;
      const next = new Set(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  // ── DEPRECATED: automatic tool resolution effect ────────────────────
  useEffect(() => {
    if (!experimental_automaticToolResolution) return;

    void toolResolutionTrigger;
    if (isResolvingToolsRef.current) return;

    const lastMsg = chatMessages[chatMessages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const toolCalls = lastMsg.parts.filter(
      (part) =>
        isToolUIPart(part) &&
        part.state === "input-available" &&
        !processedToolCalls.current.has(part.toolCallId)
    );
    if (toolCalls.length === 0) return;

    const currentTools = toolsRef.current;
    const toolCallsToResolve = toolCalls.filter(
      (part) =>
        isToolUIPart(part) &&
        !toolsRequiringConfirmation.includes(getToolName(part)) &&
        currentTools?.[getToolName(part)]?.execute
    );
    if (toolCallsToResolve.length === 0) return;

    isResolvingToolsRef.current = true;

    (async () => {
      try {
        const toolResults: Array<{
          toolCallId: string;
          toolName: string;
          output: unknown;
        }> = [];

        for (const part of toolCallsToResolve) {
          if (!isToolUIPart(part)) continue;
          let toolOutput: unknown = null;
          const toolName = getToolName(part);
          const tool = currentTools?.[toolName];

          if (tool?.execute && part.input !== undefined) {
            try {
              toolOutput = await tool.execute(part.input);
            } catch (error) {
              toolOutput = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
            }
          }

          processedToolCalls.current.add(part.toolCallId);
          toolResults.push({
            toolCallId: part.toolCallId,
            toolName,
            output: toolOutput
          });
        }

        if (toolResults.length > 0) {
          // Server is the source of truth: tell it first.
          const clientToolSchemas = extractClientToolSchemas(currentTools);
          for (const result of toolResults) {
            agentRef.current.send(
              JSON.stringify({
                type: MessageType.CF_AGENT_TOOL_RESULT,
                toolCallId: result.toolCallId,
                toolName: result.toolName,
                output: result.output,
                autoContinue: autoContinueAfterToolResult,
                clientTools: clientToolSchemas
              })
            );
          }

          await Promise.all(
            toolResults.map((result) =>
              addToolResult({
                tool: result.toolName,
                toolCallId: result.toolCallId,
                output: result.output
              })
            )
          );

          setClientToolResults((prev) => {
            const newMap = new Map(prev);
            for (const result of toolResults) {
              newMap.set(result.toolCallId, result.output);
            }
            return newMap;
          });

          startToolContinuation();
        }
      } finally {
        isResolvingToolsRef.current = false;
        setToolResolutionTrigger((c) => c + 1);
      }
    })();
  }, [
    chatMessages,
    experimental_automaticToolResolution,
    addToolResult,
    toolsRequiringConfirmation,
    autoContinueAfterToolResult,
    startToolContinuation,
    toolResolutionTrigger
  ]);

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
          // output-error is a deliberate client action — don't auto-continue.
          autoContinue: shouldAutoContinue,
          clientTools: toolsRef.current
            ? extractClientToolSchemas(toolsRef.current)
            : undefined
        })
      );

      if (state !== "output-error") {
        setClientToolResults((prev) => new Map(prev).set(toolCallId, output));
      }
      if (shouldAutoContinue) startToolContinuation();
    },
    [autoContinueAfterToolResult, startToolContinuation]
  );

  const sendToolApprovalToServer = useCallback(
    (toolCallId: string, approved: boolean) => {
      agentRef.current.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_APPROVAL,
          toolCallId,
          approved,
          autoContinue: autoContinueAfterToolResult
        })
      );
      if (autoContinueAfterToolResult) startToolContinuation();
    },
    [autoContinueAfterToolResult, startToolContinuation]
  );

  // v6-style `onToolCall` dispatch for client-side tool calls.
  useEffect(() => {
    const currentOnToolCall = onToolCallRef.current;
    if (!currentOnToolCall) return;

    const lastMsg = chatMessages[chatMessages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const pendingToolCalls = lastMsg.parts.filter(
      (part) =>
        isToolUIPart(part) &&
        part.state === "input-available" &&
        !processedToolCalls.current.has(part.toolCallId)
    );

    for (const part of pendingToolCalls) {
      if (!isToolUIPart(part)) continue;
      const toolCallId = part.toolCallId;
      const toolName = getToolName(part);

      processedToolCalls.current.add(toolCallId);
      setPendingOnToolCallIds((prev) => {
        if (prev.has(toolCallId)) return prev;
        const next = new Set(prev);
        next.add(toolCallId);
        return next;
      });

      const addToolOutputForCall = (opts: AddToolOutputOptions) => {
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

      let result: void | Promise<void>;
      try {
        result = currentOnToolCall({
          toolCall: { toolCallId, toolName, input: part.input },
          addToolOutput: addToolOutputForCall
        });
      } catch (error) {
        finishOnToolCall(toolCallId);
        throw error;
      }
      void Promise.resolve(result).finally(() => {
        finishOnToolCall(toolCallId);
      });
    }
  }, [chatMessages, sendToolOutputToServer, addToolResult, finishOnToolCall]);

  const streamStateRef = useRef<BroadcastStreamState>({ status: "idle" });

  const [isServerStreaming, setIsServerStreaming] = useState(false);

  useEffect(() => {
    const localResponseIds = localResponseMessageIdsRef.current;
    const frameProjectors = frameProjectorsRef.current;

    function onAgentMessage(event: MessageEvent) {
      if (typeof event.data !== "string") return;

      let data: OutgoingMessage<ChatMessage>;
      try {
        data = JSON.parse(event.data) as OutgoingMessage<ChatMessage>;
      } catch (_error) {
        return;
      }

      switch (data.type) {
        case MessageType.CF_AGENT_CHAT_CLEAR:
          streamStateRef.current = broadcastTransition(streamStateRef.current, {
            type: "clear"
          }).state;
          setIsServerStreaming(false);
          setIsRecovering(false);
          resetLocalChatState();
          break;

        case MessageType.CF_AGENT_CHAT_RECOVERING:
          setIsRecovering(Boolean(data.recovering));
          break;

        case MessageType.CF_AGENT_CHAT_MESSAGES: {
          let next = preserveProtectedStreamingAssistant(
            toChatMessages<ChatMessage>(data.messages)
          );
          // A cross-tab observer builds its in-flight assistant in the
          // broadcast accumulator, not the transport, so re-apply it over a
          // possibly-behind snapshot — but only when it is at least as
          // complete, so a replay-rebuilding observer can't drop parts.
          const observed = streamStateRef.current;
          if (
            observed.status === "observing" &&
            observed.accumulator.parts.length > 0
          ) {
            const snapshotIdx = next.findIndex(
              (m) => m.id === observed.accumulator.messageId
            );
            const snapshotParts =
              snapshotIdx >= 0 ? next[snapshotIdx].parts.length : 0;
            if (observed.accumulator.parts.length >= snapshotParts) {
              next = observed.accumulator.mergeInto(next) as ChatMessage[];
            }
          }
          setMessages(next);
          break;
        }

        case MessageType.CF_AGENT_MESSAGE_UPDATED:
          setMessages((prevMessages: ChatMessage[]) => {
            // On the AG-UI wire this frame is a standalone `role:"tool"` row.
            // It has no `UIMessage` of its own — `toUIMessages` attaches a tool
            // result to the part its issuing assistant opened, and drops an
            // orphan row — so fold it onto the transcript by `toolCallId`.
            if (isAGUIToolRow(data.message)) {
              return applyToolRowUpdate(prevMessages, data.message);
            }

            const updatedMessage = toChatMessages<ChatMessage>([
              data.message
            ])[0];
            if (!updatedMessage) return prevMessages;
            let idx = prevMessages.findIndex((m) => m.id === updatedMessage.id);

            // Client IDs can differ from server IDs; fall back to toolCallId.
            if (idx < 0) {
              const updatedToolCallIds = new Set(
                updatedMessage.parts
                  .filter(
                    (p: ChatMessage["parts"][number]) =>
                      "toolCallId" in p && p.toolCallId
                  )
                  .map(
                    (p: ChatMessage["parts"][number]) =>
                      (p as { toolCallId: string }).toolCallId
                  )
              );

              if (updatedToolCallIds.size > 0) {
                idx = prevMessages.findIndex((m) =>
                  m.parts.some(
                    (p) =>
                      "toolCallId" in p &&
                      updatedToolCallIds.has(
                        (p as { toolCallId: string }).toolCallId
                      )
                  )
                );
              }
            }

            if (idx >= 0) {
              const updated = [...prevMessages];
              updated[idx] = { ...updatedMessage, id: prevMessages[idx].id };
              return updated;
            }
            // Never append here — an unknown message arrives via the stream or
            // CF_AGENT_CHAT_MESSAGES; appending duplicates it (#1094).
            return prevMessages;
          });
          break;

        case MessageType.CF_AGENT_STREAM_RESUME_NONE: {
          // Every matching NONE settles the probe, but only a correlated idle
          // reason proves inactivity for it (#1914).
          const handled = customTransport.handleStreamResumeNone(data);
          if (
            handled &&
            data.reason === STREAM_RESUME_NONE_REASONS.IDLE &&
            typeof data.probeId === "string"
          ) {
            const result = broadcastTransition(streamStateRef.current, {
              type: "clear"
            });
            streamStateRef.current = result.state;
            setIsServerStreaming(result.isStreaming);
            if (observedToolContinuationRequestIdRef.current !== null) {
              resetToolContinuation();
            }
          }
          break;
        }

        case MessageType.CF_AGENT_STREAM_PENDING:
          // #1784: keep the resume probe waiting through the pre-stream window.
          customTransport.handleStreamPending();
          break;

        case MessageType.CF_AGENT_STREAM_RESUMING: {
          const isEarlyToolContinuation =
            resumingToolContinuationRef.current &&
            !customTransport.isAwaitingResume();
          if (!resume && !customTransport.isAwaitingResume()) {
            if (!isEarlyToolContinuation) return;
          }
          if (!resumingToolContinuationRef.current) {
            pendingReplayResumeRequestIdsRef.current.add(data.id);
          }
          // Synchronous handoff: the transport ACKs, claims the id, and builds
          // the stream that feeds useChat. Runs before the fallback dedupe so
          // a fallback-observed stream can still become transport-owned.
          if (customTransport.handleStreamResuming(data)) return;
          if (localRequestIdsRef.current.has(data.id)) return;
          // Duplicate offer for a stream this socket already fallback-ACKed
          // (#1733): re-ACKing only triggers a second replay.
          if (fallbackAckedResumeRequestIdsRef.current.has(data.id)) return;
          if (isEarlyToolContinuation) {
            pendingToolContinuationRef.current = false;
            observedToolContinuationRequestIdRef.current = data.id;
            if (continuationLaunchTimerRef.current) {
              clearTimeout(continuationLaunchTimerRef.current);
              continuationLaunchTimerRef.current = null;
            }
          }
          // Fallback observer path (cross-tab, or no resume in flight).
          streamStateRef.current = broadcastTransition(streamStateRef.current, {
            type: "resume-fallback",
            streamId: data.id,
            messageId: nanoid()
          }).state;
          frameProjectors.release(data.id);
          customTransport.observeServerTurn(data.id);
          setIsServerStreaming(true);
          // Streaming live to us means the turn is answering, not recovering.
          setIsRecovering(false);
          fallbackAckedResumeRequestIdsRef.current.add(data.id);
          agentRef.current.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
              id: data.id
            })
          );
          break;
        }

        case MessageType.CF_AGENT_USE_CHAT_RESPONSE: {
          if (localRequestIdsRef.current.has(data.id)) {
            // The transport owns this stream's chunks; the hook only needs the
            // run's message id for tail protection and replay resets. Done and
            // error frames carry no AG-UI event body (an error frame's body is
            // raw error text) — skip the projector rather than warn on them.
            const startChunk =
              data.done || data.error
                ? undefined
                : findStartChunk(frameProjectors.project(data.id, data.body));
            if (startChunk) {
              localResponseIds.set(data.id, startChunk.messageId);
              // `protectStreamingAssistantTail` runs at send time, before the
              // assistant is minted, so re-arm to the real id here or a
              // mid-stream full-list broadcast will replace the live message.
              // Continuations extend the already-protected assistant.
              if (!data.continuation) {
                const protection = protectedStreamingAssistantRef.current;
                if (protection?.assistantId !== startChunk.messageId) {
                  const msgs = messagesRef.current;
                  const idx = msgs.findIndex(
                    (m) => m.id === startChunk.messageId
                  );
                  const anchorMessageId =
                    idx >= 0
                      ? (msgs[idx - 1]?.id ?? null)
                      : (msgs[msgs.length - 1]?.id ?? null);
                  protectedStreamingAssistantRef.current = {
                    assistantId: startChunk.messageId,
                    anchorMessageId
                  };
                }
              }
              // EVERY replayed start rebuilds from chunk 0, so reset the
              // matching trailing assistant each time (#1733). Continuation
              // replays append instead, so they are excluded.
              if (
                data.replay &&
                !data.continuation &&
                !resumingToolContinuationRef.current &&
                observedToolContinuationRequestIdRef.current !== data.id
              ) {
                pendingReplayResumeRequestIdsRef.current.delete(data.id);
                resetMatchingHydratedAssistantForReplay(startChunk.messageId);
              }
            }

            if (data.done || data.error || data.replayComplete) {
              pendingReplayResumeRequestIdsRef.current.delete(data.id);
            }
            if (data.done || data.error) {
              if (
                streamStateRef.current.status === "observing" &&
                streamStateRef.current.streamId === data.id
              ) {
                streamStateRef.current = { status: "idle" };
                setIsServerStreaming(false);
              }
              customTransport.handleServerTurnCompleted(data.id);
              restoreProtectedStreamingAssistant(localResponseIds.get(data.id));
              localResponseIds.delete(data.id);
              localRequestIdsRef.current.delete(data.id);
              fallbackAckedResumeRequestIdsRef.current.delete(data.id);
              frameProjectors.release(data.id);
              if (observedToolContinuationRequestIdRef.current === data.id) {
                resetToolContinuation();
              }
            }
            return;
          }

          if (
            data.replay &&
            streamStateRef.current.status !== "observing" &&
            !pendingReplayResumeRequestIdsRef.current.has(data.id)
          ) {
            return;
          }
          if (data.error) {
            pendingReplayResumeRequestIdsRef.current.delete(data.id);
            customTransport.handleServerTurnCompleted(data.id);
            fallbackAckedResumeRequestIdsRef.current.delete(data.id);
            frameProjectors.release(data.id);
            setIsRecovering(false);

            if (
              streamStateRef.current.status === "idle" ||
              streamStateRef.current.streamId === data.id
            ) {
              const result = broadcastTransition(streamStateRef.current, {
                type: "clear"
              });
              streamStateRef.current = result.state;
              setIsServerStreaming(result.isStreaming);
            }
            if (observedToolContinuationRequestIdRef.current === data.id) {
              resetToolContinuation();
            }
            break;
          }

          // Error bodies are diagnostics, not events — handled above.
          const chunks = frameProjectors.project(data.id, data.body);

          const replayStart =
            data.replay &&
            !data.continuation &&
            !resumingToolContinuationRef.current &&
            observedToolContinuationRequestIdRef.current !== data.id
              ? findStartChunk(chunks)
              : null;
          if (replayStart) {
            // Reset on EVERY replayed start: a second replay would otherwise
            // stack a duplicate text part on the frozen first one (#1733).
            pendingReplayResumeRequestIdsRef.current.delete(data.id);
            resetMatchingHydratedAssistantForReplay(replayStart.messageId);
          }

          if (onDataRef.current) {
            for (const chunk of chunks) {
              if (
                typeof chunk.type === "string" &&
                chunk.type.startsWith("data-")
              ) {
                onDataRef.current(
                  chunk as Parameters<NonNullable<typeof onDataRef.current>>[0]
                );
              }
            }
          }

          if (data.done || data.replayComplete) {
            pendingReplayResumeRequestIdsRef.current.delete(data.id);
          }
          if (data.done) {
            customTransport.handleServerTurnCompleted(data.id);
            fallbackAckedResumeRequestIdsRef.current.delete(data.id);
            frameProjectors.release(data.id);
            // A terminal outcome resolves any in-progress recovery (#1620).
            setIsRecovering(false);
          }
          const completedObservedToolContinuation =
            data.done &&
            observedToolContinuationRequestIdRef.current === data.id;

          // One AG-UI event can project to several chunks; the frame's
          // terminal flags belong to the last of them.
          const steps: Array<UIMessageChunk | undefined> =
            chunks.length > 0 ? chunks : [undefined];
          for (let i = 0; i < steps.length; i++) {
            const isLast = i === steps.length - 1;
            const result = broadcastTransition(streamStateRef.current, {
              type: "response",
              streamId: data.id,
              messageId: nanoid(),
              chunkData: steps[i],
              done: isLast ? data.done : false,
              // Always false here: an error frame breaks out above. Passed
              // explicitly so this stays correct if that guard ever moves.
              error: isLast ? data.error : false,
              replay: data.replay,
              replayComplete: isLast ? data.replayComplete : false,
              continuation: data.continuation,
              currentMessages: data.continuation
                ? messagesRef.current
                : undefined
            });

            streamStateRef.current = result.state;
            if (result.messagesUpdate) {
              setMessages(
                result.messagesUpdate as unknown as (
                  prev: ChatMessage[]
                ) => ChatMessage[]
              );
            }
            setIsServerStreaming(result.isStreaming);
          }
          if (completedObservedToolContinuation) resetToolContinuation();
          break;
        }
      }
    }

    const fallbackAckedResumeRequestIds =
      fallbackAckedResumeRequestIdsRef.current;

    let socketIsOpen = false;
    let sawClose = false;
    let disposed = false;

    const clearFallbackObserver = () => {
      const result = broadcastTransition(streamStateRef.current, {
        type: "clear"
      });
      streamStateRef.current = result.state;
      setIsServerStreaming(result.isStreaming);
      if (observedToolContinuationRequestIdRef.current !== null) {
        resetToolContinuation();
      }
    };

    // An open is an edge, not durable state. Keep it pending while AI SDK
    // status, a tool continuation, or the #1837 gate is ineligible. A
    // handshake that crossed the disconnect is retransmitted on the
    // replacement socket rather than starting a second Chat resume.
    const tryPendingReconnectProbe = () => {
      if (disposed || !socketIsOpen || !reconnectProbePendingRef.current)
        return;
      if (!resume) {
        reconnectProbePendingRef.current = false;
        return;
      }
      if (customTransport.retryPendingResume()) {
        reconnectProbePendingRef.current = false;
        return;
      }

      const canReconcileObservedContinuation =
        observedToolContinuationRequestIdRef.current !== null;
      if (
        (statusRef.current !== "ready" && statusRef.current !== "error") ||
        (resumingToolContinuationRef.current &&
          !canReconcileObservedContinuation) ||
        resumeOperationRef.current !== null
      ) {
        return;
      }

      reconnectProbePendingRef.current = false;
      void resumeStreamRef.current().catch(() => {});
    };
    reconnectProbeRunnerRef.current = tryPendingReconnectProbe;

    // Track a close→open transition rather than counting opens, so mounting
    // after the parent socket was already open still counts as a reconnect.
    function onAgentClose() {
      socketIsOpen = false;
      sawClose = true;
      fallbackAckedResumeRequestIds.clear();

      // resume:false opts out of recovering disconnected streams — stop
      // claiming a disconnected fallback observer is live.
      if (!resume) clearFallbackObserver();
    }

    function onAgentOpen() {
      socketIsOpen = true;
      if (!sawClose) return;
      sawClose = false;
      reconnectProbePendingRef.current = true;
      tryPendingReconnectProbe();
    }

    agent.addEventListener("message", onAgentMessage);
    agent.addEventListener("close", onAgentClose);
    agent.addEventListener("open", onAgentOpen);

    return () => {
      disposed = true;
      if (reconnectProbeRunnerRef.current === tryPendingReconnectProbe) {
        reconnectProbeRunnerRef.current = null;
      }
      reconnectProbePendingRef.current = false;
      agent.removeEventListener("message", onAgentMessage);
      agent.removeEventListener("close", onAgentClose);
      agent.removeEventListener("open", onAgentOpen);
      fallbackAckedResumeRequestIds.clear();
      streamStateRef.current = { status: "idle" };
      setIsServerStreaming(false);
      setIsRecovering(false);
      protectedStreamingAssistantRef.current = null;
      localResponseIds.clear();
      frameProjectors.clear();
      // A launch scheduled just before unmount would otherwise fire against
      // a torn-down socket and an obsolete Chat generation.
      if (continuationLaunchTimerRef.current) {
        clearTimeout(continuationLaunchTimerRef.current);
        continuationLaunchTimerRef.current = null;
      }

      // Invalidate both sides of an old agent/Chat generation. The transport
      // settles identity-safely; the token stops its late AI SDK finalizer
      // from reopening the serialization gate under a new Chat.
      customTransport.resetResumeState();
      invalidateResumeGeneration();
    };
  }, [
    agent,
    setMessages,
    resume,
    customTransport,
    preserveProtectedStreamingAssistant,
    resetToolContinuation,
    resetMatchingHydratedAssistantForReplay,
    restoreProtectedStreamingAssistant,
    resetLocalChatState,
    invalidateResumeGeneration
  ]);

  // Own mount/chat-generation resumption so StrictMode, reconnects, tool
  // continuations and public calls share the #1837 gate. Declared after the
  // socket handler so a synchronous response can't beat listener registration.
  useEffect(() => {
    if (!resume) return;
    void resumeStream().catch(() => {});
  }, [resume, resumeStream]);

  // Flush an open edge that arrived while status/tool state was ineligible.
  useEffect(() => {
    reconnectProbeRunnerRef.current?.();
  }, [isToolContinuation, status]);

  // ── DEPRECATED: addToolResult wrapper with confirmation batching ────
  const addToolResultAndSendMessage: typeof addToolResult = async (args) => {
    const { toolCallId } = args;
    const toolName = "tool" in args ? args.tool : "";
    const output = "output" in args ? args.output : undefined;

    agentRef.current.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId,
        toolName,
        output,
        autoContinue: autoContinueAfterToolResult,
        clientTools: toolsRef.current
          ? extractClientToolSchemas(toolsRef.current)
          : undefined
      })
    );

    setClientToolResults((prev) => new Map(prev).set(toolCallId, output));

    // Not awaited — clientToolResults already gives immediate UI feedback.
    addToolResult(args);

    if (autoContinueAfterToolResult) {
      startToolContinuation();
      return;
    }

    // Legacy client-driven continuation: batch confirmations or send now.
    if (!autoSendAfterAllConfirmationsResolved) {
      sendMessage();
      return;
    }

    const pending = pendingConfirmationsRef.current?.toolCallIds;
    if (!pending) {
      sendMessage();
      return;
    }

    const wasLast = pending.size === 1 && pending.has(toolCallId);
    if (pending.has(toolCallId)) pending.delete(toolCallId);
    if (wasLast || pending.size === 0) sendMessage();
  };

  // Notify the server before updating local state so it updates the message
  // in place, rather than resolving IDs later on sendMessage().
  const addToolApprovalResponseAndNotifyServer: typeof addToolApprovalResponse =
    (args) => {
      const { id: approvalId, approved } = args;

      let toolCallId: string | undefined;
      for (const msg of messagesRef.current) {
        for (const part of msg.parts) {
          if (
            "toolCallId" in part &&
            "approval" in part &&
            (part.approval as { id?: string })?.id === approvalId
          ) {
            toolCallId = part.toolCallId as string;
            break;
          }
        }
        if (toolCallId) break;
      }

      if (toolCallId) {
        sendToolApprovalToServer(toolCallId, approved);
      } else {
        console.warn(
          `[useAgentChat] addToolApprovalResponse: Could not find toolCallId for approval ID "${approvalId}". ` +
            "Server will not be notified, which may cause duplicate messages."
        );
      }

      addToolApprovalResponse(args);
    };

  // #728: merge client-side tool results so tool parts show output-available
  // immediately after execution.
  const messagesWithToolResults = useMemo(() => {
    if (clientToolResults.size === 0) return chatMessages;
    return chatMessages.map((msg) => ({
      ...msg,
      parts: msg.parts.map((p) => {
        if (
          !("toolCallId" in p) ||
          !("state" in p) ||
          p.state !== "input-available" ||
          !clientToolResults.has(p.toolCallId)
        ) {
          return p;
        }
        return {
          ...p,
          state: "output-available" as const,
          output: clientToolResults.get(p.toolCallId)
        };
      })
    })) as ChatMessage[];
  }, [chatMessages, clientToolResults]);

  // Drop stale clientToolResults entries so long conversations don't leak.
  // clientToolResults is deliberately not a dep (the updater reads prev).
  useEffect(() => {
    const currentToolCallIds = new Set<string>();
    for (const msg of chatMessages) {
      for (const part of msg.parts) {
        if ("toolCallId" in part && part.toolCallId) {
          currentToolCallIds.add(part.toolCallId);
        }
      }
    }

    setClientToolResults((prev) => {
      if (prev.size === 0) return prev;

      let hasStaleEntries = false;
      for (const toolCallId of prev.keys()) {
        if (!currentToolCallIds.has(toolCallId)) {
          hasStaleEntries = true;
          break;
        }
      }
      if (!hasStaleEntries) return prev;

      const newMap = new Map<string, unknown>();
      for (const [id, output] of prev) {
        if (currentToolCallIds.has(id)) newMap.set(id, output);
      }
      return newMap;
    });

    for (const toolCallId of processedToolCalls.current) {
      if (!currentToolCallIds.has(toolCallId)) {
        processedToolCalls.current.delete(toolCallId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages]);

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

  // The server ends the stream as soon as it emits a tool call it can't
  // execute, dropping `status` to "ready" while the client handler still runs.
  // Derived (not counted) so it self-heals on the next part transition.
  // Tools waiting on explicit user confirmation are excluded — nothing is
  // happening until the user acts.
  const lastAssistantMessage =
    messagesWithToolResults[messagesWithToolResults.length - 1];
  const hasPendingClientToolCalls = (() => {
    if (pendingOnToolCallIds.size === 0 && !tools) return false;
    if (!lastAssistantMessage || lastAssistantMessage.role !== "assistant") {
      return false;
    }
    for (const part of lastAssistantMessage.parts) {
      if (!isToolUIPart(part)) continue;
      if (part.state !== "input-available") continue;
      const toolName = getToolName(part);
      if (toolsRequiringConfirmation.includes(toolName)) continue;
      if (pendingOnToolCallIds.has(part.toolCallId)) return true;
      if (tools?.[toolName]?.execute) return true;
    }
    return false;
  })();

  const effectiveIsServerStreaming =
    isServerStreaming || hasPendingClientToolCalls;
  const isStreaming = status === "streaming" || effectiveIsServerStreaming;

  return {
    ...useChatHelpers,
    resumeStream,
    messages: messagesWithToolResults,
    isServerStreaming: effectiveIsServerStreaming,
    isStreaming,
    isRecovering,
    isToolContinuation,
    connectionError: agent.connectionError ?? null,
    sendMessage: sendMessageWithStreamingProtection,
    stop: stopWithToolContinuationAbort,
    addToolOutput,
    /** @deprecated Use `addToolOutput` instead. */
    addToolResult: addToolResultAndSendMessage,
    addToolApprovalResponse: addToolApprovalResponseAndNotifyServer,
    clearHistory: () => {
      resetLocalChatState();
      agent.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    },
    setMessages: (messagesOrUpdater: Parameters<typeof setMessages>[0]) => {
      // Resolve updaters before syncing, or a functional update would send an
      // empty array and wipe server-side messages.
      let resolvedMessages: ChatMessage[];
      if (typeof messagesOrUpdater === "function") {
        resolvedMessages = messagesOrUpdater(messagesRef.current);
      } else {
        resolvedMessages = messagesOrUpdater;
      }

      if (resolvedMessages.length === 0) markInitialMessagesSeeded();
      setMessages(resolvedMessages);
      if (syncMessagesToServer) {
        agent.send(
          JSON.stringify({
            messages: resolvedMessages,
            type: MessageType.CF_AGENT_CHAT_MESSAGES
          })
        );
      }
    }
  };
}
