/**
 * UIMessageChunk → AGUIEvent projection used server-side when wrapping a
 * Vercel `streamText().toUIMessageStreamResponse()` body.
 *
 * Reference: `design/discovery-agui-types.md` §§ "UIMessageChunk → AG-UI Event".
 *
 * The projector is stateful: a Vercel `{type:"start", messageId}` chunk is
 * buffered until the first `text-start`/`reasoning-start`/`tool-input-start`
 * arrives so we can emit a `RUN_STARTED` with a synthesized
 * `threadId`/`runId` once we know the run is live. Tool input deltas pass
 * through 1:1; `tool-input-available` only emits `TOOL_CALL_END` because
 * the argument buffer already matches the available `input`.
 */

import { nanoid } from "nanoid";
import type { AGUIEvent } from "agents/chat/agui-types";
import {
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_REQUEST
} from "agents/chat/agui-types";
import type { UIMessageChunk } from "ai";

export type ChunkToEventProjectorOptions = {
  /** Stable thread id for the run; defaults to a freshly generated one. */
  threadId?: string;
  /** Stable run id; defaults to a freshly generated one. */
  runId?: string;
};

export class ChunkToEventProjector {
  private readonly threadId: string;
  private readonly runId: string;
  private runStarted = false;
  private runFinished = false;
  // Vercel `text-*` and `reasoning-*` chunks carry an `id`; AG-UI's
  // `messageId` is the same identifier. Tracked here so we can reuse it
  // when synthesizing `TEXT_MESSAGE_END` etc.
  private currentTextId: string | null = null;
  private currentReasoningId: string | null = null;
  // Vercel `tool-input-start` arrives without args; AG-UI emits a separate
  // `TOOL_CALL_START`. We track the toolName per id so tool-output frames
  // can include it on `TOOL_CALL_RESULT`.
  private toolNamesById = new Map<string, string>();
  // Tracks tool calls whose `TOOL_CALL_END` has already been emitted so a
  // later `tool-output-available` can synthesize a `TOOL_CALL_RESULT`
  // without re-emitting `TOOL_CALL_END`.
  private endedToolCalls = new Set<string>();
  // Tool calls that streamed at least one `tool-input-delta`; calls without
  // any get their arguments synthesized from `tool-input-available.input`.
  private argsEmitted = new Set<string>();

  constructor(options?: ChunkToEventProjectorOptions) {
    this.threadId = options?.threadId ?? nanoid();
    this.runId = options?.runId ?? nanoid();
  }

  /** Project a single Vercel `UIMessageChunk` into zero or more `AGUIEvent`s. */
  project(chunk: UIMessageChunk): AGUIEvent[] {
    switch (chunk.type) {
      case "start":
        return this.emitRunStarted();

      case "start-step":
        return [{ type: "STEP_STARTED", stepName: "step" }];

      case "finish-step":
        return [{ type: "STEP_FINISHED", stepName: "step" }];

      case "text-start": {
        const events = this.emitRunStarted();
        this.currentTextId = chunk.id;
        events.push({
          type: "TEXT_MESSAGE_START",
          messageId: chunk.id,
          role: "assistant"
        });
        return events;
      }

      case "text-delta":
        return [
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: chunk.id,
            delta: chunk.delta
          }
        ];

      case "text-end":
        this.currentTextId = null;
        return [{ type: "TEXT_MESSAGE_END", messageId: chunk.id }];

      case "reasoning-start": {
        const events = this.emitRunStarted();
        this.currentReasoningId = chunk.id;
        events.push({
          type: "REASONING_MESSAGE_START",
          messageId: chunk.id,
          role: "reasoning"
        });
        return events;
      }

      case "reasoning-delta":
        return [
          {
            type: "REASONING_MESSAGE_CONTENT",
            messageId: chunk.id,
            delta: chunk.delta
          }
        ];

      case "reasoning-end":
        this.currentReasoningId = null;
        return [{ type: "REASONING_MESSAGE_END", messageId: chunk.id }];

      case "tool-input-start": {
        const events = this.emitRunStarted();
        this.toolNamesById.set(chunk.toolCallId, chunk.toolName);
        events.push({
          type: "TOOL_CALL_START",
          toolCallId: chunk.toolCallId,
          toolCallName: chunk.toolName
        });
        return events;
      }

      case "tool-input-delta":
        this.argsEmitted.add(chunk.toolCallId);
        return [
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: chunk.toolCallId,
            delta: chunk.inputTextDelta
          }
        ];

      case "tool-input-available": {
        // Producers may emit `tool-input-available` with no prior
        // `tool-input-start` (non-streamed calls) and/or no `tool-input-delta`
        // stream. Synthesize the missing START/ARGS so the call — and its
        // arguments — are not lost.
        const events = this.emitRunStarted();
        if (!this.toolNamesById.has(chunk.toolCallId)) {
          this.toolNamesById.set(chunk.toolCallId, chunk.toolName);
          events.push({
            type: "TOOL_CALL_START",
            toolCallId: chunk.toolCallId,
            toolCallName: chunk.toolName
          });
        }
        if (!this.argsEmitted.has(chunk.toolCallId)) {
          this.argsEmitted.add(chunk.toolCallId);
          events.push({
            type: "TOOL_CALL_ARGS",
            toolCallId: chunk.toolCallId,
            delta: JSON.stringify(chunk.input ?? {})
          });
        }
        this.endedToolCalls.add(chunk.toolCallId);
        events.push({ type: "TOOL_CALL_END", toolCallId: chunk.toolCallId });
        return events;
      }

      case "tool-input-error": {
        const events: AGUIEvent[] = [];
        if (!this.endedToolCalls.has(chunk.toolCallId)) {
          events.push({ type: "TOOL_CALL_END", toolCallId: chunk.toolCallId });
          this.endedToolCalls.add(chunk.toolCallId);
        }
        events.push({
          type: "TOOL_CALL_RESULT",
          messageId: `tool_${chunk.toolCallId}`,
          toolCallId: chunk.toolCallId,
          content: JSON.stringify({ error: chunk.errorText }),
          role: "tool",
          error: chunk.errorText
        });
        return events;
      }

      case "tool-output-available":
        return [
          {
            type: "TOOL_CALL_RESULT",
            messageId: `tool_${chunk.toolCallId}`,
            toolCallId: chunk.toolCallId,
            content:
              typeof chunk.output === "string"
                ? chunk.output
                : JSON.stringify(chunk.output ?? null),
            role: "tool"
          }
        ];

      case "tool-output-error":
        return [
          {
            type: "TOOL_CALL_RESULT",
            messageId: `tool_${chunk.toolCallId}`,
            toolCallId: chunk.toolCallId,
            content: JSON.stringify({ error: chunk.errorText }),
            role: "tool",
            error: chunk.errorText
          }
        ];

      case "tool-output-denied":
        return [
          {
            type: "CUSTOM",
            name: CF_TOOL_APPROVAL_DECISION,
            value: {
              toolCallId: chunk.toolCallId,
              approvalId: `approval_${chunk.toolCallId}`,
              approved: false
            }
          }
        ];

      case "tool-approval-request":
        return [
          {
            type: "CUSTOM",
            name: CF_TOOL_APPROVAL_REQUEST,
            value: {
              toolCallId: chunk.toolCallId,
              toolName: this.toolNamesById.get(chunk.toolCallId) ?? "",
              input: null,
              approvalId: chunk.approvalId
            }
          }
        ];

      case "finish":
        return this.emitRunFinished(chunk.finishReason);

      case "error":
        this.runFinished = true;
        return [{ type: "RUN_ERROR", message: chunk.errorText }];

      case "abort":
        this.runFinished = true;
        return [
          {
            type: "RUN_ERROR",
            message: chunk.reason ?? "aborted",
            code: "aborted"
          }
        ];

      case "source-url":
        return [
          {
            type: "CUSTOM",
            name: "cf.agents.source",
            value: {
              kind: "url",
              sourceId: chunk.sourceId,
              url: chunk.url,
              title: chunk.title
            }
          }
        ];

      case "source-document":
        return [
          {
            type: "CUSTOM",
            name: "cf.agents.source",
            value: {
              kind: "document",
              sourceId: chunk.sourceId,
              mediaType: chunk.mediaType,
              title: chunk.title,
              filename: chunk.filename
            }
          }
        ];

      case "file":
        return [
          {
            type: "CUSTOM",
            name: "cf.agents.file",
            value: { url: chunk.url, mediaType: chunk.mediaType }
          }
        ];

      case "message-metadata":
        return [
          {
            type: "CUSTOM",
            name: "cf.agents.message_metadata",
            value: chunk.messageMetadata
          }
        ];

      default:
        return this.projectDataChunk(chunk);
    }
  }

  /** Emit a synthetic `RUN_FINISHED` if no `finish` chunk arrived. */
  flush(): AGUIEvent[] {
    if (this.runFinished || !this.runStarted) return [];
    return this.emitRunFinished("stop");
  }

  private emitRunStarted(): AGUIEvent[] {
    if (this.runStarted) return [];
    this.runStarted = true;
    return [
      { type: "RUN_STARTED", threadId: this.threadId, runId: this.runId }
    ];
  }

  private emitRunFinished(finishReason?: string): AGUIEvent[] {
    if (this.runFinished) return [];
    if (!this.runStarted) {
      // A finish without a start means the entire run was empty. Emit
      // both so consumers see a complete lifecycle.
      this.runStarted = true;
    }
    this.runFinished = true;
    return [
      {
        type: "RUN_FINISHED",
        threadId: this.threadId,
        runId: this.runId,
        ...(finishReason !== undefined && { result: { finishReason } })
      }
    ];
  }

  private projectDataChunk(chunk: UIMessageChunk): AGUIEvent[] {
    // `data-*` chunk discrimination relies on the type prefix because the
    // Vercel union for `DataUIMessageChunk` is open.
    const typeName = (chunk as { type: unknown }).type;
    if (typeof typeName !== "string" || !typeName.startsWith("data-")) {
      // e.g. an already-AG-UI stream piped in by mistake — surface it rather
      // than yielding a well-formed empty stream.
      console.warn(
        "[ai-chat-vercel] ChunkToEventProjector: dropping unrecognized chunk type",
        typeName
      );
      return [];
    }
    const dataValue = (chunk as { data?: unknown }).data;
    return [
      {
        type: "CUSTOM",
        name: `data.${typeName.slice("data-".length)}`,
        value: dataValue
      }
    ];
  }
}

/**
 * Convenience: project an entire `ReadableStream<UIMessageChunk>` into an
 * AG-UI SSE `Response` body. Used by `toAGUIResponse` to wrap
 * `streamText().toUIMessageStreamResponse()`.
 */
export function projectChunkStreamToAGUISSE(
  chunks: ReadableStream<UIMessageChunk>,
  options?: ChunkToEventProjectorOptions
): ReadableStream<Uint8Array> {
  const projector = new ChunkToEventProjector(options);
  const encoder = new TextEncoder();
  const reader = chunks.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          for (const event of projector.flush()) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          }
          controller.close();
          return;
        }
        for (const event of projector.project(value)) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    }
  });
}
