/**
 * AG-UI `Message[]` → Vercel `UIMessage[]`.
 *
 * `AGUIChatAgent.messages` is canonical AG-UI, but every Vercel-path
 * `onChatMessage` needs to feed `convertToModelMessages()`, which wants
 * `UIMessage[]`. This is the projection that closes that gap, and it is the
 * inverse of the `migrateUIMessageToAGUI` shim in `agents/chat`.
 *
 * It is deliberately lossy in one direction only: fields AG-UI carries that
 * have no `UIMessage` counterpart (`encryptedValue`, activity payloads) are
 * dropped rather than smuggled through, because `convertToModelMessages`
 * would discard them anyway.
 */

import type {
  AGUIInputContent,
  AGUIMessage,
  ToolCall
} from "agents/chat/agui-types";
import type { UIMessage } from "ai";

type UIPart = UIMessage["parts"][number];

/**
 * Project canonical AG-UI messages into the `UIMessage` shape.
 *
 * Tool results arrive as standalone `role: "tool"` messages in AG-UI, but
 * `UIMessage` folds them onto the tool part of the assistant turn that
 * issued the call. Results are therefore matched back by `toolCallId` — a
 * result whose call is not found is skipped rather than emitted loose,
 * since a tool part with no input is not a shape the AI SDK accepts.
 */
export function toUIMessages(messages: readonly AGUIMessage[]): UIMessage[] {
  const ui: UIMessage[] = [];
  // toolCallId -> the tool part awaiting its output.
  const pendingToolParts = new Map<string, Record<string, unknown>>();

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const parts = inputContentToParts(message.content);
        if (parts.length) ui.push({ id: message.id, role: "user", parts });
        break;
      }

      case "system":
      case "developer": {
        if (!message.content) break;
        ui.push({
          id: message.id,
          role: "system",
          parts: [{ type: "text", text: message.content }]
        });
        break;
      }

      case "assistant": {
        const parts: UIPart[] = [];
        if (message.content) {
          parts.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          const part = toolCallToPart(call);
          pendingToolParts.set(call.id, part);
          parts.push(part as unknown as UIPart);
        }
        if (parts.length) {
          ui.push({ id: message.id, role: "assistant", parts });
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
        ui.push({
          id: message.id,
          role: "assistant",
          parts: [{ type: "reasoning", text: message.content }]
        });
        break;
      }

      // `activity` is progress metadata with no UIMessage counterpart.
      case "activity":
        break;
    }
  }

  return ui;
}

function toolCallToPart(call: ToolCall): Record<string, unknown> {
  return {
    type: `tool-${call.function.name}`,
    toolCallId: call.id,
    state: "input-available",
    input: parseJSON(call.function.arguments)
  };
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
