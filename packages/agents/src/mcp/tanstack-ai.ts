import type { ServerTool } from "@tanstack/ai";
import { MCPClientManager, type MCPServerFilter } from "./client";

export type { ServerTool } from "@tanstack/ai";
export type { MCPServerFilter } from "./client";

/**
 * Project an `MCPClientManager`'s connected tools into TanStack AI
 * `ServerTool[]` shape, mirroring `mcp.getAITools()` (which projects to the
 * Vercel `ToolSet`).
 *
 * This is a thin re-export of {@link MCPClientManager.getServerTools} so users
 * who consume the SDK from the TanStack-shaped subpath
 * (`agents/mcp/tanstack-ai`) can avoid pulling in the wider `mcp/client`
 * surface when all they want is the tool projection.
 *
 * @example
 * ```ts
 * import { getServerTools } from "agents/mcp/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * const tools = getServerTools(this.mcp);
 * const stream = chat({
 *   adapter: openaiText("gpt-4o"),
 *   tools,
 *   messages,
 * });
 * ```
 */
export function getServerTools(
  mcp: MCPClientManager,
  filter?: MCPServerFilter
): ServerTool[] {
  return mcp.getServerTools(filter);
}
