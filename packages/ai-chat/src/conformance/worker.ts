/**
 * Fixture agents for the differential conformance harness.
 *
 * Each agent streams a fully scripted, deterministic AI SDK chunk sequence
 * from `onChatMessage` so the harness can record byte-stable traces of the
 * LEGACY `AIChatAgent` (wire frames, persisted rows, client-visible list).
 * Adapted from the fixtures in `src/tests/worker.ts`.
 */

import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "../";
import { AIChatAgent as ProjectedAIChatAgent } from "../agent";
import type {
  UIMessage as ChatMessage,
  GenerateTextOnFinishCallback,
  ToolSet
} from "ai";
import { routeAgentRequest } from "agents";

type ToolPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

function sse(chunks: ReadonlyArray<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

function textRun(id: string, deltas: string[]): Record<string, unknown>[] {
  return [
    { type: "start" },
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta", id, delta })),
    { type: "text-end", id },
    { type: "finish" }
  ];
}

/** Shared RPC surface the harness uses to settle and inspect a fixture DO. */
class ConformanceBase extends AIChatAgent<Env> {
  protected _chatMessageCalls = 0;
  private _hookCalls: Array<Record<string, unknown>> = [];

  /** Wait for the turn queue + interaction applies to drain. */
  async stable(timeout = 8000): Promise<boolean> {
    return this.waitUntilStable({ timeout });
  }

  /** How many times `onChatMessage` ran — a barrier for frameless turns. */
  calls(): number {
    return this._chatMessageCalls;
  }

  /** Recorded lifecycle-hook invocations, in order — part of the trace. */
  hooks(): Array<Record<string, unknown>> {
    return this._hookCalls;
  }

  /** Turn-queue depth — a barrier for queued-overlap scenarios. */
  queueDepth(): number {
    return (
      this as unknown as { _turnQueue: { queuedCount(): number } }
    )._turnQueue.queuedCount();
  }

  protected onChatResponse(result: ChatResponseResult): void {
    this._hookCalls.push({
      hook: "onChatResponse",
      requestId: result.requestId,
      status: result.status,
      continuation: result.continuation,
      ...(result.error !== undefined && { error: result.error }),
      messageId: result.message.id
    });
  }

  // Record (and swallow) server errors so the pre-throw scenario's expected
  // error lands in the trace instead of an uncaught-exception banner.
  onError(connectionOrError: unknown, error?: unknown): void {
    this._hookCalls.push({
      hook: "onError",
      error: String(error ?? connectionOrError)
    });
  }

  /** Overlapping-submit count — the concurrency-test barrier (see src/tests). */
  overlapping(): number {
    return (
      this as unknown as {
        _submitConcurrency: { overlappingSubmitCount: number };
      }
    )._submitConcurrency.overlappingSubmitCount;
  }

  /** Raw persisted rows, in table order (rowid tiebreak for same-second ties). */
  rows(): Array<{ id: string; message: unknown; created_at: string }> {
    return (
      this.sql<{ id: string; message: string; created_at: string }>`
        select id, message, created_at
        from cf_ai_chat_agent_messages order by created_at, rowid
      ` || []
    ).map((row) => ({
      id: row.id,
      message: JSON.parse(row.message),
      created_at: row.created_at
    }));
  }

  /** Append a user message programmatically, triggering a server-side turn. */
  async programmaticTurn(text: string) {
    return this.saveMessages([
      ...this.messages,
      {
        id: "prog-user-1",
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  protected findToolPart(toolCallId: string): ToolPart | undefined {
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    return lastAssistant?.parts.find(
      (part): part is ToolPart =>
        "toolCallId" in part && part.toolCallId === toolCallId
    );
  }
}

/**
 * Body-driven fixture: `body.scenario` picks the scripted chunk sequence.
 * The body is stored by the framework and re-supplied on continuations, so
 * continuation turns branch on `options.continuation` + persisted tool state.
 */
export class ScriptedAgent extends ConformanceBase {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    this._chatMessageCalls++;
    const scenario =
      (options?.body as { scenario?: string } | undefined)?.scenario ??
      "plain-text";

    switch (scenario) {
      case "pre-throw":
        throw new Error("boom before response");

      case "plaintext":
        return new Response("plain reply", {
          headers: { "Content-Type": "text/plain" }
        });

      // Truly no response — exercises the "No response was generated" branch.
      case "no-response":
        return undefined;

      // A Response with an empty body — a different legacy branch.
      case "empty-response-body":
        return new Response(null);

      case "reasoning":
        return sse([
          { type: "start" },
          { type: "reasoning-start", id: "r-1" },
          { type: "reasoning-delta", id: "r-1", delta: "thinking about it" },
          { type: "reasoning-end", id: "r-1" },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "reasoned answer" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      case "tool-single":
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-start",
            toolCallId: "call-weather-1",
            toolName: "getWeather"
          },
          {
            type: "tool-input-delta",
            toolCallId: "call-weather-1",
            inputTextDelta: '{"city":"Sydney"}'
          },
          {
            type: "tool-input-available",
            toolCallId: "call-weather-1",
            toolName: "getWeather",
            input: { city: "Sydney" }
          },
          {
            type: "tool-output-available",
            toolCallId: "call-weather-1",
            output: { temp: 21 }
          },
          { type: "finish-step" },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "It is 21C" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      case "tool-parallel":
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-start",
            toolCallId: "call-a",
            toolName: "getWeather"
          },
          {
            type: "tool-input-start",
            toolCallId: "call-b",
            toolName: "getTime"
          },
          {
            type: "tool-input-available",
            toolCallId: "call-a",
            toolName: "getWeather",
            input: { city: "Sydney" }
          },
          {
            type: "tool-input-available",
            toolCallId: "call-b",
            toolName: "getTime",
            input: { zone: "AEST" }
          },
          {
            type: "tool-output-available",
            toolCallId: "call-a",
            output: { temp: 21 }
          },
          {
            type: "tool-output-available",
            toolCallId: "call-b",
            output: { time: "09:00" }
          },
          { type: "finish-step" },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "21C at 09:00" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      case "client-tool":
        if (options?.continuation) {
          return sse(textRun("t-cont", ["client tool handled"]));
        }
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-start",
            toolCallId: "call-client-1",
            toolName: "clientEcho"
          },
          {
            type: "tool-input-available",
            toolCallId: "call-client-1",
            toolName: "clientEcho",
            input: { text: "hi" }
          },
          { type: "finish-step" },
          { type: "finish", finishReason: "tool-calls" }
        ]);

      case "approval": {
        if (options?.continuation) {
          const part = this.findToolPart("call-approval-1");
          if (part?.state === "approval-responded") {
            return sse([
              { type: "start" },
              { type: "start-step" },
              {
                type: "tool-output-available",
                toolCallId: "call-approval-1",
                output: { ran: true }
              },
              { type: "text-start", id: "t-appr" },
              { type: "text-delta", id: "t-appr", delta: "approved and ran" },
              { type: "text-end", id: "t-appr" },
              { type: "finish" }
            ]);
          }
          return sse(textRun("t-deny", ["denied — riskyTool not run"]));
        }
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call-approval-1",
            toolName: "riskyTool",
            input: { level: 9 }
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-approval-1",
            approvalId: "approval-1"
          }
        ]);
      }

      case "error-mid":
        return sse([
          { type: "start" },
          { type: "text-start", id: "t-err" },
          { type: "text-delta", id: "t-err", delta: "partial " },
          { type: "error", errorText: "scripted mid-stream failure" }
        ]);

      case "metadata":
        return sse([
          { type: "start" },
          {
            type: "message-metadata",
            messageMetadata: { model: "fixture-model" }
          },
          {
            type: "data-weather",
            id: "data-1",
            data: { city: "Sydney", temp: 21 }
          },
          {
            type: "file",
            url: "data:text/plain;base64,aGk=",
            mediaType: "text/plain"
          },
          {
            type: "source-url",
            sourceId: "src-1",
            url: "https://example.com/doc",
            title: "Doc"
          },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "with extras" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      default:
        return sse(textRun("t-1", ["Hello ", "world"]));
    }
  }
}

/**
 * Streams a prefix, then blocks on a gate the test opens via the `release`
 * RPC. Makes mid-stream scenarios (cancel, resume, concurrency overlap)
 * deterministic: nothing after the gate moves until the test says so.
 */
export class GatedAgent extends ConformanceBase {
  private _gateOpen = false;
  private _waiters: Array<() => void> = [];

  release(): void {
    this._gateOpen = true;
    for (const waiter of this._waiters.splice(0)) waiter();
  }

  private _gate(): Promise<void> {
    if (this._gateOpen) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    this._chatMessageCalls++;
    const signal = options?.abortSignal;
    const gate = () => this._gate();
    const encoder = new TextEncoder();
    const emit = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      chunk: Record<string, unknown>
    ) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        emit(controller, { type: "start" });
        emit(controller, { type: "text-start", id: "t-g" });
        emit(controller, {
          type: "text-delta",
          id: "t-g",
          delta: "before-gate "
        });
        await gate();
        if (!signal?.aborted) {
          emit(controller, {
            type: "text-delta",
            id: "t-g",
            delta: "after-gate"
          });
          emit(controller, { type: "text-end", id: "t-g" });
          emit(controller, { type: "finish" });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }
}

export class LatestGatedAgent extends GatedAgent {
  messageConcurrency = "latest" as const;
}

export class DropGatedAgent extends GatedAgent {
  messageConcurrency = "drop" as const;
}

export class MergeGatedAgent extends GatedAgent {
  messageConcurrency = "merge" as const;
}

export class DebounceGatedAgent extends GatedAgent {
  // 1ms window: the terminal outcome is timing-independent once it elapses,
  // and the gate holds the queue busy until the test releases it.
  messageConcurrency = { strategy: "debounce", debounceMs: 1 } as const;
}

export class MaxPersistedAgent extends ScriptedAgent {
  maxPersistedMessages = 2;
}

/**
 * Phase-3 smoke fixture: the PROJECTED `AIChatAgent` (`../agent.ts` — the
 * AG-UI engine under the legacy AI SDK surface). Not part of the golden
 * matrix; exercised by `projected-smoke.test.ts` only.
 */
export class ProjectedAgent extends ProjectedAIChatAgent<Env> {
  private _projHooks: Array<Record<string, unknown>> = [];

  async stable(timeout = 8000): Promise<boolean> {
    return this.waitUntilStable({ timeout });
  }

  /** Recorded lifecycle-hook invocations (legacy shapes), in order. */
  hooks(): Array<Record<string, unknown>> {
    return this._projHooks;
  }

  /** Raw persisted rows — AG-UI shape with the `_v` marker. */
  rows(): Array<{ id: string; message: unknown }> {
    return (
      this.sql<{ id: string; message: string }>`
        select id, message from cf_ai_chat_agent_messages
        order by created_at, rowid
      ` || []
    ).map((row) => ({ id: row.id, message: JSON.parse(row.message) }));
  }

  /** The legacy-projected view (`this.messages` getter). */
  uiMessages(): ChatMessage[] {
    return this.messages;
  }

  protected onChatResponse(result: ChatResponseResult): void {
    this._projHooks.push({
      hook: "onChatResponse",
      requestId: result.requestId,
      status: result.status,
      continuation: result.continuation,
      messageId: result.message.id,
      partTypes: result.message.parts.map((part) => part.type)
    });
  }

  protected findToolPart(toolCallId: string): ToolPart | undefined {
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    return lastAssistant?.parts.find(
      (part): part is ToolPart =>
        "toolCallId" in part && part.toolCallId === toolCallId
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const scenario =
      (options?.body as { scenario?: string } | undefined)?.scenario ??
      "plain-text";
    switch (scenario) {
      case "tool-single":
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-start",
            toolCallId: "call-weather-1",
            toolName: "getWeather"
          },
          {
            type: "tool-input-delta",
            toolCallId: "call-weather-1",
            inputTextDelta: '{"city":"Sydney"}'
          },
          {
            type: "tool-input-available",
            toolCallId: "call-weather-1",
            toolName: "getWeather",
            input: { city: "Sydney" }
          },
          {
            type: "tool-output-available",
            toolCallId: "call-weather-1",
            output: { temp: 21 }
          },
          { type: "finish-step" },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "It is 21C" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      case "reasoning":
        return sse([
          { type: "start" },
          { type: "reasoning-start", id: "r-1" },
          { type: "reasoning-delta", id: "r-1", delta: "thinking about it" },
          { type: "reasoning-end", id: "r-1" },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "reasoned answer" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      case "tool-error":
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call-boom-1",
            toolName: "boom",
            input: { fuse: "short" }
          },
          {
            type: "tool-output-error",
            toolCallId: "call-boom-1",
            errorText: "exploded"
          },
          { type: "finish-step" },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "tool failed" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      case "approval": {
        if (options?.continuation) {
          const part = this.findToolPart("call-approval-1");
          if (part?.state === "approval-responded") {
            return sse([
              { type: "start" },
              { type: "start-step" },
              {
                type: "tool-output-available",
                toolCallId: "call-approval-1",
                output: { ran: true }
              },
              { type: "text-start", id: "t-appr" },
              { type: "text-delta", id: "t-appr", delta: "approved and ran" },
              { type: "text-end", id: "t-appr" },
              { type: "finish" }
            ]);
          }
          return sse(textRun("t-deny", ["denied — riskyTool not run"]));
        }
        return sse([
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call-approval-1",
            toolName: "riskyTool",
            input: { level: 9 }
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-approval-1",
            approvalId: "approval-1"
          }
        ]);
      }

      case "metadata":
        return sse([
          { type: "start" },
          {
            type: "message-metadata",
            messageMetadata: { model: "fixture-model" }
          },
          {
            type: "data-weather",
            id: "data-1",
            data: { city: "Sydney", temp: 21 }
          },
          {
            type: "file",
            url: "data:text/plain;base64,aGk=",
            mediaType: "text/plain"
          },
          {
            type: "source-url",
            sourceId: "src-1",
            url: "https://example.com/doc",
            title: "Doc"
          },
          { type: "text-start", id: "t-1" },
          { type: "text-delta", id: "t-1", delta: "with extras" },
          { type: "text-end", id: "t-1" },
          { type: "finish" }
        ]);

      default:
        return sse(textRun("t-1", ["Hello ", "world"]));
    }
  }
}

export type Env = {
  ScriptedAgent: DurableObjectNamespace<ScriptedAgent>;
  GatedAgent: DurableObjectNamespace<GatedAgent>;
  LatestGatedAgent: DurableObjectNamespace<LatestGatedAgent>;
  DropGatedAgent: DurableObjectNamespace<DropGatedAgent>;
  MergeGatedAgent: DurableObjectNamespace<MergeGatedAgent>;
  DebounceGatedAgent: DurableObjectNamespace<DebounceGatedAgent>;
  MaxPersistedAgent: DurableObjectNamespace<MaxPersistedAgent>;
  ProjectedAgent: DurableObjectNamespace<ProjectedAgent>;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
