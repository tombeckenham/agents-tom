/**
 * AGUIStreamAccumulator — wraps `applyEventToSnapshot` with the metadata
 * tracking the agent layer needs to broadcast partial state, surface
 * approvals, and merge final messages into the persisted message list.
 *
 * Sidecar to the Vercel-shaped `StreamAccumulator`: same role in the AG-UI
 * stack, different vocabulary because event semantics differ. The reducer
 * does all event-shape work; this class only tracks turn boundaries, run
 * metadata, and provides a merge primitive.
 */

import {
  applyEventToSnapshot,
  createInitialSnapshot,
  type SnapshotState
} from "./agui-message-builder";
import {
  CF_TOOL_APPROVAL_REQUEST,
  type AGUIEvent,
  type AGUIMessage,
  type AssistantMessage,
  type CFToolApprovalRequestValue,
  type CustomEvent as AGUICustomEvent,
  type ReasoningMessage,
  type ToolMessage
} from "./agui-types";

// ============================================================================
// Options + action vocabulary
// ============================================================================

export interface AGUIStreamAccumulatorOptions {
  existingMessages?: AGUIMessage[];
  existingState?: unknown;
}

/**
 * Discriminated action returned per `applyEvent` call. The caller uses it to
 * decide whether to broadcast a partial message, notify other connected
 * clients of a cross-message tool landing, or surface an approval modal.
 *
 * Choices vs Vercel `ChunkAction`:
 * - `extend` / `start` replace `start`/`finish`/`message-metadata` because
 *   AG-UI carries turn metadata in the reducer state, not chunk-level fields.
 * - `tool-result` replaces `cross-message-tool-update`: AG-UI's
 *   `TOOL_CALL_RESULT` is always cross-message (separate `ToolMessage`).
 * - `approval` keeps the Vercel `tool-approval-request` semantics, expanded
 *   to carry both `toolCallId` and `approvalId`.
 * - `lifecycle` is new: AG-UI exposes RUN_/STEP_ lifecycle as first-class
 *   events; the agent layer needs to react to them but they do not change
 *   the message list.
 * - `noop` covers recognized-but-silent events (RAW, STATE, ACTIVITY,
 *   non-cf CUSTOM) so callers can distinguish "handled" from "ignored".
 * - `unknown` covers reducer rejection (malformed / unrecognized) — Vercel
 *   surfaced this as `handled: false` on `ChunkResult`.
 */
export type AGUIChunkAction =
  | { kind: "extend"; messageId: string }
  | { kind: "start"; messageId: string }
  | { kind: "tool-result"; toolCallId: string }
  | { kind: "approval"; toolCallId: string; approvalId: string }
  | {
      kind: "lifecycle";
      phase:
        | "run-start"
        | "run-finish"
        | "run-error"
        | "step-start"
        | "step-finish";
    }
  | { kind: "noop" }
  | { kind: "unknown" };

// ============================================================================
// Accumulator
// ============================================================================

export class AGUIStreamAccumulator {
  private _state: SnapshotState;
  private _finishReason: string | undefined;
  private _usage: unknown;

  constructor(options: AGUIStreamAccumulatorOptions = {}) {
    this._state = createInitialSnapshot(options.existingMessages ?? []);
    if (options.existingState !== undefined) {
      this._state.state = options.existingState;
    }
  }

  applyEvent(event: AGUIEvent): AGUIChunkAction {
    const before = this.snapshotBefore(event);
    const handled = applyEventToSnapshot(this._state, event);
    if (!handled) return { kind: "unknown" };
    return this.deriveAction(event, before);
  }

  get messages(): readonly AGUIMessage[] {
    return this._state.messages;
  }

  get state(): unknown | undefined {
    return this._state.state;
  }

  /** The most recent RUN_ERROR, if the stream carried one. */
  get lastError(): { message: string; code?: string } | undefined {
    return this._state.lastError;
  }

  get pendingApprovals(): ReadonlyMap<string, CFToolApprovalRequestValue> {
    return this._state.pendingApprovals;
  }

  get customEvents(): readonly AGUICustomEvent[] {
    // Reducer records both raw CUSTOM payloads and synthetic entries
    // (STATE_DELTA, ACTIVITY_*). Project everything to a CUSTOM event shape
    // so consumers have one stable type to switch over.
    return this._state.customEvents
      .filter((c) => c.name !== CF_TOOL_APPROVAL_REQUEST)
      .map<AGUICustomEvent>((c) => ({
        type: "CUSTOM",
        name: c.name,
        value: c.value
      }));
  }

  get runMetadata(): {
    threadId?: string;
    runId?: string;
    finishReason?: string;
    usage?: unknown;
  } {
    return {
      threadId: this._state.threadId,
      runId: this._state.runId,
      finishReason: this._finishReason,
      usage: this._usage
    };
  }

  /**
   * Returns a new array combining `prev` with the accumulator's current
   * messages. Any `prev` entry whose `id` matches an accumulated message is
   * replaced in place; accumulated messages not in `prev` are appended in
   * the order the reducer holds them. Tool messages always follow their
   * owning assistant because the reducer appends them in stream order; we
   * preserve that order on append.
   */
  mergeInto(prev: AGUIMessage[]): AGUIMessage[] {
    const accIds = new Set<string>();
    for (const m of this._state.messages) accIds.add(m.id);

    const accById = new Map<string, AGUIMessage>();
    for (const m of this._state.messages) accById.set(m.id, m);

    const result: AGUIMessage[] = [];
    const replaced = new Set<string>();
    for (const m of prev) {
      const replacement = accById.get(m.id);
      if (replacement) {
        result.push(replacement);
        replaced.add(m.id);
      } else {
        result.push(m);
      }
    }
    for (const m of this._state.messages) {
      if (!replaced.has(m.id)) result.push(m);
    }
    return result;
  }

  reset(): void {
    this._state = createInitialSnapshot();
    this._finishReason = undefined;
    this._usage = undefined;
  }

  // ------------------------------------------------------------------------

  private snapshotBefore(event: AGUIEvent): {
    hasTextStream: boolean;
    hasReasoningStream: boolean;
    hasToolBuffer: boolean;
    assistantExists: boolean;
    toolCallExists: boolean;
    parentAssistantExists: boolean;
  } {
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        return {
          hasTextStream: this._state.textStreams.has(event.messageId),
          hasReasoningStream: false,
          hasToolBuffer: false,
          assistantExists: this.hasAssistantWithId(event.messageId),
          toolCallExists: false,
          parentAssistantExists: false
        };
      case "REASONING_MESSAGE_START":
        return {
          hasTextStream: false,
          hasReasoningStream: this._state.reasoningStreams.has(event.messageId),
          hasToolBuffer: false,
          assistantExists: this.hasReasoningWithId(event.messageId),
          toolCallExists: false,
          parentAssistantExists: false
        };
      case "TOOL_CALL_START": {
        const parent = event.parentMessageId;
        return {
          hasTextStream: false,
          hasReasoningStream: false,
          hasToolBuffer: this._state.toolBuffers.has(event.toolCallId),
          assistantExists: false,
          toolCallExists: this.hasToolCallId(event.toolCallId),
          parentAssistantExists: parent
            ? this.hasAssistantWithId(parent)
            : this.lastMessageIsAssistant()
        };
      }
      default:
        return {
          hasTextStream: false,
          hasReasoningStream: false,
          hasToolBuffer: false,
          assistantExists: false,
          toolCallExists: false,
          parentAssistantExists: false
        };
    }
  }

  private deriveAction(
    event: AGUIEvent,
    before: ReturnType<AGUIStreamAccumulator["snapshotBefore"]>
  ): AGUIChunkAction {
    switch (event.type) {
      case "RUN_STARTED":
        return { kind: "lifecycle", phase: "run-start" };
      case "RUN_FINISHED": {
        const result = event.result;
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          if (typeof r.finishReason === "string") {
            this._finishReason = r.finishReason;
          }
          if (r.usage !== undefined) this._usage = r.usage;
        }
        return { kind: "lifecycle", phase: "run-finish" };
      }
      case "RUN_ERROR":
        return { kind: "lifecycle", phase: "run-error" };
      case "STEP_STARTED":
        return { kind: "lifecycle", phase: "step-start" };
      case "STEP_FINISHED":
        return { kind: "lifecycle", phase: "step-finish" };

      case "TEXT_MESSAGE_START":
        return before.hasTextStream || before.assistantExists
          ? { kind: "extend", messageId: event.messageId }
          : { kind: "start", messageId: event.messageId };
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_END":
        return { kind: "extend", messageId: event.messageId };

      case "REASONING_MESSAGE_START":
        return before.hasReasoningStream || before.assistantExists
          ? { kind: "extend", messageId: event.messageId }
          : { kind: "start", messageId: event.messageId };
      case "REASONING_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_END":
        return { kind: "extend", messageId: event.messageId };
      case "REASONING_MESSAGE_CHUNK": {
        const id = event.messageId ?? this.findLastReasoningId();
        if (!id) return { kind: "noop" };
        return { kind: "extend", messageId: id };
      }
      case "REASONING_START":
      case "REASONING_END":
      case "REASONING_ENCRYPTED_VALUE":
        return { kind: "noop" };

      case "TOOL_CALL_START": {
        // Replay (buffer or tool call already there) is an extend on the
        // hosting assistant. Otherwise: if the reducer attached to an
        // already-existing assistant, that's an extend on that turn; if it
        // had to synthesize a fresh assistant, that's a start.
        const assistantId = this.findAssistantIdForTool(event.toolCallId);
        if (!assistantId) return { kind: "noop" };
        if (before.hasToolBuffer || before.toolCallExists) {
          return { kind: "extend", messageId: assistantId };
        }
        return before.parentAssistantExists
          ? { kind: "extend", messageId: assistantId }
          : { kind: "start", messageId: assistantId };
      }
      case "TOOL_CALL_ARGS":
      case "TOOL_CALL_END": {
        const assistantId = this.findAssistantIdForTool(event.toolCallId);
        return assistantId
          ? { kind: "extend", messageId: assistantId }
          : { kind: "noop" };
      }
      case "TOOL_CALL_RESULT":
        return { kind: "tool-result", toolCallId: event.toolCallId };

      case "MESSAGES_SNAPSHOT":
        return { kind: "noop" };

      case "STATE_SNAPSHOT":
      case "STATE_DELTA":
      case "ACTIVITY_SNAPSHOT":
      case "ACTIVITY_DELTA":
      case "RAW":
        return { kind: "noop" };

      case "CUSTOM": {
        if (event.name === CF_TOOL_APPROVAL_REQUEST) {
          const v = event.value as CFToolApprovalRequestValue | undefined;
          if (v?.toolCallId && v?.approvalId) {
            return {
              kind: "approval",
              toolCallId: v.toolCallId,
              approvalId: v.approvalId
            };
          }
        }
        return { kind: "noop" };
      }
    }
  }

  private hasAssistantWithId(id: string): boolean {
    for (const m of this._state.messages) {
      if (m.role === "assistant" && m.id === id) return true;
    }
    return false;
  }

  private hasReasoningWithId(id: string): boolean {
    for (const m of this._state.messages) {
      if (m.role === "reasoning" && m.id === id) return true;
    }
    return false;
  }

  private lastMessageIsAssistant(): boolean {
    const last = this._state.messages[this._state.messages.length - 1];
    return last !== undefined && last.role === "assistant";
  }

  private hasToolCallId(toolCallId: string): boolean {
    for (const m of this._state.messages) {
      if (m.role !== "assistant" || !m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        if (tc.id === toolCallId) return true;
      }
    }
    return false;
  }

  private findAssistantIdForTool(toolCallId: string): string | undefined {
    for (let i = this._state.messages.length - 1; i >= 0; i--) {
      const m = this._state.messages[i];
      if (m.role !== "assistant" || !m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        if (tc.id === toolCallId) return m.id;
      }
    }
    return undefined;
  }

  private findLastReasoningId(): string | undefined {
    for (let i = this._state.messages.length - 1; i >= 0; i--) {
      const m = this._state.messages[i];
      if (m.role === "reasoning") return m.id;
    }
    return undefined;
  }
}

// Re-export type aliases consumers may need alongside the accumulator.
export type {
  AGUIMessage,
  AssistantMessage,
  ReasoningMessage,
  ToolMessage,
  CFToolApprovalRequestValue,
  AGUICustomEvent
};
