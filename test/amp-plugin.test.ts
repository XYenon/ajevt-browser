import assert from "node:assert/strict";
import test from "node:test";
import type { PluginAPI, PluginToolDefinition } from "@ampcode/plugin";
import plugin, { description } from "../.amp/plugins/ajevt-browser/index.js";
import { ajevtBrowserJsonSchema } from "../src/schema.js";

test("Amp directory plugin registers the shared browser tool and schema", () => {
  let tool: PluginToolDefinition | undefined;
  plugin({ registerTool: (definition: PluginToolDefinition) => (tool = definition) } as unknown as PluginAPI);
  assert.match(description, /browser/);
  assert.equal(tool?.name, "ajevt_browser");
  assert.deepEqual(tool?.inputSchema, ajevtBrowserJsonSchema);
  assert.equal(tool?.inputSchema.required?.join(","), "goal,url");
});

test("Amp tool reports configuration failures without invoking a browser", async () => {
  let tool: PluginToolDefinition | undefined;
  plugin({ registerTool: (definition: PluginToolDefinition) => (tool = definition) } as unknown as PluginAPI);
  const previous = process.env.AJEVT_BROWSER_CONFIG;
  process.env.AJEVT_BROWSER_CONFIG = "/nonexistent/ajevt-browser-test-config.json";
  try {
    const result = await tool?.execute({ goal: "test", url: "https://example.com" }, {} as never);
    assert.match(result as string, /Ajevt Browser error: AJEVT_BROWSER_CONFIG does not exist/);
  } finally {
    if (previous === undefined) delete process.env.AJEVT_BROWSER_CONFIG;
    else process.env.AJEVT_BROWSER_CONFIG = previous;
  }
});
