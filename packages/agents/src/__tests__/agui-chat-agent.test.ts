import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import {
  CF_TOOL_APPROVAL_DECISION,
  CF_TOOL_APPROVAL_REQUEST,
  type AGUIEvent,
  type AssistantMessage,
  type CFToolApprovalDecisionValue,
  type CFToolApprovalRequestValue,
  type CustomEvent,
  type UserMessage,
  PERSISTED_MESSAGE_SCHEMA_VERSION
} from "../chat/agui-types";
import { CHAT_MESSAGE_TYPES } from "../chat/protocol";
import {
  collectUntilDone,
  connectChatWS,
  isStreamResumeNoneFrame,
  isStreamResumingFrame,
  isUseChatResponseMessage,
  parseEventFromFrame,
  sendCancel,
  sendChatRequest,
  sendClearRequest,
  waitForChatClearBroadcast
} from "./test-utils";

const BASIC_PATH = "basic-a-g-u-i-agent";
const SSE_PATH = "s-s-e-reply-a-g-u-i-agent";
const SLOW_PATH = "slow-s-s-e-a-g-u-i-agent";
const APPROVAL_PATH = "approval-a-g-u-i-agent";
const RECORDING_PATH = "recording-a-g-u-i-agent";

type SerializedMessage = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMessages(json: string): SerializedMessage[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected array");
  }
  return parsed.filter((m): m is SerializedMessage => isObject(m));
}

function hasRole(m: SerializedMessage, role: string): boolean {
  return m.role === role;
}

function asAssistant(m: SerializedMessage): AssistantMessage {
  if (m.role !== "assistant" || typeof m.id !== "string") {
    throw new Error(`expected assistant, got ${JSON.stringify(m)}`);
  }
  return m as unknown as AssistantMessage;
}

function isCustom(e: AGUIEvent): e is CustomEvent {
  return e.type === "CUSTOM";
}

describe("AGUIChatAgent — SQL setup", () => {
  it("creates persistence tables on construction", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);
    const tables = await stub.getTableNames();
    expect(tables).toContain("cf_ai_chat_agent_messages");
    expect(tables).toContain("cf_ai_chat_request_context");
  });

  it("initializes a fresh agent with an empty messages array", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);
    const inMemory = parseMessages(await stub.getInMemoryMessagesJSON());
    expect(inMemory).toEqual([]);
  });
});

describe("AGUIChatAgent — persistence with v6 schema marker", () => {
  it("persists messages incrementally without deleting existing rows", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);

    await stub.callPersist([{ id: "incr-1", role: "user", content: "first" }]);
    await stub.callPersist([
      { id: "incr-1", role: "user", content: "first" },
      { id: "incr-2", role: "assistant", content: "second" }
    ]);

    const rows = await stub.getRawRows();
    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["incr-1", "incr-2"]);
  });

  it("writes the v6 marker into every persisted row", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);

    const user: UserMessage = {
      id: "u-1",
      role: "user",
      content: "hello"
    };
    const assistant: AssistantMessage = {
      id: "a-1",
      role: "assistant",
      content: "world"
    };
    await stub.callPersist([user, assistant]);

    const rows = await stub.getRawRows();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const parsed = JSON.parse(row.message) as unknown;
      expect(isObject(parsed)).toBe(true);
      if (!isObject(parsed)) throw new Error("row JSON not an object");
      expect(parsed._v).toBe(PERSISTED_MESSAGE_SCHEMA_VERSION);
    }
  });

  it("strips the v6 marker when reloading into the in-memory list", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);

    const user: UserMessage = {
      id: "u-strip",
      role: "user",
      content: "ping"
    };
    await stub.callPersist([user]);

    const inMemory = parseMessages(await stub.getInMemoryMessagesJSON());
    expect(inMemory.length).toBe(1);
    const loaded = inMemory[0];
    expect(loaded).toBeDefined();
    expect(loaded._v).toBeUndefined();
    expect(loaded.id).toBe("u-strip");
    expect(loaded.role).toBe("user");
  });
});

describe("AGUIChatAgent — legacy v5 row migration on load", () => {
  it("migrates a v5 UIMessage row into an AG-UI AssistantMessage at load time", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);

    const legacy = {
      id: "legacy-a-1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }]
    };
    await stub.seedRawRow("legacy-a-1", JSON.stringify(legacy));

    const reloaded = parseMessages(await stub.clearAndReloadJSON());
    expect(reloaded.length).toBe(1);
    const msg = reloaded[0];
    expect(msg).toBeDefined();
    const assistant = asAssistant(msg);
    expect(assistant.id).toBe("legacy-a-1");
    expect(assistant.content).toBe("hi");
  });

  it("rewrites a migrated message with the v6 marker on next persist", async () => {
    const room = crypto.randomUUID();
    const stub = await getAgentByName(env.BasicAGUIAgent, room);

    const legacy = {
      id: "legacy-u-1",
      role: "user",
      parts: [{ type: "text", text: "boot" }]
    };
    await stub.seedRawRow("legacy-u-1", JSON.stringify(legacy));

    const reloaded = parseMessages(await stub.clearAndReloadJSON());
    expect(reloaded.length).toBe(1);
    await stub.repersistFromLoadedMessages();

    const rows = await stub.getRawRows();
    const matching = rows.find((r) => r.id === "legacy-u-1");
    expect(matching).toBeDefined();
    if (!matching) throw new Error("missing row");
    const parsed = JSON.parse(matching.message) as unknown;
    if (!isObject(parsed)) throw new Error("row JSON not an object");
    expect(parsed._v).toBe(PERSISTED_MESSAGE_SCHEMA_VERSION);
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("boot");
  });
});

describe("AGUIChatAgent — SSE reply forwarding", () => {
  it("preserves SSE event ordering across the wire", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${SSE_PATH}/${room}`);

    const requestId = "req-sse-order";
    const user: UserMessage = {
      id: "u-sse-ord",
      role: "user",
      content: "go"
    };

    const collecting = collectUntilDone(ws, requestId);
    sendChatRequest(ws, requestId, { messages: [user] });
    const { frames, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    const eventTypes: string[] = [];
    for (const f of frames) {
      if (!isUseChatResponseMessage(f) || f.id !== requestId) continue;
      const ev = parseEventFromFrame(f);
      if (ev) eventTypes.push(ev.type);
    }
    expect(eventTypes[0]).toBe("RUN_STARTED");
    expect(eventTypes[1]).toBe("TEXT_MESSAGE_START");
    expect(eventTypes[eventTypes.length - 1]).toBe("RUN_FINISHED");
    const endIdx = eventTypes.indexOf("TEXT_MESSAGE_END");
    const startIdx = eventTypes.indexOf("TEXT_MESSAGE_START");
    expect(endIdx).toBeGreaterThan(startIdx);

    ws.close(1000);
  });

  it("forwards AG-UI SSE events verbatim and persists the assistant content", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${SSE_PATH}/${room}`);

    const user: UserMessage = {
      id: "u-sse-1",
      role: "user",
      content: "say hello"
    };

    const requestId = "req-sse-1";
    const collecting = collectUntilDone(ws, requestId);
    sendChatRequest(ws, requestId, { messages: [user] });
    const { frames, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    const responseFrames = frames.filter(isUseChatResponseMessage);
    const events: AGUIEvent[] = [];
    for (const f of responseFrames) {
      if (f.id !== requestId) continue;
      const ev = parseEventFromFrame(f);
      if (ev) events.push(ev);
    }

    expect(events.some((e) => e.type === "RUN_STARTED")).toBe(true);
    expect(events.some((e) => e.type === "TEXT_MESSAGE_START")).toBe(true);
    const contents = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(contents.length).toBe(2);
    expect(events.some((e) => e.type === "TEXT_MESSAGE_END")).toBe(true);
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true);

    const terminal = responseFrames.find(
      (f) => f.id === requestId && f.done === true
    );
    expect(terminal).toBeDefined();

    ws.close(1000);

    const stub = await getAgentByName(env.SSEReplyAGUIAgent, room);
    const persisted = parseMessages(await stub.getPersistedMessagesJSON());
    const assistantRow = persisted.find((m) => hasRole(m, "assistant"));
    expect(assistantRow).toBeDefined();
    if (!assistantRow) throw new Error("no assistant persisted");
    const assistant = asAssistant(assistantRow);
    expect(assistant.content).toBe("hello world");
    expect(assistant.id).toBe("asst-sse-1");
  });
});

describe("AGUIChatAgent — chat clear wire handling", () => {
  it("deletes all rows from the database", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${BASIC_PATH}/${room}`);

    const stub = await getAgentByName(env.BasicAGUIAgent, room);
    await stub.callPersist([
      { id: "u-pre-1", role: "user", content: "first" },
      { id: "u-pre-2", role: "user", content: "second" }
    ]);

    const beforeRows = await stub.getRawRows();
    expect(beforeRows.length).toBe(2);

    sendClearRequest(ws);
    await new Promise((r) => setTimeout(r, 200));

    const afterRows = await stub.getRawRows();
    expect(afterRows.length).toBe(0);
    const inMemory = parseMessages(await stub.getInMemoryMessagesJSON());
    expect(inMemory).toEqual([]);

    ws.close(1000);
  });

  it("broadcasts CHAT_CLEAR to peers that did not initiate the clear", async () => {
    const room = crypto.randomUUID();
    const { ws: senderWs } = await connectChatWS(
      `/agents/${BASIC_PATH}/${room}`
    );
    const { ws: peerWs } = await connectChatWS(`/agents/${BASIC_PATH}/${room}`);

    const stub = await getAgentByName(env.BasicAGUIAgent, room);
    await stub.callPersist([{ id: "u-peer-1", role: "user", content: "x" }]);

    const cleared = waitForChatClearBroadcast(peerWs);
    sendClearRequest(senderWs);
    await cleared;

    senderWs.close(1000);
    peerWs.close(1000);
  });
});

describe("AGUIChatAgent — cancel wire handling", () => {
  it("aborts an in-flight turn and stops emitting non-terminal chunks", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${SLOW_PATH}/${room}`);

    const requestId = "req-cancel-1";
    const user: UserMessage = {
      id: "u-cancel-1",
      role: "user",
      content: "stream slowly"
    };

    const collecting = collectUntilDone(ws, requestId, 5000);
    sendChatRequest(ws, requestId, {
      messages: [user],
      delayMs: 60,
      chunkCount: 20
    });

    await new Promise((r) => setTimeout(r, 150));
    sendCancel(ws, requestId);

    const { frames, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    const terminal = frames.filter(
      (f) =>
        isUseChatResponseMessage(f) && f.id === requestId && f.done === true
    );
    expect(terminal.length).toBe(1);

    const chunksAfterTerminal: typeof frames = [];
    let sawTerminal = false;
    for (const f of frames) {
      if (sawTerminal) {
        if (isUseChatResponseMessage(f) && f.id === requestId) {
          chunksAfterTerminal.push(f);
        }
        continue;
      }
      if (isUseChatResponseMessage(f) && f.id === requestId && f.done) {
        sawTerminal = true;
      }
    }
    expect(chunksAfterTerminal.length).toBe(0);

    ws.close(1000);
  });
});

describe("AGUIChatAgent — resume wire handling", () => {
  it("returns STREAM_RESUME_NONE when no stream is active", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${SLOW_PATH}/${room}`);

    const noneSeen = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        resolve(false);
      }, 2000);
      function handler(event: MessageEvent) {
        const data = JSON.parse(event.data as string) as unknown;
        if (isStreamResumeNoneFrame(data)) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(true);
        }
      }
      ws.addEventListener("message", handler);
    });

    ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST }));
    expect(await noneSeen).toBe(true);

    ws.close(1000);
  });

  it("sends STREAM_RESUMING when a second connection opens during an in-flight turn", async () => {
    const room = crypto.randomUUID();
    const { ws: ws1 } = await connectChatWS(`/agents/${SLOW_PATH}/${room}`);

    const requestId = "req-resume-1";
    const user: UserMessage = {
      id: "u-resume-1",
      role: "user",
      content: "stream"
    };

    const completing = collectUntilDone(ws1, requestId, 6000);
    sendChatRequest(ws1, requestId, {
      messages: [user],
      delayMs: 80,
      chunkCount: 10
    });

    await new Promise((r) => setTimeout(r, 150));

    const { ws: ws2 } = await connectChatWS(`/agents/${SLOW_PATH}/${room}`);
    const resumingPromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws2.removeEventListener("message", handler);
        resolve(false);
      }, 3000);
      function handler(event: MessageEvent) {
        const data = JSON.parse(event.data as string) as unknown;
        if (isStreamResumingFrame(data) && data.id === requestId) {
          clearTimeout(timeout);
          ws2.removeEventListener("message", handler);
          resolve(true);
        }
      }
      ws2.addEventListener("message", handler);
    });

    expect(await resumingPromise).toBe(true);

    ws2.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
        id: requestId
      })
    );

    const { timedOut } = await completing;
    expect(timedOut).toBe(false);

    ws1.close(1000);
    ws2.close(1000);
  });
});

describe("AGUIChatAgent — tool approval CUSTOM round-trip", () => {
  it("emits a decision CUSTOM event when the client approves the tool call", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${APPROVAL_PATH}/${room}`);

    const toolCallId = "tc-approval-x";
    const approvalId = "ap-x";
    const requestId = "req-approval-1";
    const user: UserMessage = {
      id: "u-approval-1",
      role: "user",
      content: "approve me"
    };

    const initial = collectUntilDone(ws, requestId, 5000);
    sendChatRequest(ws, requestId, {
      messages: [user],
      toolCallId,
      approvalId,
      toolName: "writeFile"
    });
    const { frames: initialFrames, timedOut: initialTimedOut } = await initial;
    expect(initialTimedOut).toBe(false);

    const initialEvents: AGUIEvent[] = [];
    for (const f of initialFrames) {
      if (!isUseChatResponseMessage(f) || f.id !== requestId) continue;
      const ev = parseEventFromFrame(f);
      if (ev) initialEvents.push(ev);
    }
    const requestEvent = initialEvents.find(
      (e): e is CustomEvent =>
        isCustom(e) && e.name === CF_TOOL_APPROVAL_REQUEST
    );
    expect(requestEvent).toBeDefined();
    if (!requestEvent) throw new Error("missing approval request event");
    const requestValue = requestEvent.value as CFToolApprovalRequestValue;
    expect(requestValue.toolCallId).toBe(toolCallId);
    expect(requestValue.approvalId).toBe(approvalId);

    const decisionSeen = new Promise<CustomEvent | null>((resolve) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        resolve(null);
      }, 3000);
      function handler(event: MessageEvent) {
        const data = JSON.parse(event.data as string) as unknown;
        if (!isUseChatResponseMessage(data)) return;
        const ev = parseEventFromFrame(data);
        if (!ev || !isCustom(ev)) return;
        if (ev.name !== CF_TOOL_APPROVAL_DECISION) return;
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(ev);
      }
      ws.addEventListener("message", handler);
    });

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
        toolCallId,
        approved: true
      })
    );

    const decisionEvent = await decisionSeen;
    expect(decisionEvent).not.toBeNull();
    if (!decisionEvent) throw new Error("no decision event");
    const decisionValue = decisionEvent.value as CFToolApprovalDecisionValue;
    expect(decisionValue.toolCallId).toBe(toolCallId);
    expect(decisionValue.approved).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const stub = await getAgentByName(env.ApprovalAGUIAgent, room);
    const persisted = parseMessages(await stub.getPersistedMessagesJSON());
    const assistantRow = persisted.find(
      (m) => hasRole(m, "assistant") && m.id === "asst-approval-1"
    );
    expect(assistantRow).toBeDefined();

    ws.close(1000);
  });

  it("emits a decision CUSTOM event with approved=false when the client rejects", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${APPROVAL_PATH}/${room}`);

    const toolCallId = "tc-reject-1";
    const approvalId = "ap-reject-1";
    const requestId = "req-reject-1";
    const user: UserMessage = {
      id: "u-reject-1",
      role: "user",
      content: "reject me"
    };

    const initial = collectUntilDone(ws, requestId, 5000);
    sendChatRequest(ws, requestId, {
      messages: [user],
      toolCallId,
      approvalId,
      toolName: "deleteFile"
    });
    const { timedOut } = await initial;
    expect(timedOut).toBe(false);

    const decisionSeen = new Promise<CustomEvent | null>((resolve) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        resolve(null);
      }, 3000);
      function handler(event: MessageEvent) {
        const data = JSON.parse(event.data as string) as unknown;
        if (!isUseChatResponseMessage(data)) return;
        const ev = parseEventFromFrame(data);
        if (!ev || !isCustom(ev)) return;
        if (ev.name !== CF_TOOL_APPROVAL_DECISION) return;
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(ev);
      }
      ws.addEventListener("message", handler);
    });

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
        toolCallId,
        approved: false
      })
    );

    const decisionEvent = await decisionSeen;
    expect(decisionEvent).not.toBeNull();
    if (!decisionEvent) throw new Error("no decision event");
    const value = decisionEvent.value as CFToolApprovalDecisionValue;
    expect(value.toolCallId).toBe(toolCallId);
    expect(value.approved).toBe(false);

    ws.close(1000);
  });
});

describe("AGUIChatAgent — auto-continuation", () => {
  it("does not enqueue a continuation when autoContinue is false on TOOL_RESULT", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${RECORDING_PATH}/${room}`);

    const requestId = "req-rec-no-cont";
    const user: UserMessage = {
      id: "u-rec-no-cont",
      role: "user",
      content: "go"
    };

    const initial = collectUntilDone(ws, requestId, 5000);
    sendChatRequest(ws, requestId, { messages: [user] });
    const { timedOut } = await initial;
    expect(timedOut).toBe(false);

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "tc-recording-1",
        toolName: "echo",
        output: { ok: true },
        state: "output-available",
        autoContinue: false
      })
    );

    await new Promise((r) => setTimeout(r, 500));

    const stub = await getAgentByName(env.RecordingAGUIAgent, room);
    const invocations = await stub.getInvocations();
    expect(invocations.length).toBe(1);
    expect(invocations[0].continuation).toBe(false);

    ws.close(1000);
  });

  it("invokes onChatMessage a second time with continuation=true when autoContinue is set on TOOL_RESULT", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/${RECORDING_PATH}/${room}`);

    const requestId = "req-rec-1";
    const user: UserMessage = {
      id: "u-rec-1",
      role: "user",
      content: "go"
    };

    const initial = collectUntilDone(ws, requestId, 5000);
    sendChatRequest(ws, requestId, { messages: [user] });
    const { timedOut } = await initial;
    expect(timedOut).toBe(false);

    const stub = await getAgentByName(env.RecordingAGUIAgent, room);
    const afterFirst = await stub.getInvocations();
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].continuation).toBe(false);

    const continuationDone = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", handler);
        resolve(false);
      }, 4000);
      function handler(event: MessageEvent) {
        const data = JSON.parse(event.data as string) as unknown;
        if (!isUseChatResponseMessage(data)) return;
        if (data.continuation !== true) return;
        if (data.done !== true) return;
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(true);
      }
      ws.addEventListener("message", handler);
    });

    ws.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "tc-recording-1",
        toolName: "echo",
        output: { ok: true },
        state: "output-available",
        autoContinue: true
      })
    );

    expect(await continuationDone).toBe(true);

    const afterContinuation = await stub.getInvocations();
    expect(afterContinuation.length).toBe(2);
    const continuationInvocation = afterContinuation[1];
    expect(continuationInvocation).toBeDefined();
    expect(continuationInvocation.continuation).toBe(true);

    ws.close(1000);
  });
});
