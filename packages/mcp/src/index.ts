import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type AjevtBrowserParams,
  executeAjevtBrowser,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  type ToolProgress,
} from "ajevt-browser/core";
import { formatHandoff } from "ajevt-browser/format";
import { ajevtBrowserJsonSchema } from "ajevt-browser/schema";
import type { Handoff } from "ajevt-browser/types";

const { version: SERVER_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

export type McpToolExecutor = (
  params: AjevtBrowserParams,
  options: {
    signal?: AbortSignal;
    onProgress?: (event: ToolProgress) => void | Promise<void>;
  },
) => Promise<Handoff>;

export function createMcpServer(execute: McpToolExecutor = executeAjevtBrowser): Server {
  const server = new Server({ name: "ajevt-browser", version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        title: "Ajevt Browser",
        description: TOOL_DESCRIPTION,
        inputSchema: ajevtBrowserJsonSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }

    try {
      const result = await execute(request.params.arguments as unknown as AjevtBrowserParams, {
        signal: extra.signal,
        onProgress: async (event) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: event.step,
              message: `${event.phase}${event.operation ? ` · ${event.operation}` : ""}`,
            },
          });
        },
      });
      return {
        content: [{ type: "text", text: formatHandoff(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: result.status === "error",
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
