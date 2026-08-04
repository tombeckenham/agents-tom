import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat-tanstack/react";

/**
 * The TanStack client. `useAgentChat` here wraps `@tanstack/ai-react`'s
 * `useChat` through a WebSocket-backed `stream()` connection adapter, so
 * the message shape below is TanStack's `UIMessage` rather than the AI
 * SDK's — the one place the two adapters genuinely differ for app code.
 */
export default function App() {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({ agent: "chat-agent" });

  const { messages, sendMessage, clearHistory, stop, isStreaming } =
    useAgentChat({ agent });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="app">
      <header>
        <h1>AG-UI Chat — TanStack adapter</h1>
        <button type="button" onClick={clearHistory}>
          Clear
        </button>
      </header>

      <main>
        {messages.length === 0 && (
          <p className="empty">Say hello to start the conversation.</p>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`msg ${message.role}`}>
            <span className="role">{message.role}</span>
            <div className="body">
              {message.parts.map((part, i) =>
                part.type === "text" ? <p key={i}>{part.content}</p> : null
              )}
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
