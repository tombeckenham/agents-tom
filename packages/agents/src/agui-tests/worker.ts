/**
 * Test worker for the `AGUIChatAgent` server suite.
 *
 * Each fixture agent returns a deterministic AG-UI SSE `Response` from
 * `onChatMessage` so tests can assert on the exact wire frames, persistence
 * rows, and lifecycle side-effects. Fixtures expose a `/probe` route via
 * `onRequest` where a test needs to observe captured server state.
 */

import { routeAgentRequest } from "../index";
import {
  AGUIChatAgent,
  type AGUIChatRecoveryContext,
  type AGUIMessage,
  type ClientToolSchema,
  type OnChatMessageOptions
} from "../agui-chat-agent";
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
  ) {
    if (options?.requestId) this._startedRequestIds.push(options.requestId);
    const delayMs = (options?.body as { responseDelayMs?: number } | undefined)
      ?.responseDelayMs;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
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

    return sseResponse(
      textRunEvents(`assistant-${this.onChatMessageCallCount}-${Date.now()}`, [
        "Continued response."
      ])
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
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
