/**
 * AG-UI `Message[]` → TanStack `ModelMessage[]`.
 *
 * Symmetric with `toUIMessages()` in `@cloudflare/ai-chat`, and a
 * good measure of how close the two formats are: TanStack's `ModelMessage`
 * already carries `role` / `content` / `toolCalls` / `toolCallId` with the
 * same meanings AG-UI gives them, and its multimodal `ContentPart` union is
 * structurally identical to AG-UI's `AGUIInputContent` apart from the text
 * variant's field name (`content` vs `text`).
 *
 * So this is a rename and a role fold, not a projection. Compare against
 * the Vercel adapter's version, which has to reshape tool results onto the
 * assistant turn that issued them.
 */

import type { AGUIInputContent, AGUIMessage } from "agents/chat/agui-types";
import type { ContentPart, ModelMessage } from "@tanstack/ai";

/**
 * Project canonical AG-UI messages into TanStack `ModelMessage`s.
 *
 * `ModelMessage` has no `system` role — system and developer turns are
 * returned separately as `systemPrompts`, which is the shape `chat()`
 * accepts. `reasoning` and `activity` messages are dropped: they are
 * transcript metadata, not model input.
 */
export function toModelMessages(messages: readonly AGUIMessage[]): {
  messages: ModelMessage[];
  systemPrompts: string[];
} {
  const out: ModelMessage[] = [];
  const systemPrompts: string[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        if (message.content) systemPrompts.push(message.content);
        break;
      }

      case "user": {
        out.push({
          role: "user",
          content: toModelContent(message.content),
          ...(message.name ? { name: message.name } : {})
        });
        break;
      }

      case "assistant": {
        out.push({
          role: "assistant",
          content: message.content ?? null,
          ...(message.toolCalls?.length
            ? { toolCalls: message.toolCalls.map((c) => ({ ...c })) }
            : {})
        });
        break;
      }

      case "tool": {
        out.push({
          role: "tool",
          content: message.error ?? message.content,
          toolCallId: message.toolCallId
        });
        break;
      }

      // Transcript-only; not model input.
      case "reasoning":
      case "activity":
        break;
    }
  }

  return { messages: out, systemPrompts };
}

function toModelContent(
  content: string | readonly AGUIInputContent[]
): string | ContentPart[] {
  if (typeof content === "string") return content;

  return content.map((item): ContentPart => {
    // AG-UI names the text payload `text`; TanStack names it `content`.
    // Every other variant is structurally identical.
    if (item.type === "text") return { type: "text", content: item.text };
    return { type: item.type, source: item.source, metadata: item.metadata };
  });
}
