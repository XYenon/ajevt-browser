import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Handoff } from "ajevt-browser/types";
import { createMcpServer } from "../src/index.js";

const result: Handoff = {
  status: "done",
  goal: "Inspect page",
  url: "https://example.test",
  observation: { title: "Example", text: "Ready", elements: [] },
  recent_actions: [],
  confidence: 1,
  reason: "Verified.",
  resumable: false,
  next: "No further action required.",
  verification: { passed: true, checks: [] },
};

test("MCP server exposes and executes ajevt_browser", async () => {
  let received: unknown;
  const server = createMcpServer(async (params) => {
    received = params;
    return result;
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["ajevt_browser"],
    );

    const called = await client.callTool({
      name: "ajevt_browser",
      arguments: { goal: "Inspect page", url: "https://example.test" },
    });
    assert.deepEqual(received, { goal: "Inspect page", url: "https://example.test" });
    assert.deepEqual(called.structuredContent, result);
    const content = called.content as Array<{ type: string; text: string }>;
    assert.match(content[0]!.text, /^✓ Ajevt Browser · Completed/);
  } finally {
    await client.close();
    await server.close();
  }
});
