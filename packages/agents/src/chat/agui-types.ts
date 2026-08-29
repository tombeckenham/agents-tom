/**
 * Canonical AG-UI type surface used internally by the Cloudflare Agents
 * Chat lifecycle (`AIChatAgent`, `message-builder`, `sanitize`,
 * `message-reconciler`, persistence, broadcast).
 *
 * Pure structural TypeScript: no runtime, no imports, no Zod. Shapes are
 * intentionally assignable to `@ag-ui/core@0.0.53`'s runtime types so
 * adapter packages (`@cloudflare/ai-chat-vercel`,
 * `@cloudflare/ai-chat-tanstack`, ...) can pass values straight through to
 * AG-UI validators / encoders without remapping.
 *
 * Field naming follows AG-UI's JSON wire format (camelCase) — exactly what
 * `@ag-ui/encoder.encode()` produces. `readonly` is used on fields that
 * AG-UI treats as authoritative once emitted; mutable fields exist so the
 * `applyEventToSnapshot` reducer can construct and grow messages in place.
 */

// ============================================================================
// Schema version marker
// ============================================================================

/**
 * Marker persisted alongside `cf_ai_chat_agent_messages` rows so legacy v5
 * Vercel `UIMessage` rows can be detected and lazily migrated by
 * `autoTransformMessages` on load. Rows written by the AG-UI lifecycle carry
 * this string; rows missing it are treated as pre-AG-UI.
 */
export const PERSISTED_MESSAGE_SCHEMA_VERSION = "v6_agui_message" as const;
export type PersistedMessageSchemaVersion =
  typeof PERSISTED_MESSAGE_SCHEMA_VERSION;

// ============================================================================
// Role union
// ============================================================================

/**
 * Discriminator for every `AGUIMessage` variant. Mirrors AG-UI's `Role`
 * type at 0.0.53, with `"activity"` carried as a separate top-level message
 * variant on `AGUIMessage` (see `ActivityMessage`).
 */
export type AGUIRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "developer"
  | "reasoning"
  | "activity";

// ============================================================================
// Multimodal user input content (AG-UI `InputContent`)
// ============================================================================

/**
 * Source descriptor for an `AGUIInputContent` attachment. Either an inline
 * blob (`type: "data"`, typically base64) or a referenceable URL.
 */
export type AGUIInputContentSource =
  | { readonly type: "data"; readonly value: string; readonly mimeType: string }
  | {
      readonly type: "url";
      readonly value: string;
      readonly mimeType?: string;
    };

/**
 * Discriminated union for multimodal user message content. Mirrors AG-UI's
 * `InputContent` union — `text` carries a plain string, while `image`,
 * `audio`, `video`, and `document` reference data via an
 * `AGUIInputContentSource`. The `metadata` bag is intentionally open
 * (`unknown` values) because AG-UI permits arbitrary per-attachment
 * provider metadata.
 */
export type AGUIInputContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: AGUIInputContentSource;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "audio";
      readonly source: AGUIInputContentSource;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "video";
      readonly source: AGUIInputContentSource;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "document";
      readonly source: AGUIInputContentSource;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

// ============================================================================
// Tool call (AG-UI `ToolCall`)
// ============================================================================

/**
 * An assistant-issued tool invocation. At AG-UI 0.0.53 the only standardized
 * `type` is `"function"`. `function.arguments` is a JSON-encoded string
 * (matching OpenAI tool-call shape) — callers must `JSON.parse` before use.
 */
export type ToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    /** JSON-encoded argument object. Parse with `JSON.parse`. */
    arguments: string;
  };
  /**
   * CF extension: legacy tool-part fields with no AG-UI slot
   * (`providerExecuted`, `callProviderMetadata`, `providerMetadata`,
   * `preliminary`, …) so provider round-trips survive the storage flip.
   * Spread back onto the projected tool part verbatim.
   */
  partExtras?: Record<string, unknown>;
};

// ============================================================================
// Message variants (AG-UI `Message`)
// ============================================================================

/**
 * Fields shared by every `AGUIMessage` variant. `id` is the authoritative
 * message identifier emitted by the producer (provider, agent, or migration
 * shim); `name` carries an optional human-readable speaker label.
 */
export type BaseMessage = {
  readonly id: string;
  readonly role: AGUIRole;
  readonly name?: string;
  /**
   * Open per-message metadata bag (CF extension). Carries the legacy
   * `UIMessage.metadata` / `message-metadata` chunk payload across the
   * AG-UI row shape so projection round-trips are lossless.
   */
  metadata?: unknown;
};

/**
 * Legacy-shaped assistant part with no AG-UI slot (`file`, `source-url`,
 * `source-document`, `data-*`), persisted verbatim on the assistant row so
 * the AI SDK projection can reproduce it (CF extension).
 */
export type AssistantExtraPart = { type: string } & Record<string, unknown>;

/**
 * Durable tool-approval state keyed by `toolCallId` (CF extension). AG-UI
 * carries approvals as CUSTOM events; this is the row-level record so
 * approval state survives reload and projects back to the legacy
 * `approval-requested` / `approval-responded` / `output-denied` part states.
 * `approved` is absent while the request is undecided.
 */
export type ToolApprovalState = { approvalId: string; approved?: boolean };

/**
 * End-user input. Mirrors AG-UI's `UserMessage`. `content` is either a
 * plain string (text-only turn) or a heterogeneous `AGUIInputContent[]` for
 * multimodal turns.
 */
export type UserMessage = BaseMessage & {
  readonly role: "user";
  content: string | AGUIInputContent[];
};

/**
 * Instruction / persona prompt. Mirrors AG-UI's `SystemMessage`. The
 * reducer never produces these mid-stream; they are seeded by the caller.
 */
export type SystemMessage = BaseMessage & {
  readonly role: "system";
  content: string;
};

/**
 * Out-of-band guidance from the developer / framework — distinct from
 * `system` so providers that distinguish (OpenAI Responses) can route
 * appropriately. Mirrors AG-UI's `DeveloperMessage`.
 */
export type DeveloperMessage = BaseMessage & {
  readonly role: "developer";
  content: string;
};

/**
 * Assistant turn. `content` is optional because tool-only turns are valid;
 * `toolCalls` is optional because text-only turns are valid. Both grow
 * mutably during streaming (text via `TEXT_MESSAGE_CONTENT`, tool calls via
 * `TOOL_CALL_START`/`TOOL_CALL_ARGS`/`TOOL_CALL_END`). Mirrors AG-UI's
 * `AssistantMessage`.
 */
export type AssistantMessage = BaseMessage & {
  readonly role: "assistant";
  content?: string;
  toolCalls?: ToolCall[];
  /** CF extension: see {@link AssistantExtraPart}. */
  extraParts?: AssistantExtraPart[];
  /** CF extension: see {@link ToolApprovalState}. */
  toolApprovals?: Record<string, ToolApprovalState>;
  /**
   * CF extension: text stream still open (no `TEXT_MESSAGE_END` yet). Set by
   * the reducer while streaming; survives on interrupted persists so the
   * UIMessage projection can mark the part `state: "streaming"`.
   */
  partial?: true;
  /** CF extension: the legacy text part's providerMetadata. */
  contentProviderMetadata?: unknown;
};

/**
 * Tool execution result. Produced by `TOOL_CALL_RESULT`; persisted as a
 * standalone message (not folded onto the assistant turn). `content` is a
 * string — by convention JSON-encoded — and `error` carries provider error
 * text when execution failed. `encryptedValue` carries provider-encrypted
 * payloads (e.g. OpenAI Responses) for round-trip. Mirrors AG-UI's
 * `ToolMessage`.
 */
export type ToolMessage = BaseMessage & {
  readonly role: "tool";
  readonly toolCallId: string;
  content: string;
  error?: string;
  encryptedValue?: string;
  /** CF extension: result of a provider-executed tool (code_execution,
   * text_editor, …) whose payload the sanitizer may truncate. */
  providerExecuted?: true;
};

/**
 * Standalone reasoning / chain-of-thought message. Emitted via the
 * `REASONING_MESSAGE_*` event family. `encryptedValue` carries
 * provider-specific signed reasoning blobs delivered by
 * `REASONING_ENCRYPTED_VALUE`. Mirrors AG-UI's `ReasoningMessage`.
 */
export type ReasoningMessage = BaseMessage & {
  readonly role: "reasoning";
  content?: string;
  encryptedValue?: string;
  /** CF extension: reasoning stream still open — see AssistantMessage.partial. */
  partial?: true;
  /** CF extension: the legacy reasoning part's providerMetadata (e.g.
   * Anthropic redacted_thinking blocks) — required for provider round-trips. */
  providerMetadata?: unknown;
};

/**
 * Agent activity / progress message. AG-UI 0.0.53 under-specifies the exact
 * payload shape (only the snapshot/delta events are typed). `content` is
 * therefore `unknown` until the spec firms up; treat as opaque pass-through.
 */
export type ActivityMessage = BaseMessage & {
  readonly role: "activity";
  content?: unknown;
};

/**
 * Discriminated union over `role` of every persisted AG-UI message variant.
 * The persisted row format in `cf_ai_chat_agent_messages` stores arrays of
 * these objects verbatim (alongside `PERSISTED_MESSAGE_SCHEMA_VERSION`).
 */
export type AGUIMessage =
  | UserMessage
  | SystemMessage
  | DeveloperMessage
  | AssistantMessage
  | ToolMessage
  | ReasoningMessage
  | ActivityMessage;

// ============================================================================
// JSON Patch (RFC 6902)
// ============================================================================

/**
 * Single RFC 6902 JSON Patch operation. Used by `STATE_DELTA` and
 * `ACTIVITY_DELTA` to express incremental updates to opaque state
 * snapshots.
 */
export type JSONPatchOp =
  | { readonly op: "add"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "move"; readonly from: string; readonly path: string }
  | { readonly op: "copy"; readonly from: string; readonly path: string }
  | { readonly op: "test"; readonly path: string; readonly value: unknown };

// ============================================================================
// Event type enumeration
// ============================================================================

/**
 * String-literal enumeration of every AG-UI event `type` discriminator.
 * Declared as a `const` object (rather than a TS `enum`) so the values
 * tree-shake to plain string literals and remain assignable to AG-UI's own
 * `EventType` enum values structurally. Use `EventType.TEXT_MESSAGE_START`
 * for type-safe reference; the runtime value is the literal string
 * `"TEXT_MESSAGE_START"`.
 */
export const EventType = {
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
  ACTIVITY_SNAPSHOT: "ACTIVITY_SNAPSHOT",
  ACTIVITY_DELTA: "ACTIVITY_DELTA",
  RAW: "RAW",
  CUSTOM: "CUSTOM",
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  REASONING_START: "REASONING_START",
  REASONING_END: "REASONING_END",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  REASONING_MESSAGE_CHUNK: "REASONING_MESSAGE_CHUNK",
  REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE"
} as const;

/**
 * Union of every event `type` literal — the discriminator for `AGUIEvent`.
 */
export type AGUIEventType = (typeof EventType)[keyof typeof EventType];

// ============================================================================
// Base event shape
// ============================================================================

/**
 * Fields shared by every `AGUIEvent` variant. `timestamp` is ms-epoch when
 * present (optional in the spec). `rawEvent` carries the pre-transform
 * original payload (e.g. the raw provider event the AG-UI event was derived
 * from) and is intentionally `unknown` because AG-UI permits any shape.
 */
export type BaseAGUIEvent = {
  readonly type: string;
  readonly timestamp?: number;
  readonly rawEvent?: unknown;
};

// ============================================================================
// Lifecycle events
// ============================================================================

/**
 * `RUN_STARTED` — the agent has begun a new run for this `runId` against
 * this `threadId`. `input` carries the original `RunAgentInput` for replay
 * tooling; structurally typed as `unknown` to avoid pulling in
 * `RunAgentInput` here.
 */
export type RunStartedEvent = BaseAGUIEvent & {
  readonly type: "RUN_STARTED";
  readonly threadId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly input?: unknown;
};

/**
 * `RUN_FINISHED` — the run completed successfully. `result` is the
 * provider-defined run outcome (e.g. finish reason, usage); shape varies
 * per producer.
 */
export type RunFinishedEvent = BaseAGUIEvent & {
  readonly type: "RUN_FINISHED";
  readonly threadId: string;
  readonly runId: string;
  readonly result?: unknown;
  /** CF extension: synthesized at stream end because the producer never
   * sent a `finish` chunk — clients projecting back to AI SDK chunks can
   * skip re-inventing one. */
  readonly synthesized?: true;
};

/**
 * `RUN_ERROR` — terminal failure for the current run. `runId` is optional
 * because TS bindings at 0.0.53 omit it (Kotlin/Go include it); we accept
 * it when present.
 */
export type RunErrorEvent = BaseAGUIEvent & {
  readonly type: "RUN_ERROR";
  readonly message: string;
  readonly code?: string;
  readonly runId?: string;
};

/**
 * `STEP_STARTED` — boundary marker for a named sub-step within a run.
 */
export type StepStartedEvent = BaseAGUIEvent & {
  readonly type: "STEP_STARTED";
  readonly stepName: string;
};

/**
 * `STEP_FINISHED` — companion to `STEP_STARTED`.
 */
export type StepFinishedEvent = BaseAGUIEvent & {
  readonly type: "STEP_FINISHED";
  readonly stepName: string;
};

// ============================================================================
// Text message events
// ============================================================================

/**
 * `TEXT_MESSAGE_START` — opens a new assistant text message keyed by
 * `messageId`. The reducer should allocate an empty `AssistantMessage`.
 */
export type TextMessageStartEvent = BaseAGUIEvent & {
  readonly type: "TEXT_MESSAGE_START";
  readonly messageId: string;
  readonly role: "assistant";
};

/**
 * `TEXT_MESSAGE_CONTENT` — appends `delta` to the assistant message keyed
 * by `messageId`. `delta` is non-empty per spec.
 */
export type TextMessageContentEvent = BaseAGUIEvent & {
  readonly type: "TEXT_MESSAGE_CONTENT";
  readonly messageId: string;
  readonly delta: string;
};

/**
 * `TEXT_MESSAGE_END` — closes the assistant text message.
 */
export type TextMessageEndEvent = BaseAGUIEvent & {
  readonly type: "TEXT_MESSAGE_END";
  readonly messageId: string;
};

// ============================================================================
// Tool call events
// ============================================================================

/**
 * `TOOL_CALL_START` — declares a new tool invocation on the assistant
 * message identified by `parentMessageId` (when present). The reducer
 * begins buffering `arguments` from subsequent `TOOL_CALL_ARGS` deltas.
 */
export type ToolCallStartEvent = BaseAGUIEvent & {
  readonly type: "TOOL_CALL_START";
  readonly toolCallId: string;
  readonly toolCallName: string;
  readonly parentMessageId?: string;
  /** CF extension: synthesized from a non-streamed `tool-input-available`
   * (the producer never sent a `tool-input-start`). */
  readonly synthesized?: true;
};

/**
 * `TOOL_CALL_ARGS` — appends a JSON fragment to the buffered arguments for
 * `toolCallId`. The buffer is only guaranteed to be valid JSON after
 * `TOOL_CALL_END`.
 */
export type ToolCallArgsEvent = BaseAGUIEvent & {
  readonly type: "TOOL_CALL_ARGS";
  readonly toolCallId: string;
  readonly delta: string;
  /**
   * CF extension: the args were synthesized from a non-streamed
   * `tool-input-available` (the producer never sent input deltas). A client
   * projection can skip re-emitting a delta chunk the producer never sent.
   */
  readonly synthesized?: true;
};

/**
 * `TOOL_CALL_END` — finalizes argument streaming for `toolCallId`. After
 * this point the buffered argument string is complete JSON.
 */
export type ToolCallEndEvent = BaseAGUIEvent & {
  readonly type: "TOOL_CALL_END";
  readonly toolCallId: string;
};

/**
 * `TOOL_CALL_RESULT` — execution result for `toolCallId`. Persists as a
 * standalone `ToolMessage` with id `messageId`. `content` is a string
 * (typically JSON-encoded); `role` defaults to `"tool"`.
 */
export type ToolCallResultEvent = BaseAGUIEvent & {
  readonly type: "TOOL_CALL_RESULT";
  readonly messageId: string;
  readonly toolCallId: string;
  readonly content: string;
  readonly role?: "tool";
  /** CF extension: error text when the execution failed (drives the legacy
   * `output-error` projection). */
  readonly error?: string;
};

// ============================================================================
// State events
// ============================================================================

/**
 * `STATE_SNAPSHOT` — full agent state replacement. Shape is producer-
 * defined; structurally `unknown`.
 */
export type StateSnapshotEvent = BaseAGUIEvent & {
  readonly type: "STATE_SNAPSHOT";
  readonly snapshot: unknown;
};

/**
 * `STATE_DELTA` — incremental update to agent state, expressed as a JSON
 * Patch (RFC 6902) document.
 */
export type StateDeltaEvent = BaseAGUIEvent & {
  readonly type: "STATE_DELTA";
  readonly delta: JSONPatchOp[];
};

/**
 * `MESSAGES_SNAPSHOT` — full message-list replacement. Used by the
 * resumable-stream replay shortcut to seed clients with the settled prefix
 * before live tailing resumes.
 */
export type MessagesSnapshotEvent = BaseAGUIEvent & {
  readonly type: "MESSAGES_SNAPSHOT";
  readonly messages: AGUIMessage[];
};

/**
 * `ACTIVITY_SNAPSHOT` — full activity-state replacement. Payload shape is
 * under-specified at AG-UI 0.0.53.
 */
export type ActivitySnapshotEvent = BaseAGUIEvent & {
  readonly type: "ACTIVITY_SNAPSHOT";
  readonly activity: unknown;
};

/**
 * `ACTIVITY_DELTA` — incremental activity-state update via JSON Patch.
 */
export type ActivityDeltaEvent = BaseAGUIEvent & {
  readonly type: "ACTIVITY_DELTA";
  readonly delta: JSONPatchOp[];
};

// ============================================================================
// Special events
// ============================================================================

/**
 * `RAW` — opaque pass-through of a provider-native event. Payload is
 * intentionally `unknown` because AG-UI does not constrain the shape;
 * `source` optionally names the producer.
 */
export type RawEvent = BaseAGUIEvent & {
  readonly type: "RAW";
  readonly event: unknown;
  readonly source?: string;
};

/**
 * `CUSTOM` — namespaced extension carrier. AG-UI's escape hatch; the
 * Cloudflare extensions (`cf.agents.*`) ride on this event. `value` is
 * `unknown` because the spec permits any payload.
 */
export type CustomEvent = BaseAGUIEvent & {
  readonly type: "CUSTOM";
  readonly name: string;
  readonly value: unknown;
};

// ============================================================================
// Reasoning events
// ============================================================================

/**
 * `REASONING_START` — block-level reasoning region boundary (not tied to a
 * standalone reasoning message). Pairs with `REASONING_END`.
 */
export type ReasoningStartEvent = BaseAGUIEvent & {
  readonly type: "REASONING_START";
  readonly messageId: string;
};

/**
 * `REASONING_END` — closes a block-level reasoning region opened by
 * `REASONING_START`.
 */
export type ReasoningEndEvent = BaseAGUIEvent & {
  readonly type: "REASONING_END";
  readonly messageId: string;
};

/**
 * `REASONING_MESSAGE_START` — opens a standalone `ReasoningMessage` keyed
 * by `messageId`.
 */
export type ReasoningMessageStartEvent = BaseAGUIEvent & {
  readonly type: "REASONING_MESSAGE_START";
  readonly messageId: string;
  readonly role: "reasoning";
};

/**
 * `REASONING_MESSAGE_CONTENT` — appends `delta` to the reasoning message
 * keyed by `messageId`.
 */
export type ReasoningMessageContentEvent = BaseAGUIEvent & {
  readonly type: "REASONING_MESSAGE_CONTENT";
  readonly messageId: string;
  readonly delta: string;
};

/**
 * `REASONING_MESSAGE_END` — closes a streaming reasoning message.
 */
export type ReasoningMessageEndEvent = BaseAGUIEvent & {
  readonly type: "REASONING_MESSAGE_END";
  readonly messageId: string;
};

/**
 * `REASONING_MESSAGE_CHUNK` — compact reasoning delta. The first chunk in
 * a stream carries `messageId`; subsequent chunks may omit it. Clients
 * typically expand a `CHUNK` stream into synthetic `START` / `CONTENT` /
 * `END` events.
 */
export type ReasoningMessageChunkEvent = BaseAGUIEvent & {
  readonly type: "REASONING_MESSAGE_CHUNK";
  readonly messageId?: string;
  readonly delta?: string;
};

/**
 * `REASONING_ENCRYPTED_VALUE` — carries a provider-signed encrypted
 * reasoning blob bound to either a reasoning message or a tool call via
 * `entityId`.
 */
export type ReasoningEncryptedValueEvent = BaseAGUIEvent & {
  readonly type: "REASONING_ENCRYPTED_VALUE";
  readonly subtype: "message" | "tool-call";
  readonly entityId: string;
  readonly encryptedValue: string;
};

// ============================================================================
// Event union
// ============================================================================

/**
 * Discriminated union over `type` of every AG-UI event variant emitted /
 * consumed by the Agents chat lifecycle. The body of
 * `CF_AGENT_USE_CHAT_RESPONSE` frames carries one of these per SSE
 * `data:` line.
 */
export type AGUIEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | ActivitySnapshotEvent
  | ActivityDeltaEvent
  | RawEvent
  | CustomEvent
  | ReasoningStartEvent
  | ReasoningEndEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningMessageChunkEvent
  | ReasoningEncryptedValueEvent;

// ============================================================================
// Cloudflare extensions (CUSTOM event namespace)
// ============================================================================

/**
 * Reserved `CUSTOM.name` prefix for every Cloudflare-defined extension
 * event. Consumers can filter on this prefix to identify Cloudflare-
 * specific payloads.
 */
export const CF_NAMESPACE_PREFIX = "cf.agents." as const;

/**
 * `CUSTOM.name` for an out-of-band tool-approval request. The agent emits
 * this when a tool requires user approval before execution; the payload is
 * a `CFToolApprovalRequestValue`.
 */
export const CF_TOOL_APPROVAL_REQUEST =
  "cf.agents.tool_approval.request" as const;

/** `CUSTOM.name` for a streamed file attachment (folds onto the assistant row). */
export const CF_FILE = "cf.agents.file" as const;

/** `CUSTOM.name` for a streamed source reference (folds onto the assistant row). */
export const CF_SOURCE = "cf.agents.source" as const;

/** `CUSTOM.name` for message metadata (folds onto the assistant row). */
export const CF_MESSAGE_METADATA = "cf.agents.message_metadata" as const;

/**
 * `CUSTOM.name` for an out-of-band tool-approval decision (granted or
 * denied). The payload is a `CFToolApprovalDecisionValue`.
 */
export const CF_TOOL_APPROVAL_DECISION =
  "cf.agents.tool_approval.decision" as const;

/**
 * `CUSTOM.name` emitted when an outstanding approval request times out.
 * The payload is a `CFToolApprovalExpiredValue`.
 */
export const CF_TOOL_APPROVAL_EXPIRED =
  "cf.agents.tool_approval.expired" as const;

/**
 * Payload of a `CUSTOM` event with `name === CF_TOOL_APPROVAL_REQUEST`.
 * Carries enough information for the client to render an approval prompt:
 * which tool, what input, an `approvalId` to correlate the decision, and
 * an optional `expiresAt` (ms-epoch) deadline.
 */
export type CFToolApprovalRequestValue = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly approvalId: string;
  readonly expiresAt?: number;
};

/**
 * Payload of a `CUSTOM` event with `name === CF_TOOL_APPROVAL_DECISION`.
 * `approved: false` signals the user denied the call; `reason` is an
 * optional free-text explanation.
 */
export type CFToolApprovalDecisionValue = {
  readonly toolCallId: string;
  readonly approvalId: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly decidedAt?: number;
};

/**
 * Payload of a `CUSTOM` event with `name === CF_TOOL_APPROVAL_EXPIRED`.
 * Emitted when an outstanding approval request was not decided before its
 * `expiresAt` deadline.
 */
export type CFToolApprovalExpiredValue = {
  readonly toolCallId: string;
  readonly approvalId: string;
};
