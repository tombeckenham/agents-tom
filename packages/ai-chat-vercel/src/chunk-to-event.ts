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
  /**
   * Assistant message id to anchor the run on when the producer's `start`
   * chunk carries none — a continuation turn passes the seed assistant's id
   * so the streamed text extends that message instead of opening a new one.
   */
  messageId?: string;
  /**
   * When true, `messageId` outranks a producer-supplied `start.messageId`
   * (#1229): a continuation must extend the seed assistant even when the
   * provider mints a fresh message id, or the turn forks a duplicate.
   */
  messageIdAuthoritative?: boolean;
};

export class ChunkToEventProjector {
  private readonly threadId: string;
  private readonly runId: string;
  private runStarted = false;
  // Assistant message id from the Vercel `start` chunk (or the caller's
  // `messageId` option); carried onto tool calls as `parentMessageId` since
  // AG-UI keeps no run-level message id. Generated at RUN_STARTED if absent.
  private runMessageId: string | null;
  // Vercel text part id -> the AG-UI message id it maps to.
  private textPartMessageIds = new Map<string, string>();
  private runFinished = false;
  // Vercel `text-*` and `reasoning-*` chunks carry an `id`; AG-UI's
  // `messageId` is the same identifier. Tracked here so we can reuse it
  // when synthesizing `TEXT_MESSAGE_END` etc.
  private currentTextId: string | null = null;
  private currentReasoningId: string | null = null;
  // Vercel reasoning part id -> the AG-UI message id it maps to. Reasoning
  // ids are PART ids that producers reuse across turns; mapping them to a
  // fresh per-run id keeps two turns from colliding on one persisted row.
  private reasoningMessageIds = new Map<string, string>();
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

  private readonly runMessageIdLocked: boolean;

  constructor(options?: ChunkToEventProjectorOptions) {
    this.threadId = options?.threadId ?? nanoid();
    this.runId = options?.runId ?? nanoid();
    this.runMessageId = options?.messageId ?? null;
    this.runMessageIdLocked =
      options?.messageIdAuthoritative === true && options?.messageId != null;
  }

  /** Project a single Vercel `UIMessageChunk` into zero or more `AGUIEvent`s. */
  project(chunk: UIMessageChunk): AGUIEvent[] {
    switch (chunk.type) {
      case "start": {
        // `RUN_STARTED` has no message id, so remember the one the Vercel
        // `start` carries and hand it to tool calls as `parentMessageId` —
        // the only id source a tool-first turn has. See `toolCallStart`.
        // An authoritative anchor (continuation seed, #1229) outranks it.
        if (chunk.messageId != null && !this.runMessageIdLocked) {
          this.runMessageId = chunk.messageId;
        }
        const events = this.emitRunStarted();
        // A `start` can carry messageMetadata (the AI SDK writes it onto the
        // message); forward it so the reducer attaches it to the assistant.
        const startMetadata = (chunk as { messageMetadata?: unknown })
          .messageMetadata;
        if (startMetadata !== undefined) {
          events.push({
            type: "CUSTOM",
            name: "cf.agents.message_metadata",
            value: startMetadata
          });
        }
        return events;
      }

      case "start-step":
        return [{ type: "STEP_STARTED", stepName: "step" }];

      case "finish-step":
        return [{ type: "STEP_FINISHED", stepName: "step" }];

      case "text-start": {
        const events = this.emitRunStarted();
        const messageId = this.textMessageId(chunk.id ?? "__text");
        this.currentTextId = messageId;
        events.push({
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant"
        });
        return events;
      }

      case "text-delta":
        return [
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: this.textMessageId(chunk.id ?? "__text"),
            delta: chunk.delta
          }
        ];

      case "text-end":
        this.currentTextId = null;
        return [
          {
            type: "TEXT_MESSAGE_END",
            messageId: this.textMessageId(chunk.id ?? "__text")
          }
        ];

      case "reasoning-start": {
        const events = this.emitRunStarted();
        // Some producers omit the part id; AG-UI requires one — synthesize.
        const reasoningId = this.reasoningMessageId(chunk.id);
        this.currentReasoningId = reasoningId;
        events.push({
          type: "REASONING_MESSAGE_START",
          messageId: reasoningId,
          role: "reasoning"
        });
        return events;
      }

      case "reasoning-delta": {
        const reasoningId =
          chunk.id != null
            ? this.reasoningMessageId(chunk.id)
            : this.currentReasoningId;
        if (reasoningId == null) return [];
        return [
          {
            type: "REASONING_MESSAGE_CONTENT",
            messageId: reasoningId,
            delta: chunk.delta
          }
        ];
      }

      case "reasoning-end": {
        const reasoningId =
          chunk.id != null
            ? this.reasoningMessageId(chunk.id)
            : this.currentReasoningId;
        this.currentReasoningId = null;
        if (reasoningId == null) return [];
        return [{ type: "REASONING_MESSAGE_END", messageId: reasoningId }];
      }

      case "tool-input-start": {
        const events = this.emitRunStarted();
        this.toolNamesById.set(chunk.toolCallId, chunk.toolName);
        events.push(this.toolCallStart(chunk.toolCallId, chunk.toolName));
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
            ...this.toolCallStart(chunk.toolCallId, chunk.toolName),
            synthesized: true
          } as AGUIEvent);
        }
        if (!this.argsEmitted.has(chunk.toolCallId)) {
          this.argsEmitted.add(chunk.toolCallId);
          events.push({
            type: "TOOL_CALL_ARGS",
            toolCallId: chunk.toolCallId,
            delta: JSON.stringify(chunk.input ?? {}),
            // The producer never streamed deltas; a client projection can
            // skip re-emitting a delta chunk the producer never sent.
            synthesized: true
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
    // No finishReason: the producer never said why it stopped, and the
    // legacy engine emitted a bare `finish` in that case. Marked
    // synthesized so a chunk projection can skip re-inventing the finish
    // chunk the producer never sent.
    return this.emitRunFinished().map(
      (event) => ({ ...event, synthesized: true }) as AGUIEvent
    );
  }

  /**
   * `parentMessageId` is what lets a consumer attribute a tool call to its
   * assistant message — the reducer in `agui-message-builder` invents an id
   * without it, and the client projection has no other id for a turn whose
   * first content is a tool call.
   */
  /**
   * AG-UI keys a text message by the ASSISTANT message id; Vercel's
   * `text-start.id` is a *part* id, and the `start` chunk carries the real
   * message id. Mapping the part id straight through renamed the assistant on
   * every round trip, so the run's first text part adopts the run message id.
   * Later parts keep their own ids — remapping them all onto one id would
   * change how multi-part turns reduce.
   */
  private textMessageId(partId: string): string {
    const known = this.textPartMessageIds.get(partId);
    if (known) return known;
    // Later parts mint a fresh id rather than passing the part id through:
    // AI SDK part ids are POSITIONAL ("0", "1", … reset per response), so a
    // verbatim id collides with the previous turn's second text part and
    // overwrites its persisted row. Same fix as `reasoningMessageId`. With
    // no run anchor at all (a mid-stream fragment translated without its
    // RUN_STARTED, e.g. resume replay) the part id passes through so frames
    // stay correlated with the stream's earlier, untranslated frames.
    const messageId =
      this.runMessageId == null
        ? partId
        : this.textPartMessageIds.size === 0
          ? this.runMessageId
          : nanoid();
    this.textPartMessageIds.set(partId, messageId);
    return messageId;
  }

  private reasoningMessageId(partId: string | undefined): string {
    if (partId == null) return nanoid();
    let mapped = this.reasoningMessageIds.get(partId);
    if (!mapped) {
      mapped = nanoid();
      this.reasoningMessageIds.set(partId, mapped);
    }
    return mapped;
  }

  private toolCallStart(toolCallId: string, toolCallName: string): AGUIEvent {
    return {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName,
      ...(this.runMessageId != null
        ? { parentMessageId: this.runMessageId }
        : {})
    };
  }

  private emitRunStarted(): AGUIEvent[] {
    if (this.runStarted) return [];
    this.runStarted = true;
    // No message id from the producer (a bare `start` chunk, or none at
    // all): generate one, exactly like the legacy engine generated an
    // assistant id per turn. Without it, part ids leak into AG-UI message
    // ids — two turns reusing a part id ("t-1") would collide on the same
    // persisted assistant row, and a tool+text turn would split into two
    // assistant messages.
    this.runMessageId ??= nanoid();
    // CF extension: carry the run's assistant id so a client projection can
    // open its leading `start` chunk with the SAME id the server persists,
    // even when the run's first content is not text (reasoning-first,
    // metadata-first turns).
    return [
      {
        type: "RUN_STARTED",
        threadId: this.threadId,
        runId: this.runId,
        messageId: this.runMessageId
      }
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
    // Wrap so the part's `id`/`transient` round-trip (the reducer persists
    // `id` on the extra part; `transient` parts are never persisted).
    const { id, data, transient } = chunk as {
      id?: string;
      data?: unknown;
      transient?: boolean;
    };
    return [
      {
        type: "CUSTOM",
        name: `data.${typeName.slice("data-".length)}`,
        value: {
          ...(id !== undefined && { id }),
          data,
          ...(transient !== undefined && { transient })
        }
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
    // Same contract as parseUIMessageSSE's pull: never resolve without
    // enqueueing or closing, or a cross-context consumer can be stranded.
    async pull(controller) {
      try {
        let enqueued = false;
        while (!enqueued) {
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
            enqueued = true;
          }
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
