/**
 * Test worker for the `AGUIChatAgent` server suite.
 *
 * Each fixture agent returns a deterministic AG-UI SSE `Response` from
 * `onChatMessage` so tests can assert on the exact wire frames, persistence
 * rows, and lifecycle side-effects. Fixtures expose a `/probe` route via
 * `onRequest` where a test needs to observe captured server state.
 */

import {
  Agent,
  routeAgentRequest,
  type AgentToolEventMessage,
  type AgentToolLifecycleResult,
  type AgentToolRunInfo,
  type AgentToolRunInspection,
  type AgentToolStoredChunk,
  type RunAgentToolResult
} from "../index";
import {
  AGUIChatAgent,
  type AGUIChatRecoveryContext,
  type AGUIMessage,
  type ClientToolSchema,
  type OnChatMessageOptions
} from "../agui-chat-agent";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import type {
  ChatRecoveryConfig,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  SaveMessagesResult
} from "../chat/lifecycle";
import { CF_TOOL_APPROVAL_REQUEST, type AGUIEvent } from "../chat/agui-types";

function sseResponse(
  events: AGUIEvent[],
  options?: { delayMs?: number; signal?: AbortSignal; holdMsAfter?: number }
): Response {
  const encoder = new TextEncoder();
  const delayMs = options?.delayMs ?? 0;
  const signal = options?.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if (signal?.aborted) break;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (options?.holdMsAfter && !signal?.aborted) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.holdMsAfter)
        );
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

/**
 * An SSE response that streams a partial assistant turn and then HANGS — the
 * stream never closes and never emits another event. Exercises the
 * `chatStreamStallTimeoutMs` inactivity watchdog (#1626): the gap after the
 * last delta trips the watchdog, which aborts the turn into bounded recovery.
 */
function hangingSSEResponse(messageId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const events: AGUIEvent[] = [
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: "partial before stall"
        }
      ];
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      // Intentionally never enqueue more or close: a hung provider.
    },
    cancel() {}
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

/** An SSE body that opens a run and then throws — a provider failing mid-stream. */
function errorAfterStartSSEResponse(message: string): Response {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t1", runId: "r1" })}\n\n`
          )
        );
        return;
      }
      throw new Error(message);
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

function textRunEvents(messageId: string, deltas: string[]): AGUIEvent[] {
  return [
    { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    ...deltas.map(
      (delta): AGUIEvent => ({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta
      })
    ),
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
  ];
}

/** Streams a fixed two-delta assistant reply. */
export class EchoAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return sseResponse(
      textRunEvents(`assistant-${Date.now()}`, ["Hello ", "world"])
    );
  }
}

/** Streams a tool call plus its result, then a closing text run. */
export class ToolCallAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const messageId = `assistant-${Date.now()}`;
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tc-1",
        toolCallName: "getWeather",
        parentMessageId: messageId
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: '{"city":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: '"Sydney"}' },
      { type: "TOOL_CALL_END", toolCallId: "tc-1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool-1",
        toolCallId: "tc-1",
        content: JSON.stringify({ temp: 21 })
      },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "It is 21C" },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    return sseResponse(events);
  }
}

/**
 * Streams slowly (100ms per event) so tests can cancel mid-stream or attach
 * a second client while the stream is active. Records whether the
 * `abortSignal` fired; exposed via the `/probe` route.
 */
export class SlowAguiAgent extends AGUIChatAgent<Env> {
  private _sawAbort = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ) {
    options?.abortSignal?.addEventListener("abort", () => {
      this._sawAbort = true;
    });
    const messageId = `assistant-${Date.now()}`;
    return sseResponse(textRunEvents(messageId, Array(12).fill("tick ")), {
      delayMs: 100,
      signal: options?.abortSignal
    });
  }

  async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/probe")) {
      return Response.json({ sawAbort: this._sawAbort });
    }
    return super.onRequest(request);
  }
}

/**
 * Holds `onChatMessage` for `responseDelayMs` before returning a Response, so a
 * turn spends a controllable window accepted-but-not-yet-streaming (#1784).
 * Records every request id that entered the handler so tests can synchronize on
 * that window instead of sleeping.
 */
export class PreStreamAguiAgent extends AGUIChatAgent<Env> {
  private _startedRequestIds: string[] = [];

  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    if (options?.requestId) this._startedRequestIds.push(options.requestId);
    const body = options?.body as
      | { responseDelayMs?: number; noStream?: boolean }
      | undefined;
    if (body?.responseDelayMs)
      await new Promise((resolve) => setTimeout(resolve, body.responseDelayMs));
    // `noStream`: settle the turn by returning no Response at all — the pre-
    // stream window closes with neither a stream NOR a terminal record, which
    // is the only shape that must release a parked client with a bare
    // STREAM_RESUME_NONE (a pre-Response throw records a terminal instead).
    if (body?.noStream) return undefined;
    return sseResponse(
      textRunEvents(`assistant-${options?.requestId ?? "x"}`, ["ok"])
    );
  }

  getStartedRequestIds(): string[] {
    return [...this._startedRequestIds];
  }
}

/** Same pre-stream delay knob under the `latest` supersede policy. */
export class PreStreamLatestAguiAgent extends PreStreamAguiAgent {
  messageConcurrency = "latest" as const;
}

/** Returns a plaintext (non-SSE) Response — must be wrapped in a synthetic run. */
export class PlaintextAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return new Response("plain answer", {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/** Throws before producing a Response — the pre-stream error path. */
export class PreThrowAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(): Promise<Response | undefined> {
    throw new Error("boom before response");
  }
}

/** SSE body that errors mid-stream after one event. */
export class ErrorStreamAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const encoder = new TextEncoder();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t1", runId: "r1" })}\n\n`
            )
          );
          return;
        }
        throw new Error("boom mid-stream");
      }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }
}

/**
 * Streams a tool call whose approval is requested mid-stream, then holds the
 * stream open so tests can observe the eager persistence and send the
 * approval decision while the turn is still live.
 */
export class ApprovalAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const messageId = "assistant-approval";
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tc-approve",
        toolCallName: "deleteEverything",
        parentMessageId: messageId
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc-approve", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "tc-approve" },
      {
        type: "CUSTOM",
        name: CF_TOOL_APPROVAL_REQUEST,
        value: {
          toolCallId: "tc-approve",
          approvalId: "ap-1",
          toolName: "deleteEverything"
        }
      },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    return sseResponse(events, { holdMsAfter: 2000 });
  }
}

/** Keeps at most 2 persisted rows. */
export class MaxPersistedAguiAgent extends AGUIChatAgent<Env> {
  maxPersistedMessages = 2;

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return sseResponse(textRunEvents(`assistant-${Date.now()}`, ["ok"]));
  }
}

/** Exposes `saveMessages` through a `/trigger-save` route. */
export class SaveMessagesAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return sseResponse(textRunEvents("assistant-saved", ["saved-reply"]));
  }

  async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/trigger-save")) {
      const messages = (await request.json()) as AGUIMessage[];
      const result = await this.saveMessages(messages);
      return Response.json(result);
    }
    return super.onRequest(request);
  }
}

/**
 * Auto-continuation fixture (#1649 / #1650). Streams a configurable number of
 * deltas so a turn can be held open while tool results arrive, records every
 * request id that entered `onChatMessage`, and exposes the barrier's internal
 * state so the ported suite can assert on park / fire / defer transitions.
 *
 * Body knobs (sent on the chat request, replayed into continuations via
 * `_lastBody`): `streamChunks`, `streamDelayMs`, `continuationStreamError`.
 */
export class AutoContinueAguiAgent extends AGUIChatAgent<Env> {
  private _startedRequestIds: string[] = [];
  private _capturedBodies: Array<Record<string, unknown> | undefined> = [];
  private _capturedClientTools: Array<ClientToolSchema[] | undefined> = [];

  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    this._startedRequestIds.push(options?.requestId ?? "unknown");
    this._capturedBodies.push(options?.body);
    this._capturedClientTools.push(options?.clientTools);
    const body = options?.body as
      | {
          streamChunks?: number;
          streamDelayMs?: number;
          responseDelayMs?: number;
          streamToolCallIds?: string[];
          continuationStreamError?: string;
          continuationStreamChunks?: number;
        }
      | undefined;

    if (options?.continuation && body?.continuationStreamError) {
      return errorAfterStartSSEResponse(body.continuationStreamError);
    }

    // Make only the CONTINUATION slow, so the priming turn stays instant and a
    // second client has a live continuation stream to probe against.
    if (options?.continuation && body?.continuationStreamChunks) {
      return sseResponse(
        textRunEvents(
          `assistant-cont-${this._startedRequestIds.length}`,
          Array(body.continuationStreamChunks).fill("tick ")
        ),
        { delayMs: 80, signal: options.abortSignal }
      );
    }

    // Hold the turn accepted-but-not-yet-streaming so a test can land a sibling
    // result after the barrier fired but before `_startStream` consumes the
    // pending continuation — the window where a result must be DEFERRED.
    if (body?.responseDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, body.responseDelayMs));
    }

    const messageId = `assistant-${this._startedRequestIds.length}`;

    // Fan out tool calls one at a time (first turn only, so a continuation
    // doesn't re-issue them): the client can answer the first while its
    // siblings have not been streamed yet — the #1650 signature.
    if (body?.streamToolCallIds?.length && !options?.continuation) {
      const events: AGUIEvent[] = [
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        ...body.streamToolCallIds.flatMap((toolCallId): AGUIEvent[] => [
          {
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: "testTool",
            parentMessageId: messageId
          },
          { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
          { type: "TOOL_CALL_END", toolCallId }
        ]),
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
      ];
      return sseResponse(events, { delayMs: body.streamDelayMs ?? 100 });
    }

    const deltas = Array(body?.streamChunks ?? 1).fill("tick ");
    return sseResponse(textRunEvents(messageId, deltas), {
      delayMs: body?.streamDelayMs ?? 0
    });
  }

  getStartedRequestIds(): string[] {
    return [...this._startedRequestIds];
  }

  getPersistedMessages(): AGUIMessage[] {
    return this.messages;
  }

  /** Per-turn `body` / `clientTools` as `onChatMessage` actually received them. */
  getCapturedBodiesForTest(): Array<Record<string, unknown> | undefined> {
    return [...this._capturedBodies];
  }

  getCapturedClientToolsForTest(): Array<ClientToolSchema[] | undefined> {
    return [...this._capturedClientTools];
  }

  clearCapturedContextForTest(): void {
    this._startedRequestIds = [];
    this._capturedBodies = [];
    this._capturedClientTools = [];
  }

  /** The durable request context, as a cold start would find it on disk. */
  getPersistedRequestContextForTest(): Record<string, string> {
    const rows =
      this.sql<{
        key: string;
        value: string;
      }>`select key, value from cf_ai_chat_request_context` || [];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * Simulate a cold start: drop the in-memory request context and rehydrate it
   * from SQLite exactly as the constructor does.
   */
  reloadRequestContextForTest(): void {
    this._lastBody = undefined;
    this._lastClientTools = undefined;
    (
      this as unknown as { _restoreRequestContext(): void }
    )._restoreRequestContext();
  }

  /** Seed one assistant message fanning out `toolCallIds` unanswered calls. */
  async persistParallelToolCallsForTest(
    messageId: string,
    toolCallIds: string[]
  ): Promise<void> {
    await this.persistMessages([
      { id: `user-${messageId}`, role: "user", content: "do both" },
      {
        id: messageId,
        role: "assistant",
        toolCalls: toolCallIds.map((id) => ({
          id,
          type: "function" as const,
          function: { name: "testTool", arguments: "{}" }
        }))
      }
    ]);
  }

  /** Barrier + continuation state, flattened for RPC. */
  getContinuationStateForTest(): {
    hasPending: boolean;
    hasDeferred: boolean;
    pastCoalesce: boolean;
    armed: boolean;
    activeRequestId: string | null;
  } {
    const internal = this as unknown as {
      _continuation: {
        pending: { pastCoalesce: boolean } | null;
        deferred: unknown | null;
        activeRequestId: string | null;
      };
      _autoContinuation: { isArmed(): boolean };
    };
    return {
      hasPending: internal._continuation.pending !== null,
      hasDeferred: internal._continuation.deferred !== null,
      pastCoalesce: internal._continuation.pending?.pastCoalesce ?? false,
      armed: internal._autoContinuation.isArmed(),
      activeRequestId: internal._continuation.activeRequestId
    };
  }

  hasPendingInteractionForTest(): boolean {
    return this.hasPendingInteraction();
  }

  /** Whether a resumable stream is live right now. */
  hasActiveStreamForTest(): boolean {
    return (
      this as unknown as { _resumableStream: { hasActiveStream(): boolean } }
    )._resumableStream.hasActiveStream();
  }

  /**
   * Point continuation ownership at an arbitrary connection id. Used to stage
   * the state an ABRUPT (1006) disconnect leaves behind: `onClose` never ran,
   * so the id of a connection that is already gone is still recorded as owner.
   */
  setContinuationOwnerForTest(connectionId: string): void {
    (
      this as unknown as {
        _continuation: { activeConnectionId: string | null };
      }
    )._continuation.activeConnectionId = connectionId;
  }

  /** Turns waiting behind the active one — a continuation the barrier fired. */
  getQueuedTurnCountForTest(): number {
    return (
      this as unknown as { _turnQueue: { queuedCount(): number } }
    )._turnQueue.queuedCount();
  }

  waitUntilStableForTest(timeout?: number): Promise<boolean> {
    return this.waitUntilStable(timeout != null ? { timeout } : undefined);
  }

  resetTurnStateForTest(): void {
    this.resetTurnState();
  }

  /**
   * Two read-modify-writes with an await between read and write. Unserialized
   * they clobber (result 1); serialized behind the apply chain both land (2).
   */
  async testInteractionApplySerialization(): Promise<number> {
    let shared = 0;
    const rmw = (delayMs: number) => async () => {
      const read = shared;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      shared = read + 1;
      return true;
    };
    await Promise.all([
      this._enqueueInteractionApply(rmw(30)),
      this._enqueueInteractionApply(rmw(0))
    ]);
    return shared;
  }
}

/**
 * Recovery fixture — port of `ChatRecoveryTestAgent` from
 * `packages/ai-chat/src/tests/worker.ts` on the AG-UI shape. Exposes the
 * `*ForTest` RPC surface the ported recovery suites drive.
 */
export class RecoveryAguiAgent extends AGUIChatAgent<Env> {
  recoveryContexts: AGUIChatRecoveryContext[] = [];
  exhaustedContexts: ChatRecoveryExhaustedContext[] = [];
  recoveryOverride: ChatRecoveryOptions | null = null;
  recoveryShouldThrow = false;
  onChatMessageCallCount = 0;
  onChatMessageBodies: Array<Record<string, unknown> | undefined> = [];
  onChatMessageClientTools: Array<ClientToolSchema[] | undefined> = [];
  onExhaustedCalls = 0;
  private _shouldThrow = false;
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;
  private _emitStreamError: string | null = null;
  private _emitStreamErrorAfterChunks = 0;
  private _forceStableTimeout = false;
  /** Number of upcoming turns whose model stream hangs (see
   *  {@link hangingSSEResponse}) before reverting to the normal response. */
  private _hangTurnsRemaining = 0;

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    this.onChatMessageCallCount++;
    this.onChatMessageBodies.push(options?.body);
    this.onChatMessageClientTools.push(options?.clientTools);

    if (this._shouldThrow) {
      throw new Error("onChatMessage boom");
    }

    if (this._stashData !== null) {
      try {
        this.stash(this._stashData);
        this._stashResult = { success: true };
      } catch (e) {
        this._stashResult = {
          success: false,
          error: e instanceof Error ? e.message : String(e)
        };
      }
    }

    if (this._hangTurnsRemaining > 0) {
      this._hangTurnsRemaining--;
      return hangingSSEResponse(
        `assistant-hang-${this.onChatMessageCallCount}`
      );
    }

    if (this._emitStreamError) {
      // Surface a terminal stream error (the way a provider 500 arrives),
      // optionally after `_emitStreamErrorAfterChunks` text deltas so the
      // errored stream carries partial content to replay (#1575).
      const message = this._emitStreamError;
      const messageId = "assistant-partial";
      const prelude: AGUIEvent[] = [
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        ...(this._emitStreamErrorAfterChunks > 0
          ? [
              {
                type: "TEXT_MESSAGE_START" as const,
                messageId,
                role: "assistant" as const
              },
              ...Array.from(
                { length: this._emitStreamErrorAfterChunks },
                (_, i): AGUIEvent => ({
                  type: "TEXT_MESSAGE_CONTENT",
                  messageId,
                  delta: `partial-${i} `
                })
              )
            ]
          : [])
      ];
      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < prelude.length) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(prelude[index++])}\n\n`)
            );
            return;
          }
          throw new Error(message);
        }
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" }
      });
    }

    // `streamChunks` / `streamDelayMs` (from the request body) turn the default
    // reply into a long slow stream a client can cancel mid-flight.
    const body = options?.body as
      | { streamChunks?: number; streamDelayMs?: number }
      | undefined;
    return sseResponse(
      textRunEvents(
        `assistant-${this.onChatMessageCallCount}-${Date.now()}`,
        Array(body?.streamChunks ?? 1).fill("Continued response.")
      ),
      {
        delayMs: body?.streamDelayMs ?? 0,
        signal: options?.abortSignal
      }
    );
  }

  override async onChatRecovery(
    ctx: AGUIChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.recoveryContexts.push(ctx);
    if (this.recoveryShouldThrow) {
      throw new Error("onChatRecovery boom");
    }
    if (this.recoveryOverride) return this.recoveryOverride;
    return {};
  }

  override async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }): Promise<boolean> {
    if (this._forceStableTimeout) return false;
    return super.waitUntilStable(options);
  }

  // ── Configuration toggles ──────────────────────────────────────────

  setShouldThrow(value: boolean): void {
    this._shouldThrow = value;
  }

  setStashData(data: unknown): void {
    this._stashData = data;
  }

  getStashResult(): { success: boolean; error?: string } | null {
    return this._stashResult;
  }

  setRecoveryOverride(options: ChatRecoveryOptions): void {
    this.recoveryOverride = options;
  }

  setRecoveryShouldThrowForTest(shouldThrow: boolean): void {
    this.recoveryShouldThrow = shouldThrow;
  }

  setChatRecoveryConfigForTest(config: ChatRecoveryConfig): void {
    this.chatRecovery = config;
  }

  /** Functions can't cross RPC, so the predicate is built in-DO. */
  setShouldKeepRecoveringForTest(keepRecovering: boolean): void {
    this.chatRecovery = { shouldKeepRecovering: () => keepRecovering };
  }

  enableThrowingOnExhaustedForTest(
    maxAttempts: number,
    terminalMessage: string
  ): void {
    this.onExhaustedCalls = 0;
    this.chatRecovery = {
      maxAttempts,
      terminalMessage,
      onExhausted: () => {
        this.onExhaustedCalls++;
        throw new Error("onExhausted boom");
      }
    };
  }

  getOnExhaustedCallsForTest(): number {
    return this.onExhaustedCalls;
  }

  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): void {
    this.exhaustedContexts = [];
    this.chatRecovery = {
      maxAttempts,
      ...(terminalMessage ? { terminalMessage } : {}),
      onExhausted: (exhaustedCtx) => {
        this.exhaustedContexts.push(exhaustedCtx);
      }
    };
  }

  getExhaustedContextsForTest(): ChatRecoveryExhaustedContext[] {
    return this.exhaustedContexts;
  }

  setForceStableTimeoutForTest(value: boolean): void {
    this._forceStableTimeout = value;
  }

  setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: ClientToolSchema[]
  ): void {
    this._lastBody = body;
    this._lastClientTools = clientTools;
  }

  // ── Introspection ──────────────────────────────────────────────────

  getRecoveryContexts(): AGUIChatRecoveryContext[] {
    return this.recoveryContexts;
  }

  getPersistedMessages(): AGUIMessage[] {
    return (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => JSON.parse(row.message as string));
  }

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT id, name FROM cf_agents_runs
      ` || []
    );
  }

  getAbortControllerCount(): number {
    return (this as unknown as { _abortRegistry: { size: number } })
      ._abortRegistry.size;
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getOnChatMessageBodies(): Array<Record<string, unknown> | undefined> {
    return this.onChatMessageBodies;
  }

  getOnChatMessageClientTools(): Array<ClientToolSchema[] | undefined> {
    return this.onChatMessageClientTools;
  }

  getScheduleCountForCallback(callback: string): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE callback = ${callback}
    `;
    return rows[0]?.count ?? 0;
  }

  getPartialText(streamId?: string): { text: string; parts: unknown[] } {
    const id = streamId ?? this._resumableStream.activeStreamId ?? undefined;
    if (!id) return { text: "", parts: [] };
    return (
      this as unknown as {
        _getPartialStreamText(id: string): { text: string; parts: unknown[] };
      }
    )._getPartialStreamText(id);
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ timeout: 10_000 });
  }

  // ── Interruption seeding + recovery triggers ───────────────────────

  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs = 0
  ): void {
    const createdAt = Date.now() - ageMs;
    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'streaming', ${createdAt})
    `;
    for (const chunk of chunks) {
      const id = `chunk-${streamId}-${chunk.index}`;
      this.sql`
        insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
        values (${id}, ${streamId}, ${chunk.body}, ${chunk.index}, ${createdAt})
      `;
    }
    (
      this as unknown as { _resumableStream: { restore(): void } }
    )._resumableStream.restore();
  }

  insertInterruptedFiber(name: string, snapshot?: unknown): void {
    const id = `fiber-${crypto.randomUUID()}`;
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  async triggerFiberRecovery(): Promise<void> {
    await (
      this as unknown as { _checkRunFibers(): Promise<void> }
    )._checkRunFibers();
  }

  async runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this._chatRecoveryContinue(data);
  }

  async runChatRecoveryRetryDirectForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this._chatRecoveryRetry(data);
  }

  /** Simulate the not-yet-deleted one-shot row `alarm()` is executing. */
  async preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this.schedule(60, "_chatRecoveryContinue", data, {
      idempotent: false
    });
  }

  async preScheduleRecoveryRetryForTest(
    data: Record<string, unknown>
  ): Promise<void> {
    await this.schedule(60, "_chatRecoveryRetry", data, { idempotent: false });
  }

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryContinue'
      ORDER BY time ASC LIMIT 1
    `;
    if (!rows[0]) return;
    await this._chatRecoveryContinue(JSON.parse(rows[0].payload));
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryRetry'
      ORDER BY time ASC LIMIT 1
    `;
    if (!rows[0]) return;
    await this._chatRecoveryRetry(JSON.parse(rows[0].payload));
  }

  // ── Incident / progress / terminal storage probes ──────────────────

  async beginIncidentForTest(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: "retry" | "continue";
    nowMs?: number;
  }): Promise<{
    incidentId: string;
    attempt: number;
    exhausted: boolean;
    reason?: string;
  }> {
    const self = this as unknown as {
      _beginChatRecoveryIncident(i: typeof input): Promise<{
        incident: { incidentId: string; attempt: number; reason?: string };
        exhausted: boolean;
      }>;
    };
    const { incident, exhausted } =
      await self._beginChatRecoveryIncident(input);
    return {
      incidentId: incident.incidentId,
      attempt: incident.attempt,
      exhausted,
      reason: incident.reason
    };
  }

  /** Push an incident's `lastAttemptAt` back past the alarm-debounce window. */
  async ageIncidentForTest(incidentId: string, ms: number): Promise<void> {
    const key = `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`;
    const inc = await this.ctx.storage.get<{ lastAttemptAt: number }>(key);
    if (!inc) return;
    inc.lastAttemptAt -= ms;
    await this.ctx.storage.put(key, inc);
  }

  async seedIncidentForTest(incident: {
    incidentId: string;
    requestId: string;
    recoveryKind: "retry" | "continue";
    attempt: number;
    maxAttempts: number;
    status: string;
    firstSeenAt: number;
    lastAttemptAt: number;
    lastProgressAt?: number;
    progress?: number;
    workBaseline?: number;
  }): Promise<void> {
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incident.incidentId)}`,
      incident
    );
  }

  async getChatRecoveryIncidentsForTest(): Promise<unknown[]> {
    const entries = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    return [...entries.values()];
  }

  async getIncidentForTest(incidentId: string): Promise<{
    attempt: number;
    status: string;
    reason?: string;
  } | null> {
    const incident = await this.ctx.storage.get<{
      attempt: number;
      status: string;
      reason?: string;
    }>(`cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`);
    return incident
      ? {
          attempt: incident.attempt,
          status: incident.status,
          reason: incident.reason
        }
      : null;
  }

  async updateIncidentForTest(
    incidentId: string,
    status: string,
    reason?: string
  ): Promise<void> {
    await (
      this as unknown as {
        _updateChatRecoveryIncident(
          id: string,
          status: string,
          reason?: string
        ): Promise<void>;
      }
    )._updateChatRecoveryIncident(incidentId, status, reason);
  }

  async bumpRecoveryProgressForTest(): Promise<void> {
    await (
      this as unknown as { _bumpChatRecoveryProgress(): Promise<void> }
    )._bumpChatRecoveryProgress();
  }

  /** Stream content, then re-persist the same orphan, reading the progress
   *  counter at each step (#1637 reconnect-immunity). */
  async probeProgressReconnectImmunityForTest(): Promise<{
    start: number;
    afterFlush: number;
    afterPersist: number;
  }> {
    const self = this as unknown as {
      _resumableStream: { start(id: string): string };
      _storeStreamChunk(streamId: string, body: string): void;
      _persistOrphanedStream(streamId: string): Promise<void>;
    };
    const read = async (): Promise<number> =>
      (await this.ctx.storage.get<number>("cf:chat-recovery:progress")) ?? 0;

    const start = await read();
    const streamId = self._resumableStream.start("req-progress-immunity");
    self._storeStreamChunk(
      streamId,
      JSON.stringify({
        type: "TEXT_MESSAGE_START",
        messageId: "m-prog",
        role: "assistant"
      })
    );
    self._storeStreamChunk(
      streamId,
      JSON.stringify({ type: "TOOL_CALL_END", toolCallId: "tc1" })
    );
    self._storeStreamChunk(
      streamId,
      JSON.stringify({
        type: "TOOL_CALL_RESULT",
        messageId: "tool-prog",
        toolCallId: "tc1",
        content: "{}"
      })
    );
    // Progress bumps are fire-and-forget; give them a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterFlush = await read();

    await self._persistOrphanedStream(streamId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterPersist = await read();

    return { start, afterFlush, afterPersist };
  }

  async getChatRecoveringForTest(): Promise<{ requestId?: string } | null> {
    return (
      (await this.ctx.storage.get<{ requestId?: string }>(
        "cf:chat:recovering"
      )) ?? null
    );
  }

  getRecoveringConnectFrameForTest(): Promise<Record<string, unknown> | null> {
    return (
      this as unknown as {
        _buildRecoveringConnectFrame(): Promise<Record<string, unknown> | null>;
      }
    )._buildRecoveringConnectFrame();
  }

  async getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return this._pendingChatTerminal();
  }

  // ── Server-side turn drivers ───────────────────────────────────────

  async saveSyntheticUserMessage(
    text: string
  ): Promise<{ requestId: string; status: string }> {
    return this.saveMessages((messages) => [
      ...messages,
      {
        id: `synth-${crypto.randomUUID()}`,
        role: "user" as const,
        content: text
      }
    ]);
  }

  async driveSuccessfulTurnForTest(): Promise<SaveMessagesResult["status"]> {
    const result = await this.saveMessages([
      { id: `u-${crypto.randomUUID()}`, role: "user", content: "hello" }
    ]);
    return result.status;
  }

  /** Configure the live-stream inactivity watchdog (#1626). */
  setChatStreamStallTimeoutForTest(ms: number): void {
    this.chatStreamStallTimeoutMs = ms;
  }

  /**
   * Drive a turn whose model stream hangs after a partial, with a short stall
   * timeout configured, so the inactivity watchdog fires and routes the turn
   * into bounded recovery. `hangTurns` controls how many turns hang (1 = only
   * the first attempt hangs, so a scheduled continuation would complete).
   * Returns the server-side turn status (`"aborted"` once the stall is routed).
   */
  async driveStallingTurnForTest(options?: {
    timeoutMs?: number;
    hangTurns?: number;
  }): Promise<SaveMessagesResult["status"]> {
    this.chatStreamStallTimeoutMs = options?.timeoutMs ?? 50;
    this._hangTurnsRemaining = options?.hangTurns ?? 1;
    const result = await this.saveMessages([
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        content: "tell me a long story"
      }
    ]);
    return result.status;
  }

  /** Invoke the protected `continueLastTurn` directly. */
  async continueLastTurnForTest(
    body?: Record<string, unknown>
  ): Promise<SaveMessagesResult> {
    return this.continueLastTurn(body);
  }

  /**
   * Queue a `continueLastTurn`, then bump the turn-queue generation before it
   * reaches the front — the superseded-epoch skip.
   */
  async continueLastTurnSupersededForTest(): Promise<SaveMessagesResult> {
    const continuing = this.continueLastTurn();
    this.resetTurnState();
    return continuing;
  }

  async driveAbortedTurnForTest(): Promise<SaveMessagesResult["status"]> {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const result = await this.saveMessages(
      [{ id: `u-${crypto.randomUUID()}`, role: "user", content: "hello" }],
      { signal: controller.signal }
    );
    return result.status;
  }

  /** Drive a server-side turn whose stream errors after `afterChunks` deltas. */
  async driveErroredTurnForTest(
    message: string,
    afterChunks = 0
  ): Promise<SaveMessagesResult["status"]> {
    this._emitStreamError = message;
    this._emitStreamErrorAfterChunks = afterChunks;
    try {
      const result = await this.saveMessages([
        { id: `u-${crypto.randomUUID()}`, role: "user", content: "hello" }
      ]);
      return result.status;
    } finally {
      this._emitStreamError = null;
      this._emitStreamErrorAfterChunks = 0;
    }
  }

  /** Persist an assistant parked on an unresolved tool call (no ToolMessage). */
  async persistPendingToolCallForTest(
    messageId: string,
    toolName: string
  ): Promise<void> {
    await this.persistMessages([
      {
        id: messageId,
        role: "assistant",
        toolCalls: [
          {
            id: `call_${messageId}`,
            type: "function",
            function: { name: toolName, arguments: "{}" }
          }
        ]
      }
    ]);
  }

  async addAssistantMessageForTest(id: string): Promise<void> {
    await this.persistMessages([
      ...this.messages,
      { id, role: "assistant", content: "progress" }
    ]);
  }

  // ── Agent-tool child rebind probes (parity with the legacy suite) ──

  /**
   * Seed an in-flight (running) `cf_ai_chat_agent_tool_runs` row, as if this
   * facet were running as an agent-tool child whose turn was interrupted
   * before completing. Used to assert the recovery continuation re-binds the
   * row's `request_id` so the parent's re-attach tail keeps attributing
   * frames.
   */
  async seedAgentToolChildRunForTest(
    runId: string,
    requestId: string,
    startedAt: number = Date.now()
  ): Promise<void> {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${startedAt})
    `;
  }

  /** Seed a SETTLED (terminal) child-run row — the rebind must not touch it. */
  async seedSettledAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at, completed_at)
      values (${runId}, ${requestId}, 'completed', '{}', ${now}, ${now})
    `;
  }

  /** Directly invoke the rebind helper (bypassing the full recovery flow). */
  async rebindAgentToolChildRunRequestIdForTest(
    requestId: string
  ): Promise<void> {
    (
      this as unknown as {
        _rebindAgentToolChildRunRequestId(requestId: string): void;
      }
    )._rebindAgentToolChildRunRequestId(requestId);
  }

  /** The `request_id` currently bound to an agent-tool child run row. */
  async getAgentToolChildRunRequestIdForTest(
    runId: string
  ): Promise<string | null> {
    const rows = this.sql<{ request_id: string | null }>`
      select request_id from cf_ai_chat_agent_tool_runs where run_id = ${runId}
    `;
    return rows[0]?.request_id ?? null;
  }

  /** Resolve which agent-tool run a request id is attributed to. */
  async resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null> {
    return (
      this as unknown as {
        _agentToolRunForRequest(requestId: string): string | null;
      }
    )._agentToolRunForRequest(requestId);
  }

  /** Simulate a parent re-attach that forwards `chunks` of a child's stream by
   *  driving the real `_forwardAgentToolStream` over a synthetic child stream.
   *  The in-memory throttle is reset first so this models a fresh post-restart
   *  isolate. Returns the durable recovery-progress counter before/after so a
   *  test can assert forwarding child output credits the PARENT's progress
   *  marker (N9) — and that a SILENT child (chunks = 0) does NOT. */
  async forwardChildStreamProgressForTest(chunks: number): Promise<{
    start: number;
    after: number;
  }> {
    const self = this as unknown as {
      _forwardAgentToolStream(
        stream: ReadableStream<{ body: string }>,
        parentToolCallId: string | undefined,
        runId: string,
        sequence: number
      ): Promise<unknown>;
      _agentToolStreamProgress: { _lastBumpAt: number };
    };
    self._agentToolStreamProgress._lastBumpAt = 0;
    const read = async (): Promise<number> =>
      (await this.ctx.storage.get<number>("cf:chat-recovery:progress")) ?? 0;
    const start = await read();
    const bodies = Array.from({ length: chunks }, (_, i) => ({
      body: `chunk-${i}`
    }));
    const stream = new ReadableStream<{ body: string }>({
      start(controller) {
        for (const b of bodies) controller.enqueue(b);
        controller.close();
      }
    });
    await self._forwardAgentToolStream(stream, undefined, "n9-probe-run", 1);
    const after = await read();
    return { start, after };
  }
}

// ============================================================================
// Agent-tool child adapter fixtures — port of the legacy
// `AIChatAgentToolChild` / `AIChatAgentToolParent` pair on the AG-UI shape.
// ============================================================================

type AgentToolInput = {
  prompt: string;
  delayMs?: number;
  chunkDelayMs?: number;
  structured?: boolean;
  streamError?: string;
};

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** SSE body that opens a run, optionally waits, then throws `message`. */
function delayedErrorSSEResponse(message: string, delayMs: number): Response {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t1", runId: "r1" })}\n\n`
          )
        );
        return;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      throw new Error(message);
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export class AguiAgentToolChild extends AGUIChatAgent<Env> {
  protected override formatAgentToolInput(
    input: unknown,
    request: { runId: string }
  ): AGUIMessage {
    return {
      id: `tool-input-${request.runId}`,
      role: "user",
      content: (input as AgentToolInput).prompt
    };
  }

  protected override getAgentToolOutput(
    request: { runId: string; input: unknown },
    messagesAfterStart: readonly AGUIMessage[]
  ): unknown {
    const input = request.input as AgentToolInput;
    if (input.structured) {
      return {
        handledPrompt: input.prompt,
        messageCount: messagesAfterStart.length
      };
    }
    return super.getAgentToolOutput(request, messagesAfterStart);
  }

  protected override getAgentToolSummary(
    request: { runId: string; input: unknown },
    output: unknown,
    messagesAfterStart: readonly AGUIMessage[]
  ): string {
    const input = request.input as AgentToolInput;
    if (input.structured) {
      return `structured:${input.prompt}`;
    }
    return super.getAgentToolSummary(request, output, messagesAfterStart);
  }

  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ) {
    const input = options?.body?.agentToolInput as AgentToolInput | undefined;
    const lastUser = [...this.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt =
      lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
    const bodyText = `AGUI child handled: ${prompt}`;

    await delayWithAbort(Number(input?.delayMs ?? 0), options?.abortSignal);
    if (input?.streamError) {
      return delayedErrorSSEResponse(
        input.streamError,
        Number(input?.chunkDelayMs ?? 0)
      );
    }

    const messageId = `assistant-${options?.requestId ?? Date.now()}`;
    return sseResponse(
      [
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: bodyText.slice(0, 20)
        },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: bodyText.slice(20) },
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
      ],
      {
        delayMs: Number(input?.chunkDelayMs ?? 0),
        signal: options?.abortSignal
      }
    );
  }

  listMessagesForTest(): AGUIMessage[] {
    return this.messages;
  }

  private _attachRaceInjection: { runId: string; body: string } | null = null;

  /**
   * #1589: arm a one-shot chunk injection that fires from inside
   * `getAgentToolChunks` — AFTER the stored snapshot is read but (in the buggy
   * ordering) BEFORE `tailAgentToolRun` attaches its live forwarder.
   */
  armAttachRaceInjectionForTest(runId: string, body: string): void {
    this._attachRaceInjection = { runId, body };
  }

  private _progressInjection: {
    runId: string;
    progressBody: string;
    milestoneBody: string;
  } | null = null;

  /**
   * Arm a one-shot injection of NON-stored progress + milestone frames (the
   * `reportProgress` wire shape) that fire from inside `getAgentToolChunks` —
   * broadcast-only frames with no stored chunk_index, so they rely on the
   * in-memory live sequence counter to be forwarded.
   */
  armProgressInjectionForTest(
    runId: string,
    progressBody: string,
    milestoneBody: string
  ): void {
    this._progressInjection = { runId, progressBody, milestoneBody };
  }

  /**
   * Bounded-poll until the live child turn has registered its request id and
   * resumable stream id, so a test injection attributes exactly like a real
   * streamed chunk.
   */
  private async _waitForLiveTurnForTest(
    runId: string
  ): Promise<{ requestId: string; streamId: string } | null> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = this["_getAgentToolRunRow"](runId);
      const requestId = row?.request_id ?? undefined;
      if (requestId) {
        const streamId = this["_getAgentToolStreamId"](requestId);
        if (streamId) return { requestId, streamId };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return null;
  }

  override async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    const chunks = await super.getAgentToolChunks(runId, options);

    const race = this._attachRaceInjection;
    if (race && race.runId === runId) {
      this._attachRaceInjection = null;
      // Land a STORED + broadcast chunk in the drain↔register window (#1589).
      const live = await this._waitForLiveTurnForTest(runId);
      if (live) {
        await this["_storeStreamChunk"](live.streamId, race.body);
        this["_broadcastChatMessage"]({
          body: race.body,
          done: false,
          id: live.requestId,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
        });
      }
    }

    const progress = this._progressInjection;
    if (progress && progress.runId === runId) {
      this._progressInjection = null;
      // Land NON-stored progress + milestone frames in the same window; they
      // depend on the in-memory live sequence to be forwarded.
      const live = await this._waitForLiveTurnForTest(runId);
      if (live) {
        this["_broadcastChatMessage"]({
          body: progress.progressBody,
          done: false,
          id: live.requestId,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
        });
        this["_broadcastChatMessage"]({
          body: progress.milestoneBody,
          done: false,
          id: live.requestId,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
        });
      }
    }

    return chunks;
  }

  /**
   * Reproduce the post-restart cold-counter realign: seed a RUNNING run with
   * a stored backlog 0..N, wipe the in-memory live sequence (as a child DO
   * restart would), then tail it directly. After the drain the live counter
   * must realign to N+1 so a NEW broadcast forwards at N+1 instead of
   * restarting at 0 and being dropped by the high-water dedupe.
   */
  async coldCounterReattachForwardsForTest(): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }> {
    const runId = "cold-realign-run";
    const requestId = "cold-realign-req";
    const streamId = this["_resumableStream"].start(requestId);
    const backlog = [
      JSON.stringify({
        type: "TEXT_MESSAGE_START",
        messageId: "m-cold",
        role: "assistant"
      }),
      JSON.stringify({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m-cold",
        delta: "a"
      }),
      JSON.stringify({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m-cold",
        delta: "b"
      })
    ];
    for (const body of backlog) {
      await this["_storeStreamChunk"](streamId, body);
    }
    this["_resumableStream"].flushBuffer();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // Simulate a restart / hibernation wake: only the durable backlog survives.
    this["_agentToolLiveSequences"].delete(runId);

    const stream = (await this.tailAgentToolRun(runId, {
      afterSequence: -1
    })) as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const streamDecoder = new TextDecoder();
    let buffer = "";
    const readLine = async (timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line) return line;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const next = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), remaining)
          )
        ]);
        if (next === "timeout" || next.done) return null;
        buffer += streamDecoder.decode(next.value, { stream: true });
      }
    };

    const drained: number[] = [];
    for (let i = 0; i < backlog.length; i++) {
      const line = await readLine(2000);
      if (line === null) break;
      drained.push((JSON.parse(line) as { sequence: number }).sequence);
    }

    // Wait (bounded) for the post-drain realign to run.
    const deadline = Date.now() + 2000;
    while (
      this["_agentToolLiveSequences"].get(runId) !== backlog.length &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const liveSequenceAfterDrain = this["_agentToolLiveSequences"].get(runId);

    // The recovered turn now broadcasts a NEW chunk (not in the backlog).
    const postBody = JSON.stringify({
      type: "TOOL_CALL_RESULT",
      messageId: "tool-post",
      toolCallId: "post-restart",
      content: "ok"
    });
    this["_broadcastChatMessage"]({
      body: postBody,
      done: false,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    });

    const postLine = await readLine(2000);
    const postRestart =
      postLine === null
        ? null
        : (JSON.parse(postLine) as { sequence: number; body: string });
    await reader.cancel();
    return { drained, liveSequenceAfterDrain, postRestart };
  }

  /**
   * Reproduce the cancelled-tailer-starves-siblings bug: two parents tail the
   * SAME run; tailer A's consumer cancels its reader; a subsequent broadcast
   * must still reach sibling tailer B.
   */
  async cancelledTailerStarvationForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
  }> {
    const runId = "starve-run";
    const requestId = "starve-req";
    const streamId = this["_resumableStream"].start(requestId);
    await this["_storeStreamChunk"](
      streamId,
      JSON.stringify({
        type: "TEXT_MESSAGE_START",
        messageId: "m-starve",
        role: "assistant"
      })
    );
    this["_resumableStream"].flushBuffer();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // One stored chunk (index 0) ⇒ live counter sits at 1, in lockstep.
    this["_agentToolLiveSequences"].set(runId, 1);

    // afterSequence: 0 ⇒ the drain skips the stored backlog, so both tailers
    // go live immediately. A is registered first.
    const a = (await this.tailAgentToolRun(runId, {
      afterSequence: 0
    })) as unknown as ReadableStream<Uint8Array>;
    const b = (await this.tailAgentToolRun(runId, {
      afterSequence: 0
    })) as unknown as ReadableStream<Uint8Array>;
    const readerA = a.getReader();
    const readerB = b.getReader();

    // Wait until both forwarders are registered and live (drain complete).
    const regDeadline = Date.now() + 2000;
    while (
      (this["_agentToolForwarders"].get(runId)?.size ?? 0) < 2 &&
      Date.now() < regDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A's consumer detaches.
    await readerA.cancel();

    // A new chunk is broadcast for the run.
    const body = JSON.stringify({
      type: "TOOL_CALL_RESULT",
      messageId: "tool-sibling",
      toolCallId: "sibling",
      content: "ok"
    });
    this["_broadcastChatMessage"]({
      body,
      done: false,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    });

    // B must still receive it.
    const streamDecoder = new TextDecoder();
    let buf = "";
    let siblingBodyAfterCancel: string | null = null;
    const deadline = Date.now() + 2000;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) {
          siblingBodyAfterCancel = (JSON.parse(line) as { body: string }).body;
          break;
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        readerB.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buf += streamDecoder.decode(next.value, { stream: true });
    }
    await readerB.cancel();
    return { siblingBodyAfterCancel };
  }

  /**
   * #1575: broadcast a chat error frame whose request id belongs to no
   * agent-tool run, simulating an unrelated turn failing on this agent while
   * a run is being tailed.
   */
  broadcastUnrelatedErrorForTest(requestId: string): void {
    this.broadcast(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: requestId,
        error: true,
        done: false,
        body: "unrelated turn failure"
      })
    );
  }

  /** #1575: live request-id → run-id cache entries (leak probe). */
  agentToolRunsByRequestIdSizeForTest(): number {
    return this["_agentToolRunsByRequestId"].size;
  }

  /**
   * #1575: simulate a DO restart mid-run — the in-memory request-id map is
   * empty, but the run row persisted its `request_id` at turn start.
   * `_agentToolRunForRequest` must still attribute via the SQL fallback.
   */
  resolveAgentToolRunAfterRestartForTest(
    runId: string,
    requestId: string
  ): { running: string | null; unknown: string | null } {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // Cold in-memory map, as after a restart.
    this["_agentToolRunsByRequestId"].clear();
    return {
      running: this["_agentToolRunForRequest"](requestId),
      unknown: this["_agentToolRunForRequest"]("no-such-request")
    };
  }

  private _readChildRunStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_ai_chat_agent_tool_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.status ?? null;
  }

  /**
   * P1 (#1630): a child facet evicted mid agent-tool run strands its run row
   * `running`. Its own durable chat-recovery settles the turn OUTSIDE
   * `startAgentToolRun`'s finalizer, so the `finally` of BOTH recovery
   * entrypoints must reconcile the stranded row. Drives each entrypoint into
   * a benign no-op path that still runs its `finally`, and asserts the row
   * finalized: `completed` when a recovered assistant turn exists, else
   * `error`.
   */
  async reconcileStaleChildRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }> {
    if (withAssistantTurn) {
      // Persist a settled assistant turn directly (no streaming) so the
      // reconcile recognises a recovered turn.
      await this.persistMessages([
        {
          id: `seed-user-${crypto.randomUUID()}`,
          role: "user",
          content: "seed prompt"
        },
        {
          id: `seed-assistant-${crypto.randomUUID()}`,
          role: "assistant",
          content: "recovered answer"
        }
      ]);
    }
    const runId = crypto.randomUUID();
    // Strand a `running` row with no live abort controller — the
    // post-eviction shape the reconcile repairs. A valid `input_json` is
    // required because the completed branch re-derives output.
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, status, input_json, started_at)
      VALUES (${runId}, 'running', ${JSON.stringify({ prompt: "recovered" })}, ${Date.now()})
    `;
    const before = this._readChildRunStatusForTest(runId);
    if (path === "continue") {
      // A non-leaf `targetAssistantId` → benign "conversation_changed" skip
      // that still reaches the `finally`.
      await this._chatRecoveryContinue({
        targetAssistantId: "no-such-leaf"
      });
    } else {
      // A non-user leaf (or empty transcript) → benign
      // "no_unanswered_user_message" skip that still reaches the `finally`.
      await this._chatRecoveryRetry({});
    }
    return { before, after: this._readChildRunStatusForTest(runId) };
  }

  /**
   * P4 (#1630): `cancelAgentToolRun` must abort not just the original
   * in-isolate run but any in-flight chat-recovery turn driving this child
   * facet — which registers a request controller in the `AbortRegistry`
   * outside `startAgentToolRun` — so a torn-down child stops grinding.
   */
  async cancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }> {
    const runId = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, status, started_at)
      VALUES (${runId}, 'running', ${Date.now()})
    `;
    const signal = (
      this as unknown as {
        _abortRegistry: { getSignal(id: string): AbortSignal | undefined };
      }
    )._abortRegistry.getSignal("recovered-request");
    const abortedBefore = signal?.aborted ?? false;
    await this.cancelAgentToolRun(runId, "parent gave up re-attaching");
    return {
      abortedBefore,
      abortedAfter: signal?.aborted ?? false,
      childStatus: this._readChildRunStatusForTest(runId)
    };
  }
}

type AgentToolFinishForTest = {
  run: AgentToolRunInfo;
  result: AgentToolLifecycleResult;
};

export class AguiAgentToolParent extends Agent<Env> {
  private events: AgentToolEventMessage[] = [];
  private finishes: AgentToolFinishForTest[] = [];

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as AgentToolEventMessage;
        if (parsed.type === "agent-tool-event") {
          this.events.push(parsed);
        }
      } catch {
        // Ignore non-agent-tool frames.
      }
    }
    super.broadcast(msg, without);
  }

  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.finishes.push({ run, result });
  }

  async runChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    return this.runAgentTool(AguiAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
  }

  /** #1589: run a child that injects a chunk into the tail attach window. */
  async runChildWithAttachRaceForTest(
    input: AgentToolInput,
    raceBody: string,
    runId = crypto.randomUUID()
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(AguiAgentToolChild, runId);
    await child.armAttachRaceInjectionForTest(runId, raceBody);
    const result = await this.runAgentTool(AguiAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
    return { result, events: this.events };
  }

  /** Run a child that injects NON-stored progress + milestone frames. */
  async runChildWithProgressInjectionForTest(
    input: AgentToolInput,
    progressBody: string,
    milestoneBody: string,
    runId = crypto.randomUUID()
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(AguiAgentToolChild, runId);
    await child.armProgressInjectionForTest(runId, progressBody, milestoneBody);
    const result = await this.runAgentTool(AguiAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
    return { result, events: this.events };
  }

  /** Drive the child's post-restart cold-counter realign probe. */
  async coldCounterChildReattachForTest(): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }> {
    const child = await this.subAgent(AguiAgentToolChild, crypto.randomUUID());
    return child.coldCounterReattachForwardsForTest();
  }

  /** Drive the cancelled-tailer-starves-siblings probe. */
  async cancelledTailerStarvationChildForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
  }> {
    const child = await this.subAgent(AguiAgentToolChild, crypto.randomUUID());
    return child.cancelledTailerStarvationForTest();
  }

  async runChildWithDelayedAbort(
    input: AgentToolInput,
    abortAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    const controller = new AbortController();
    const timeout =
      abortAfterMs > 0
        ? setTimeout(() => controller.abort("test abort"), abortAfterMs)
        : undefined;
    if (abortAfterMs <= 0) controller.abort("test abort");
    try {
      return await this.runAgentTool(AguiAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input,
        signal: controller.signal
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getEventsForTest(): AgentToolEventMessage[] {
    return this.events;
  }

  getFinishesForTest(): AgentToolFinishForTest[] {
    return this.finishes;
  }

  /**
   * #1575: run a child while injecting a chat error frame from an UNRELATED
   * turn into the child's broadcast stream mid-run. The run's terminal status
   * must not be contaminated by it.
   */
  async runChildWithInjectedUnrelatedError(
    input: AgentToolInput,
    injectAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(AguiAgentToolChild, runId);
    const timer = setTimeout(() => {
      void child.broadcastUnrelatedErrorForTest(`unrelated-turn-${runId}`);
    }, injectAfterMs);
    try {
      return await this.runAgentTool(AguiAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input,
        inputPreview: input.prompt
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** #1575: the child's live request-id cache size after a run. */
  async childAgentToolRunsMapSizeForTest(runId: string): Promise<number> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    return child.agentToolRunsByRequestIdSizeForTest();
  }

  /** #1575: post-restart attribution via the child's SQL fallback. */
  async childResolveAfterRestartForTest(
    runId: string,
    requestId: string
  ): Promise<{ running: string | null; unknown: string | null }> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    return child.resolveAgentToolRunAfterRestartForTest(runId, requestId);
  }

  /**
   * #1575: start a child run directly — no tailer is ever attached — and wait
   * for its terminal inspection. Terminal status must come from the child
   * turn's own result, not from tailing side effects.
   */
  async startChildWithoutTailForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    await child.startAgentToolRun(input, { runId });
    return this.waitForTerminalInspectionForTest(child, runId);
  }

  private insertRecoverableParentRunForTest(
    runId: string,
    agentType: string,
    inputPreview: string,
    startedAt: number,
    status: "starting" | "running" = "running"
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at
      ) VALUES (
        ${runId}, 'test-tool-call', ${agentType},
        ${JSON.stringify(inputPreview)}, 1, ${status},
        ${JSON.stringify({ name: "test child" })}, 0, ${startedAt}
      )
    `;
  }

  private async waitForTerminalInspectionForTest(
    child: {
      inspectAgentToolRun(
        runId: string
      ): Promise<AgentToolRunInspection | null>;
    },
    runId: string
  ): Promise<AgentToolRunInspection> {
    let inspection = await child.inspectAgentToolRun(runId);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        inspection &&
        inspection.status !== "running" &&
        inspection.status !== "starting"
      ) {
        return inspection;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      inspection = await child.inspectAgentToolRun(runId);
    }
    throw new Error("Timed out waiting for child agent-tool completion");
  }

  private async prepareCompletedChildForRecoveryTest(
    input: AgentToolInput,
    runId: string
  ): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    const started = await child.startAgentToolRun(input, { runId });
    this.insertRecoverableParentRunForTest(
      runId,
      "AguiAgentToolChild",
      input.prompt,
      started.startedAt
    );
    return this.waitForTerminalInspectionForTest(child, runId);
  }

  private async reconcileAgentToolRunsForTest(options?: {
    childInspectionTimeoutMs?: number;
    reattachTimeoutMs?: number;
  }): Promise<void> {
    await (
      this as unknown as {
        _reconcileAgentToolRuns(options?: {
          childInspectionTimeoutMs?: number;
          reattachTimeoutMs?: number;
        }): Promise<unknown>;
      }
    )._reconcileAgentToolRuns(options);
  }

  async reconcileCompletedChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    inspection: AgentToolRunInspection;
  }> {
    const inspection = await this.prepareCompletedChildForRecoveryTest(
      input,
      runId
    );
    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();

    return { events: this.events, finishes: this.finishes, inspection };
  }

  /**
   * A still-running child that reaches terminal *during* the parent's bounded
   * re-attach window: reconciliation should tail it to terminal and finalize
   * the parent row `completed` instead of abandoning it `interrupted` (#1630).
   */
  async reconcileRunningChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    // Short delay: still running when reconciliation starts, then terminal a
    // moment later — within the generous re-attach budget.
    const started = await child.startAgentToolRun(
      { ...input, delayMs: input.delayMs ?? 200 },
      { runId }
    );
    this.insertRecoverableParentRunForTest(
      runId,
      "AguiAgentToolChild",
      input.prompt,
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest({ reattachTimeoutMs: 30_000 });

    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  /**
   * A tail-able child whose turn never reaches terminal: reconciliation must
   * re-attach, tail until the bounded re-attach budget is spent, then seal the
   * parent row `interrupted` (#1630).
   */
  async reattachStuckTailableChildForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    const started = await child.startAgentToolRun(
      { prompt: "stuck tailable child", delayMs: 60_000 },
      { runId }
    );
    this.insertRecoverableParentRunForTest(
      runId,
      "AguiAgentToolChild",
      "stuck tailable child",
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    const startedAt = Date.now();
    try {
      await this.reconcileAgentToolRunsForTest({ reattachTimeoutMs: 200 });
    } finally {
      await child.cancelAgentToolRun(runId, "test cleanup");
    }
    return {
      events: this.events,
      finishes: this.finishes,
      elapsedMs: Date.now() - startedAt,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  getParentAgentToolStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_agent_tool_runs WHERE run_id = ${runId} LIMIT 1
    `;
    return rows[0]?.status ?? null;
  }

  async inspectChild(runId: string): Promise<AgentToolRunInspection | null> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    return child.inspectAgentToolRun(runId);
  }

  async getChildChunks(
    runId: string,
    afterSequence?: number
  ): Promise<AgentToolStoredChunk[]> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    return child.getAgentToolChunks(runId, { afterSequence });
  }

  async getChildMessages(runId: string): Promise<AGUIMessage[]> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    return child.listMessagesForTest();
  }

  async startAndCancelChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection | null> {
    const child = await this.subAgent(AguiAgentToolChild, runId);
    await child.startAgentToolRun(input, { runId });
    await child.cancelAgentToolRun(runId, "test abort");
    return child.inspectAgentToolRun(runId);
  }

  // P1/P4 (#1630): the child-side seams must run on the child AS A FACET of
  // this parent, so route through the parent.
  async childReconcileStaleRunViaRecoveryForTest(
    path: "continue" | "retry",
    withAssistantTurn: boolean
  ): Promise<{ before: string | null; after: string | null }> {
    const child = await this.subAgent(AguiAgentToolChild, crypto.randomUUID());
    return child.reconcileStaleChildRunViaRecoveryForTest(
      path,
      withAssistantTurn
    );
  }

  async childCancelAgentToolRunAbortsRecoveryForTest(): Promise<{
    abortedBefore: boolean;
    abortedAfter: boolean;
    childStatus: string | null;
  }> {
    const child = await this.subAgent(AguiAgentToolChild, crypto.randomUUID());
    return child.cancelAgentToolRunAbortsRecoveryForTest();
  }

  async runChildWithTrackedAbortListener(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    result: RunAgentToolResult;
    abortListenerAdded: number;
    abortListenerRemoved: number;
  }> {
    const controller = new AbortController();
    const signal = controller.signal;

    let abortListenerAdded = 0;
    let abortListenerRemoved = 0;
    type AddListener = typeof signal.addEventListener;
    type RemoveListener = typeof signal.removeEventListener;
    const originalAdd = signal.addEventListener.bind(signal) as AddListener;
    const originalRemove = signal.removeEventListener.bind(
      signal
    ) as RemoveListener;

    signal.addEventListener = ((
      type: Parameters<AddListener>[0],
      listener: Parameters<AddListener>[1],
      options?: Parameters<AddListener>[2]
    ) => {
      if (type === "abort") abortListenerAdded++;
      (originalAdd as (...args: unknown[]) => void)(type, listener, options);
    }) as AddListener;
    signal.removeEventListener = ((
      type: Parameters<RemoveListener>[0],
      listener: Parameters<RemoveListener>[1],
      options?: Parameters<RemoveListener>[2]
    ) => {
      if (type === "abort") abortListenerRemoved++;
      (originalRemove as (...args: unknown[]) => void)(type, listener, options);
    }) as RemoveListener;

    const result = await this.runAgentTool(AguiAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      signal
    });

    return { result, abortListenerAdded, abortListenerRemoved };
  }
}

/**
 * Detached notify / milestone fixture — drives the `_cfDetachedNotifyFinish`
 * and `_deliverDetachedMilestone` hooks directly (the warm-path / backbone
 * delivery is exercised by the base-Agent suites).
 */
export class DetachedNotifyAguiAgent extends AGUIChatAgent<Env> {
  private _chatMessageCallCount = 0;

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    this._chatMessageCallCount++;
    return sseResponse(
      textRunEvents(`assistant-react-${this._chatMessageCallCount}`, [
        "Understood."
      ])
    );
  }

  getChatMessageCallCountForTest(): number {
    return this._chatMessageCallCount;
  }

  getMessagesForTest(): AGUIMessage[] {
    return this.messages;
  }

  /** Drive the `detached: { notify }` completion hook directly, `times` times
   *  to prove the deterministic message id collapses re-delivery to one. */
  async notifyDetachedFinishForTest(options?: {
    runId?: string;
    notifySource?: string;
    status?: AgentToolLifecycleResult["status"];
    times?: number;
  }): Promise<void> {
    const runId = options?.runId ?? "detached-notify-run";
    const status = options?.status ?? "completed";
    for (let i = 0; i < (options?.times ?? 1); i++) {
      await this._cfDetachedNotifyFinish(
        {
          runId,
          agentType: "Researcher",
          status,
          inputPreview: "detached topic",
          displayOrder: 0,
          startedAt: Date.now(),
          ...(options?.notifySource !== undefined && {
            notifySource: options.notifySource
          })
        },
        { status, summary: "detached summary" }
      );
    }
  }

  /** Drive the `detached: { onMilestones }` hook directly, `times` times. */
  async notifyDetachedMilestoneForTest(options?: {
    runId?: string;
    name?: string;
    notifySource?: string;
    times?: number;
    mode?: "react" | "narrate";
  }): Promise<void> {
    const runId = options?.runId ?? "detached-milestone-run";
    const name = options?.name ?? "sources-gathered";
    const mode = options?.mode ?? "narrate";
    const internals = this as unknown as {
      _deliverDetachedMilestone(
        run: AgentToolRunInfo,
        milestone: {
          name: string;
          sequence: number;
          at: number;
          data?: unknown;
        },
        mode: "react" | "narrate"
      ): Promise<void>;
    };
    for (let i = 0; i < (options?.times ?? 2); i++) {
      await internals._deliverDetachedMilestone(
        {
          runId,
          agentType: "Researcher",
          status: "running",
          inputPreview: "detached topic",
          displayOrder: 0,
          startedAt: Date.now(),
          ...(options?.notifySource !== undefined && {
            notifySource: options.notifySource
          })
        },
        { name, sequence: 0, at: Date.now(), data: { sources: 2 } },
        mode
      );
    }
  }
}

export type Env = {
  EchoAguiAgent: DurableObjectNamespace<EchoAguiAgent>;
  ToolCallAguiAgent: DurableObjectNamespace<ToolCallAguiAgent>;
  SlowAguiAgent: DurableObjectNamespace<SlowAguiAgent>;
  PlaintextAguiAgent: DurableObjectNamespace<PlaintextAguiAgent>;
  PreThrowAguiAgent: DurableObjectNamespace<PreThrowAguiAgent>;
  ErrorStreamAguiAgent: DurableObjectNamespace<ErrorStreamAguiAgent>;
  ApprovalAguiAgent: DurableObjectNamespace<ApprovalAguiAgent>;
  MaxPersistedAguiAgent: DurableObjectNamespace<MaxPersistedAguiAgent>;
  SaveMessagesAguiAgent: DurableObjectNamespace<SaveMessagesAguiAgent>;
  RecoveryAguiAgent: DurableObjectNamespace<RecoveryAguiAgent>;
  PreStreamAguiAgent: DurableObjectNamespace<PreStreamAguiAgent>;
  PreStreamLatestAguiAgent: DurableObjectNamespace<PreStreamLatestAguiAgent>;
  AutoContinueAguiAgent: DurableObjectNamespace<AutoContinueAguiAgent>;
  AguiAgentToolChild: DurableObjectNamespace<AguiAgentToolChild>;
  AguiAgentToolParent: DurableObjectNamespace<AguiAgentToolParent>;
  DetachedNotifyAguiAgent: DurableObjectNamespace<DetachedNotifyAguiAgent>;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
