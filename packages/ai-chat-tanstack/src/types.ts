/**
 * Wire envelope types for `@cloudflare/ai-chat-tanstack`.
 *
 * The CF_AGENT_* framing is identical to `@cloudflare/ai-chat-vercel`; the
 * body of `CF_AGENT_USE_CHAT_RESPONSE` is raw `JSON.stringify(event)` (no
 * `data: ` prefix — that prefix only appears inside server-side AG-UI SSE
 * bodies). Since TanStack AI is AG-UI-native, the transport parses each
 * body as `JSON.parse(body) as AGUIEvent` and forwards it through to
 * `@tanstack/ai-react`'s `useChat` without any projection step.
 */

import type { AGUIMessage } from "agents/chat/agui-types";

export const MessageType = {
  CF_AGENT_CHAT_MESSAGES: "cf_agent_chat_messages",
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_CHAT_CLEAR: "cf_agent_chat_clear",
  CF_AGENT_CHAT_REQUEST_CANCEL: "cf_agent_chat_request_cancel",
  CF_AGENT_STREAM_RESUMING: "cf_agent_stream_resuming",
  CF_AGENT_STREAM_RESUME_ACK: "cf_agent_stream_resume_ack",
  CF_AGENT_STREAM_RESUME_REQUEST: "cf_agent_stream_resume_request",
  CF_AGENT_STREAM_RESUME_NONE: "cf_agent_stream_resume_none",
  CF_AGENT_TOOL_RESULT: "cf_agent_tool_result",
  CF_AGENT_MESSAGE_UPDATED: "cf_agent_message_updated",
  CF_AGENT_TOOL_APPROVAL: "cf_agent_tool_approval"
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export type OutgoingAGUIWireMessage =
  | { type: typeof MessageType.CF_AGENT_CHAT_CLEAR }
  | {
      type: typeof MessageType.CF_AGENT_CHAT_MESSAGES;
      messages: readonly AGUIMessage[];
    }
  | {
      type: typeof MessageType.CF_AGENT_USE_CHAT_RESPONSE;
      id: string;
      body: string;
      done: boolean;
      error?: boolean;
      continuation?: boolean;
      replay?: boolean;
      replayComplete?: boolean;
    }
  | { type: typeof MessageType.CF_AGENT_STREAM_RESUMING; id: string }
  | { type: typeof MessageType.CF_AGENT_STREAM_RESUME_NONE }
  | {
      type: typeof MessageType.CF_AGENT_MESSAGE_UPDATED;
      message: AGUIMessage;
    };

export type IncomingAGUIWireMessage =
  | { type: typeof MessageType.CF_AGENT_CHAT_CLEAR }
  | {
      type: typeof MessageType.CF_AGENT_USE_CHAT_REQUEST;
      id: string;
      init: Pick<
        RequestInit,
        "method" | "headers" | "body" | "credentials" | "mode"
      >;
    }
  | {
      type: typeof MessageType.CF_AGENT_CHAT_MESSAGES;
      messages: AGUIMessage[];
    }
  | {
      type: typeof MessageType.CF_AGENT_CHAT_REQUEST_CANCEL;
      id: string;
    }
  | {
      type: typeof MessageType.CF_AGENT_STREAM_RESUME_ACK;
      id: string;
    }
  | { type: typeof MessageType.CF_AGENT_STREAM_RESUME_REQUEST }
  | {
      type: typeof MessageType.CF_AGENT_TOOL_RESULT;
      toolCallId: string;
      toolName: string;
      output: unknown;
      state?: "output-available" | "output-error";
      errorText?: string;
      autoContinue?: boolean;
    }
  | {
      type: typeof MessageType.CF_AGENT_TOOL_APPROVAL;
      toolCallId: string;
      approved: boolean;
      autoContinue?: boolean;
    };
