/**
 * Scenario driver for the conformance suite.
 *
 * Records a normalized trace per scenario — wire frames per client, persisted
 * rows at end of turn, and the client-visible message list (`/get-messages`) —
 * and diffs it against a committed golden. Goldens are vitest file snapshots
 * under `./goldens/`; re-record with `UPDATE_GOLDENS=1 pnpm test:conformance`.
 *
 * Normalization is deterministic: every id-valued string is mapped to
 * `id-1`, `id-2`, … in order of first appearance across the whole trace, and
 * every timestamp-valued number becomes `"TS"`.
 */

import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";

export type WireFrame = {
  type: string;
  id?: string;
  body?: unknown;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
  [key: string]: unknown;
};

export type Client = {
  ws: WebSocket;
  frames: WireFrame[];
  waitFor(
    predicate: (f: WireFrame) => boolean,
    timeoutMs?: number
  ): Promise<WireFrame>;
  close(): void;
};

/** Only chat-protocol frames are recorded; other agent traffic is noise. */
const CHAT_FRAME_TYPES = new Set<string>(Object.values(MessageType));

export function userMessage(id: string, text: string): ChatMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export async function connectClient(path: string): Promise<Client> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();

  const frames: WireFrame[] = [];
  const waiters: Array<{
    predicate: (f: WireFrame) => boolean;
    resolve: (f: WireFrame) => void;
  }> = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    let frame: WireFrame;
    try {
      frame = JSON.parse(event.data as string) as WireFrame;
    } catch {
      return;
    }
    if (!CHAT_FRAME_TYPES.has(frame.type)) return;
    // Parse chunk bodies so id normalization reaches inside them.
    if (typeof frame.body === "string" && frame.body.length > 0) {
      try {
        frame.body = JSON.parse(frame.body);
      } catch {
        // keep as string (non-JSON body)
      }
    }
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(frame)) {
        const [waiter] = waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
  });

  return {
    ws,
    frames,
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for frame; got: ${JSON.stringify(frames)}`
              )
            ),
          timeoutMs
        );
        waiters.push({
          predicate,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          }
        });
      });
    },
    close() {
      ws.close(1000);
    }
  };
}

export function sendChatRequest(
  client: Client,
  requestId: string,
  messages: ChatMessage[],
  extraBody: Record<string, unknown> = {}
): void {
  client.ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extraBody })
      }
    })
  );
}

export function sendCancel(client: Client, requestId: string): void {
  client.ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    })
  );
}

export function sendToolResult(
  client: Client,
  toolCallId: string,
  toolName: string,
  output: unknown
): void {
  client.ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId,
      toolName,
      output,
      autoContinue: true
    })
  );
}

export function sendToolApproval(
  client: Client,
  toolCallId: string,
  approved: boolean
): void {
  client.ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_TOOL_APPROVAL,
      toolCallId,
      approved,
      autoContinue: true
    })
  );
}

export function isDone(requestId: string) {
  return (f: WireFrame) =>
    f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
    f.id === requestId &&
    f.done === true;
}

export function isAnyDone(f: WireFrame): boolean {
  return f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && f.done === true;
}

export function isTextDelta(f: WireFrame): boolean {
  return (
    f.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
    typeof f.body === "object" &&
    f.body !== null &&
    (f.body as { type?: string }).type === "text-delta"
  );
}

export async function fetchClientView(path: string): Promise<unknown[]> {
  const res = await exports.default.fetch(
    `http://example.com${path}/get-messages`
  );
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
}

// ── Normalization ────────────────────────────────────────────────────

const ID_KEYS = new Set([
  "id",
  "messageId",
  "toolCallId",
  "approvalId",
  "parentMessageId",
  "sourceId",
  "requestId",
  "request_id",
  "streamId"
]);
const TS_KEYS = new Set([
  "createdAt",
  "created_at",
  "timestamp",
  "startedAt",
  "completedAt",
  "time"
]);

export function normalize<T>(value: T): T {
  const ids = new Map<string, string>();
  const mapId = (raw: string): string => {
    let mapped = ids.get(raw);
    if (!mapped) {
      mapped = `id-${ids.size + 1}`;
      ids.set(raw, mapped);
    }
    return mapped;
  };
  const walk = (val: unknown, key?: string): unknown => {
    if (Array.isArray(val)) return val.map((item) => walk(item));
    if (val !== null && typeof val === "object") {
      return Object.fromEntries(
        Object.entries(val).map(([k, v]) => [k, walk(v, k)])
      );
    }
    if (key !== undefined) {
      if (ID_KEYS.has(key) && typeof val === "string") return mapId(val);
      // Timestamps appear both as epoch numbers and SQLite datetime strings.
      if (
        TS_KEYS.has(key) &&
        (typeof val === "number" || typeof val === "string")
      ) {
        return "TS";
      }
    }
    return val;
  };
  return walk(value) as T;
}

// ── Trace assembly + golden compare ──────────────────────────────────

type ConformanceStub = {
  stable(timeout?: number): Promise<boolean>;
  rows(): Promise<unknown>;
};

export type Trace = {
  scenario: string;
  clients: Array<{ label: string; frames: WireFrame[] }>;
  persistedRows: unknown[];
  clientView: unknown[];
};

/**
 * Settle the DO, then assemble the trace. `sortFramesByRequestId` stably
 * groups a client's frames by request id — used where two requests overlap
 * and the cross-request interleaving is not part of the contract.
 */
export async function finishTrace(options: {
  scenario: string;
  path: string;
  stub: ConformanceStub;
  clients: Client[];
  sortFramesByRequestId?: boolean;
}): Promise<Trace> {
  const { scenario, path, stub, clients } = options;
  expect(await stub.stable()).toBe(true);
  const persistedRows = (await stub.rows()) as unknown[];
  const clientView = await fetchClientView(path);
  for (const client of clients) client.close();
  return {
    scenario,
    clients: clients.map((client, index) => {
      const frames = options.sortFramesByRequestId
        ? [...client.frames].sort((a, b) =>
            (a.id ?? "").localeCompare(b.id ?? "")
          )
        : client.frames;
      return { label: `client-${index + 1}`, frames };
    }),
    persistedRows,
    clientView
  };
}

export async function expectGolden(name: string, trace: Trace): Promise<void> {
  const json = `${JSON.stringify(normalize(trace), null, 2)}\n`;
  await expect(json).toMatchFileSnapshot(`./goldens/${name}.json`);
}
