/**
 * `@cloudflare/ai-chat` — AI SDK chat agents on the AG-UI engine.
 *
 * The chat engine (turns, persistence, streaming, recovery, transport) is the
 * AG-UI canonical `AGUIChatAgent` in the `agents` package; `AIChatAgent`
 * (./agent.ts) is a projection layer that keeps the legacy AI SDK surface:
 * `onChatMessage` returns an AI SDK `UIMessageChunk` SSE Response,
 * `this.messages` is `UIMessage[]`, and the lifecycle hooks keep their
 * legacy shapes. Persisted rows are AG-UI (`_v: "v6_agui_message"`); legacy
 * rows migrate on first load.
 *
 * Behavior parity with the pre-cutover implementation is pinned by the
 * differential conformance suite in ./conformance (goldens recorded from the
 * legacy class; semantically-equivalent differences are documented in
 * goldens/*.allowlist.md).
 */

export { AIChatAgent } from "./agent";
export type { ChatMessage, OnChatMessageOptions } from "./agent";

// Lifecycle types re-exported from the shared chat toolkit so existing
// consumers (`import type { ChatResponseResult } from "@cloudflare/ai-chat"`)
// continue to work.
export type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext,
  ChatRecoveryOptions,
  ClientToolSchema,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";

export { createToolsFromClientSchemas } from "agents/chat";
