import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AGUIMessage,
  AssistantMessage,
  ReasoningMessage,
  ToolCall,
  ToolMessage,
  UserMessage
} from "../agui-types";
import {
  assistantContentKey,
  reconcileMessages,
  resolveToolMergeId
} from "../agui-message-reconciler";

function user(id: string, content: string): UserMessage {
  return { id, role: "user", content };
}

function assistant(
  id: string,
  content: string,
  toolCalls?: ToolCall[]
): AssistantMessage {
  return toolCalls
    ? { id, role: "assistant", content, toolCalls }
    : { id, role: "assistant", content };
}

function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function toolMsg(id: string, toolCallId: string, content: string): ToolMessage {
  return { id, role: "tool", toolCallId, content };
}

function reasoning(id: string, content: string): ReasoningMessage {
  return { id, role: "reasoning", content };
}

describe("reconcileMessages", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns incoming unchanged when server is empty", () => {
    const incoming: AGUIMessage[] = [
      user("u1", "hi"),
      assistant("a1", "hello")
    ];
    const result = reconcileMessages(incoming, []);
    expect(result).toEqual(incoming);
    expect(result).not.toBe(incoming);
  });

  it("uses server assistant version when ids match (fresh toolCalls/content)", () => {
    const server: AGUIMessage[] = [
      assistant("a1", "final text", [toolCall("tc1", "calc", '{"x":1}')])
    ];
    const incoming: AGUIMessage[] = [assistant("a1", "partial")];
    const result = reconcileMessages(incoming, server);
    expect(result[0]).toEqual(server[0]);
    expect(result[0]).not.toBe(server[0]);
  });

  it("server tool result wins over stale incoming tool result with same toolCallId", () => {
    const server: AGUIMessage[] = [
      assistant("a1", "", [toolCall("tc1", "calc", '{"x":1}')]),
      toolMsg("t-srv", "tc1", '{"result":42}')
    ];
    const incoming: AGUIMessage[] = [
      assistant("a1", "", [toolCall("tc1", "calc", '{"x":1}')]),
      toolMsg("t-cli", "tc1", '{"result":"stale"}')
    ];
    const result = reconcileMessages(incoming, server);
    const reconciledTool = result[1] as ToolMessage;
    expect(reconciledTool.role).toBe("tool");
    expect(reconciledTool.content).toBe('{"result":42}');
    expect(reconciledTool.id).toBe("t-srv");
  });

  it("adopts server id when assistant content-key matches but id drifted", () => {
    const server: AGUIMessage[] = [
      user("u1", "q"),
      assistant("srv-a1", "Sure thing")
    ];
    const incoming: AGUIMessage[] = [
      user("u1", "q"),
      assistant("cli-tmp-a1", "Sure thing")
    ];
    const result = reconcileMessages(incoming, server);
    expect(result[1].id).toBe("srv-a1");
    expect(result[1].role).toBe("assistant");
    expect((result[1] as AssistantMessage).content).toBe("Sure thing");
  });

  it("adopts server id when assistants share a toolCallId but ids differ", () => {
    const server: AGUIMessage[] = [
      assistant("srv-a1", "calling", [toolCall("tc1", "calc", '{"x":1}')])
    ];
    const incoming: AGUIMessage[] = [
      assistant("cli-a1", "calling-with-different-text", [
        toolCall("tc1", "calc", '{"x":1}')
      ])
    ];
    const result = reconcileMessages(incoming, server);
    expect(result[0].id).toBe("srv-a1");
    expect((result[0] as AssistantMessage).content).toBe(
      "calling-with-different-text"
    );
  });

  it("preserves order and assistant/tool pairing across substitution", () => {
    const server: AGUIMessage[] = [
      assistant("srv-a1", "ok", [
        toolCall("tc1", "calc", '{"x":1}'),
        toolCall("tc2", "calc", '{"x":2}')
      ]),
      toolMsg("srv-t1", "tc1", '{"r":1}'),
      toolMsg("srv-t2", "tc2", '{"r":2}')
    ];
    const incoming: AGUIMessage[] = [
      assistant("cli-a1", "ok", [
        toolCall("tc1", "calc", '{"x":1}'),
        toolCall("tc2", "calc", '{"x":2}')
      ]),
      toolMsg("cli-t1", "tc1", "pending"),
      toolMsg("cli-t2", "tc2", "pending")
    ];
    const result = reconcileMessages(incoming, server);
    expect(result.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect(result[0].id).toBe("srv-a1");
    expect((result[1] as ToolMessage).toolCallId).toBe("tc1");
    expect((result[1] as ToolMessage).content).toBe('{"r":1}');
    expect((result[2] as ToolMessage).toolCallId).toBe("tc2");
    expect((result[2] as ToolMessage).content).toBe('{"r":2}');
  });

  it("does not mutate inputs", () => {
    const server: AGUIMessage[] = [
      assistant("srv-a1", "hi", [toolCall("tc1", "calc", "{}")]),
      toolMsg("srv-t1", "tc1", '{"r":1}')
    ];
    const incoming: AGUIMessage[] = [
      assistant("cli-a1", "hi", [toolCall("tc1", "calc", "{}")]),
      toolMsg("cli-t1", "tc1", "stale")
    ];
    const incomingSnapshot = JSON.parse(JSON.stringify(incoming));
    const serverSnapshot = JSON.parse(JSON.stringify(server));
    reconcileMessages(incoming, server);
    expect(incoming).toEqual(incomingSnapshot);
    expect(server).toEqual(serverSnapshot);
  });

  it("passes malformed messages through and warns", () => {
    const malformed = {
      role: "assistant",
      content: "no id"
    } as unknown as AGUIMessage;
    const incoming: AGUIMessage[] = [malformed, assistant("a1", "ok")];
    const server: AGUIMessage[] = [assistant("a1", "ok-updated")];
    const result = reconcileMessages(incoming, server);
    expect(result[0]).toBe(malformed);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("resolveToolMergeId", () => {
  it("returns null when no toolCallIds intersect", () => {
    const server: AGUIMessage[] = [
      assistant("srv-a1", "x", [toolCall("tc-other", "calc", "{}")])
    ];
    const msg = assistant("cli-a1", "y", [toolCall("tc1", "calc", "{}")]);
    expect(resolveToolMergeId(msg, server)).toBeNull();
  });

  it("finds server assistant id when toolCalls share an id", () => {
    const server: AGUIMessage[] = [
      assistant("srv-a1", "x", [toolCall("tc1", "calc", "{}")])
    ];
    const msg = assistant("cli-a1", "y", [toolCall("tc1", "calc", "{}")]);
    expect(resolveToolMergeId(msg, server)).toBe("srv-a1");
  });

  it("finds server tool message id when a tool message shares toolCallId", () => {
    const server: AGUIMessage[] = [toolMsg("srv-t1", "tc1", '{"r":1}')];
    const msg = assistant("cli-a1", "y", [toolCall("tc1", "calc", "{}")]);
    expect(resolveToolMergeId(msg, server)).toBe("srv-t1");
  });

  it("returns null when given a non-tool-bearing user message", () => {
    const server: AGUIMessage[] = [
      assistant("srv-a1", "x", [toolCall("tc1", "calc", "{}")])
    ];
    expect(resolveToolMergeId(user("u1", "hi"), server)).toBeNull();
  });
});

describe("assistantContentKey", () => {
  it("returns undefined for non-assistant roles", () => {
    expect(assistantContentKey(user("u1", "hi"))).toBeUndefined();
    expect(assistantContentKey(toolMsg("t1", "tc1", "out"))).toBeUndefined();
  });

  it("produces equal keys for assistants with the same content + toolCalls", () => {
    const a = assistant("a1", "Hi", [toolCall("tc1", "calc", '{"x":1}')]);
    const b = assistant("a2", "Hi", [toolCall("tc1", "calc", '{"x":1}')]);
    expect(assistantContentKey(a)).toBe(assistantContentKey(b));
  });

  it("sorts toolCalls by id so streaming order doesn't perturb the hash", () => {
    const a = assistant("a1", "x", [
      toolCall("tcA", "calc", "{}"),
      toolCall("tcB", "calc", "{}")
    ]);
    const b = assistant("a2", "x", [
      toolCall("tcB", "calc", "{}"),
      toolCall("tcA", "calc", "{}")
    ]);
    expect(assistantContentKey(a)).toBe(assistantContentKey(b));
  });

  it("folds in paired reasoning content when provided", () => {
    const a = assistant("a1", "Hi");
    const r = reasoning("r1", "thinking");
    const withReasoning = assistantContentKey(a, undefined, r);
    const withoutReasoning = assistantContentKey(a);
    expect(withReasoning).not.toBe(withoutReasoning);
  });

  it("applies sanitize before computing the key", () => {
    const noisy = assistant("a1", "Hi");
    const sanitize = (m: AGUIMessage): AGUIMessage =>
      m.role === "assistant" ? { ...m, content: "Hi-clean" } : m;
    expect(assistantContentKey(noisy, sanitize)).toBe(
      assistantContentKey(assistant("a2", "Hi-clean"))
    );
  });
});
