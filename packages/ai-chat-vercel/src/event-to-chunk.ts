/**
 * AGUIEvent → UIMessageChunk projection used client-side by
 * `WebSocketChatTransport` to feed `@ai-sdk/react`'s `useChat`.
 *
 * Reference: `design/discovery-agui-types.md` §§ "AG-UI Event → UIMessageChunk".
 *
 * Statefulness:
 *  - `RUN_STARTED` does not carry a `messageId`; the leading
 *    `{type:"start", messageId}` chunk is therefore deferred until the first
 *    `TEXT_MESSAGE_START` / `REASONING_MESSAGE_START` arrives.
 *  - AG-UI splits tool arguments across `TOOL_CALL_ARGS` deltas with no
 *    guarantee of valid JSON before `TOOL_CALL_END`. The projector
 *    accumulates per-`toolCallId` and emits `tool-input-available` on END.
 *  - `MESSAGES_SNAPSHOT` has no UIMessageChunk equivalent; the projector
 *    expands the snapshot into a synthetic chunk stream so the transport
 *    surface stays uniform across replay and live tail.
 */

import type {
  AGUIEvent,
  AGUIMessage,
  AssistantMessage,
  CFToolApprovalDecisionValue,
  CFToolApprovalRequestValue,
  ReasoningMessage,
  ToolMessage,
  UserMessage
} from "agents/chat/agui-types";
import {
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_REQUEST
} from "agents/chat/agui-types";
import type { UIMessageChunk } from "ai";

type ToolBuffer = {
  toolName: string;
  args: string;
  startedInputAvailable: boolean;
};

export class EventToChunkProjector {
  // `RUN_STARTED` arrives without a `messageId`; we buffer the fact that a
  // run has begun and only emit the leading Vercel `{type:"start", messageId}`
  // chunk once `TEXT_MESSAGE_START` / `REASONING_MESSAGE_START` gives us
  // an id to attach.
  private runStartedBuffered = false;
  private leadingStartEmitted = false;
  private toolBuffers = new Map<string, ToolBuffer>();
  // Tracks the messageId of the open reasoning chunk so a stray
  // `REASONING_MESSAGE_CHUNK` without an explicit `messageId` can be
  // attributed to it.
  private currentReasoningId: string | null = null;

  /** Project a single AG-UI event into zero or more `UIMessageChunk`s. */
  project(event: AGUIEvent): UIMessageChunk[] {
    switch (event.type) {
      case "RUN_STARTED":
        this.runStartedBuffered = true;
        return [];

      case "RUN_FINISHED":
        return [{ type: "finish" }];

      case "RUN_ERROR":
        return [{ type: "error", errorText: event.message }];

      case "STEP_STARTED":
        return [{ type: "start-step" }];

      case "STEP_FINISHED":
        return [{ type: "finish-step" }];

      case "TEXT_MESSAGE_START":
        return [
          ...this.emitLeadingStart(event.messageId),
          { type: "text-start", id: event.messageId }
        ];

      case "TEXT_MESSAGE_CONTENT":
        return [
          { type: "text-delta", id: event.messageId, delta: event.delta }
        ];

      case "TEXT_MESSAGE_END":
        return [{ type: "text-end", id: event.messageId }];

      case "REASONING_MESSAGE_START":
        this.currentReasoningId = event.messageId;
        return [
          ...this.emitLeadingStart(event.messageId),
          { type: "reasoning-start", id: event.messageId }
        ];

      case "REASONING_MESSAGE_CONTENT":
        return [
          { type: "reasoning-delta", id: event.messageId, delta: event.delta }
        ];

      case "REASONING_MESSAGE_END":
        if (this.currentReasoningId === event.messageId) {
          this.currentReasoningId = null;
        }
        return [{ type: "reasoning-end", id: event.messageId }];

      case "REASONING_MESSAGE_CHUNK":
        return this.expandReasoningChunk(event);

      case "REASONING_START":
      case "REASONING_END":
      case "REASONING_ENCRYPTED_VALUE":
        return [];

      case "TOOL_CALL_START": {
        this.toolBuffers.set(event.toolCallId, {
          toolName: event.toolCallName,
          args: "",
          startedInputAvailable: false
        });
        return [
          {
            type: "tool-input-start",
            toolCallId: event.toolCallId,
            toolName: event.toolCallName
          }
        ];
      }

      case "TOOL_CALL_ARGS": {
        const buffer = this.toolBuffers.get(event.toolCallId);
        if (buffer) buffer.args += event.delta;
        return [
          {
            type: "tool-input-delta",
            toolCallId: event.toolCallId,
            inputTextDelta: event.delta
          }
        ];
      }

      case "TOOL_CALL_END": {
        const buffer = this.toolBuffers.get(event.toolCallId);
        if (!buffer) {
          return [];
        }
        if (buffer.startedInputAvailable) {
          return [];
        }
        buffer.startedInputAvailable = true;
        const input = parseToolArgs(buffer.args);
        return [
          {
            type: "tool-input-available",
            toolCallId: event.toolCallId,
            toolName: buffer.toolName,
            input
          }
        ];
      }

      case "TOOL_CALL_RESULT":
        return [
          {
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: parseToolOutput(event.content)
          }
        ];

      case "CUSTOM":
        return this.projectCustom(event.name, event.value);

      case "MESSAGES_SNAPSHOT":
        return this.expandMessagesSnapshot(event.messages);

      case "STATE_SNAPSHOT":
        return [
          {
            type: "data-cf.state",
            id: "snapshot",
            data: event.snapshot
          } as UIMessageChunk
        ];

      case "STATE_DELTA":
        return [
          {
            type: "data-cf.state-delta",
            data: event.delta,
            transient: true
          } as UIMessageChunk
        ];

      case "ACTIVITY_SNAPSHOT":
        return [
          {
            type: "data-cf.activity",
            id: "snapshot",
            data: event.activity
          } as UIMessageChunk
        ];

      case "ACTIVITY_DELTA":
        return [
          {
            type: "data-cf.activity-delta",
            data: event.delta,
            transient: true
          } as UIMessageChunk
        ];

      case "RAW":
        return [
          {
            type: "data-cf.raw",
            data: event.event,
            transient: true
          } as UIMessageChunk
        ];

      default:
        return [];
    }
  }

  private emitLeadingStart(messageId: string): UIMessageChunk[] {
    if (this.leadingStartEmitted) return [];
    if (!this.runStartedBuffered) {
      // A TEXT/REASONING start without a prior RUN_STARTED is legal in
      // mid-stream replay scenarios; emit the leading `start` anyway so
      // the AI SDK gets a well-formed lifecycle.
    }
    this.leadingStartEmitted = true;
    return [{ type: "start", messageId }];
  }

  private projectCustom(name: string, value: unknown): UIMessageChunk[] {
    if (name === CF_TOOL_APPROVAL_REQUEST) {
      const request = value as CFToolApprovalRequestValue;
      return [
        {
          type: "tool-approval-request",
          toolCallId: request.toolCallId,
          approvalId: request.approvalId
        }
      ];
    }
    if (name === CF_TOOL_APPROVAL_DECISION) {
      const decision = value as CFToolApprovalDecisionValue;
      if (decision.approved) {
        return [];
      }
      return [
        {
          type: "tool-output-denied",
          toolCallId: decision.toolCallId
        }
      ];
    }
    // Unknown CUSTOM events surface as data parts so consumers can opt
    // into namespaced handling without losing information.
    return [
      {
        type: `data-${name}`,
        data: value
      } as UIMessageChunk
    ];
  }

  private expandReasoningChunk(event: {
    readonly messageId?: string;
    readonly delta?: string;
  }): UIMessageChunk[] {
    const out: UIMessageChunk[] = [];
    const id = event.messageId ?? this.currentReasoningId;
    if (event.messageId && this.currentReasoningId !== event.messageId) {
      if (this.currentReasoningId !== null) {
        out.push({ type: "reasoning-end", id: this.currentReasoningId });
      }
      this.currentReasoningId = event.messageId;
      out.push(...this.emitLeadingStart(event.messageId));
      out.push({ type: "reasoning-start", id: event.messageId });
    }
    if (id !== null && event.delta) {
      out.push({ type: "reasoning-delta", id, delta: event.delta });
    }
    return out;
  }

  private expandMessagesSnapshot(messages: AGUIMessage[]): UIMessageChunk[] {
    // Snapshot expansion is replay-only; emit a synthetic chunk stream
    // that mirrors what live events would have produced for these
    // messages. The chunks are NOT idempotent across overlapping live
    // tails — callers must only invoke this on reconnect, before any
    // live event has been forwarded.
    const out: UIMessageChunk[] = [];
    for (const message of messages) {
      switch (message.role) {
        case "user":
          // User messages do not flow through UIMessageChunk on the
          // assistant turn boundary; they are seeded via `setMessages`.
          // We surface them as data parts so consumers can mirror them
          // if needed, but skip them in the default chunk stream.
          continue;
        case "assistant":
          out.push(...this.expandAssistantMessage(message));
          break;
        case "tool":
          out.push(...this.expandToolMessage(message));
          break;
        case "reasoning":
          out.push(...this.expandReasoningMessage(message));
          break;
        case "system":
        case "developer":
        case "activity":
          continue;
      }
    }
    return out;
  }

  private expandAssistantMessage(message: AssistantMessage): UIMessageChunk[] {
    const out: UIMessageChunk[] = [];
    out.push(...this.emitLeadingStart(message.id));
    if (message.content) {
      out.push({ type: "text-start", id: message.id });
      out.push({ type: "text-delta", id: message.id, delta: message.content });
      out.push({ type: "text-end", id: message.id });
    }
    for (const call of message.toolCalls ?? []) {
      out.push({
        type: "tool-input-start",
        toolCallId: call.id,
        toolName: call.function.name
      });
      out.push({
        type: "tool-input-delta",
        toolCallId: call.id,
        inputTextDelta: call.function.arguments
      });
      out.push({
        type: "tool-input-available",
        toolCallId: call.id,
        toolName: call.function.name,
        input: parseToolArgs(call.function.arguments)
      });
    }
    return out;
  }

  private expandToolMessage(message: ToolMessage): UIMessageChunk[] {
    return [
      {
        type: "tool-output-available",
        toolCallId: message.toolCallId,
        output: parseToolOutput(message.content)
      }
    ];
  }

  private expandReasoningMessage(message: ReasoningMessage): UIMessageChunk[] {
    if (!message.content) return [];
    return [
      ...this.emitLeadingStart(message.id),
      { type: "reasoning-start", id: message.id },
      { type: "reasoning-delta", id: message.id, delta: message.content },
      { type: "reasoning-end", id: message.id }
    ];
  }
}

function parseToolArgs(buffered: string): unknown {
  if (buffered.length === 0) return {};
  try {
    return JSON.parse(buffered);
  } catch {
    return {};
  }
}

function parseToolOutput(content: string): unknown {
  if (content.length === 0) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

// Re-export under structural names so the test file can assert with
// readable type imports if needed.
export type {
  AssistantMessage as ProjectorAssistantMessage,
  ToolMessage as ProjectorToolMessage,
  ReasoningMessage as ProjectorReasoningMessage,
  UserMessage as ProjectorUserMessage
};
