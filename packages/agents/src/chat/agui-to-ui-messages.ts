/**
 * AG-UI `Message[]` → Vercel `UIMessage[]`.
 *
 * The inverse of `migrateUIMessageToAGUI` in `./agui-migration` — the pair
 * must be mutually idempotent: migrate→project→migrate is a fixed point
 * (see `__tests__/agui-migration.test.ts`).
 *
 * Shape notes (pinned by the legacy conformance goldens):
 * - a `reasoning` row folds onto the adjacent FOLLOWING assistant message as
 *   a reasoning part (legacy persisted ONE assistant with
 *   `[{reasoning},{text}]`); a reasoning row with no following assistant
 *   falls back to a standalone assistant message carrying just the part;
 * - tool results arrive as standalone `role: "tool"` messages and are folded
 *   back onto the tool part of the assistant that issued the call;
 * - tool state projects from the result row and the `toolApprovals` CF
 *   extension: `output-available`, `output-error`, `output-denied`,
 *   `approval-responded`, `approval-requested`, else `input-available`;
 * - `extraParts` (file / source-* / data-*) and `metadata` CF extensions are
 *   emitted verbatim.
 *
 * Deliberately lossy in one direction only: fields with no `UIMessage`
 * counterpart (`encryptedValue`, activity payloads) are dropped rather than
 * smuggled through, because `convertToModelMessages` would discard them.
 */

import type { UIMessage } from "ai";
import type {
  AGUIInputContent,
  AGUIMessage,
  ToolApprovalState,
  ToolCall
} from "./agui-types";

type UIPart = UIMessage["parts"][number];

export function toUIMessages(messages: readonly AGUIMessage[]): UIMessage[] {
  const ui: UIMessage[] = [];
  // toolCallId -> the tool part awaiting its output.
  const pendingToolParts = new Map<string, Record<string, unknown>>();
  // Reasoning rows waiting for their adjacent following assistant.
  let pendingReasoning: Array<{
    id: string;
    metadata?: unknown;
    text: string;
    partial?: true;
  }> = [];

  // Streamed parts carry a state marker (legacy shape): "done" once the
  // stream closed, "streaming" while open / when interrupted (`partial`).
  const partState = (partial: true | undefined) =>
    partial ? "streaming" : "done";

  // The most recent assistant pushed to `ui` — a reasoning row with no
  // FOLLOWING assistant (a continuation's reasoning persists after its
  // assistant in table order) folds onto it as trailing parts.
  let lastAssistant: UIMessage | null = null;

  const flushStandaloneReasoning = () => {
    for (const r of pendingReasoning) {
      if (lastAssistant) {
        lastAssistant.parts.push({
          type: "reasoning",
          text: r.text,
          state: partState(r.partial)
        });
        continue;
      }
      ui.push({
        id: r.id,
        role: "assistant",
        parts: [
          { type: "reasoning", text: r.text, state: partState(r.partial) }
        ],
        ...(r.metadata !== undefined && { metadata: r.metadata })
      } as UIMessage);
    }
    pendingReasoning = [];
  };

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        flushStandaloneReasoning();
        lastAssistant = null;
        const parts = inputContentToParts(message.content);
        if (parts.length) {
          ui.push({
            id: message.id,
            role: "user",
            parts,
            ...(message.metadata !== undefined && {
              metadata: message.metadata
            })
          } as UIMessage);
        }
        break;
      }

      case "system":
      case "developer": {
        flushStandaloneReasoning();
        lastAssistant = null;
        if (!message.content) break;
        // `aguiRole` markers let migrate restore the developer role.
        const metadata =
          message.role === "developer"
            ? {
                ...(isObject(message.metadata) ? message.metadata : {}),
                aguiRole: "developer"
              }
            : message.metadata;
        ui.push({
          id: message.id,
          role: "system",
          parts: [{ type: "text", text: message.content }],
          ...(metadata !== undefined && { metadata })
        } as UIMessage);
        break;
      }

      case "assistant": {
        const parts: UIPart[] = [];
        for (const r of pendingReasoning) {
          parts.push({
            type: "reasoning",
            text: r.text,
            state: partState(r.partial)
          });
        }
        pendingReasoning = [];
        for (const extra of message.extraParts ?? []) {
          parts.push(extra as unknown as UIPart);
        }
        for (const call of message.toolCalls ?? []) {
          const part = toolCallToPart(call, message.toolApprovals?.[call.id]);
          pendingToolParts.set(call.id, part);
          parts.push(part as unknown as UIPart);
        }
        if (message.content) {
          parts.push({
            type: "text",
            text: message.content,
            state: partState(message.partial)
          });
        }
        if (parts.length) {
          const assistant = {
            id: message.id,
            role: "assistant",
            parts,
            ...(message.metadata !== undefined && {
              metadata: message.metadata
            })
          } as UIMessage;
          ui.push(assistant);
          lastAssistant = assistant;
        }
        break;
      }

      case "tool": {
        const part = pendingToolParts.get(message.toolCallId);
        if (!part) break;
        pendingToolParts.delete(message.toolCallId);
        if (message.error) {
          part.state = "output-error";
          part.errorText = message.error;
        } else {
          part.state = "output-available";
          part.output = parseJSON(message.content);
        }
        break;
      }

      case "reasoning": {
        if (!message.content) break;
        pendingReasoning.push({
          id: message.id,
          text: message.content,
          ...(message.partial && { partial: message.partial }),
          ...(message.metadata !== undefined && { metadata: message.metadata })
        });
        break;
      }

      // `activity` is progress metadata with no UIMessage counterpart.
      case "activity":
        break;
    }
  }
  flushStandaloneReasoning();

  return ui;
}

function toolCallToPart(
  call: ToolCall,
  approval: ToolApprovalState | undefined
): Record<string, unknown> {
  const base = {
    type: `tool-${call.function.name}`,
    toolCallId: call.id,
    toolName: call.function.name,
    input: parseJSON(call.function.arguments)
  };
  if (!approval) return { ...base, state: "input-available" };
  const approvalField = {
    id: approval.approvalId,
    ...(approval.approved !== undefined && { approved: approval.approved })
  };
  const state =
    approval.approved === undefined
      ? "approval-requested"
      : approval.approved
        ? "approval-responded"
        : "output-denied";
  return { ...base, state, approval: approvalField };
}

function inputContentToParts(
  content: string | readonly AGUIInputContent[]
): UIPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  const parts: UIPart[] = [];
  for (const item of content) {
    if (item.type === "text") {
      if (item.text) parts.push({ type: "text", text: item.text });
      continue;
    }
    // image / audio / video / document all carry an AGUIInputContentSource,
    // which maps onto the AI SDK's file part.
    const { source } = item;
    parts.push({
      type: "file",
      mediaType: source.mimeType ?? "application/octet-stream",
      url:
        source.type === "url"
          ? source.value
          : `data:${source.mimeType};base64,${source.value}`
    } as UIPart);
  }
  return parts;
}

function parseJSON(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    // Providers occasionally emit bare strings for trivial results; passing
    // the raw text through beats throwing away the turn.
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
