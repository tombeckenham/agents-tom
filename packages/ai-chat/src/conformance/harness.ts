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
import { EventToChunkProjector } from "@cloudflare/ai-chat-vercel";
import { toUIMessages } from "agents/chat";
import type { AGUIEvent, AGUIMessage } from "agents/chat/agui-types";

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

/** Matches streamed text on either stack's wire (AI SDK chunk / AG-UI event). */
export function isTextDelta(f: WireFrame): boolean {
  if (
    f.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
    typeof f.body !== "object" ||
    f.body === null
  ) {
    return false;
  }
  const bodyType = (f.body as { type?: string }).type;
  return bodyType === "text-delta" || bodyType === "TEXT_MESSAGE_CONTENT";
}

export async function fetchClientView(path: string): Promise<unknown[]> {
  const res = await exports.default.fetch(
    `http://example.com${path}/get-messages`
  );
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
}

// ── Normalization ────────────────────────────────────────────────────

// Only keys that actually appear in goldens — every extra key is a collision
// risk with real payload values (e.g. "time" once erased a tool output).
const ID_KEYS = new Set([
  "id",
  "messageId",
  "toolCallId",
  "approvalId",
  "sourceId",
  "requestId"
]);
const TS_KEYS = new Set(["created_at"]);

/**
 * Streaming chunk types whose `id` is a PART id: an opaque correlation key
 * that only groups deltas within one stream. Legacy generated distinct part
 * ids ("t-1"); AG-UI reuses the assistant messageId. Both are semantically
 * equivalent, so part ids normalize in their own namespace (`part-N`) —
 * whether a part id coincides with a message id is not part of the contract.
 */
const PART_ID_CHUNK_TYPES = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end"
]);

export function normalize<T>(value: T): T {
  const ids = new Map<string, string>();
  const partIds = new Map<string, string>();
  const mapId = (raw: string): string => {
    let mapped = ids.get(raw);
    if (!mapped) {
      mapped = `id-${ids.size + 1}`;
      ids.set(raw, mapped);
    }
    return mapped;
  };
  const mapPartId = (raw: string): string => {
    let mapped = partIds.get(raw);
    if (!mapped) {
      mapped = `part-${partIds.size + 1}`;
      partIds.set(raw, mapped);
    }
    return mapped;
  };
  const walk = (val: unknown, key?: string, parent?: unknown): unknown => {
    if (Array.isArray(val)) return val.map((item) => walk(item));
    if (val !== null && typeof val === "object") {
      return Object.fromEntries(
        Object.entries(val).map(([k, v]) => [k, walk(v, k, val)])
      );
    }
    if (key !== undefined) {
      if (
        key === "id" &&
        typeof val === "string" &&
        PART_ID_CHUNK_TYPES.has(
          (parent as { type?: string } | undefined)?.type ?? ""
        )
      ) {
        return mapPartId(val);
      }
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

// ── Projected-stack → legacy-shape trace projection ──────────────────
//
// The projected stack speaks AG-UI on the wire and persists AG-UI rows;
// storage divergence is a stated design fact (`ag-ui-plan.md` §Versioning),
// not per-scenario behavior. The differ therefore compares BEHAVIOR: wire
// frames are projected back through the client-side `EventToChunkProjector`
// (exactly what the Phase-4 client runs) and rows/views through
// `toUIMessages` (the sanctioned reverse projection) before diffing against
// the legacy goldens.

/** AG-UI event frames → legacy UIMessageChunk frames, per stream id. */
export function projectFramesToLegacy(frames: WireFrame[]): WireFrame[] {
  const projectors = new Map<string, EventToChunkProjector>();
  const out: WireFrame[] = [];
  for (const frame of frames) {
    const body = frame.body;
    // Init/refresh frames carry the persisted list; project the rows.
    if (
      frame.type === MessageType.CF_AGENT_CHAT_MESSAGES &&
      Array.isArray((frame as { messages?: unknown }).messages)
    ) {
      out.push({
        ...frame,
        messages: projectViewToLegacy(
          (frame as unknown as { messages: unknown[] }).messages
        )
      });
      continue;
    }
    if (
      frame.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
      typeof body !== "object" ||
      body === null ||
      typeof (body as { type?: unknown }).type !== "string"
    ) {
      out.push(frame);
      continue;
    }
    const event = body as AGUIEvent;
    const key = String(frame.id ?? "");
    // A RUN_STARTED restarts the stream (fresh run or replay pass).
    if (event.type === "RUN_STARTED" || !projectors.has(key)) {
      projectors.set(key, new EventToChunkProjector());
    }
    const projector = projectors.get(key) as EventToChunkProjector;
    for (const chunk of projector.project(event)) {
      out.push({ ...frame, body: chunk });
    }
  }
  return out;
}

/** AG-UI rows → legacy-shaped persisted rows (message granularity). */
export function projectRowsToLegacy(rows: unknown[]): unknown[] {
  const messages = (
    rows as Array<{ message: unknown; created_at?: string }>
  ).map((row) => row.message) as AGUIMessage[];
  return toUIMessages(messages).map((message) => ({
    id: message.id,
    message,
    created_at: "TS"
  }));
}

/** AG-UI message list (`/get-messages`) → legacy `UIMessage[]`. */
export function projectViewToLegacy(view: unknown[]): unknown[] {
  return toUIMessages(view as AGUIMessage[]);
}

// ── Trace assembly + golden compare ──────────────────────────────────

type ConformanceStub = {
  stable(timeout?: number): Promise<boolean>;
  rows(): Promise<unknown>;
  hooks(): Promise<unknown>;
};

export type Trace = {
  scenario: string;
  clients: Array<{ label: string; frames: WireFrame[] }>;
  hooks: unknown[];
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
  /** Trace came from the projected stack: project it to legacy shape. */
  projected?: boolean;
}): Promise<Trace> {
  const { scenario, path, stub, clients, projected } = options;
  expect(await stub.stable()).toBe(true);
  const hooks = (await stub.hooks()) as unknown[];
  const rawRows = (await stub.rows()) as unknown[];
  const rawView = await fetchClientView(path);
  for (const client of clients) client.close();
  return {
    scenario,
    clients: clients.map((client, index) => {
      let frames = options.sortFramesByRequestId
        ? [...client.frames].sort((a, b) => {
            const left = a.id ?? "";
            const right = b.id ?? "";
            return left < right ? -1 : left > right ? 1 : 0;
          })
        : client.frames;
      if (projected) frames = projectFramesToLegacy(frames);
      return { label: `client-${index + 1}`, frames };
    }),
    hooks,
    persistedRows: projected ? projectRowsToLegacy(rawRows) : rawRows,
    clientView: projected ? projectViewToLegacy(rawView) : rawView
  };
}

export async function expectGolden(name: string, trace: Trace): Promise<void> {
  const json = `${JSON.stringify(normalize(trace), null, 2)}\n`;
  await expect(json).toMatchFileSnapshot(`./goldens/${name}.json`);
}

// ── Differential compare (projected stack vs legacy goldens) ─────────

const goldenFiles = import.meta.glob("./goldens/*.json", {
  eager: true
}) as Record<string, { default: unknown }>;

const allowlistFiles = import.meta.glob("./goldens/*.allowlist.md", {
  eager: true,
  query: "?raw",
  import: "default"
}) as Record<string, string>;

/**
 * Diff a projected-stack trace (already projected to legacy shape) against
 * the committed legacy golden.
 *
 * Default: the normalized trace must deep-equal the golden — any difference
 * is DIVERGENT and fails.
 *
 * If `goldens/<name>.allowlist.md` exists (one-line justifications for
 * semantically-equivalent differences), the trace is instead pinned as its
 * own snapshot `goldens/<name>.projected.json` so the equivalence stays
 * reviewable and stable. Re-record with UPDATE_GOLDENS=1.
 */
export async function expectProjectedGolden(
  name: string,
  trace: Trace
): Promise<void> {
  const normalized = normalize(trace);
  if (allowlistFiles[`./goldens/${name}.allowlist.md`] !== undefined) {
    const json = `${JSON.stringify(normalized, null, 2)}\n`;
    await expect(json).toMatchFileSnapshot(`./goldens/${name}.projected.json`);
    return;
  }
  const golden = goldenFiles[`./goldens/${name}.json`];
  if (!golden) throw new Error(`no committed golden for scenario "${name}"`);
  expect(normalized).toEqual(golden.default);
}
