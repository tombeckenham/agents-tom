/**
 * AG-UI reducer: applies one `AGUIEvent` at a time to a mutable
 * `SnapshotState`. Sidecar replacement for `message-builder.ts`'s
 * `applyChunkToParts` — the legacy module continues to handle
 * `UIMessageChunk` shapes while this module is wired in (Phase 3 RFC).
 *
 * The reducer mirrors the lenience and in-place mutation contract of
 * `applyChunkToParts`: malformed events log via `console.warn` and return
 * `false` rather than throwing; recognized events mutate state and return
 * `true`. The state shape is an array of `AGUIMessage` (not a parts array)
 * because `TOOL_CALL_RESULT` materializes a separate `ToolMessage`.
 */

import type {
  AGUIEvent,
  AGUIMessage,
  AssistantMessage,
  CFToolApprovalDecisionValue,
  CFToolApprovalRequestValue,
  ReasoningMessage,
  ToolCall,
  ToolMessage
} from "./agui-types";
import {
  CF_NAMESPACE_PREFIX,
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_EXPIRED,
  CF_TOOL_APPROVAL_REQUEST
} from "./agui-types";

// ============================================================================
// State shape
// ============================================================================

/**
 * Tracks one in-flight `TOOL_CALL_*` stream. `assistant` is the message the
 * `ToolCall` was attached to; `toolCall` is the live entry whose `arguments`
 * grows as `TOOL_CALL_ARGS` deltas arrive.
 */
type ToolCallBuffer = {
  assistant: AssistantMessage;
  toolCall: ToolCall;
  buffered: string;
};

/**
 * The reducer's working state. `messages` is the authoritative ordered list
 * of `AGUIMessage`s produced so far in the current run.
 *
 * The in-flight maps (`textStreams`, `reasoningStreams`, `toolBuffers`) index
 * partially-built messages by their stream identifier so subsequent CONTENT /
 * ARGS / END events can locate them in O(1).
 *
 * `state` mirrors the most recent `STATE_SNAPSHOT` / `STATE_DELTA` payload.
 * `pendingApprovals` and `customEvents` surface CUSTOM events to the agent
 * layer without coupling the reducer to approval policy. `lastError` records
 * the most recent `RUN_ERROR` so callers can surface it after the run ends.
 */
export type SnapshotState = {
  messages: AGUIMessage[];
  readonly textStreams: Map<string, AssistantMessage>;
  readonly reasoningStreams: Map<string, ReasoningMessage>;
  readonly toolBuffers: Map<string, ToolCallBuffer>;
  readonly pendingApprovals: Map<string, CFToolApprovalRequestValue>;
  readonly customEvents: { name: string; value: unknown }[];
  threadId?: string;
  runId?: string;
  state?: unknown;
  lastError?: { message: string; code?: string };
};

/**
 * Builds a fresh `SnapshotState`. If `messages` is supplied it is adopted as
 * the initial settled prefix (mirrors `MESSAGES_SNAPSHOT` replay semantics).
 */
export function createInitialSnapshot(
  messages: AGUIMessage[] = []
): SnapshotState {
  return {
    messages: [...messages],
    textStreams: new Map(),
    reasoningStreams: new Map(),
    toolBuffers: new Map(),
    pendingApprovals: new Map(),
    customEvents: []
  };
}

// ============================================================================
// Reducer entry point
// ============================================================================

/**
 * Applies one `AGUIEvent` to `state` in place. Returns `true` if the event
 * was recognized and applied, `false` if the event was malformed or
 * unrecognized. Never throws.
 */
export function applyEventToSnapshot(
  state: SnapshotState,
  event: AGUIEvent
): boolean {
  switch (event.type) {
    case "RUN_STARTED":
      return handleRunStarted(state, event);
    case "RUN_FINISHED":
      return handleRunFinished(state, event);
    case "RUN_ERROR":
      return handleRunError(state, event);

    case "STEP_STARTED":
    case "STEP_FINISHED":
      return true;

    case "TEXT_MESSAGE_START":
      return handleTextStart(state, event);
    case "TEXT_MESSAGE_CONTENT":
      return handleTextContent(state, event);
    case "TEXT_MESSAGE_END":
      return handleTextEnd(state, event);

    case "TOOL_CALL_START":
      return handleToolStart(state, event);
    case "TOOL_CALL_ARGS":
      return handleToolArgs(state, event);
    case "TOOL_CALL_END":
      return handleToolEnd(state, event);
    case "TOOL_CALL_RESULT":
      return handleToolResult(state, event);

    case "REASONING_MESSAGE_START":
      return handleReasoningStart(state, event);
    case "REASONING_MESSAGE_CONTENT":
      return handleReasoningContent(state, event);
    case "REASONING_MESSAGE_END":
      return handleReasoningEnd(state, event);
    case "REASONING_MESSAGE_CHUNK":
      return handleReasoningChunk(state, event);
    case "REASONING_START":
    case "REASONING_END":
      return true;
    case "REASONING_ENCRYPTED_VALUE":
      return handleReasoningEncryptedValue(state, event);

    case "MESSAGES_SNAPSHOT":
      return handleMessagesSnapshot(state, event);
    case "STATE_SNAPSHOT":
      state.state = event.snapshot;
      return true;
    case "STATE_DELTA":
      // JSON Patch application is deferred to the agent layer; the reducer
      // only records the delta so callers can apply it where state lives.
      state.customEvents.push({ name: "STATE_DELTA", value: event.delta });
      return true;

    case "ACTIVITY_SNAPSHOT":
    case "ACTIVITY_DELTA":
      return handleActivity(state, event);

    case "RAW":
      return true;

    case "CUSTOM":
      return handleCustom(state, event);

    default: {
      warn("unrecognized event type", event);
      return false;
    }
  }
}

// ============================================================================
// Lifecycle handlers
// ============================================================================

function handleRunStarted(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "RUN_STARTED" }>
): boolean {
  if (!event.threadId || !event.runId) {
    warn("RUN_STARTED missing threadId/runId", event);
    return false;
  }
  state.threadId = event.threadId;
  state.runId = event.runId;
  return true;
}

function handleRunFinished(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "RUN_FINISHED" }>
): boolean {
  if (!event.threadId || !event.runId) {
    warn("RUN_FINISHED missing threadId/runId", event);
    return false;
  }
  clearInFlight(state);
  return true;
}

function handleRunError(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "RUN_ERROR" }>
): boolean {
  if (typeof event.message !== "string") {
    warn("RUN_ERROR missing message", event);
    return false;
  }
  state.lastError = { message: event.message, code: event.code };
  clearInFlight(state);
  return true;
}

// ============================================================================
// Text message handlers
// ============================================================================

function handleTextStart(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TEXT_MESSAGE_START" }>
): boolean {
  if (!event.messageId) {
    warn("TEXT_MESSAGE_START missing messageId", event);
    return false;
  }
  if (state.textStreams.has(event.messageId)) {
    return true;
  }
  const existing = findAssistantById(state, event.messageId);
  if (existing) {
    if (existing.content === undefined) {
      existing.content = "";
    }
    state.textStreams.set(event.messageId, existing);
    return true;
  }
  const assistant: AssistantMessage = {
    id: event.messageId,
    role: "assistant",
    content: ""
  };
  state.messages.push(assistant);
  state.textStreams.set(event.messageId, assistant);
  return true;
}

function handleTextContent(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TEXT_MESSAGE_CONTENT" }>
): boolean {
  if (!event.messageId || typeof event.delta !== "string") {
    warn("TEXT_MESSAGE_CONTENT missing messageId or delta", event);
    return false;
  }
  const assistant = state.textStreams.get(event.messageId);
  if (!assistant) {
    warn("TEXT_MESSAGE_CONTENT with no matching stream", event);
    return false;
  }
  assistant.content = (assistant.content ?? "") + event.delta;
  return true;
}

function handleTextEnd(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TEXT_MESSAGE_END" }>
): boolean {
  if (!event.messageId) {
    warn("TEXT_MESSAGE_END missing messageId", event);
    return false;
  }
  state.textStreams.delete(event.messageId);
  return true;
}

// ============================================================================
// Tool call handlers
// ============================================================================

function handleToolStart(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TOOL_CALL_START" }>
): boolean {
  if (!event.toolCallId || !event.toolCallName) {
    warn("TOOL_CALL_START missing toolCallId or toolCallName", event);
    return false;
  }
  if (state.toolBuffers.has(event.toolCallId)) {
    return true;
  }
  const assistant = ensureAssistantForToolCall(state, event.parentMessageId);
  const toolCall: ToolCall = {
    id: event.toolCallId,
    type: "function",
    function: { name: event.toolCallName, arguments: "" }
  };
  if (!assistant.toolCalls) {
    assistant.toolCalls = [];
  }
  assistant.toolCalls.push(toolCall);
  state.toolBuffers.set(event.toolCallId, {
    assistant,
    toolCall,
    buffered: ""
  });
  return true;
}

function handleToolArgs(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TOOL_CALL_ARGS" }>
): boolean {
  if (!event.toolCallId || typeof event.delta !== "string") {
    warn("TOOL_CALL_ARGS missing toolCallId or delta", event);
    return false;
  }
  const buffer = state.toolBuffers.get(event.toolCallId);
  if (!buffer) {
    warn("TOOL_CALL_ARGS with no matching buffer", event);
    return false;
  }
  buffer.buffered += event.delta;
  return true;
}

function handleToolEnd(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TOOL_CALL_END" }>
): boolean {
  if (!event.toolCallId) {
    warn("TOOL_CALL_END missing toolCallId", event);
    return false;
  }
  const buffer = state.toolBuffers.get(event.toolCallId);
  if (!buffer) {
    warn("TOOL_CALL_END with no matching buffer", event);
    return false;
  }
  buffer.toolCall.function.arguments = buffer.buffered;
  state.toolBuffers.delete(event.toolCallId);
  return true;
}

function handleToolResult(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "TOOL_CALL_RESULT" }>
): boolean {
  if (
    !event.messageId ||
    !event.toolCallId ||
    typeof event.content !== "string"
  ) {
    warn("TOOL_CALL_RESULT missing required fields", event);
    return false;
  }
  const toolMessage: ToolMessage = {
    id: event.messageId,
    role: "tool",
    toolCallId: event.toolCallId,
    content: event.content
  };
  state.messages.push(toolMessage);
  return true;
}

// ============================================================================
// Reasoning handlers
// ============================================================================

function handleReasoningStart(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "REASONING_MESSAGE_START" }>
): boolean {
  if (!event.messageId) {
    warn("REASONING_MESSAGE_START missing messageId", event);
    return false;
  }
  if (state.reasoningStreams.has(event.messageId)) {
    return true;
  }
  const reasoning: ReasoningMessage = {
    id: event.messageId,
    role: "reasoning",
    content: ""
  };
  state.messages.push(reasoning);
  state.reasoningStreams.set(event.messageId, reasoning);
  return true;
}

function handleReasoningContent(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "REASONING_MESSAGE_CONTENT" }>
): boolean {
  if (!event.messageId || typeof event.delta !== "string") {
    warn("REASONING_MESSAGE_CONTENT missing messageId or delta", event);
    return false;
  }
  const reasoning = state.reasoningStreams.get(event.messageId);
  if (!reasoning) {
    warn("REASONING_MESSAGE_CONTENT with no matching stream", event);
    return false;
  }
  reasoning.content = (reasoning.content ?? "") + event.delta;
  return true;
}

function handleReasoningEnd(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "REASONING_MESSAGE_END" }>
): boolean {
  if (!event.messageId) {
    warn("REASONING_MESSAGE_END missing messageId", event);
    return false;
  }
  state.reasoningStreams.delete(event.messageId);
  return true;
}

function handleReasoningChunk(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "REASONING_MESSAGE_CHUNK" }>
): boolean {
  if (typeof event.delta !== "string") {
    warn("REASONING_MESSAGE_CHUNK missing delta", event);
    return false;
  }
  const messageId = event.messageId ?? lastOpenReasoningId(state);
  if (!messageId) {
    warn("REASONING_MESSAGE_CHUNK with no messageId and no open stream", event);
    return false;
  }
  if (!state.reasoningStreams.has(messageId)) {
    const started = handleReasoningStart(state, {
      type: "REASONING_MESSAGE_START",
      messageId,
      role: "reasoning"
    });
    if (!started) return false;
  }
  return handleReasoningContent(state, {
    type: "REASONING_MESSAGE_CONTENT",
    messageId,
    delta: event.delta
  });
}

function handleReasoningEncryptedValue(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "REASONING_ENCRYPTED_VALUE" }>
): boolean {
  if (!event.entityId || !event.encryptedValue || !event.subtype) {
    warn("REASONING_ENCRYPTED_VALUE missing fields", event);
    return false;
  }
  if (event.subtype === "message") {
    const target = findReasoningById(state, event.entityId);
    if (!target) {
      warn(
        "REASONING_ENCRYPTED_VALUE references unknown reasoning message",
        event
      );
      return false;
    }
    target.encryptedValue = event.encryptedValue;
    return true;
  }
  // subtype === "tool-call" — bind to the ToolMessage produced by the call.
  const tool = findToolMessageByCallId(state, event.entityId);
  if (!tool) {
    warn("REASONING_ENCRYPTED_VALUE references unknown tool call", event);
    return false;
  }
  tool.encryptedValue = event.encryptedValue;
  return true;
}

// ============================================================================
// Snapshot / state / activity / custom
// ============================================================================

function handleMessagesSnapshot(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "MESSAGES_SNAPSHOT" }>
): boolean {
  if (!Array.isArray(event.messages)) {
    warn("MESSAGES_SNAPSHOT missing messages array", event);
    return false;
  }
  state.messages = [...event.messages];
  clearInFlight(state);
  return true;
}

function handleActivity(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "ACTIVITY_SNAPSHOT" | "ACTIVITY_DELTA" }>
): boolean {
  // AG-UI 0.0.53 under-specifies ActivityMessage payload — record the raw
  // event for the agent layer to interpret rather than guessing a shape.
  state.customEvents.push({ name: event.type, value: event });
  return true;
}

function handleCustom(
  state: SnapshotState,
  event: Extract<AGUIEvent, { type: "CUSTOM" }>
): boolean {
  if (!event.name) {
    warn("CUSTOM missing name", event);
    return false;
  }
  if (event.name === CF_TOOL_APPROVAL_REQUEST) {
    const value = event.value as CFToolApprovalRequestValue | undefined;
    if (!value?.toolCallId || !value?.approvalId) {
      warn("cf.agents.tool_approval.request missing fields", event);
      return false;
    }
    state.pendingApprovals.set(value.toolCallId, value);
    return true;
  }
  if (event.name === CF_TOOL_APPROVAL_DECISION) {
    const value = event.value as CFToolApprovalDecisionValue | undefined;
    if (!value?.toolCallId) {
      warn("cf.agents.tool_approval.decision missing toolCallId", event);
      return false;
    }
    state.pendingApprovals.delete(value.toolCallId);
    state.customEvents.push({ name: event.name, value: event.value });
    return true;
  }
  if (event.name === CF_TOOL_APPROVAL_EXPIRED) {
    const value = event.value as { toolCallId?: string } | undefined;
    if (value?.toolCallId) {
      state.pendingApprovals.delete(value.toolCallId);
    }
    state.customEvents.push({ name: event.name, value: event.value });
    return true;
  }
  if (event.name.startsWith(CF_NAMESPACE_PREFIX)) {
    state.customEvents.push({ name: event.name, value: event.value });
    return true;
  }
  state.customEvents.push({ name: event.name, value: event.value });
  return true;
}

// ============================================================================
// Replay detection
// ============================================================================

/**
 * Returns `true` if `event` would be a no-op replay against `state` — i.e.
 * an upstream is re-emitting events for a stream the reducer has already
 * advanced past. Mirrors `isReplayChunk` semantics for the AG-UI surface.
 *
 * Conditions:
 * - `TEXT_MESSAGE_START` for a `messageId` that already has a closed
 *   assistant message and no open text stream.
 * - `TOOL_CALL_START` for a `toolCallId` whose `ToolCall` already exists
 *   on an assistant message and is no longer being buffered.
 * - `TOOL_CALL_RESULT` for a `toolCallId` that already has a matching
 *   `ToolMessage`.
 */
export function isReplayEvent(state: SnapshotState, event: AGUIEvent): boolean {
  switch (event.type) {
    case "TEXT_MESSAGE_START": {
      if (!event.messageId) return false;
      if (state.textStreams.has(event.messageId)) return false;
      return findAssistantById(state, event.messageId) !== undefined;
    }
    case "TOOL_CALL_START": {
      if (!event.toolCallId) return false;
      if (state.toolBuffers.has(event.toolCallId)) return false;
      return findToolCallById(state, event.toolCallId) !== undefined;
    }
    case "TOOL_CALL_RESULT": {
      if (!event.toolCallId) return false;
      return findToolMessageByCallId(state, event.toolCallId) !== undefined;
    }
    default:
      return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function findAssistantById(
  state: SnapshotState,
  id: string
): AssistantMessage | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "assistant" && m.id === id) return m;
  }
  return undefined;
}

function findReasoningById(
  state: SnapshotState,
  id: string
): ReasoningMessage | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "reasoning" && m.id === id) return m;
  }
  return undefined;
}

function findToolMessageByCallId(
  state: SnapshotState,
  toolCallId: string
): ToolMessage | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "tool" && m.toolCallId === toolCallId) return m;
  }
  return undefined;
}

function findToolCallById(
  state: SnapshotState,
  toolCallId: string
): ToolCall | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc.id === toolCallId) return tc;
    }
  }
  return undefined;
}

function ensureAssistantForToolCall(
  state: SnapshotState,
  parentMessageId: string | undefined
): AssistantMessage {
  if (parentMessageId) {
    const existing = findAssistantById(state, parentMessageId);
    if (existing) return existing;
    const created: AssistantMessage = {
      id: parentMessageId,
      role: "assistant"
    };
    state.messages.push(created);
    return created;
  }
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "assistant") return last;
  // No parent and no trailing assistant: synthesize one. The reducer cannot
  // fabricate the producer's id without colliding, so the id is derived from
  // position. Callers that need stable ids should always send parentMessageId.
  const created: AssistantMessage = {
    id: `assistant-${state.messages.length}`,
    role: "assistant"
  };
  state.messages.push(created);
  return created;
}

function lastOpenReasoningId(state: SnapshotState): string | undefined {
  let last: string | undefined;
  for (const id of state.reasoningStreams.keys()) last = id;
  return last;
}

function clearInFlight(state: SnapshotState): void {
  state.textStreams.clear();
  state.reasoningStreams.clear();
  state.toolBuffers.clear();
}

function warn(reason: string, event: unknown): void {
  console.warn(`[agui-message-builder] ${reason}`, event);
}
