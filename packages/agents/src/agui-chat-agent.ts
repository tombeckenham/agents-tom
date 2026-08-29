/**
 * AGUIChatAgent — canonical chat agent for the Cloudflare Agents SDK.
 *
 * Behavior-identical port of `AIChatAgent` (packages/ai-chat/src/index.ts) on
 * the AG-UI canonical shape. Persistence rows are `AGUIMessage[]` with a
 * `_v` schema marker; CF_AGENT_USE_CHAT_RESPONSE bodies carry AG-UI SSE
 * (`data: {...AGUIEvent JSON}\n\n`); the `onChatMessage` hook returns a
 * `Response` whose body is AG-UI SSE.
 *
 * The class extends `Agent` directly and has zero dependency on the `ai`
 * package. Format-agnostic primitives (`TurnQueue`, `AbortRegistry`,
 * `ContinuationState`, `ResumableStream`, `SubmitConcurrencyController`,
 * lifecycle types) are reused verbatim from `agents/chat`. AG-UI
 * primitives (`agui-message-builder`, `agui-sanitize`, `agui-migration`,
 * `agui-stream-accumulator`, `agui-agent-tools`) handle every shape-aware
 * concern.
 */

import { nanoid } from "nanoid";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentContext,
  type AgentToolStoredChunk,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage
} from "./index";
import { isDurableObjectMemoryLimitReset } from "./retries";
import { AbortRegistry } from "./chat/abort-registry";
import {
  awaitWithDeadline,
  drainInteractionApplies,
  TIMED_OUT
} from "./chat/async-helpers";
import { AutoContinuationController } from "./chat/auto-continuation-controller";
import { aguiRecoveryCodec } from "./chat/agui-recovery-codec";
import {
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot,
  type ChatFiberSnapshot
} from "./chat/recovery";
import { shouldCreditStreamProgress } from "./chat/recovery-codec";
import {
  ChatRecoveryEngine,
  chatRecoverySchedulePolicy,
  runChatRecoveryExhaustion,
  type ChatFiberWakeHooks,
  type ChatRecoveryAdapter,
  type ChatRecoveryScheduleCallback,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type ResolvedRecoveryStream
} from "./chat/recovery-engine";
import {
  AgentToolStreamProgressThrottle,
  buildChatRecoveringFrame,
  bumpChatRecoveryProgress,
  clearChatTerminal,
  listActiveChatRecoveryIncidents,
  pendingChatTerminal,
  readChatRecoveryProgress,
  recordChatTerminal,
  resolveChatRecoveryConfig,
  setChatRecovering,
  StreamProgressCreditThrottle,
  sweepStaleChatRecoveryIncidents,
  type ChatRecoveryIncident,
  type ChatRecoveryKind
} from "./chat/recovery-incident";
import { clientResolvableToolNames } from "./chat/tool-state";
import {
  type AGUIAgentToolEvent,
  applyAGUIAgentToolEvent,
  createAGUIAgentToolEventState
} from "./chat/agui-agent-tools";
import {
  applyEventToSnapshot,
  createInitialSnapshot,
  type SnapshotState
} from "./chat/agui-message-builder";
import { autoTransformAGUIMessages } from "./chat/agui-migration";
import { reconcileMessages } from "./chat/agui-message-reconciler";
import {
  byteLength as aguiByteLength,
  enforceRowSizeLimit,
  isEmptyReasoningMessage,
  ROW_MAX_BYTES,
  sanitizeAGUIMessage
} from "./chat/agui-sanitize";
import { AGUIStreamAccumulator } from "./chat/agui-stream-accumulator";
import {
  type AGUIEvent,
  type AGUIMessage,
  type AssistantMessage,
  CF_TOOL_APPROVAL_DECISION,
  type CFToolApprovalDecisionValue,
  PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ToolMessage,
  type UserMessage
} from "./chat/agui-types";
import type { ClientToolSchema } from "./chat/client-tools";
import {
  ContinuationState,
  type ContinuationConnection
} from "./chat/continuation-state";
import type {
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult
} from "./chat/lifecycle";
import { PreStreamTurns } from "./chat/pre-stream-turns";
import {
  CHAT_MESSAGE_TYPES,
  type StreamResumeNoneReason
} from "./chat/protocol";
import {
  cleanupStreamBuffers,
  ResumableStream,
  STREAM_CLEANUP_DELAY_SECONDS
} from "./chat/resumable-stream";
import { ResumeHandshake } from "./chat/resume-handshake";
import {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "./chat/stall-watchdog";
import {
  type SubmitConcurrencyDecision,
  SubmitConcurrencyController
} from "./chat/submit-concurrency";
import { TurnQueue, type TurnResult } from "./chat/turn-queue";

// ----------------------------------------------------------------------------
// Wire envelope (AG-UI-shape body, same MessageType discriminators)
// ----------------------------------------------------------------------------

/**
 * Outgoing wire envelope structurally identical to the legacy `OutgoingMessage`
 * union except that `CF_AGENT_CHAT_MESSAGES` carries `AGUIMessage[]` and
 * `CF_AGENT_MESSAGE_UPDATED` carries an `AGUIMessage`. The
 * `CF_AGENT_USE_CHAT_RESPONSE` body is the AG-UI SSE `data: …` line.
 */
type OutgoingAGUIMessage =
  | { type: typeof CHAT_MESSAGE_TYPES.CHAT_CLEAR }
  | {
      type: typeof CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
      messages: readonly AGUIMessage[];
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
      id: string;
      body: string;
      done: boolean;
      error?: boolean;
      continuation?: boolean;
      replay?: boolean;
      replayComplete?: boolean;
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.STREAM_RESUMING;
      id: string;
      probeId?: string;
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;
      message: AGUIMessage;
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.STREAM_PENDING;
      id?: string;
      probeId?: string;
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;
      reason?: StreamResumeNoneReason;
      probeId?: string;
    };

/**
 * Incoming wire envelope mirroring `IncomingMessage` from `ai-chat/types.ts`
 * but parameterized over `AGUIMessage` for the `CHAT_MESSAGES` variant.
 */
type IncomingAGUIMessage =
  | { type: typeof CHAT_MESSAGE_TYPES.CHAT_CLEAR }
  | {
      type: typeof CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST;
      id: string;
      init: Pick<
        RequestInit,
        | "method"
        | "keepalive"
        | "headers"
        | "body"
        | "redirect"
        | "integrity"
        | "credentials"
        | "mode"
        | "referrer"
        | "referrerPolicy"
        | "window"
      >;
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
      messages: AGUIMessage[];
    }
  | { type: typeof CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL; id: string }
  | { type: typeof CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK; id: string }
  | {
      type: typeof CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST;
      /** Opaque id the server echoes so the client can match the response. */
      probeId?: string;
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.TOOL_RESULT;
      toolCallId: string;
      toolName: string;
      output: unknown;
      state?: "output-available" | "output-error";
      errorText?: string;
      autoContinue?: boolean;
      clientTools?: ClientToolSchema[];
    }
  | {
      type: typeof CHAT_MESSAGE_TYPES.TOOL_APPROVAL;
      toolCallId: string;
      approved: boolean;
      autoContinue?: boolean;
    };

// ----------------------------------------------------------------------------
// Public hook types (lifecycle on the AG-UI surface)
// ----------------------------------------------------------------------------

/**
 * AG-UI analogue of `ChatResponseResult`. A turn can produce an assistant
 * message and zero or more tool messages, so the hook surfaces
 * `messages: AGUIMessage[]` instead of a single `message`.
 */
export type AGUIChatResponseResult = {
  messages: AGUIMessage[];
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
};

/**
 * Options passed to {@link AGUIChatAgent.onChatMessage}. Mirrors
 * `OnChatMessageOptions` from the legacy package.
 */
export type OnChatMessageOptions = {
  requestId: string;
  abortSignal?: AbortSignal;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
  continuation?: boolean;
};

/**
 * Onfinish callback shape — protocol-agnostic. The legacy class typed this
 * via `StreamTextOnFinishCallback<ToolSet>` from the `ai` package; AG-UI
 * has no such dependency, so we accept any thenable / void return.
 */
export type AGUIOnFinishCallback = (result: unknown) => void | Promise<void>;

/**
 * AG-UI-shaped `onChatRecovery` context. Identical to the shared
 * `ChatRecoveryContext` except the transcript and reconstructed partial carry
 * `AGUIMessage[]` (the AG-UI parts vocabulary) instead of AI SDK shapes.
 */
export type AGUIChatRecoveryContext = Omit<
  ChatRecoveryContext,
  "messages" | "partialParts"
> & {
  messages: AGUIMessage[];
  partialParts: AGUIMessage[];
};

/** Payload of a scheduled `_chatRecoveryRetry` callback. */
type ChatRecoveryRetryData = {
  targetUserId?: string;
  originalRequestId?: string;
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
};

/** Payload of a scheduled `_chatRecoveryContinue` callback. */
type ChatRecoveryContinueData = {
  targetAssistantId?: string;
  originalRequestId?: string;
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
};

/** Classification detail threaded from classify to dispatch on fiber wake. */
type AGUIRecoveryClassification = { shouldRetryPreStream: boolean };

/** How a consumed stream Response ended. */
type StreamResultStatus = {
  status: "completed" | "aborted" | "error";
  error?: string;
};

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

type ChatRequestTrigger = "submit-message" | "regenerate-message";

const decoder = new TextDecoder();

/** Error text for a server tool call interrupted before a result landed. */
const TOOL_INTERRUPTED_MESSAGE =
  "The tool call was interrupted before a result was recorded.";

function sendIfOpen(connection: Connection, message: string): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}

function isWebSocketClosedSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

/**
 * Wrap an `AGUIMessage` with the `_v` schema-version marker for persistence.
 * Lives next to the class because both the constructor (load path) and
 * `persistMessages` (write path) need it.
 */
function wrapPersistedShape(
  message: AGUIMessage
): AGUIMessage & { readonly _v: typeof PERSISTED_MESSAGE_SCHEMA_VERSION } {
  return { ...message, _v: PERSISTED_MESSAGE_SCHEMA_VERSION };
}

/**
 * Decide whether the SSE response should be parsed as AG-UI events or as
 * a plaintext stream. Anything announcing `text/event-stream` is SSE;
 * everything else is wrapped in a synthetic TEXT_MESSAGE run.
 */
function isSSEResponse(response: Response): boolean {
  const ct = response.headers.get("content-type") ?? "";
  return ct.includes("text/event-stream");
}

/**
 * Parse one SSE `data: …` payload into an `AGUIEvent`. Returns `null` for
 * non-data lines, the `[DONE]` sentinel, or malformed JSON.
 */
export function parseAGUIEventLine(line: string): AGUIEvent | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6);
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as AGUIEvent;
  } catch {
    return null;
  }
}

/**
 * Serialize an `AGUIEvent` into one SSE `data: …\n\n` frame body, matching
 * the framing the reducer expects. The trailing newline pair is included so
 * callers can concatenate frames into a single SSE stream.
 */
export function encodeAGUIEventLine(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ============================================================================
// AGUIChatAgent
// ============================================================================

/**
 * Canonical chat agent. Extend this class and override {@link onChatMessage}
 * to produce an AG-UI SSE `Response`.
 */
export class AGUIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private _abortRegistry: AbortRegistry;

  protected _resumableStream!: ResumableStream;

  // Current in-flight assistant + tool messages produced by `_reply`. Used
  // to apply tool results / approvals to a turn that has not yet persisted.
  private _streamingMessages: AGUIMessage[] | null = null;
  private _streamingAssistantId: string | null = null;
  /** The in-flight turn's accumulator, so tool results can join it live. */
  private _streamingAccumulator: AGUIStreamAccumulator | null = null;

  private _pendingChatResponseResults: AGUIChatResponseResult[] = [];
  private _insideResponseHook = false;
  private _pendingInteractionPromise: Promise<boolean> | null = null;
  /** Tail of the serialized tool-result/approval apply chain (#1649). */
  private _interactionApplyTail: Promise<unknown> = Promise.resolve();

  // Set when an approval CUSTOM event arrives mid-stream and we eagerly
  // persist the assistant turn so a page refresh sees the approval modal.
  private _approvalPersistedAssistantId: string | null = null;

  private _turnQueue = new TurnQueue();

  /**
   * Durable chat recovery configuration. Every chat turn runs in a durable
   * fiber, enabling `onChatRecovery` and `this.stash()` during streaming.
   * Assign an object to tune recovery budgets and terminal behavior. Mirrors
   * `AIChatAgent.chatRecovery` — always enabled; a legacy runtime `false`
   * value safely receives the defaults. See {@link ChatRecoveryConfig}.
   */
  chatRecovery: ChatRecoveryConfig = true;

  /**
   * Inactivity watchdog for the live model/transport stream, in milliseconds.
   * If more than this many ms elapse between stream chunks, the turn is aborted
   * and routed into bounded recovery (the same continuation machinery as a
   * deploy or eviction interruption, #1626) rather than parking forever on a
   * hung provider.
   *
   * Default `0` disables the watchdog (opt-in), matching `AIChatAgent` and
   * `@cloudflare/think`. A value such as `60_000` is a reasonable starting
   * point; tune it above your slowest legitimate inter-chunk gap. The watchdog
   * measures the GAP between chunks, not total turn duration, so a steadily
   * streaming turn never trips it regardless of overall length.
   *
   * Assign as a class field or in the constructor, like {@link chatRecovery}.
   */
  chatStreamStallTimeoutMs = 0;

  /** Stable request id for the whole recovery continuation chain, when one is active. */
  private _activeChatRecoveryRootRequestId: string | undefined;

  /** Per-isolate throttle for crediting recovery progress from streaming deltas. */
  private _streamProgressCredit = new StreamProgressCreditThrottle();

  /** Per-isolate N9 throttle: forwarded sub-agent chunks credit parent progress. */
  private _agentToolStreamProgress = new AgentToolStreamProgressThrottle();

  private _mergeQueuedUserStartIndexByEpoch = new Map<number, number>();
  private _submitConcurrency = new SubmitConcurrencyController({
    defaultDebounceMs: AGUIChatAgent.MESSAGE_DEBOUNCE_MS
  });

  private _pendingResumeConnections: Set<string> = new Set();
  private _continuation = new ContinuationState<Connection>();
  /** Accepted-but-not-yet-streamed turns and the clients parked on them (#1784). */
  private _preStream = new PreStreamTurns<Connection>();
  private _resumeHandshakeInstance: ResumeHandshake | null = null;

  private _agentToolForwarders = new Map<
    string,
    Set<(chunk: AgentToolStoredChunk) => void>
  >();
  private _agentToolClosers = new Map<string, Set<() => void>>();
  private _agentToolLastErrors = new Map<string, string>();
  private _agentToolPreTurnAssistantIds = new Map<string, Set<string>>();
  private _agentToolLiveSequences = new Map<string, number>();
  private _agentToolActiveRunId: string | null = null;

  protected _lastClientTools: ClientToolSchema[] | undefined;
  protected _lastBody: Record<string, unknown> | undefined;

  /** JSON cache for incremental persistence (skip SQL writes for unchanged rows). */
  private _persistedMessageCache: Map<string, string> = new Map();

  /**
   * Shared auto-continuation barrier (#1649 / #1650): owns the coalesce timer
   * and the double-fire guard. Parameterized by this agent's stream-active
   * signal, apply-drain, and continuation-turn pipeline
   * (`_fireAutoContinuation`) — the same controller `AIChatAgent` and
   * `@cloudflare/think` drive, on AG-UI-shaped completeness predicates.
   */
  private _autoContinuation = new AutoContinuationController<Connection>({
    continuation: this._continuation,
    generateRequestId: () => nanoid(),
    isStreamActive: () => this._streamingTurnActive,
    hasPendingInteraction: () => this._pendingInteractionPromise !== null,
    hasIncompleteToolBatch: () => this._hasIncompleteToolBatch(),
    drainInteractionApplies: () => this._drainInteractionApplies(),
    keepAliveWhile: <T>(fn: () => Promise<T>) => this.keepAliveWhile(fn),
    fire: () => this._fireAutoContinuation()
  });

  /**
   * Stream-active gate for the auto-continuation barrier (#1650). True while an
   * assistant turn is streaming in `_reply`: the parallel tool batch can still
   * grow with tool calls the model hasn't emitted yet, so no completeness check
   * is meaningful until the stream finalizes. `_onStreamingTurnFinalized`
   * clears it and re-runs the barrier once the batch is fully materialized.
   */
  private _streamingTurnActive = false;

  /**
   * Tool calls whose approval decision this isolate has already applied. AG-UI
   * persists approvals as CUSTOM events rather than message state, so a decided
   * call keeps looking unanswered in `this._aguiMessages` until the continuation
   * executes it — without this the completeness gate would park forever on a
   * batch whose only outstanding member is an already-approved tool.
   *
   * Pruned when the call's `ToolMessage` lands (the persisted result takes
   * over as the answer) and on `resetTurnState`.
   */
  private _decidedApprovals = new Set<string>();

  private static MESSAGE_DEBOUNCE_MS = 750;

  maxPersistedMessages: number | undefined = undefined;
  messageConcurrency: MessageConcurrency = "queue";
  waitForMcpConnections: boolean | { timeout: number } = { timeout: 10_000 };

  /**
   * Canonical AG-UI message store. Engine internals read/write this directly;
   * the public {@link messages} accessor delegates to it so a projection
   * layer (e.g. the AI SDK shim in `@cloudflare/ai-chat`) can override the
   * public view without disturbing the engine.
   */
  protected _aguiMessages: AGUIMessage[] = [];

  /**
   * Authoritative message list. Mutable for backwards compatibility, but
   * write-through `persistMessages` is preferred.
   */
  get messages(): AGUIMessage[] {
    return this._aguiMessages;
  }
  set messages(value: AGUIMessage[]) {
    this._aguiMessages = value;
  }

  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    // Intercept CF_AGENT_USE_CHAT_RESPONSE frames and forward to active
    // agent-tool runs so a parent agent reconstructing a child's stream
    // can fan-in via `agui-agent-tools`.
    if (this._agentToolForwarders.size > 0 && typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as {
          type?: unknown;
          body?: unknown;
          error?: unknown;
        };
        if (parsed.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) {
          if (parsed.error === true && typeof parsed.body === "string") {
            const runIds =
              this._agentToolActiveRunId !== null
                ? [this._agentToolActiveRunId]
                : [...this._agentToolForwarders.keys()];
            for (const runId of runIds) {
              this._agentToolLastErrors.set(runId, parsed.body);
            }
          } else if (
            typeof parsed.body === "string" &&
            parsed.body.length > 0
          ) {
            const entries =
              this._agentToolActiveRunId !== null
                ? [
                    [
                      this._agentToolActiveRunId,
                      this._agentToolForwarders.get(
                        this._agentToolActiveRunId
                      ) ?? new Set<(chunk: AgentToolStoredChunk) => void>()
                    ] as const
                  ]
                : [...this._agentToolForwarders.entries()];
            for (const [runId, forwarders] of entries) {
              const sequence = this._agentToolLiveSequences.get(runId) ?? 0;
              this._agentToolLiveSequences.set(runId, sequence + 1);
              const chunk: AgentToolStoredChunk = {
                sequence,
                body: parsed.body
              };
              for (const forward of forwarders) forward(chunk);
            }
          }
        }
      } catch {
        // non-chat frames pass through unchanged
      }
    }
    super.broadcast(msg, without);
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`create table if not exists cf_ai_chat_agent_messages (
			id text primary key,
			message text not null,
			created_at datetime default current_timestamp
		)`;

    this.sql`create table if not exists cf_ai_chat_request_context (
			key text primary key,
			value text not null
		)`;

    this._restoreRequestContext();

    this._resumableStream = new ResumableStream(this.sql.bind(this));

    const rawMessages = this._loadMessagesFromDb();
    this._aguiMessages = autoTransformAGUIMessages(rawMessages);

    this._abortRegistry = new AbortRegistry();

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (
      connection: Connection,
      cctx: ConnectionContext
    ) => {
      if (this._cf_requestTargetsSubAgent(cctx.request)) {
        return _onConnect(connection, cctx);
      }
      if (this._resumableStream.hasActiveStream()) {
        this._notifyStreamResuming(connection);
      } else if (this._preStream.park(connection)) {
        // A turn is accepted but its stream hasn't started yet (#1784): park
        // this connection and tell it to keep waiting. `park` sent the
        // keep-waiting frame; the turn flushes it into STREAM_RESUMING on
        // _startStream or releases it with STREAM_RESUME_NONE on settle.
      } else {
        // No active stream: if a recovery is in progress (between attempts),
        // replay the live "recovering…" status so a client that connects
        // mid-recovery reads the turn as working rather than frozen (#1620).
        const recoveringFrame = await this._buildRecoveringConnectFrame();
        if (recoveringFrame) {
          sendIfOpen(connection, JSON.stringify(recoveringFrame));
        }
      }
      return _onConnect(connection, cctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      this._pendingResumeConnections.delete(connection.id);
      this._preStream.release(connection.id);
      this._continuation.awaitingConnections.delete(connection.id);
      if (this._continuation.pending?.connectionId === connection.id) {
        this._continuation.pending = null;
      }
      if (this._continuation.activeConnectionId === connection.id) {
        this._continuation.activeConnectionId = null;
      }
      return _onClose(connection, code, reason, wasClean);
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (this._cf_connectionTargetsSubAgent(connection)) {
        return _onMessage(connection, message);
      }
      if (typeof message === "string") {
        const data = this._tryParseIncoming(message);
        if (data) {
          const handled = await this._handleIncoming(connection, data);
          if (handled) return;
        }
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      return this._tryCatchChat(async () => {
        const url = new URL(request.url);
        if (url.pathname.split("/").pop() === "get-messages") {
          return Response.json(this._loadMessagesFromDb());
        }
        return _onRequest(request);
      });
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Public hook surface
  // ──────────────────────────────────────────────────────────────────

  /**
   * Override to handle a chat turn. Return a `Response` whose body is
   * AG-UI SSE (`Content-Type: text/event-stream`, each event encoded as
   * `data: {…AGUIEvent JSON}\n\n`).
   */
  async onChatMessage(
    _onFinish: AGUIOnFinishCallback,
    _options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    throw new Error(
      "received a chat message, override onChatMessage and return a Response carrying AG-UI SSE to send to the client"
    );
  }

  /**
   * Fires after a chat turn completes, outside the turn lock. Default no-op.
   */
  protected onChatResponse(
    _result: AGUIChatResponseResult
  ): void | Promise<void> {}

  /**
   * Subclass hook to transform a message before persistence (after the
   * built-in sanitizer). Default identity.
   */
  protected sanitizeMessageForPersistence(message: AGUIMessage): AGUIMessage {
    return message;
  }

  // ──────────────────────────────────────────────────────────────────
  // Projection seams — identity here; a projection layer (the AI SDK
  // shim in `@cloudflare/ai-chat`) overrides these to adapt hook shapes
  // without the engine dispatching user hooks with the wrong vocabulary.
  // ──────────────────────────────────────────────────────────────────

  /** Applied to the `onChatMessage` return before `_reply` consumes it. */
  protected _projectHandlerResponse(
    response: Response | undefined
  ): Response | undefined {
    return response;
  }

  /** Dispatch seam for {@link onChatResponse}. */
  protected _invokeChatResponseHook(
    result: AGUIChatResponseResult
  ): void | Promise<void> {
    return this.onChatResponse(result);
  }

  /** Dispatch seam for {@link onChatRecovery}. */
  protected async _invokeChatRecoveryHook(
    ctx: AGUIChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return this.onChatRecovery(ctx);
  }

  // ──────────────────────────────────────────────────────────────────
  // Incoming protocol dispatch
  // ──────────────────────────────────────────────────────────────────

  private _tryParseIncoming(raw: string): IncomingAGUIMessage | null {
    try {
      return JSON.parse(raw) as IncomingAGUIMessage;
    } catch {
      return null;
    }
  }

  private async _handleIncoming(
    connection: Connection,
    data: IncomingAGUIMessage
  ): Promise<boolean> {
    switch (data.type) {
      case CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST:
        return this._handleChatRequest(connection, data);
      case CHAT_MESSAGE_TYPES.CHAT_CLEAR:
        return this._handleChatClear(connection);
      case CHAT_MESSAGE_TYPES.CHAT_MESSAGES:
        return this._handleChatMessages(connection, data);
      case CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL:
        this._abortRegistry.cancel(data.id);
        this._emit("message:cancel", { requestId: data.id });
        return true;
      case CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST:
        await this._resumeHandshake().handleResumeRequest(
          connection,
          data.probeId
        );
        return true;
      case CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK:
        await this._resumeHandshake().handleResumeAck(connection, data.id);
        return true;
      case CHAT_MESSAGE_TYPES.TOOL_RESULT:
        return this._handleToolResult(connection, data);
      case CHAT_MESSAGE_TYPES.TOOL_APPROVAL:
        return this._handleToolApproval(connection, data);
      default:
        return false;
    }
  }

  private async _handleChatRequest(
    connection: Connection,
    data: Extract<
      IncomingAGUIMessage,
      { type: typeof CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST }
    >
  ): Promise<boolean> {
    if (data.init.method !== "POST") return true;
    const { body } = data.init;
    if (!body) {
      console.warn(
        "[AGUIChatAgent] Received chat request with empty body, ignoring"
      );
      return true;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body as string);
    } catch {
      console.warn(
        "[AGUIChatAgent] Received chat request with invalid JSON body, ignoring"
      );
      return true;
    }

    const {
      messages,
      clientTools,
      trigger: _trigger,
      ...customBody
    } = parsed as {
      messages: unknown[];
      clientTools?: ClientToolSchema[];
      trigger?: string;
      [key: string]: unknown;
    };

    const chatMessageId = data.id;
    const transformedMessages = autoTransformAGUIMessages(messages ?? []);
    const requestTrigger: ChatRequestTrigger =
      _trigger === "regenerate-message"
        ? "regenerate-message"
        : "submit-message";
    const requestClientTools = clientTools?.length ? clientTools : undefined;
    const requestBody =
      Object.keys(customBody).length > 0 ? customBody : undefined;
    const epoch = this._turnQueue.generation;
    const concurrencyDecision =
      this._getSubmitConcurrencyDecision(requestTrigger);

    if (concurrencyDecision.action === "drop") {
      this._rollbackDroppedSubmit(connection);
      this._completeSkippedRequest(connection, chatMessageId);
      return true;
    }

    // A genuinely-new turn supersedes any pending terminal record (#1645)
    // so a stale exhaustion can't replay on a later reconnect once the
    // user has moved on.
    await this._clearChatTerminal();

    // Mark this turn as accepted-but-not-yet-streamed (#1784) so a client that
    // reconnects/re-mounts before the stream starts is parked and told to keep
    // waiting (see onConnect / the resume handshake), then flushed into
    // STREAM_RESUMING on _startStream or released on settle.
    this._preStream.begin(chatMessageId);

    // Outer try so the accepted turn ALWAYS settles: begin() runs before the
    // pre-turn-body steps (persistMessages, _mergeQueuedUserMessages, and
    // inside the queued callback mcp.waitForConnections / _setRequestContext),
    // and if any of those throws chatTurnBody's own finally never runs. Without
    // this backstop the request id stays stuck in _preStream — hasInFlight()
    // true forever — so every future client is parked on STREAM_PENDING instead
    // of getting an immediate STREAM_RESUME_NONE.
    try {
      const releasePendingEnqueue = this._submitConcurrency.beginEnqueue();
      try {
        this._broadcastChatMessage(
          {
            messages: transformedMessages,
            type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES
          },
          [connection.id]
        );
        await this.persistMessages(transformedMessages, [connection.id], {
          _deleteStaleRows: true
        });
        if (concurrencyDecision.strategy === "merge") {
          await this._mergeQueuedUserMessages(epoch);
        }
      } finally {
        releasePendingEnqueue();
      }

      await this._runExclusiveChatTurn(
        chatMessageId,
        async () => {
          if (
            this._submitConcurrency.isSuperseded(
              concurrencyDecision.submitSequence
            )
          ) {
            this._completeSkippedRequest(connection, chatMessageId);
            return;
          }
          if (concurrencyDecision.debounceUntilMs !== null) {
            await this._submitConcurrency.waitForTimestamp(
              concurrencyDecision.debounceUntilMs
            );
            if (this._turnQueue.generation !== epoch) {
              this._completeSkippedRequest(connection, chatMessageId);
              return;
            }
            if (
              this._submitConcurrency.isSuperseded(
                concurrencyDecision.submitSequence
              )
            ) {
              this._completeSkippedRequest(connection, chatMessageId);
              return;
            }
          }
          if (concurrencyDecision.strategy === "merge") {
            await this._mergeQueuedUserMessages(epoch);
            if (this._turnQueue.generation !== epoch) {
              this._completeSkippedRequest(connection, chatMessageId);
              return;
            }
            if (
              this._submitConcurrency.isSuperseded(
                concurrencyDecision.submitSequence
              )
            ) {
              this._completeSkippedRequest(connection, chatMessageId);
              return;
            }
          }

          if (this.waitForMcpConnections) {
            const timeout =
              typeof this.waitForMcpConnections === "object"
                ? this.waitForMcpConnections.timeout
                : undefined;
            await this.mcp.waitForConnections(
              timeout != null ? { timeout } : undefined
            );
          }

          this._setRequestContext(requestClientTools, requestBody);
          this._emit("message:request");

          const abortSignal = this._abortRegistry.getSignal(chatMessageId);

          return this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              async () => {
                const chatTurnBody = async () => {
                  try {
                    const response = await this._invokeChatHandler(
                      async (_finishResult) => {},
                      {
                        requestId: chatMessageId,
                        abortSignal,
                        clientTools: requestClientTools,
                        body: requestBody,
                        continuation: false
                      }
                    );
                    if (response) {
                      await this._reply(
                        chatMessageId,
                        response,
                        [connection.id],
                        { chatMessageId }
                      );
                    } else {
                      console.warn(
                        `[AGUIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`
                      );
                      this._broadcastChatMessage(
                        {
                          body: "",
                          done: true,
                          id: chatMessageId,
                          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
                        },
                        [connection.id]
                      );
                    }
                  } finally {
                    this._abortRegistry.remove(chatMessageId);
                    // Settle the pre-stream turn on the normal path (#1784): a
                    // no-op when the turn streamed (already flushed into
                    // STREAM_RESUMING on _startStream), a release on the
                    // no-response path. A throw before chatTurnBody runs is
                    // caught by the outer finally instead.
                    this._settlePreStreamTurn(chatMessageId);
                  }
                };
                await this._runChatRecoveryFiber(
                  chatMessageId,
                  false,
                  chatTurnBody
                );
              }
            );
          });
        },
        {
          epoch,
          onStale: () => this._completeSkippedRequest(connection, chatMessageId)
        }
      );
    } finally {
      // Guaranteed settle (#1784). On the happy path chatTurnBody /
      // _completeSkippedRequest already settled (idempotent here); this covers
      // a throw in a pre-turn-body step before chatTurnBody's finally could run.
      this._settlePreStreamTurn(chatMessageId);
    }
    return true;
  }

  private async _handleChatClear(connection: Connection): Promise<boolean> {
    this.resetTurnState();
    this.sql`delete from cf_ai_chat_agent_messages`;
    // Drop any pending terminal record (#1645) so a stale exhaustion can't
    // replay onto a freshly-cleared conversation.
    await this._clearChatTerminal();
    this._resumableStream.clearAll();
    this._pendingResumeConnections.clear();
    this._lastClientTools = undefined;
    this._lastBody = undefined;
    this._persistRequestContext();
    this._persistedMessageCache.clear();
    this._aguiMessages = [];
    this._broadcastChatMessage({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }, [
      connection.id
    ]);
    this._emit("message:clear");
    return true;
  }

  private async _handleChatMessages(
    connection: Connection,
    data: Extract<
      IncomingAGUIMessage,
      { type: typeof CHAT_MESSAGE_TYPES.CHAT_MESSAGES }
    >
  ): Promise<boolean> {
    const transformedMessages = autoTransformAGUIMessages(data.messages);
    await this.persistMessages(transformedMessages, [connection.id]);
    return true;
  }

  /**
   * The shared resume-handshake driver (Tier-2), lazily built. The
   * `ResumableStream` / `ContinuationState` / pending set are stable after the
   * constructor, so one instance threads them for the agent's lifetime.
   */
  private _resumeHandshake(): ResumeHandshake {
    return (this._resumeHandshakeInstance ??= new ResumeHandshake({
      responseMessageType: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      resumableStream: this._resumableStream,
      continuation: this._continuation,
      preStream: this._preStream,
      pendingResumeConnections: this._pendingResumeConnections,
      pendingChatTerminal: () => this._pendingChatTerminal(),
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      isConnectionPresent: (connectionId) =>
        this._isConnectionPresent(connectionId)
    }));
  }

  /** Whether a connection with this id is still attached. */
  private _isConnectionPresent(connectionId: string): boolean {
    return this.getConnection(connectionId) !== undefined;
  }

  private _handleToolResult(
    connection: Connection,
    data: Extract<
      IncomingAGUIMessage,
      { type: typeof CHAT_MESSAGE_TYPES.TOOL_RESULT }
    >
  ): boolean {
    if (data.clientTools?.length) {
      this._lastClientTools = data.clientTools;
      this._persistRequestContext();
    }
    this._emit("tool:result", {
      toolCallId: data.toolCallId,
      toolName: data.toolName
    });

    // In the AG-UI shape, tool results are first-class `ToolMessage`s. We
    // upsert / append a tool message and persist immediately so subsequent
    // turns see it.
    this._enqueueInteractionApply(() =>
      this._applyToolResult(
        data.toolCallId,
        data.output,
        data.state === "output-error" ? data.errorText : undefined
      )
    );

    if (data.autoContinue) {
      this._autoContinuation.schedule({
        connection,
        clientTools: data.clientTools ?? this._lastClientTools,
        body: this._lastBody,
        errorPrefix: "[AGUIChatAgent] Tool continuation failed:"
      });
    } else {
      // A result that arrived WITHOUT autoContinue (e.g. a standalone errored
      // tool) can still be the one that completes a parallel batch a sibling
      // already opted to continue — re-arm the barrier so that continuation
      // fires once the batch is whole (#1650). Never CREATES a pending
      // continuation.
      this._autoContinuation.rearmForBatch();
    }
    return true;
  }

  private _handleToolApproval(
    connection: Connection,
    data: Extract<
      IncomingAGUIMessage,
      { type: typeof CHAT_MESSAGE_TYPES.TOOL_APPROVAL }
    >
  ): boolean {
    this._emit("tool:approval", {
      toolCallId: data.toolCallId,
      approved: data.approved
    });
    this._enqueueInteractionApply(() =>
      this._applyToolApproval(data.toolCallId, data.approved)
    );

    if (data.autoContinue) {
      this._autoContinuation.schedule({
        connection,
        clientTools: this._lastClientTools,
        body: this._lastBody,
        errorPrefix: "[AGUIChatAgent] Tool approval continuation failed:"
      });
    } else {
      this._autoContinuation.rearmForBatch();
    }
    return true;
  }

  /**
   * Serialize a client-tool result/approval apply behind any in-flight apply
   * (#1649): each apply is a read-modify-write of `this._aguiMessages` followed by a
   * persist, and parallel results arrive as independent WebSocket messages.
   * `_pendingInteractionPromise` tracks the newest link so the barrier's
   * pending-interaction signal observes the latest apply; because the chain is
   * serial, awaiting it transitively waits for every predecessor.
   */
  protected _enqueueInteractionApply(
    apply: () => Promise<boolean>
  ): Promise<boolean> {
    // `.then(apply, apply)` runs regardless of a predecessor's outcome so one
    // rejected apply can't poison the rest of the batch.
    const resultPromise = this._interactionApplyTail.then(apply, apply);
    this._interactionApplyTail = resultPromise.then(
      () => undefined,
      () => undefined
    );
    this._pendingInteractionPromise = resultPromise;
    resultPromise
      .finally(() => {
        if (this._pendingInteractionPromise === resultPromise) {
          this._pendingInteractionPromise = null;
        }
      })
      .catch(() => {});
    return resultPromise;
  }

  // ──────────────────────────────────────────────────────────────────
  // Tool-result / tool-approval state transitions (AG-UI shape)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Apply a client-supplied tool result. In the AG-UI shape a `ToolMessage`
   * is the canonical carrier — we upsert it (first-write-wins for terminal
   * states) and broadcast the updated tool message.
   */
  private async _applyToolResult(
    toolCallId: string,
    output: unknown,
    errorText?: string
  ): Promise<boolean> {
    const existing = this._findToolMessageByCallId(toolCallId);
    if (existing) {
      // First-write-wins — duplicate frames / second-tab races are no-ops.
      return true;
    }
    // A real result supersedes any approval-decision placeholder for this call.
    this._decidedApprovals.delete(toolCallId);

    // Locate the assistant that owns the call so the new tool message can
    // be inserted immediately after it. Falls back to append if the
    // assistant is not found (e.g. agent issued a tool message without a
    // matching assistant turn — uncommon but legal).
    const assistantIdx = this._findAssistantIndexByToolCall(toolCallId);
    const toolMessage: ToolMessage = {
      id: `tool-${nanoid()}`,
      role: "tool",
      toolCallId,
      content:
        errorText !== undefined
          ? JSON.stringify({ error: errorText })
          : typeof output === "string"
            ? output
            : JSON.stringify(output ?? null),
      ...(errorText !== undefined && { error: errorText })
    };

    // The assistant that issued this call may still be streaming, and so is
    // not persisted yet. Hand the result to the live turn instead of writing a
    // standalone row that would land BEFORE its assistant and collide with it
    // in reconciliation. Mirrors the legacy `_findAndUpdateToolPart`, which
    // updates `_streamingMessage` in place and lets stream completion persist.
    const streaming = this._streamingAccumulator;
    if (
      assistantIdx < 0 &&
      streaming &&
      this._streamingOwnsToolCall(streaming, toolCallId)
    ) {
      streaming.applyEvent({
        type: "TOOL_CALL_RESULT",
        messageId: toolMessage.id,
        toolCallId,
        content: toolMessage.content
      });
      if (toolMessage.error !== undefined) {
        // The reducer builds a bare ToolMessage; carry the error text across.
        const added = streaming.messages.at(-1);
        if (added?.role === "tool") added.error = toolMessage.error;
      }
      this._streamingMessages = [...streaming.messages];
      this._broadcastChatMessage({
        type: CHAT_MESSAGE_TYPES.MESSAGE_UPDATED,
        message: toolMessage
      });
      return true;
    }

    const next = [...this._aguiMessages];
    if (assistantIdx >= 0) {
      next.splice(assistantIdx + 1, 0, toolMessage);
    } else {
      next.push(toolMessage);
    }
    await this.persistMessages(next);
    this._broadcastChatMessage({
      type: CHAT_MESSAGE_TYPES.MESSAGE_UPDATED,
      message: toolMessage
    });
    return true;
  }

  /**
   * Apply a tool-approval decision.
   *
   * AG-UI has no per-call approval state in the message shape, so the decision
   * lives in exactly two places: the broadcast `CUSTOM` event live clients
   * render from, and the in-isolate {@link _decidedApprovals} ledger the
   * batch-completeness gate reads. The message snapshot is re-persisted only so
   * a refresh mid-decision keeps whatever the turn had produced so far — it
   * does NOT carry the decision, which is why an isolate restart before the
   * continuation runs loses it and the client replays the approval.
   */
  private async _applyToolApproval(
    toolCallId: string,
    approved: boolean
  ): Promise<boolean> {
    if (!this._hasToolCall(toolCallId)) {
      // No assistant ever issued this call: record nothing (a bogus id must not
      // enter the completeness ledger and settle a batch it isn't part of) and
      // report failure, mirroring the legacy not-found path.
      console.warn(
        `[AGUIChatAgent] _applyToolApproval: no tool call with id ${toolCallId}`
      );
      return false;
    }
    const value: CFToolApprovalDecisionValue = {
      toolCallId,
      approvalId: `approval-${nanoid()}`,
      approved,
      decidedAt: Date.now()
    };
    // The decision settles this call for the batch-completeness gate — the
    // continuation turn is what actually produces its `ToolMessage`.
    this._decidedApprovals.add(toolCallId);
    // Durable record on the issuing assistant row (persisted below / on
    // stream completion) so the decision survives an isolate restart and
    // projects back to approval-responded / output-denied.
    this._recordApprovalDecisionOnRow(toolCallId, value.approvalId, approved);
    const event: AGUIEvent = {
      type: "CUSTOM",
      name: CF_TOOL_APPROVAL_DECISION,
      value
    };
    // Stream the decision so live clients see it; persistence runs in the
    // continuation turn that consumes the decision.
    this._broadcastChatMessage({
      body: JSON.stringify(event),
      done: false,
      id: `approval-${toolCallId}`,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    });
    // Persist current snapshot so a refresh between approval and the
    // continuation turn does not lose the decision state.
    if (this._aguiMessages.length > 0) {
      await this.persistMessages(this._aguiMessages);
    }
    return true;
  }

  /**
   * Write an approval decision onto the assistant row that issued the call —
   * persisted (or the in-flight streaming copy, persisted on completion).
   * Prefers the request's original approvalId when the row already has one.
   */
  private _recordApprovalDecisionOnRow(
    toolCallId: string,
    approvalId: string,
    approved: boolean
  ): void {
    const record = (messages: readonly AGUIMessage[]): boolean => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "assistant") continue;
        if (!m.toolCalls?.some((tc) => tc.id === toolCallId)) continue;
        const existing = m.toolApprovals?.[toolCallId];
        (m.toolApprovals ??= {})[toolCallId] = {
          approvalId: existing?.approvalId ?? approvalId,
          approved
        };
        return true;
      }
      return false;
    };
    if (record(this._aguiMessages)) {
      // New array identity so projection layers memoizing on it re-project.
      this._aguiMessages = [...this._aguiMessages];
    } else if (this._streamingAccumulator) {
      record(this._streamingAccumulator.messages);
    }
  }

  /** Whether any assistant — persisted or still streaming — issued this call. */
  private _hasToolCall(toolCallId: string): boolean {
    return this._messagesForClientSync().some(
      (m) =>
        m.role === "assistant" &&
        (m.toolCalls?.some((tc) => tc.id === toolCallId) ?? false)
    );
  }

  /** Whether the in-flight turn's assistant issued this tool call. */
  private _streamingOwnsToolCall(
    streaming: AGUIStreamAccumulator,
    toolCallId: string
  ): boolean {
    return streaming.messages.some(
      (m) =>
        m.role === "assistant" &&
        (m.toolCalls?.some((tc) => tc.id === toolCallId) ?? false)
    );
  }

  private _findToolMessageByCallId(
    toolCallId: string
  ): ToolMessage | undefined {
    // Includes the in-flight turn's messages so a duplicate frame arriving
    // mid-stream is still a first-write-wins no-op.
    const messages = this._messagesForClientSync();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "tool" && m.toolCallId === toolCallId) return m;
    }
    return undefined;
  }

  private _findAssistantIndexByToolCall(toolCallId: string): number {
    for (let i = this._aguiMessages.length - 1; i >= 0; i--) {
      const m = this._aguiMessages[i];
      if (m.role !== "assistant" || !m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        if (tc.id === toolCallId) return i;
      }
    }
    return -1;
  }

  private _findLastAssistantMessage(): AssistantMessage | undefined {
    for (let i = this._aguiMessages.length - 1; i >= 0; i--) {
      const m = this._aguiMessages[i];
      if (m.role === "assistant") return m;
    }
    return undefined;
  }

  // ──────────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────────

  private _loadMessagesFromDb(): unknown[] {
    const rows =
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      [];
    this._persistedMessageCache.clear();
    return rows
      .map((row) => {
        try {
          const messageStr = row.message as string;
          const parsed = JSON.parse(messageStr) as unknown;
          const id =
            parsed && typeof parsed === "object" && "id" in parsed
              ? (parsed as { id: unknown }).id
              : undefined;
          if (typeof id === "string") {
            this._persistedMessageCache.set(id, messageStr);
          }
          return parsed;
        } catch (error) {
          console.error(`Failed to parse message ${row.id}:`, error);
          return null;
        }
      })
      .filter((m): m is unknown => m !== null);
  }

  async persistMessages(
    messages: AGUIMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    const mergedMessages = reconcileMessages(
      messages,
      this._aguiMessages,
      (msg) => this._sanitizeMessageForPersistence(msg, messages)
    );

    for (const message of mergedMessages) {
      if (isEmptyReasoningMessage(message)) continue;
      const sanitized = this._sanitizeMessageForPersistence(
        message,
        mergedMessages
      );
      const safe = enforceRowSizeLimit(sanitized);
      const persisted = wrapPersistedShape(safe);
      const json = JSON.stringify(persisted);

      if (this._persistedMessageCache.get(safe.id) === json) continue;
      if (aguiByteLength(json) > ROW_MAX_BYTES) {
        console.warn(
          `[AGUIChatAgent] Skipping persist of ${safe.id}: row exceeds size limit after enforcement`
        );
        continue;
      }
      this.sql`
				insert into cf_ai_chat_agent_messages (id, message)
				values (${safe.id}, ${json})
				on conflict(id) do update set message = excluded.message
			`;
      this._persistedMessageCache.set(safe.id, json);
    }

    if (options?._deleteStaleRows) {
      const serverIds = new Set(this._aguiMessages.map((m) => m.id));
      const isSubsetOfServer = mergedMessages.every((m) => serverIds.has(m.id));
      if (isSubsetOfServer) {
        const keepIds = new Set(mergedMessages.map((m) => m.id));
        const allDbRows =
          this.sql<{ id: string }>`select id from cf_ai_chat_agent_messages` ||
          [];
        for (const row of allDbRows) {
          if (!keepIds.has(row.id)) {
            this
              .sql`delete from cf_ai_chat_agent_messages where id = ${row.id}`;
            this._persistedMessageCache.delete(row.id);
          }
        }
      }
    }

    if (this.maxPersistedMessages != null) {
      this._enforceMaxPersistedMessages();
    }

    const persistedRows = this._loadMessagesFromDb();
    this._aguiMessages = autoTransformAGUIMessages(persistedRows);
    this._broadcastChatMessage(
      {
        messages: mergedMessages,
        type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES
      },
      excludeBroadcastIds
    );
  }

  /**
   * Subclass-hookable sanitizer composing the built-in pipeline + user hook.
   * Protected so a projection layer can adapt the hook's message vocabulary;
   * `context` is the batch being persisted (lets a projection resolve
   * cross-row references, e.g. a tool result's issuing assistant).
   */
  protected _sanitizeMessageForPersistence(
    message: AGUIMessage,
    _context?: readonly AGUIMessage[]
  ): AGUIMessage {
    const base = sanitizeAGUIMessage(message);
    return this.sanitizeMessageForPersistence(base);
  }

  private _enforceMaxPersistedMessages() {
    if (this.maxPersistedMessages == null) return;
    const countResult = this.sql<{ cnt: number }>`
			select count(*) as cnt from cf_ai_chat_agent_messages
		`;
    const count = countResult?.[0]?.cnt ?? 0;
    if (count <= this.maxPersistedMessages) return;
    const excess = count - this.maxPersistedMessages;
    const toDelete = this.sql<{ id: string }>`
			select id from cf_ai_chat_agent_messages
			order by created_at asc
			limit ${excess}
		`;
    if (toDelete && toDelete.length > 0) {
      for (const row of toDelete) {
        this.sql`delete from cf_ai_chat_agent_messages where id = ${row.id}`;
        this._persistedMessageCache.delete(row.id);
      }
    }
  }

  private _restoreRequestContext() {
    const rows =
      this.sql<{ key: string; value: string }>`
				select key, value from cf_ai_chat_request_context
			` || [];
    for (const row of rows) {
      try {
        if (row.key === "lastBody") {
          this._lastBody = JSON.parse(row.value);
        } else if (row.key === "lastClientTools") {
          this._lastClientTools = JSON.parse(row.value);
        }
      } catch {
        // corrupted row — next request overwrites
      }
    }
  }

  private _persistRequestContext() {
    if (this._lastBody) {
      this.sql`
				insert or replace into cf_ai_chat_request_context (key, value)
				values ('lastBody', ${JSON.stringify(this._lastBody)})
			`;
    } else {
      this.sql`delete from cf_ai_chat_request_context where key = 'lastBody'`;
    }
    if (this._lastClientTools) {
      this.sql`
				insert or replace into cf_ai_chat_request_context (key, value)
				values ('lastClientTools', ${JSON.stringify(this._lastClientTools)})
			`;
    } else {
      this
        .sql`delete from cf_ai_chat_request_context where key = 'lastClientTools'`;
    }
  }

  private _setRequestContext(
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>
  ) {
    this._lastClientTools = clientTools?.length ? clientTools : undefined;
    this._lastBody = body && Object.keys(body).length > 0 ? body : undefined;
    this._persistRequestContext();
  }

  // ──────────────────────────────────────────────────────────────────
  // Broadcast helpers
  // ──────────────────────────────────────────────────────────────────

  private _broadcastChatMessage(
    message: OutgoingAGUIMessage,
    exclude?: string[]
  ) {
    const allExclusions = [
      ...(exclude || []),
      ...this._pendingResumeConnections
    ];
    this.broadcast(JSON.stringify(message), allExclusions);
  }

  private _completeSkippedRequest(connection: Connection, requestId: string) {
    this._sendDirectMessage(connection, {
      body: "",
      done: true,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    });
    // A skipped turn settles out of the pre-stream set, but must NOT release
    // parked connections (#1784): a skip happens because a NEWER turn was
    // admitted (latest/merge supersede) or the queue generation advanced. The
    // earliest "successor exists" signal (`SubmitConcurrencyController.decide`)
    // fires before the successor's `_preStream.begin()`, so releasing here would
    // race a `begin()` that hasn't run yet and cut a parked client loose right
    // before the successor streams. Leave it parked: the successor flushes it on
    // `_startStream`, or the final surviving turn's settle releases it.
    this._settlePreStreamTurn(requestId, { releaseParked: false });
  }

  /**
   * Mark an accepted turn (#1784) as settled. When `releaseParked` (the default)
   * and no accepted turn remains in flight and no stream is active, release every
   * parked connection with STREAM_RESUME_NONE so a client that reconnected during
   * the pre-stream window stops waiting. A no-op when the parked set was already
   * flushed on stream start.
   */
  private _settlePreStreamTurn(
    requestId: string,
    options: { releaseParked?: boolean } = {}
  ): void {
    const idle = this._preStream.settle(requestId);
    const releaseParked = options.releaseParked ?? true;
    if (releaseParked && idle && !this._resumableStream.hasActiveStream()) {
      this._preStream.releaseAwaiting();
    }
  }

  private _rollbackDroppedSubmit(connection: Connection) {
    this._sendDirectMessage(connection, {
      messages: this._messagesForClientSync(),
      type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES
    });
  }

  private _sendDirectMessage(
    connection: Connection,
    message: OutgoingAGUIMessage
  ): void {
    try {
      connection.send(JSON.stringify(message));
    } catch {
      // connection closed before reply
    }
  }

  private _messagesForClientSync(): readonly AGUIMessage[] {
    if (!this._streamingMessages || this._streamingMessages.length === 0) {
      return this._aguiMessages;
    }
    const streaming = this._streamingMessages;
    const merged: AGUIMessage[] = this._aguiMessages.map(
      (m) => streaming.find((sm) => sm.id === m.id) ?? m
    );
    for (const sm of streaming) {
      if (!this._aguiMessages.some((m) => m.id === sm.id)) merged.push(sm);
    }
    return merged;
  }

  /**
   * Proactively offer an active stream for resume — delegates to the shared
   * {@link ResumeHandshake}. Kept as a thin method because onConnect and the
   * continuation flush both call it. See the driver for the #1733 double-send
   * contract.
   */
  private _notifyStreamResuming(connection: Connection) {
    this._resumeHandshake().notifyStreamResuming(connection);
  }

  // ──────────────────────────────────────────────────────────────────
  // Turn queue / concurrency
  // ──────────────────────────────────────────────────────────────────

  private _getSubmitConcurrencyDecision(
    trigger: ChatRequestTrigger
  ): SubmitConcurrencyDecision {
    const decision = this._submitConcurrency.decide({
      concurrency: this.messageConcurrency,
      isSubmitMessage: trigger === "submit-message",
      queuedTurns: this._turnQueue.queuedCount()
    });
    if (decision.strategy === "merge") {
      if (
        !this._mergeQueuedUserStartIndexByEpoch.has(this._turnQueue.generation)
      ) {
        this._mergeQueuedUserStartIndexByEpoch.set(
          this._turnQueue.generation,
          this._aguiMessages.length
        );
      }
    }
    return decision;
  }

  private async _mergeQueuedUserMessages(
    epoch = this._turnQueue.generation
  ): Promise<void> {
    const merged = this._getMergedQueuedUserMessages(epoch);
    if (!merged) return;
    await this.persistMessages(merged, [], { _deleteStaleRows: true });
  }

  private _getMergedQueuedUserMessages(epoch: number): AGUIMessage[] | null {
    const queuedUserStart = this._mergeQueuedUserStartIndexByEpoch.get(epoch);
    if (queuedUserStart === undefined) return null;

    let queuedUserEnd = queuedUserStart;
    while (this._aguiMessages[queuedUserEnd]?.role === "user") {
      queuedUserEnd++;
    }
    if (
      queuedUserEnd === queuedUserStart &&
      queuedUserStart < this._aguiMessages.length
    ) {
      console.warn(
        `[AGUIChatAgent] merge: expected user messages at index ${queuedUserStart} ` +
          `but found role="${this._aguiMessages[queuedUserStart]?.role}"; skipping merge`
      );
    }
    const queuedUserMessages = this._aguiMessages.slice(
      queuedUserStart,
      queuedUserEnd
    );
    if (queuedUserMessages.length < 2) return null;

    return [
      ...this._aguiMessages.slice(0, queuedUserStart),
      AGUIChatAgent._mergeUserMessages(queuedUserMessages),
      ...this._aguiMessages.slice(queuedUserEnd)
    ];
  }

  private static _mergeUserMessages(messages: AGUIMessage[]): UserMessage {
    // AG-UI `UserMessage.content` is either string or InputContent[]. We
    // concatenate text content; multimodal content is preserved by
    // concatenating the arrays.
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") {
      throw new Error("cannot merge an empty user-message list");
    }
    let textBuf = "";
    const multimodal: AGUIMessage[] = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (typeof m.content === "string") {
        if (textBuf.length > 0) textBuf += "\n\n";
        textBuf += m.content;
      } else {
        multimodal.push(m);
      }
    }
    if (multimodal.length === 0) {
      return { id: last.id, role: "user", content: textBuf };
    }
    // At least one multimodal — flatten everything into an InputContent[].
    const out: UserMessage["content"] = [];
    if (textBuf.length > 0) out.push({ type: "text", text: textBuf });
    for (const m of multimodal) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const ic of m.content) out.push(ic);
    }
    return { id: last.id, role: "user", content: out };
  }

  private async _runExclusiveChatTurn<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: { epoch?: number; onStale?: () => void }
  ): Promise<T> {
    const generation = options?.epoch;
    let result: TurnResult<T>;
    try {
      result = await this._turnQueue.enqueue(requestId, fn, { generation });
    } finally {
      const gen = generation ?? this._turnQueue.generation;
      if (this._turnQueue.queuedCount(gen) === 0) {
        this._mergeQueuedUserStartIndexByEpoch.delete(gen);
      }
      if (
        this._pendingChatResponseResults.length > 0 &&
        !this._insideResponseHook
      ) {
        this._insideResponseHook = true;
        try {
          await this.keepAliveWhile(async () => {
            while (this._pendingChatResponseResults.length > 0) {
              const chatResult = this._pendingChatResponseResults.shift()!;
              // A later turn ending in a non-error outcome supersedes any
              // pending terminal record (#1645); a terminal (non-recovered)
              // stream error is durably recorded so a disconnected client
              // still learns the turn failed on reconnect.
              if (
                chatResult.status === "completed" ||
                chatResult.status === "aborted"
              ) {
                await this._clearChatTerminal();
              } else if (chatResult.status === "error") {
                await this._recordChatTerminal(
                  chatResult.requestId,
                  chatResult.error ?? "The assistant encountered an error."
                );
              }
              try {
                await this._invokeChatResponseHook(chatResult);
              } catch (hookError) {
                console.error(
                  "[AGUIChatAgent] onChatResponse threw:",
                  hookError
                );
              }
            }
          });
        } finally {
          this._insideResponseHook = false;
        }
      }
    }
    if (result!.status === "stale") {
      options?.onStale?.();
      return undefined as T;
    }
    return result!.value;
  }

  private async _tryCatchChat<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  /**
   * Invoke `onChatMessage` and, if it throws BEFORE producing a `Response`,
   * broadcast a terminal `error: true, done: true` frame for the request.
   * Mid-stream failures are handled inside `_reply`; a pre-Response throw
   * never reaches `_reply`, so without this frame clients awaiting the
   * request id would hang forever. The error is rethrown so `onError` /
   * turn bookkeeping behave exactly as before.
   */
  private async _invokeChatHandler(
    onFinish: AGUIOnFinishCallback,
    options: OnChatMessageOptions
  ): Promise<Response | undefined> {
    try {
      return this._projectHandlerResponse(
        await this.onChatMessage(onFinish, options)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._broadcastChatMessage({
        body: message,
        done: true,
        error: true,
        id: options.requestId,
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        ...(options.continuation && { continuation: true })
      });
      // Durable record too (#1645): this turn never reaches the stream-result
      // path that records terminals, so without it a client disconnected at
      // this instant learns nothing on reconnect.
      await this._recordChatTerminal(options.requestId, message);
      this._emit("message:error", { error: message });
      throw error;
    }
  }

  protected resetTurnState(): void {
    this._mergeQueuedUserStartIndexByEpoch.delete(this._turnQueue.generation);
    this._turnQueue.reset();
    this._abortRegistry.destroyAll();
    this._submitConcurrency.reset();
    this._pendingInteractionPromise = null;
    // Drop the apply chain so new interactions don't serialize behind a stale
    // (possibly hung) apply from the turn we just reset (#1649).
    this._interactionApplyTail = Promise.resolve();
    // Tear down the event-driven auto-continuation barrier (#1650): cancel the
    // coalesce timer and clear the double-fire / stream-active gates so a reset
    // mid-park can't leave a stale flag pinning future continuations.
    this._autoContinuation.reset();
    this._streamingTurnActive = false;
    this._decidedApprovals.clear();
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
    // Cut parked clients loose (#1784): the turns they were waiting on are gone.
    // Also covers chat clear, which routes through here.
    this._preStream.releaseAwaiting();
    this._preStream.reset();
    this._pendingChatResponseResults.length = 0;
  }

  protected abortRequest(requestId: string, reason?: unknown): void {
    this._abortRegistry.cancel(requestId, reason);
  }

  protected abortAllRequests(reason?: unknown): void {
    this._abortRegistry.destroyAll(reason);
  }

  // ──────────────────────────────────────────────────────────────────
  // Auto-continuation
  // ──────────────────────────────────────────────────────────────────

  private _activateDeferredAutoContinuation() {
    this._autoContinuation.activateDeferredAndReschedule();
  }

  private _clearAllAutoContinuationState(sendNone = false) {
    this._clearPendingAutoContinuation(sendNone);
    this._continuation.clearDeferred();
  }

  private _clearPendingAutoContinuation(sendNone = false) {
    if (sendNone) this._continuation.sendResumeNone();
    this._continuation.clearPending();
  }

  private _flushAwaitingStreamStartConnections() {
    if (!this._resumableStream.hasActiveStream()) return;
    this._continuation.flushAwaitingConnections((c: ContinuationConnection) =>
      this._notifyStreamResuming(c as Connection)
    );
  }

  /**
   * Drain every in-flight tool-result/approval apply, including any enqueued
   * while we wait, so the subsequent {@link _hasIncompleteToolBatch} re-check
   * sees every result that has ALREADY arrived. Bounded by real apply activity
   * (a storage write each), never by a fixed timer.
   */
  private _drainInteractionApplies(): Promise<void> {
    return drainInteractionApplies(
      () => this._continuation.pending !== null,
      () => this._interactionApplyTail
    );
  }

  /**
   * `true` when the latest assistant message is mid-batch: at least one of its
   * tool calls is answered and at least one is still outstanding. That is the
   * #1649 signature — the model fanned out parallel tool calls and only some
   * have come back. The AG-UI analogue of the legacy leaf-part scan: results
   * are standalone `ToolMessage`s, so a call counts as answered when a matching
   * `ToolMessage` exists (or an approval decision has been applied for it).
   */
  private _hasIncompleteToolBatch(): boolean {
    const messages = this._messagesForClientSync();
    let leaf: AssistantMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") {
        leaf = m;
        break;
      }
    }
    if (!leaf?.toolCalls?.length) return false;

    const answered = new Set<string>(this._decidedApprovals);
    for (const m of messages) {
      if (m.role === "tool") answered.add(m.toolCallId);
    }
    let hasPending = false;
    let hasSettled = false;
    for (const call of leaf.toolCalls) {
      if (answered.has(call.id)) {
        hasSettled = true;
      } else {
        hasPending = true;
      }
      if (hasPending && hasSettled) return true;
    }
    return false;
  }

  /**
   * Called when a streaming assistant turn finalizes (its messages, with all
   * tool calls, are now persisted). Clears the stream-active gate and re-runs
   * the barrier for a continuation the gate held (#1650). Essential for an
   * all-fast parallel batch whose every result landed mid-stream: once the
   * stream ends there is no further tool-result event to re-arm, so without
   * this the held continuation would never fire.
   */
  private _onStreamingTurnFinalized(): void {
    this._streamingTurnActive = false;
    this._autoContinuation.rearmForBatch();
  }

  /**
   * `true` when an auto-continuation is armed and going to fire on its own —
   * its coalesce timer is still pending or its completeness barrier is
   * mid-drain (#1650). Such an agent is NOT stable: a continuation turn is
   * imminent. A continuation that has already entered its turn
   * (`pastCoalesce`) is covered by the turn queue, and a parked one (waiting on
   * an unanswered sibling) by the pending-interaction predicate.
   */
  private _hasArmedContinuation(): boolean {
    return (
      this._continuation.pending !== null &&
      !this._continuation.pending.pastCoalesce &&
      this._autoContinuation.isArmed()
    );
  }

  /**
   * Run the continuation turn for the current `continuation.pending`. Invoked
   * by the barrier once the parallel batch is complete and no stream is active.
   */
  private _fireAutoContinuation() {
    const pending = this._continuation.pending;
    if (!pending) return;
    const requestId = pending.requestId;

    const epoch = this._turnQueue.generation;
    // `_runExclusiveChatTurn` must be called synchronously so the turn queue is
    // set up immediately — otherwise idle waiters can resolve before the
    // continuation starts. `keepAlive()` runs inside the turn.
    this._runExclusiveChatTurn(
      requestId,
      async () => {
        const dispose = await this.keepAlive();
        try {
          const connection = this._continuation.pending
            ?.connection as Connection | null;
          if (!connection) {
            this._clearAllAutoContinuationState(true);
            return;
          }
          const clientTools = this._continuation.pending?.clientTools;
          const body = this._continuation.pending?.body;
          if (this._continuation.pending) {
            this._continuation.pending.pastCoalesce = true;
          }
          const abortSignal = this._abortRegistry.getSignal(requestId);

          return this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              async () => {
                const autoBody = async () => {
                  try {
                    await this._repairInterruptedToolsBeforeTurn();
                    const response = await this._invokeChatHandler(
                      async (_finishResult) => {},
                      {
                        requestId,
                        abortSignal,
                        clientTools,
                        body,
                        continuation: true
                      }
                    );
                    if (response) {
                      const replyResult = await this._reply(
                        requestId,
                        response,
                        [],
                        {
                          continuation: true,
                          chatMessageId: requestId
                        }
                      );
                      if (replyResult.status === "error") {
                        this._clearAllAutoContinuationState(true);
                        return;
                      }
                      this._activateDeferredAutoContinuation();
                    } else {
                      this._clearPendingAutoContinuation(true);
                      this._activateDeferredAutoContinuation();
                    }
                  } finally {
                    this._abortRegistry.remove(requestId);
                  }
                };
                await this._runChatRecoveryFiber(requestId, true, autoBody);
              }
            );
          });
        } finally {
          dispose();
        }
      },
      {
        epoch,
        onStale: () => this._clearAllAutoContinuationState(true)
      }
    ).catch((error) => {
      const errorPrefix =
        this._continuation.pending?.errorPrefix ??
        "[AGUIChatAgent] Auto-continuation failed:";
      this._clearAllAutoContinuationState(true);
      console.error(errorPrefix, error);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // _reply — consume the SSE Response, persist final message list
  // ──────────────────────────────────────────────────────────────────

  private async _reply(
    id: string,
    response: Response,
    excludeBroadcastIds: string[] = [],
    options: { continuation?: boolean; chatMessageId?: string } = {}
  ): Promise<StreamResultStatus> {
    const { continuation = false, chatMessageId } = options;
    const abortSignal = chatMessageId
      ? this._abortRegistry.getExistingSignal(chatMessageId)
      : undefined;

    return this.keepAliveWhile(() =>
      this._tryCatchChat(async (): Promise<StreamResultStatus> => {
        if (!response.body) {
          this._clearPendingAutoContinuation(true);
          this._broadcastChatMessage({
            body: "",
            done: true,
            id,
            type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
            ...(continuation && { continuation: true })
          });
          this._activateDeferredAutoContinuation();
          return { status: "completed" };
        }

        const streamId = this._startStream(id);
        const reader = response.body.getReader();

        // Seed the accumulator from the last assistant message when this
        // turn is a continuation — matches the legacy class's cloning
        // behavior.
        const seed: AGUIMessage[] = continuation
          ? this._continuationSeed()
          : [];
        const accumulator = new AGUIStreamAccumulator({
          existingMessages: seed
        });
        this._streamingAccumulator = accumulator;
        this._streamingMessages = [...seed];
        this._streamingAssistantId =
          seed.find((m): m is AssistantMessage => m.role === "assistant")?.id ??
          null;

        // Stream-active gate for the auto-continuation barrier (#1650): while
        // this assistant turn is streaming, the parallel tool batch can still
        // grow, so no completeness check is meaningful. Cleared by
        // `_onStreamingTurnFinalized` once `_reply` settles — AFTER the streamed
        // messages are persisted — so the re-armed check sees the whole batch.
        this._streamingTurnActive = true;

        // Whether the stream function returned normally — drives the success
        // `message:response` emit below. Never true on the catch path.
        let streamCompleted = false;
        let streamResult: StreamResultStatus = { status: "completed" };
        // Set when a stall watchdog abort was routed into bounded recovery
        // (#1626): a continuation (or terminal exhaustion) now owns the turn,
        // so the terminal error frame and the success `message:response` emit
        // are both skipped.
        let stallRouted = false;

        try {
          if (isSSEResponse(response)) {
            streamResult = {
              status: await this._streamSSEReply(
                id,
                streamId,
                reader,
                accumulator,
                continuation,
                abortSignal
              )
            };
          } else {
            streamResult = {
              status: await this._sendPlaintextReply(
                id,
                streamId,
                reader,
                accumulator,
                continuation,
                abortSignal
              )
            };
          }
          streamCompleted = true;
        } catch (error) {
          // A stall watchdog abort (#1626) is a recoverable interruption, not a
          // terminal error: the partial is persisted below (the same path a
          // normal turn uses, so the continuation re-anchors onto it via
          // `targetAssistantId`) and the turn routes into bounded recovery.
          if (error instanceof ChatStreamStalledError) {
            const outcome = await this._routeStallToBoundedRecovery({
              requestId: id,
              streamId,
              partialMessages: accumulator.messages,
              targetAssistantId: accumulator.messages
                .filter((m): m is AssistantMessage => m.role === "assistant")
                .at(-1)?.id
            });
            if (outcome === "scheduled") {
              // Recovering: close the stream cleanly (no terminal error frame);
              // the scheduled continuation drives the turn to completion.
              this._completeStream(streamId);
              this._broadcastChatMessage({
                body: "",
                done: true,
                id,
                type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
                ...(continuation && { continuation: true })
              });
            } else {
              // Budget spent: `_routeStallToBoundedRecovery` already delivered
              // terminal UX (terminalMessage + done/error frame + onExhausted),
              // identical to deploy-recovery exhaustion.
              this._markStreamError(streamId);
            }
            // `aborted` (not `error`) so this attempt does not terminalize the
            // turn for callers (continueLastTurn / saveMessages / recovery).
            streamResult = { status: "aborted" };
            stallRouted = true;
          } else {
            // Mid-stream failure resolves (not rethrows) with `status: "error"`
            // so callers (continueLastTurn, saveMessages, recovery) observe the
            // terminal outcome — mirrors the legacy `AIChatAgent._reply`.
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            streamResult = { status: "error", error: errorMessage };
            this._markStreamError(streamId);
            this._broadcastChatMessage({
              body: errorMessage,
              done: true,
              error: true,
              id,
              type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
              ...(continuation && { continuation: true })
            });
            this._emit("message:error", { error: errorMessage });
          }
        } finally {
          reader.releaseLock();
          this._streamingAccumulator = null;
          this._streamingMessages = null;
          this._streamingAssistantId = null;
          this._approvalPersistedAssistantId = null;
          if (chatMessageId) {
            this._abortRegistry.remove(chatMessageId);
            if (streamCompleted && !stallRouted) {
              this._emit("message:response");
            }
          }
        }

        if (accumulator.messages.length > 0) {
          await this._persistStreamResult(
            accumulator.messages,
            excludeBroadcastIds
          );
        }

        this._pendingChatResponseResults.push({
          messages: [...accumulator.messages],
          requestId: id,
          continuation,
          status: streamResult.status,
          ...(streamResult.error !== undefined && { error: streamResult.error })
        });
        return streamResult;
      })
    ).finally(() => {
      // The streamed messages (with all their tool calls) are now persisted:
      // clear the stream-active gate and re-run the auto-continuation barrier
      // for a continuation it held (#1650). Skipped on the no-body early return,
      // which never armed the gate.
      if (this._streamingTurnActive) this._onStreamingTurnFinalized();
    });
  }

  /**
   * Compute the continuation seed: the last assistant message cloned, plus
   * any tool messages that follow it. Mirrors `_createStreamingAssistantMessage`
   * for the AG-UI shape, but produces an array because tool messages are
   * standalone in AG-UI.
   */
  private _continuationSeed(): AGUIMessage[] {
    const lastAssistantIdx = (() => {
      for (let i = this._aguiMessages.length - 1; i >= 0; i--) {
        if (this._aguiMessages[i].role === "assistant") return i;
      }
      return -1;
    })();
    if (lastAssistantIdx === -1) {
      return [
        {
          id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          role: "assistant"
        }
      ];
    }
    return this._aguiMessages
      .slice(lastAssistantIdx)
      .map((m) => structuredClone(m));
  }

  /**
   * Wrap `reader.read()` in the shared inactivity watchdog when
   * {@link chatStreamStallTimeoutMs} is armed. A stream that parks between
   * chunks (hung provider/transport) has its reader cancelled and the pull
   * rejects with {@link ChatStreamStalledError}, which `_reply` routes into
   * bounded recovery (#1626). A `0` timeout (the default) returns the raw
   * `reader.read()` path untouched.
   */
  private _guardedPull(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): () => Promise<ReadableStreamReadResult<Uint8Array>> {
    const timeoutMs = this.chatStreamStallTimeoutMs;
    if (!(timeoutMs > 0)) return () => reader.read();

    const byteSource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            const { done, value } = await reader.read();
            return done || value === undefined
              ? { done: true, value: undefined }
              : { done: false, value };
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            await reader.cancel().catch(() => {});
            return { done: true, value: undefined };
          }
        };
      }
    };
    const guarded = iterateWithStallWatchdog(byteSource, timeoutMs, () => {
      // Unblock the abandoned `reader.read()` so the pipeline unwinds; the
      // thrown `ChatStreamStalledError` carries the recovery decision.
      reader.cancel().catch(() => {});
    })[Symbol.asyncIterator]();
    return async () => {
      const next = await guarded.next();
      return next.done
        ? { done: true, value: undefined }
        : { done: false, value: next.value };
    };
  }

  private async _streamSSEReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    accumulator: AGUIStreamAccumulator,
    continuation: boolean,
    abortSignal?: AbortSignal
  ): Promise<"completed" | "aborted"> {
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    const pull = this._guardedPull(reader);

    let buffer = "";
    while (true) {
      if (abortSignal?.aborted) break;
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await pull();
      } catch (readError) {
        if (abortSignal?.aborted) break;
        throw readError;
      }
      const { done, value } = readResult;
      if (done) {
        if (abortSignal?.aborted) break;
        if (buffer.length > 0) {
          await this._consumeSSELine(
            buffer,
            accumulator,
            streamId,
            id,
            continuation
          );
        }
        this._completeStream(streamId);
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return "completed";
      }

      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by `\n\n`; split on single newlines for
      // `data: …` line handling and keep a tail-buffer for partial lines.
      let nlIdx = buffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line.length > 0) {
          await this._consumeSSELine(
            line,
            accumulator,
            streamId,
            id,
            continuation
          );
        }
        nlIdx = buffer.indexOf("\n");
      }
    }

    // Every `break` above is guarded by `abortSignal.aborted`, so this is the
    // abort path. Finish the stream unconditionally anyway: if that invariant
    // ever changes, a client must still get a terminal frame rather than be
    // stranded mid-stream.
    this._completeStream(streamId);
    this._broadcastChatMessage({
      body: "",
      done: true,
      id,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      ...(continuation && { continuation: true })
    });
    return abortSignal?.aborted ? "aborted" : "completed";
  }

  private async _consumeSSELine(
    line: string,
    accumulator: AGUIStreamAccumulator,
    streamId: string,
    id: string,
    continuation: boolean
  ): Promise<void> {
    const event = parseAGUIEventLine(line);
    if (!event) return;
    const action = accumulator.applyEvent(event);

    // Mirror live state for tool-result / approval application.
    this._streamingMessages = [...accumulator.messages];
    const liveAssistant = accumulator.messages.find(
      (m): m is AssistantMessage => m.role === "assistant"
    );
    if (liveAssistant) this._streamingAssistantId = liveAssistant.id;

    // Eagerly persist the assistant turn when an approval request lands so
    // a refresh between request and decision keeps the modal state.
    if (action.kind === "approval" && this._streamingAssistantId) {
      this._persistApprovalSnapshot(accumulator.messages);
    }

    // Store & broadcast every event regardless of action — clients drive
    // their UI from the raw event stream.
    const body = JSON.stringify(event);
    await this._storeStreamChunk(streamId, body);
    this._broadcastChatMessage({
      body,
      done: false,
      id,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      ...(continuation && { continuation: true })
    });
    // Action is consumed for side-effects only (approval persist above);
    // no other action requires explicit handling here. `unknown` and
    // `noop` are intentionally not differentiated past this point.
    void action;
  }

  /**
   * Synthesize TEXT_MESSAGE_START / CONTENT / END events from a plaintext
   * Response body so non-SSE producers (`generateText`, raw `fetch`) flow
   * through the same AG-UI lifecycle as SSE producers.
   */
  private async _sendPlaintextReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    accumulator: AGUIStreamAccumulator,
    continuation: boolean,
    abortSignal?: AbortSignal
  ): Promise<"completed" | "aborted"> {
    const messageId =
      this._streamingAssistantId ??
      `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await this._emitSynthetic(
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      accumulator,
      streamId,
      id,
      continuation
    );

    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    while (true) {
      if (abortSignal?.aborted) break;
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (readError) {
        if (abortSignal?.aborted) break;
        throw readError;
      }
      const { done, value } = readResult;
      if (done) {
        if (abortSignal?.aborted) break;
        await this._emitSynthetic(
          { type: "TEXT_MESSAGE_END", messageId },
          accumulator,
          streamId,
          id,
          continuation
        );
        this._completeStream(streamId);
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return "completed";
      }
      const chunk = decoder.decode(value);
      if (chunk.length > 0) {
        await this._emitSynthetic(
          { type: "TEXT_MESSAGE_CONTENT", messageId, delta: chunk },
          accumulator,
          streamId,
          id,
          continuation
        );
      }
    }

    await this._emitSynthetic(
      { type: "TEXT_MESSAGE_END", messageId },
      accumulator,
      streamId,
      id,
      continuation
    );
    this._completeStream(streamId);
    this._broadcastChatMessage({
      body: "",
      done: true,
      id,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      ...(continuation && { continuation: true })
    });
    return "aborted";
  }

  private async _emitSynthetic(
    event: AGUIEvent,
    accumulator: AGUIStreamAccumulator,
    streamId: string,
    id: string,
    continuation: boolean
  ): Promise<void> {
    accumulator.applyEvent(event);
    const body = JSON.stringify(event);
    await this._storeStreamChunk(streamId, body);
    this._broadcastChatMessage({
      body,
      done: false,
      id,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      ...(continuation && { continuation: true })
    });
  }

  private _persistApprovalSnapshot(messages: readonly AGUIMessage[]): void {
    // Direct SQL insert (no broadcast) — clients already have the data
    // from the live event stream; broadcasting would double-render.
    for (const m of messages) {
      if (isEmptyReasoningMessage(m)) continue;
      const sanitized = this._sanitizeMessageForPersistence(m, messages);
      const safe = enforceRowSizeLimit(sanitized);
      const persisted = wrapPersistedShape(safe);
      const json = JSON.stringify(persisted);
      // Same guard as `persistMessages`: an oversized row would throw here and
      // surface as a terminal stream error rather than a skipped snapshot.
      if (aguiByteLength(json) > ROW_MAX_BYTES) {
        console.warn(
          `[AGUIChatAgent] Skipping approval snapshot of ${safe.id}: row exceeds size limit after enforcement`
        );
        continue;
      }
      this.sql`
				insert into cf_ai_chat_agent_messages (id, message)
				values (${safe.id}, ${json})
				on conflict(id) do update set message = excluded.message
			`;
      this._persistedMessageCache.set(safe.id, json);
    }
    const last = messages.find(
      (m): m is AssistantMessage => m.role === "assistant"
    );
    if (last) this._approvalPersistedAssistantId = last.id;
  }

  private async _persistStreamResult(
    streamedMessages: readonly AGUIMessage[],
    excludeBroadcastIds: string[]
  ): Promise<void> {
    // `streamedMessages` is the full snapshot the reducer produced for this
    // turn (assistant + tool messages, potentially seeded from the previous
    // assistant turn on continuation). Merge into the persisted list by id.
    const merged: AGUIMessage[] = [];
    for (const m of this._aguiMessages) {
      const replacement = streamedMessages.find((sm) => sm.id === m.id);
      merged.push(replacement ?? m);
    }
    for (const sm of streamedMessages) {
      if (!this._aguiMessages.some((m) => m.id === sm.id)) merged.push(sm);
    }
    await this.persistMessages(merged, excludeBroadcastIds);
  }

  // ──────────────────────────────────────────────────────────────────
  // Orphaned-stream recovery (port from AIChatAgent on AG-UI shape)
  // ──────────────────────────────────────────────────────────────────

  protected async _persistOrphanedStream(streamId: string): Promise<void> {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (!chunks.length) return;
    const snapshot: SnapshotState = createInitialSnapshot();
    for (const chunk of chunks) {
      try {
        const event = JSON.parse(chunk.body) as AGUIEvent;
        applyEventToSnapshot(snapshot, event);
      } catch {
        // skip malformed chunks
      }
    }
    if (snapshot.messages.length === 0) return;
    const merged: AGUIMessage[] = [];
    for (const m of this._aguiMessages) {
      const replacement = snapshot.messages.find((sm) => sm.id === m.id);
      merged.push(replacement ?? m);
    }
    for (const sm of snapshot.messages) {
      if (!this._aguiMessages.some((m) => m.id === sm.id)) merged.push(sm);
    }
    // NOTE: progress is bumped at production time in `_storeStreamChunk`
    // (#1637), NOT here — a recovery/reconnect re-persist must not be
    // miscounted as new forward progress.
    await this.persistMessages(merged);
  }

  // ── Resumable stream delegates (parity with AIChatAgent) ───────────

  protected get _activeStreamId(): string | null {
    return this._resumableStream?.activeStreamId ?? null;
  }
  protected get _activeRequestId(): string | null {
    return this._resumableStream?.activeRequestId ?? null;
  }
  protected _startStream(requestId: string): string {
    const streamId = this._resumableStream.start(requestId);
    // Flush connections parked during this turn's pre-stream window (#1784)
    // into the normal STREAM_RESUMING path now that a stream exists. Safe for
    // every turn — the awaiting set is empty unless a client reconnected before
    // the first chunk. (Continuation-turn parks live in `_continuation` and are
    // flushed below.)
    this._preStream.flushOnStreamStart((c) => this._notifyStreamResuming(c));
    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._flushAwaitingStreamStartConnections();
      this._activateDeferredAutoContinuation();
    }
    // Arm the buffer sweep on START so an idle/one-off chat DO still reclaims
    // its chunk rows even if the turn never finalizes (#1706). The sweep's
    // last-activity threshold keeps an actively streaming run alive.
    void this._ensureStreamCleanupScheduled();
    return streamId;
  }

  /**
   * Ensure a single cleanup alarm is pending for this DO's resumable-stream
   * buffers. `idempotent` dedupes on (callback, payload, owner) so repeated
   * arming collapses onto one row.
   * @internal
   */
  protected async _ensureStreamCleanupScheduled({
    idempotent = true
  }: { idempotent?: boolean } = {}): Promise<void> {
    await this.schedule(
      STREAM_CLEANUP_DELAY_SECONDS,
      "_cleanupStreamBuffers",
      undefined,
      { idempotent }
    );
  }

  /**
   * Alarm callback: sweep aged stream buffers, re-arming while rows remain (see
   * the shared {@link cleanupStreamBuffers}). Public so it is reachable as a
   * schedule callback.
   * @internal
   */
  async _cleanupStreamBuffers(): Promise<void> {
    await cleanupStreamBuffers(this._resumableStream, () =>
      this._ensureStreamCleanupScheduled({ idempotent: false })
    );
  }

  protected _completeStream(streamId: string) {
    const completedRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.complete(streamId);
    this._pendingResumeConnections.clear();
    if (completedRequestId === this._continuation.activeRequestId) {
      this._continuation.activeRequestId = null;
      this._continuation.activeConnectionId = null;
    }
  }
  protected async _storeStreamChunk(streamId: string, body: string) {
    this._resumableStream.storeChunk(streamId, body);
    // Credit recovery forward progress at production time (#1637): milestones
    // always, streaming deltas through the shared throttle. Immune to client
    // reconnects / recovery re-persists (those replay stored chunks and never
    // flow through here).
    let type: string | undefined;
    try {
      type = (JSON.parse(body) as { type?: string }).type;
    } catch {
      // non-JSON chunk body — nothing to credit
    }
    if (
      shouldCreditStreamProgress({
        codec: aguiRecoveryCodec,
        type,
        throttle: this._streamProgressCredit,
        now: Date.now()
      })
    ) {
      // Awaited, not fire-and-forget: the bump is a get-then-put, so
      // interleaved unawaited bumps lose increments and a write in flight at
      // isolate teardown is dropped.
      await this._bumpChatRecoveryProgress();
    }
  }
  protected _flushChunkBuffer() {
    this._resumableStream.flushBuffer();
  }
  protected _markStreamError(streamId: string) {
    const erroredRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.markError(streamId);
    this._pendingResumeConnections.clear();
    // An errored continuation releases ownership exactly like a completed one
    // — otherwise a later resume probe is told `continuation-owned` for a turn
    // that is already dead (mirrors `AIChatAgent._markStreamError`).
    if (erroredRequestId === this._continuation.activeRequestId) {
      this._continuation.activeRequestId = null;
      this._continuation.activeConnectionId = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Stability + pending-interaction predicates (AG-UI shape)
  // ──────────────────────────────────────────────────────────────────

  /**
   * `true` when any assistant tool call still lacks a tool-result message —
   * the AG-UI analogue of the legacy `input-available`/`approval-requested`
   * part scan (tool results are first-class `ToolMessage`s here).
   */
  protected hasPendingInteraction(): boolean {
    return this._hasUnresolvedToolCall();
  }

  /**
   * Narrower, client-only predicate used by recovery: an unresolved tool call
   * counts only when the CLIENT can still resolve it after a restart (its name
   * is in the last request's client tools). A server tool's orphan is excluded
   * — its `execute()` died with the isolate and nothing will post its result.
   * AG-UI note: a pending approval is not detectable from the persisted shape
   * (approval requests ride CUSTOM events, not messages), so this keys solely
   * on client-resolvable tool names.
   */
  protected hasPendingClientInteraction(): boolean {
    const clientResolvable = clientResolvableToolNames(this._lastClientTools);
    if (clientResolvable.size === 0) return false;
    return this._hasUnresolvedToolCall((name) => clientResolvable.has(name));
  }

  private _hasUnresolvedToolCall(
    include?: (toolName: string) => boolean
  ): boolean {
    const merged = this._messagesForClientSync();
    const resolved = new Set<string>(this._decidedApprovals);
    for (const m of merged) {
      if (m.role === "tool") resolved.add(m.toolCallId);
      // A decided approval settles its call: a denied call never gets a tool
      // result row, and an approved one is owned by the armed continuation.
      if (m.role === "assistant" && m.toolApprovals) {
        for (const [callId, approval] of Object.entries(m.toolApprovals)) {
          if (approval.approved !== undefined) resolved.add(callId);
        }
      }
    }
    for (const m of merged) {
      if (m.role !== "assistant" || !m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        if (resolved.has(tc.id)) continue;
        if (!include || include(tc.function.name)) return true;
      }
    }
    return false;
  }

  /**
   * Flip interrupted SERVER-tool orphans (an assistant tool call with no
   * `ToolMessage` result whose tool the client cannot resolve) into errored
   * tool results before re-entering inference, so a recovered transcript is
   * settled. Client-resolvable tool calls are left pending — the client
   * replays their results after reconnect.
   */
  private async _repairInterruptedToolsBeforeTurn(): Promise<void> {
    const clientResolvable = clientResolvableToolNames(this._lastClientTools);
    const resolved = new Set<string>();
    for (const m of this._aguiMessages) {
      if (m.role === "tool") resolved.add(m.toolCallId);
    }
    const repairs: { assistantIdx: number; toolMessage: ToolMessage }[] = [];
    this._aguiMessages.forEach((m, idx) => {
      if (m.role !== "assistant" || !m.toolCalls) return;
      for (const tc of m.toolCalls) {
        if (resolved.has(tc.id) || clientResolvable.has(tc.function.name)) {
          continue;
        }
        // A call with approval state is not an orphan: undecided ones await
        // the human, decided ones are settled (deny) or owned by the
        // continuation about to run the tool (approve). Fabricating an
        // interrupted result here would clobber the approval flow.
        if (this._decidedApprovals.has(tc.id) || m.toolApprovals?.[tc.id]) {
          continue;
        }
        repairs.push({
          assistantIdx: idx,
          toolMessage: {
            id: `tool-${nanoid()}`,
            role: "tool",
            toolCallId: tc.id,
            content: JSON.stringify({ error: TOOL_INTERRUPTED_MESSAGE }),
            error: TOOL_INTERRUPTED_MESSAGE
          }
        });
      }
    });
    if (repairs.length === 0) return;
    const next = [...this._aguiMessages];
    for (let i = repairs.length - 1; i >= 0; i--) {
      next.splice(repairs[i].assistantIdx + 1, 0, repairs[i].toolMessage);
    }
    await this.persistMessages(next);
  }

  /**
   * Wait until the conversation is fully stable — no active turns, no
   * in-flight submits, no pending interaction, no armed auto-continuation.
   * Mirrors `AIChatAgent.waitUntilStable`; `pendingInteraction` overrides the
   * "still waiting" predicate (recovery passes the narrower
   * {@link hasPendingClientInteraction}).
   */
  protected async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;
    const hasPendingInteraction =
      options?.pendingInteraction ?? (() => this.hasPendingInteraction());
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    while (true) {
      // Drain active turns AND submits past the concurrency decision but not
      // yet enqueued, so the predicate reflects settled message state.
      while (true) {
        if (
          (await awaitWithDeadline(this._turnQueue.waitForIdle(), deadline)) ===
          TIMED_OUT
        ) {
          return false;
        }
        if (this._submitConcurrency.pendingEnqueueCount === 0) break;
        if ((await awaitWithDeadline(sleep(5), deadline)) === TIMED_OUT) {
          return false;
        }
      }

      if (!hasPendingInteraction()) {
        if (!this._hasArmedContinuation()) {
          return true;
        }
        // An auto-continuation is armed (#1650) — not stable yet. Wait for it
        // to fire (enqueuing a turn the outer loop then drains) or park, then
        // re-check.
        if (
          (await awaitWithDeadline(
            sleep(AutoContinuationController.COALESCE_MS),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
        continue;
      }

      const pending = this._pendingInteractionPromise;
      if (pending) {
        let result: boolean | typeof TIMED_OUT;
        try {
          result = await awaitWithDeadline(pending, deadline);
        } catch {
          continue;
        }
        if (result === TIMED_OUT) return false;
      } else if (
        (await awaitWithDeadline(sleep(100), deadline)) === TIMED_OUT
      ) {
        return false;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Chat recovery via fibers (mirrors AIChatAgent on the AG-UI shape)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Wrap a chat turn in a durable fiber carrying the recovery snapshot. The
   * snapshot kind/envelope key are shared with the legacy `AIChatAgent`
   * (cutover contract: a fiber persisted by either engine recovers on the
   * other — the snapshot itself is shape-agnostic).
   */
  private async _runChatRecoveryFiber<T>(
    requestId: string,
    continuation: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    const snapshot = createChatFiberSnapshot({
      kind: "ai-chat-turn",
      requestId,
      recoveryRootRequestId: this._activeChatRecoveryRootRequestId ?? requestId,
      continuation,
      messages: this._aguiMessages,
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools
    });

    return this._runFiberWithStashWrapper(
      `${(this.constructor as typeof AGUIChatAgent).CHAT_FIBER_NAME}:${requestId}`,
      async () => fn(),
      {
        initialSnapshot: wrapChatFiberSnapshot(
          "__cfAIChatFiberSnapshot",
          snapshot,
          null
        ),
        wrapStash: (data) =>
          wrapChatFiberSnapshot("__cfAIChatFiberSnapshot", snapshot, data)
      }
    );
  }

  private _resolveChatRecoveryConfig(): ResolvedChatRecoveryConfig {
    return resolveChatRecoveryConfig(this.chatRecovery);
  }

  /** Durable, monotonic forward-progress marker for recovery budget resets. */
  private async _chatRecoveryProgressMarker(): Promise<number> {
    return readChatRecoveryProgress(this.ctx.storage);
  }

  private async _bumpChatRecoveryProgress(): Promise<void> {
    return bumpChatRecoveryProgress(this.ctx.storage);
  }

  /**
   * N9: forwarding a sub-agent's chunks IS forward progress for this parent
   * turn — credit the parent's progress marker (throttled per isolate).
   */
  protected override async _onAgentToolStreamProgress(): Promise<void> {
    if (this._agentToolStreamProgress.shouldCredit(Date.now())) {
      await this._bumpChatRecoveryProgress();
    }
  }

  /**
   * Lazily-built shared recovery engine over the AG-UI adapter binding.
   * Mirrors `AIChatAgent._chatRecoveryEngine`.
   */
  private _chatRecoveryEngineInstance?: ChatRecoveryEngine;
  private _chatRecoveryEngine(): ChatRecoveryEngine {
    return (this._chatRecoveryEngineInstance ??= new ChatRecoveryEngine({
      resolveConfig: () => this._resolveChatRecoveryConfig(),
      now: () => Date.now(),
      sweepStaleIncidents: (now) =>
        sweepStaleChatRecoveryIncidents(this.ctx.storage, now),
      getIncident: async (key) =>
        (await this.ctx.storage.get<ChatRecoveryIncident>(key)) ?? null,
      readProgress: () => this._chatRecoveryProgressMarker(),
      // A turn parked on a pending CLIENT interaction is waiting on the human,
      // not stuck — budget-free.
      isAwaitingClientInteraction: () => this.hasPendingClientInteraction(),
      putIncident: (key, incident) => this.ctx.storage.put(key, incident),
      deleteIncident: async (key) => {
        await this.ctx.storage.delete(key);
      },
      emitRecoveryEvent: (event) =>
        this._emit(event.type, {
          incidentId: event.incidentId,
          requestId: event.requestId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          recoveryKind: event.recoveryKind,
          ...(event.reason ? { reason: event.reason } : {})
        }),
      scheduleRecovery: async (callback, data, reason, delaySeconds) => {
        await this.schedule(
          delaySeconds,
          callback,
          data,
          chatRecoverySchedulePolicy(reason)
        );
      },
      setRecovering: (active, requestId) =>
        this._setChatRecovering(active, requestId),
      onShouldKeepRecoveringError: (error) =>
        console.error(
          "[AGUIChatAgent] chatRecovery shouldKeepRecovering hook threw",
          error
        ),
      exhaustChatRecovery: (incident, config, partial, streamId, createdAt) =>
        this._exhaustChatRecovery(
          incident,
          config,
          partial,
          streamId,
          createdAt
        ),
      resolveRecoveryStream: (requestId) =>
        this._resolveAGUIRecoveryStream(requestId),
      getPartialStreamText: (streamId) => this._getPartialStreamText(streamId),
      activeChatRecoveryRootRequestId: () =>
        this._activeChatRecoveryRootRequestId,
      onGiveUpBookkeepingError: (phase, error) =>
        console.error(
          phase === "read"
            ? "[AGUIChatAgent] failed to read recovery incident during give-up; synthesizing"
            : "[AGUIChatAgent] failed to persist sealed recovery incident during give-up",
          error
        )
    } satisfies ChatRecoveryAdapter));
  }

  private async _beginChatRecoveryIncident(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: ChatRecoveryKind;
    /** Test-only clock injection for deterministic debounce/window timing. */
    nowMs?: number;
  }): Promise<{
    incident: ChatRecoveryIncident;
    config: ResolvedChatRecoveryConfig;
    exhausted: boolean;
  }> {
    return this._chatRecoveryEngine().beginIncident(input);
  }

  private async _updateChatRecoveryIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string
  ): Promise<void> {
    return this._chatRecoveryEngine().updateIncident(
      incidentId,
      status,
      reason
    );
  }

  private async _exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    partial: { text: string; parts: unknown[] },
    streamId: string,
    createdAt: number
  ): Promise<void> {
    await runChatRecoveryExhaustion(
      {
        incident,
        config,
        partialText: partial.text,
        // The engine seam is parts-vocabulary-agnostic; AG-UI's `parts` are
        // the reconstructed `AGUIMessage[]` and ride through the opaque slot.
        partialParts:
          partial.parts as ChatRecoveryExhaustedContext["partialParts"],
        streamId,
        createdAt
      },
      {
        emit: (event) => this._emit("chat:recovery:exhausted", event),
        onExhausted: config.onExhausted,
        onError: (error) =>
          console.error(
            "[AGUIChatAgent] chatRecovery onExhausted hook threw",
            error
          ),
        terminalize: async (ctx) => {
          // Banner BEFORE the durable terminal write: the write can reject in
          // the deploy/storage window a give-up runs in (#1730); the throw
          // then propagates and the whole give-up re-runs on a healthy
          // isolate (at-least-once banner is the documented edge).
          this._broadcastChatMessage({
            body: ctx.terminalMessage,
            done: true,
            error: true,
            id: ctx.requestId,
            type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
          });
          // Durable terminal record (#1645), replayed to reconnecting clients.
          await this._recordChatTerminal(ctx.requestId, ctx.terminalMessage);
          // Exhaustion resolves recovery — clear "recovering…" (#1620).
          await this._setChatRecovering(false);
        }
      }
    );
  }

  private async _recordChatTerminal(
    requestId: string,
    body: string
  ): Promise<void> {
    await recordChatTerminal(this.ctx.storage, requestId, body);
  }

  private async _clearChatTerminal(): Promise<void> {
    await clearChatTerminal(this.ctx.storage);
  }

  protected async _pendingChatTerminal(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return pendingChatTerminal(this.ctx.storage);
  }

  /** On-connect "recovering…" replay frame (#1620), or `null` when none. */
  private async _buildRecoveringConnectFrame(): Promise<Record<
    string,
    unknown
  > | null> {
    return buildChatRecoveringFrame(
      this.ctx.storage,
      CHAT_MESSAGE_TYPES.CHAT_RECOVERING,
      Date.now()
    );
  }

  private async _setChatRecovering(
    active: boolean,
    requestId?: string
  ): Promise<void> {
    await setChatRecovering(active, requestId, {
      storage: this.ctx.storage,
      messageType: CHAT_MESSAGE_TYPES.CHAT_RECOVERING,
      broadcast: (frame) =>
        this._broadcastChatMessage(frame as unknown as OutgoingAGUIMessage),
      now: Date.now()
    });
  }

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    return this._chatRecoveryEngine().handleChatFiberRecovery(ctx, {
      chatFiberPrefix: () =>
        `${(this.constructor as typeof AGUIChatAgent).CHAT_FIBER_NAME}:`,
      unwrapRecoverySnapshot: (fiber) => {
        const { snapshot, user } = unwrapChatFiberSnapshot<"ai-chat-turn">(
          "__cfAIChatFiberSnapshot",
          fiber.snapshot,
          "ai-chat-turn"
        );
        return { snapshot, recoveryData: user };
      },
      classifyRecoveredTurn: (input) => this._classifyRecoveredChatTurn(input),
      invokeOnChatRecovery: (input) =>
        this._invokeChatRecoveryHook({
          incidentId: input.incident.incidentId,
          recoveryRootRequestId: input.recoveryRootRequestId,
          attempt: input.incident.attempt,
          maxAttempts: input.incident.maxAttempts,
          recoveryKind: input.recoveryKind,
          streamId: input.streamId,
          requestId: input.requestId,
          partialText: input.partial.text,
          partialParts: input.partial.parts as AGUIMessage[],
          recoveryData: input.recoveryData,
          messages: [...this._aguiMessages],
          lastBody: input.snapshot?.lastBody ?? this._lastBody,
          lastClientTools:
            input.snapshot?.lastClientTools ?? this._lastClientTools,
          createdAt: input.createdAt
        }),
      // Only persist while the stream is still active — the ACK handler may
      // have already persisted + completed the orphan; persisting again would
      // double the partial. (The engine ANDs the never-drop-settled clause.)
      shouldPersistOrphanedPartial: (input) => input.streamStillActive,
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      completeRecoveredStream: (streamId) => {
        this._resumableStream.complete(streamId);
        void this._ensureStreamCleanupScheduled();
      },
      dispatchRecoveredTurn: (input) => this._dispatchRecoveredChatTurn(input)
    } satisfies ChatFiberWakeHooks<AGUIRecoveryClassification>);
  }

  /**
   * Resolve the orphaned stream for a recovered chat turn. Prefers the newest
   * durable stream row keyed by the (recovery-root) request id; falls back to
   * the live active stream; `""` when neither survives. AG-UI does not model
   * terminal stream status, so `streamStatus` stays undefined.
   */
  private _resolveAGUIRecoveryStream(
    requestId: string
  ): ResolvedRecoveryStream {
    let streamId = "";
    if (requestId) {
      const rows = this.sql<{ id: string }>`
        SELECT id FROM cf_ai_chat_stream_metadata
        WHERE request_id = ${requestId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length > 0) {
        streamId = rows[0].id;
      }
    }
    if (!streamId && this._resumableStream.hasActiveStream()) {
      streamId = this._resumableStream.activeStreamId ?? "";
    }
    const streamStillActive = Boolean(
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId
    );
    return { streamId, streamStillActive };
  }

  /** Reconstruct partial text/messages from stored AG-UI event chunks. */
  private _getPartialStreamText(streamId: string): {
    text: string;
    parts: AGUIMessage[];
    hasSettledToolResults: boolean;
  } {
    return aguiRecoveryCodec.toRecoveryPartial(
      this._resumableStream.getStreamChunks(streamId).map((chunk) => chunk.body)
    );
  }

  /**
   * Classify a recovered turn as `retry` or `continue`. Mirrors
   * `AIChatAgent._classifyRecoveredChatTurn` (#1691: an empty partial on a new
   * turn is re-run fresh rather than merged into the previous assistant).
   */
  private _classifyRecoveredChatTurn(input: ClassifyRecoveredTurnInput): {
    recoveryKind: ChatRecoveryKind;
    detail: AGUIRecoveryClassification;
  } {
    const shouldRetryPreStream = this._shouldRetryRecoveredPreStreamTurn(
      input.snapshot,
      input.streamId,
      input.partial
    );
    const preStreamLeaf =
      this._aguiMessages.length > 0
        ? this._aguiMessages[this._aguiMessages.length - 1]
        : undefined;
    const emptyPartialNewTurn =
      !!input.streamId &&
      input.snapshot?.continuation === false &&
      !!input.snapshot.latestUserMessageId &&
      input.partial.text === "" &&
      input.partial.parts.length === 0 &&
      preStreamLeaf?.role === "user" &&
      preStreamLeaf.id === input.snapshot.latestUserMessageId;
    const recoveryKind: ChatRecoveryKind =
      shouldRetryPreStream || emptyPartialNewTurn ? "retry" : "continue";
    return { recoveryKind, detail: { shouldRetryPreStream } };
  }

  private _shouldRetryRecoveredPreStreamTurn(
    snapshot: ChatFiberSnapshot | null,
    streamId: string,
    partial: { text: string; parts: unknown[] }
  ): snapshot is ChatFiberSnapshot & { latestUserMessageId: string } {
    if (
      !snapshot ||
      snapshot.continuation ||
      !snapshot.latestUserMessageId ||
      streamId ||
      partial.text ||
      partial.parts.length > 0
    ) {
      return false;
    }
    const lastMessage =
      this._aguiMessages.length > 0
        ? this._aguiMessages[this._aguiMessages.length - 1]
        : null;
    return (
      lastMessage?.role === "user" &&
      lastMessage.id === snapshot.latestUserMessageId
    );
  }

  /**
   * The retry/continue/skip decision for a recovered chat turn, run after the
   * partial is persisted and the stream completed. Mirrors
   * `AIChatAgent._dispatchRecoveredChatTurn`.
   */
  private async _dispatchRecoveredChatTurn(
    input: DispatchRecoveredTurnInput<AGUIRecoveryClassification>
  ): Promise<void> {
    const { incident, options, snapshot, recoveryRootRequestId } = input;
    const leaf =
      this._aguiMessages.length > 0
        ? this._aguiMessages[this._aguiMessages.length - 1]
        : undefined;
    const lostPartialUserId =
      snapshot?.continuation === false &&
      snapshot.latestUserMessageId &&
      leaf?.role === "user" &&
      leaf.id === snapshot.latestUserMessageId
        ? snapshot.latestUserMessageId
        : undefined;

    const targetId =
      input.detail.shouldRetryPreStream || lostPartialUserId !== undefined
        ? undefined
        : this._findLastAssistantMessage()?.id;

    if (input.detail.shouldRetryPreStream && options.continue !== false) {
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: input.recoveryKind,
        callback: "_chatRecoveryRetry",
        data: {
          targetUserId: snapshot?.latestUserMessageId,
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          lastBody: snapshot?.lastBody ?? null,
          lastClientTools: snapshot?.lastClientTools ?? null
        }
      });
    } else if (lostPartialUserId !== undefined && options.continue !== false) {
      // Re-run the orphaned new turn fresh instead of continuing (and merging
      // into) the previous assistant message (#1691).
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: "retry",
        callback: "_chatRecoveryRetry",
        data: {
          targetUserId: lostPartialUserId,
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          lastBody: snapshot?.lastBody ?? null,
          lastClientTools: snapshot?.lastClientTools ?? null
        }
      });
    } else if (options.continue !== false) {
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: input.recoveryKind,
        callback: "_chatRecoveryContinue",
        data: {
          ...(targetId ? { targetAssistantId: targetId } : {}),
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          ...(snapshot
            ? {
                lastBody: snapshot.lastBody ?? null,
                lastClientTools: snapshot.lastClientTools ?? null
              }
            : {})
        }
      });
    } else {
      await this._updateChatRecoveryIncident(
        incident.incidentId,
        "skipped",
        "continue_disabled"
      );
    }
  }

  /**
   * Called when an interrupted chat stream is detected after restart. Return
   * options to control recovery: `{}` (default) persists the partial and
   * schedules a continuation; `{ continue: false }` persists only;
   * `{ persist: false, continue: false }` hands everything to the app.
   */
  protected async onChatRecovery(
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
    _ctx: AGUIChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return {};
  }

  async _chatRecoveryContinue(data?: ChatRecoveryContinueData): Promise<void> {
    const previousRootRequestId = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId =
      data?.originalRequestId ?? previousRootRequestId;
    try {
      const recoveryConfig = this._resolveChatRecoveryConfig();
      const ready = await this.waitUntilStable({
        timeout: recoveryConfig.stableTimeoutMs,
        // Recovery-scoped: a dead server-tool orphan must not block stability
        // (the pre-turn repair settles it); a genuinely-pending CLIENT
        // interaction still parks via the `!ready` branch.
        pendingInteraction: () => this.hasPendingClientInteraction()
      });
      if (!ready) {
        // PARK, don't burn the budget, while a CLIENT interaction is pending —
        // the turn is waiting on the human, not churning.
        if (await this._parkRecoveryForPendingInteraction(data)) {
          return;
        }
        console.warn(
          "[AGUIChatAgent] _chatRecoveryContinue timed out waiting for stable state"
        );
        if (
          await this._rescheduleRecoveryAfterStableTimeout(
            "_chatRecoveryContinue",
            data,
            recoveryConfig.maxAttempts
          )
        ) {
          return;
        }
        await this._exhaustRecoveryAfterStableTimeout(
          "_chatRecoveryContinue",
          data
        );
        return;
      }

      const targetId = data?.targetAssistantId;
      if (targetId && this._findLastAssistantMessage()?.id !== targetId) {
        // The leaf moved, so this continuation is superseded — skip it.
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "conversation_changed"
        );
        return;
      }

      this._applyRecoveredRequestContext(data);
      const result = await this.continueLastTurn();
      await this._updateChatRecoveryIncident(
        data?.incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
      );
    } catch (error) {
      // OOM-only intercept (#1825): route through the tight OOM-retry budget;
      // everything else rethrows to `Agent._executeScheduleCallback`.
      if (await this._handleRecoveryOom("_chatRecoveryContinue", data, error)) {
        return;
      }
      throw error;
    } finally {
      this._activeChatRecoveryRootRequestId = previousRootRequestId;
    }
  }

  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    const previousRootRequestId = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId =
      data?.originalRequestId ?? previousRootRequestId;
    try {
      const recoveryConfig = this._resolveChatRecoveryConfig();
      const ready = await this.waitUntilStable({
        timeout: recoveryConfig.stableTimeoutMs,
        pendingInteraction: () => this.hasPendingClientInteraction()
      });
      if (!ready) {
        if (await this._parkRecoveryForPendingInteraction(data)) {
          return;
        }
        console.warn(
          "[AGUIChatAgent] _chatRecoveryRetry timed out waiting for stable state"
        );
        if (
          await this._rescheduleRecoveryAfterStableTimeout(
            "_chatRecoveryRetry",
            data,
            recoveryConfig.maxAttempts
          )
        ) {
          return;
        }
        await this._exhaustRecoveryAfterStableTimeout(
          "_chatRecoveryRetry",
          data
        );
        return;
      }

      const lastMessage =
        this._aguiMessages.length > 0
          ? this._aguiMessages[this._aguiMessages.length - 1]
          : null;
      if (!lastMessage || lastMessage.role !== "user") {
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "no_unanswered_user_message"
        );
        return;
      }

      if (data?.targetUserId && lastMessage.id !== data.targetUserId) {
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "conversation_changed"
        );
        return;
      }

      this._applyRecoveredRequestContext(data);
      const result = await this._retryLastUserTurn(
        this._lastClientTools,
        this._lastBody
      );
      await this._updateChatRecoveryIncident(
        data?.incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
      );
    } catch (error) {
      if (await this._handleRecoveryOom("_chatRecoveryRetry", data, error)) {
        return;
      }
      throw error;
    } finally {
      this._activeChatRecoveryRootRequestId = previousRootRequestId;
    }
  }

  private _applyRecoveredRequestContext(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): void {
    if (!data) return;
    if ("lastClientTools" in data) {
      this._lastClientTools = data.lastClientTools ?? undefined;
    }
    if ("lastBody" in data) {
      this._lastBody = data.lastBody ?? undefined;
    }
    if ("lastClientTools" in data || "lastBody" in data) {
      this._persistRequestContext();
    }
  }

  /**
   * Route a live stream stall (the {@link chatStreamStallTimeoutMs} watchdog
   * fired) into the same bounded-recovery machinery a deploy/eviction
   * interruption uses (#1626): open or reuse the incident under the turn's
   * recovery identity, deliver terminal UX if the budget is spent, otherwise
   * schedule a `_chatRecoveryContinue`. Mirrors
   * `AIChatAgent._routeStallToBoundedRecovery`.
   *
   * Returns `"exhausted"` when the budget was spent (terminal UX already
   * delivered), or `"scheduled"` when a continuation was queued.
   */
  private async _routeStallToBoundedRecovery(input: {
    requestId: string;
    streamId: string;
    partialMessages: readonly AGUIMessage[];
    targetAssistantId?: string;
  }): Promise<"scheduled" | "exhausted"> {
    const recoveryRootRequestId =
      this._activeChatRecoveryRootRequestId ?? input.requestId;
    const latestUserMessageId =
      [...this._aguiMessages].reverse().find((m) => m.role === "user")?.id ??
      null;
    const { incident, config, exhausted } =
      await this._beginChatRecoveryIncident({
        requestId: input.requestId,
        recoveryRootRequestId,
        latestUserMessageId,
        recoveryKind: "continue"
      });
    if (exhausted) {
      // Budget spent: deliver the SAME terminal UX as deploy-recovery
      // exhaustion instead of letting the raw stall error leak out.
      // `firstSeenAt` is the closest available turn-start proxy here.
      const partialText = input.partialMessages
        .filter((m) => m.role === "assistant" && typeof m.content === "string")
        .map((m) => (m as AssistantMessage).content as string)
        .join("");
      await this._exhaustChatRecovery(
        incident,
        config,
        { text: partialText, parts: [...input.partialMessages] },
        input.streamId,
        incident.firstSeenAt
      );
      return "exhausted";
    }
    await this._chatRecoveryEngine().scheduleRecovery({
      incident,
      recoveryKind: "continue",
      callback: "_chatRecoveryContinue",
      data: {
        ...(input.targetAssistantId
          ? { targetAssistantId: input.targetAssistantId }
          : {}),
        originalRequestId: recoveryRootRequestId,
        incidentId: incident.incidentId,
        lastBody: this._lastBody ?? null,
        lastClientTools: this._lastClientTools ?? null
      }
    });
    return "scheduled";
  }

  /**
   * Reschedule a recovery callback that timed out waiting for stable state,
   * consuming one attempt. `false` once the attempt budget is spent.
   */
  private async _rescheduleRecoveryAfterStableTimeout(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    maxAttempts: number
  ): Promise<boolean> {
    return this._chatRecoveryEngine().rescheduleAfterStableTimeout({
      incidentId: data?.incidentId,
      callback,
      data,
      fallbackMaxAttempts: maxAttempts
    });
  }

  /**
   * Park a recovery whose stable-state wait timed out because a CLIENT
   * interaction is pending: mark the incident `skipped`
   * (`awaiting_client_interaction`) instead of burning budget — the client's
   * replayed tool-result / approval drives a fresh continuation on its own.
   */
  private async _parkRecoveryForPendingInteraction(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<boolean> {
    if (!this.hasPendingClientInteraction()) return false;
    await this._updateChatRecoveryIncident(
      data?.incidentId,
      "skipped",
      "awaiting_client_interaction"
    );
    return true;
  }

  /** Recovery callbacks the alarm-boundary OOM circuit breaker may purge (#1825). */
  protected override _cf_recoveryAlarmCallbacks(): string[] {
    return ["_chatRecoveryContinue", "_chatRecoveryRetry"];
  }

  /**
   * Seal any still-live recovery incident as an out-of-memory exhaustion when
   * the alarm circuit breaker trips (#1825).
   */
  protected override async _cf_sealMemoryLimitedRecovery(): Promise<void> {
    const active = await listActiveChatRecoveryIncidents(this.ctx.storage);
    for (const { incident } of active) {
      const callback: ChatRecoveryScheduleCallback =
        incident.recoveryKind === "retry"
          ? "_chatRecoveryRetry"
          : "_chatRecoveryContinue";
      await this._chatRecoveryEngine().exhaustRecoveryGiveUp({
        callback,
        data: { incidentId: incident.incidentId },
        reason: "out_of_memory"
      });
    }
  }

  /**
   * Terminalize a recovery turn whose stable-state retry budget drained (or
   * whose incident record vanished) through the same exhaustion path as
   * deploy-recovery give-up.
   */
  private _exhaustRecoveryAfterStableTimeout(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<void> {
    return this._chatRecoveryEngine().exhaustRecoveryGiveUp({
      callback,
      data,
      reason: "stable_timeout"
    });
  }

  /**
   * Apply the tight OOM-retry budget to an error thrown out of a recovery
   * turn (#1825). Returns `true` when the error was an OOM and this method
   * owns the outcome, `false` for non-OOM errors.
   */
  private async _handleRecoveryOom(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    error: unknown
  ): Promise<boolean> {
    if (!isDurableObjectMemoryLimitReset(error)) return false;
    let decision: "rescheduled" | "exhausted" = "exhausted";
    try {
      decision = await this._chatRecoveryEngine().recordOomAndDecide({
        incidentId: data?.incidentId,
        callback,
        data,
        maxOomRetries: this._resolveChatRecoveryConfig().maxOomRetries
      });
    } catch (bookkeepingError) {
      // Fail closed (seal) rather than risk a silent wedge in the degraded
      // isolate that just OOMed.
      console.error(
        "[AGUIChatAgent] failed to record OOM recovery attempt; terminalizing",
        bookkeepingError
      );
      decision = "exhausted";
    }
    if (decision === "exhausted") {
      await this._chatRecoveryEngine().exhaustRecoveryGiveUp({
        callback,
        data,
        reason: "out_of_memory"
      });
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Programmatic entry points
  // ──────────────────────────────────────────────────────────────────

  async saveMessages(
    messages:
      | AGUIMessage[]
      | ((
          currentMessages: readonly AGUIMessage[]
        ) => AGUIMessage[] | Promise<AGUIMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const requestId = nanoid();
    const clientTools = this._lastClientTools;
    const body = this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        const resolved =
          typeof messages === "function"
            ? await messages(this._aguiMessages)
            : messages;
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }
        await this.persistMessages(resolved);
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }
        const turnResult = await this._runProgrammaticChatTurn(
          requestId,
          clientTools,
          body,
          options?.signal
        );
        status = turnResult.status;
        error = turnResult.error;
      },
      { epoch }
    );
    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }
    return { requestId, status, ...(error !== undefined && { error }) };
  }

  private async _runProgrammaticChatTurn(
    requestId: string,
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<StreamResultStatus> {
    this._setRequestContext(clientTools, body);
    let wasAborted = false;
    let status: StreamResultStatus = { status: "completed" };
    await this._tryCatchChat(async () => {
      return agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        async () => {
          const abortSignal = this._abortRegistry.getSignal(requestId);
          const detachExternal = this._abortRegistry.linkExternal(
            requestId,
            externalSignal
          );
          try {
            const programmaticBody = async () => {
              await this._repairInterruptedToolsBeforeTurn();
              const response = await this._invokeChatHandler(() => {}, {
                requestId,
                abortSignal,
                clientTools,
                body,
                continuation: false
              });
              if (response) {
                status = await this._reply(requestId, response, [], {
                  chatMessageId: requestId
                });
              }
            };
            await this._runChatRecoveryFiber(
              requestId,
              false,
              programmaticBody
            );
          } finally {
            if (abortSignal?.aborted) wasAborted = true;
            detachExternal();
            this._abortRegistry.remove(requestId);
          }
        }
      );
    });
    if (status.status === "completed" && wasAborted) {
      return { status: "aborted" };
    }
    return status;
  }

  protected async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    if (!this._findLastAssistantMessage()) {
      return { requestId: "", status: "skipped" };
    }
    const requestId = nanoid();
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let wasAborted = false;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }
        this._setRequestContext(clientTools, resolvedBody);
        const turnBody = async () => {
          await this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              async () => {
                const abortSignal = this._abortRegistry.getSignal(requestId);
                const detachExternal = this._abortRegistry.linkExternal(
                  requestId,
                  options?.signal
                );
                try {
                  // Repair interrupted server-tool orphans before re-entering
                  // inference so the recovered transcript is settled.
                  await this._repairInterruptedToolsBeforeTurn();
                  const response = await this._invokeChatHandler(() => {}, {
                    requestId,
                    abortSignal,
                    clientTools,
                    body: resolvedBody,
                    continuation: true
                  });
                  if (response) {
                    const replyResult = await this._reply(
                      requestId,
                      response,
                      [],
                      {
                        continuation: true,
                        chatMessageId: requestId
                      }
                    );
                    status = replyResult.status;
                    error = replyResult.error;
                  }
                } finally {
                  if (abortSignal?.aborted) wasAborted = true;
                  detachExternal();
                  this._abortRegistry.remove(requestId);
                }
              }
            );
          });
        };
        await this._runChatRecoveryFiber(requestId, true, turnBody);
      },
      { epoch }
    );
    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }
    return { requestId, status, ...(error !== undefined && { error }) };
  }

  /**
   * Re-run the last unanswered user turn (the pre-stream retry path). Mirrors
   * `AIChatAgent._retryLastUserTurn`.
   */
  private async _retryLastUserTurn(
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const lastMessage =
      this._aguiMessages.length > 0
        ? this._aguiMessages[this._aguiMessages.length - 1]
        : null;
    if (!lastMessage || lastMessage.role !== "user") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = nanoid();
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }
        const turnResult = await this._runProgrammaticChatTurn(
          requestId,
          clientTools,
          body,
          options?.signal
        );
        status = turnResult.status;
        error = turnResult.error;
      },
      { epoch }
    );

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }
    return { requestId, status, ...(error !== undefined && { error }) };
  }

  // ──────────────────────────────────────────────────────────────────
  // Cleanup
  // ──────────────────────────────────────────────────────────────────

  async destroy() {
    this._abortRegistry.destroyAll();
    this._resumableStream.destroy();
    await super.destroy();
  }
}

// Re-export shared types so subclasses can `import` everything from one place.
export type {
  AGUIMessage,
  AssistantMessage,
  ToolMessage,
  UserMessage
} from "./chat/agui-types";
export type { ClientToolSchema } from "./chat/client-tools";
export type {
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "./chat/lifecycle";

// Re-exports for adapter packages that wrap sub-agent forwarding.
export {
  applyAGUIAgentToolEvent,
  createAGUIAgentToolEventState,
  type AGUIAgentToolEvent
};

// Test-friendly named exports (pure-logic helpers exercised by the
// `__tests__` suite).
export {
  encodeAGUIEventLine as _aguiEncodeEventLine,
  parseAGUIEventLine as _aguiParseEventLine,
  wrapPersistedShape as _aguiWrapPersistedShape
};
