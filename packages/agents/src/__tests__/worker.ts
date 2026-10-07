import { routeAgentRequest } from "../index";
import { AGUIChatAgent, type OnChatMessageOptions } from "../agui-chat-agent";
import type { AGUIEvent, AGUIMessage } from "../chat/agui-types";
import {
  CF_TOOL_APPROVAL_REQUEST,
  type CFToolApprovalRequestValue
} from "../chat/agui-types";

function toJSON(messages: readonly AGUIMessage[]): string {
  return JSON.stringify(messages);
}

export type Env = {
  BasicAGUIAgent: DurableObjectNamespace<BasicAGUIAgent>;
  SSEReplyAGUIAgent: DurableObjectNamespace<SSEReplyAGUIAgent>;
  SlowSSEAGUIAgent: DurableObjectNamespace<SlowSSEAGUIAgent>;
  ApprovalAGUIAgent: DurableObjectNamespace<ApprovalAGUIAgent>;
  RecordingAGUIAgent: DurableObjectNamespace<RecordingAGUIAgent>;
  BareAGUIAgent: DurableObjectNamespace<BareAGUIAgent>;
};

function encodeSSE(events: ReadonlyArray<AGUIEvent>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
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

function encodeSSESlow(
  events: ReadonlyArray<AGUIEvent>,
  delayMs: number,
  abortSignal?: AbortSignal
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (const event of events) {
        if (abortSignal?.aborted) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
        if (abortSignal?.aborted) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      if (!abortSignal?.aborted) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

/**
 * Minimal agent for SQL setup / persistence / migration tests.
 * Exposes RPC helpers that bypass the wire protocol.
 */
export class BasicAGUIAgent extends AGUIChatAgent<Env> {
  async onChatMessage(): Promise<Response | undefined> {
    return encodeSSE([
      {
        type: "RUN_STARTED",
        threadId: "thread-basic",
        runId: "run-basic"
      },
      {
        type: "RUN_FINISHED",
        threadId: "thread-basic",
        runId: "run-basic"
      }
    ]);
  }

  getRawRows(): Array<{ id: string; message: string }> {
    const rows =
      this.sql<{
        id: string;
        message: string;
      }>`select id, message from cf_ai_chat_agent_messages order by created_at` ||
      [];
    return rows.map((r) => ({ id: r.id, message: r.message }));
  }

  getInMemoryMessagesJSON(): string {
    return toJSON(this.messages);
  }

  getTableNames(): string[] {
    const rows =
      this.sql<{
        name: string;
      }>`select name from sqlite_master where type='table' order by name` || [];
    return rows.map((r) => r.name);
  }

  async seedRawRow(id: string, json: string): Promise<void> {
    this
      .sql`insert into cf_ai_chat_agent_messages (id, message) values (${id}, ${json})`;
  }

  async clearAndReloadJSON(): Promise<string> {
    const rows =
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      [];
    const parsed = rows.map((r) => JSON.parse(r.message as string));
    const { autoTransformAGUIMessages } =
      await import("../chat/agui-migration");
    const transformed = autoTransformAGUIMessages(parsed);
    this.messages = transformed;
    return toJSON(transformed);
  }

  async callPersist(messages: AGUIMessage[]): Promise<void> {
    await this.persistMessages(messages);
  }

  async repersistFromLoadedMessages(): Promise<void> {
    await this.persistMessages(this.messages);
  }
}

/**
 * Agent that emits a canonical AG-UI run for SSE forwarding tests.
 */
export class SSEReplyAGUIAgent extends AGUIChatAgent<Env> {
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    _options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const messageId = "asst-sse-1";
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "thread-sse", runId: "run-sse" },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "hello " },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "world" },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: "thread-sse", runId: "run-sse" }
    ];
    return encodeSSE(events);
  }

  getPersistedMessagesJSON(): string {
    return toJSON(this.messages);
  }
}

/**
 * Agent whose stream emits one chunk every `delayMs` so tests can cancel /
 * resume mid-flight.
 */
export class SlowSSEAGUIAgent extends AGUIChatAgent<Env> {
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const body = (options?.body ?? {}) as {
      delayMs?: number;
      chunkCount?: number;
      messageId?: string;
    };
    const delayMs = typeof body.delayMs === "number" ? body.delayMs : 80;
    const chunkCount =
      typeof body.chunkCount === "number" ? body.chunkCount : 10;
    const messageId =
      typeof body.messageId === "string" ? body.messageId : "asst-slow-1";

    const events: AGUIEvent[] = [];
    events.push({
      type: "RUN_STARTED",
      threadId: "thread-slow",
      runId: "run-slow"
    });
    events.push({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
    for (let i = 0; i < chunkCount; i++) {
      events.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: `chunk-${i} `
      });
    }
    events.push({ type: "TEXT_MESSAGE_END", messageId });
    events.push({
      type: "RUN_FINISHED",
      threadId: "thread-slow",
      runId: "run-slow"
    });

    return encodeSSESlow(events, delayMs, options?.abortSignal);
  }
}

/**
 * Agent that emits a tool-approval CUSTOM event. The first turn requests
 * approval for a tool call; subsequent turns emit a plain text result.
 */
export class ApprovalAGUIAgent extends AGUIChatAgent<Env> {
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const body = (options?.body ?? {}) as {
      toolCallId?: string;
      approvalId?: string;
      toolName?: string;
    };
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : "tc-approval-1";
    const approvalId =
      typeof body.approvalId === "string" ? body.approvalId : "ap-1";
    const toolName =
      typeof body.toolName === "string" ? body.toolName : "writeFile";
    const messageId = "asst-approval-1";
    const value: CFToolApprovalRequestValue = {
      toolCallId,
      toolName,
      input: { path: "/tmp/x", contents: "hi" },
      approvalId
    };
    const events: AGUIEvent[] = [
      {
        type: "RUN_STARTED",
        threadId: "thread-approval",
        runId: "run-approval"
      },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "needs approval" },
      { type: "TEXT_MESSAGE_END", messageId },
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: toolName,
        parentMessageId: messageId
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify(value.input)
      },
      { type: "TOOL_CALL_END", toolCallId },
      { type: "CUSTOM", name: CF_TOOL_APPROVAL_REQUEST, value },
      {
        type: "RUN_FINISHED",
        threadId: "thread-approval",
        runId: "run-approval"
      }
    ];
    return encodeSSE(events);
  }

  getPersistedMessagesJSON(): string {
    return toJSON(this.messages);
  }
}

/**
 * Agent that records every onChatMessage invocation so tests can verify
 * continuation calls are made with options.continuation === true.
 */
export class RecordingAGUIAgent extends AGUIChatAgent<Env> {
  private _invocations: Array<{
    requestId: string;
    continuation: boolean;
    bodyKeys: string[];
  }> = [];

  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    this._invocations.push({
      requestId: options?.requestId ?? "",
      continuation: options?.continuation === true,
      bodyKeys: options?.body ? Object.keys(options.body) : []
    });

    const continuation = options?.continuation === true;
    const messageId = continuation ? "asst-recording-cont" : "asst-recording-1";
    const toolCallId = "tc-recording-1";

    if (!continuation) {
      const events: AGUIEvent[] = [
        {
          type: "RUN_STARTED",
          threadId: "thread-rec",
          runId: "run-rec-1"
        },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "calling tool" },
        { type: "TEXT_MESSAGE_END", messageId },
        {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: "echo",
          parentMessageId: messageId
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId,
          delta: JSON.stringify({ text: "hi" })
        },
        { type: "TOOL_CALL_END", toolCallId },
        {
          type: "RUN_FINISHED",
          threadId: "thread-rec",
          runId: "run-rec-1"
        }
      ];
      return encodeSSE(events);
    }

    const contEvents: AGUIEvent[] = [
      {
        type: "RUN_STARTED",
        threadId: "thread-rec",
        runId: "run-rec-2"
      },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "done" },
      { type: "TEXT_MESSAGE_END", messageId },
      {
        type: "RUN_FINISHED",
        threadId: "thread-rec",
        runId: "run-rec-2"
      }
    ];
    return encodeSSE(contEvents);
  }

  getInvocations(): Array<{
    requestId: string;
    continuation: boolean;
    bodyKeys: string[];
  }> {
    return [...this._invocations];
  }
}

/**
 * Agent that does not override onChatMessage. Used to verify the base
 * class's "no response" path.
 */
export class BareAGUIAgent extends AGUIChatAgent<Env> {}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/warmup/") {
      return new Response("ok");
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
