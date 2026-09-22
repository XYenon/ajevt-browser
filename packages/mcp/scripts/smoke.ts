import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  args: ["--filter", "ajevt-browser-mcp", "start"],
  cwd: new URL("../../..", import.meta.url).pathname,
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  stderr: "inherit",
});
const client = new Client({ name: "ajevt-browser-mcp-smoke", version: "1.0.0" });

await client.connect(transport);
try {
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "ajevt_browser");
  assert.ok(tool, "ajevt_browser was not listed by the MCP server");

  const called = await client.callTool({
    name: "ajevt_browser",
    arguments: {
      goal: "Confirm that the page contains Example Domain without taking any action.",
      url: "https://example.com",
      max_steps: 3,
      verifiers: [{ type: "text_contains", text: "Example Domain" }],
    },
  });
  assert.notEqual(called.isError, true);
  assert.equal((called.structuredContent as { status?: string } | undefined)?.status, "done");
  const content = called.content as Array<{ type: string; text?: string }>;
  assert.match(content[0]?.text ?? "", /^✓ Ajevt Browser · Completed/);

  console.log(
    JSON.stringify(
      {
        protocol: "stdio",
        listedTool: tool.name,
        status: (called.structuredContent as { status?: string }).status,
        summary: content[0]?.text,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
