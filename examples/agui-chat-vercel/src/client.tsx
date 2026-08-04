import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat-vercel/react";
import { getToolName, isToolUIPart } from "ai";

/**
 * The only change from the legacy `@cloudflare/ai-chat/react` client is the
 * import above — the hook's surface is deliberately identical, so an app
 * migrating to AG-UI changes one line here and two on the server.
 */
export default function App() {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({ agent: "chat-agent" });

  const { messages, sendMessage, clearHistory, stop, isStreaming } =
    useAgentChat({
      agent,
      onToolCall: async ({ toolCall, addToolOutput }) => {
        if (toolCall.toolName === "getUserTimezone") {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              localTime: new Date().toLocaleTimeString()
            }
          });
        }
      }
    });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="app">
      <header>
        <h1>AG-UI Chat — Vercel adapter</h1>
        <button type="button" onClick={clearHistory}>
          Clear
        </button>
      </header>

      <main>
        {messages.length === 0 && (
          <p className="empty">
            Ask about the weather, or what time it is where you are.
          </p>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`msg ${message.role}`}>
            <span className="role">{message.role}</span>
            <div className="body">
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  return <p key={i}>{part.text}</p>;
                }
                if (isToolUIPart(part)) {
                  return (
                    <pre key={i} className="tool">
                      {getToolName(part)} · {part.state}
                      {"output" in part && part.output
                        ? `\n${JSON.stringify(part.output, null, 2)}`
                        : ""}
                    </pre>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </main>

      <footer>
        <input
          value={input}
          placeholder="Send a message…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {isStreaming ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}
