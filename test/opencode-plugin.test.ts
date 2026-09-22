import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../index.js";

interface RegisteredTool {
  name: string;
  description: string;
  input: unknown;
  options?: { codemode?: boolean };
  execute(
    input: unknown,
    context: { signal: AbortSignal; progress(update: unknown): Promise<void> },
  ): Promise<{ content?: string | ReadonlyArray<{ type: "text"; text: string }>; metadata?: unknown }>;
}

test("OpenCode V2 plugin registers ajevt_browser from the package entrypoint", async () => {
  const tools: RegisteredTool[] = [];
  const context = {
    tool: {
      async transform(register: (editor: { add(tool: RegisteredTool): void }) => void) {
        register({ add: (tool) => tools.push(tool) });
        return { async dispose() {} };
      },
    },
  };

  assert.equal(plugin.id, "ajevt-browser");
  await plugin.setup(context as never);
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.ok(tool);
  assert.equal(tool.name, "ajevt_browser");
  assert.equal(typeof tool.execute, "function");
  assert.notEqual(tool.options?.codemode, true);
  assert.deepEqual((tool.input as { required?: string[] }).required, ["goal", "url"]);
});

test("OpenCode V2 plugin passes ctx.options into tool execution", async () => {
  const tools: RegisteredTool[] = [];
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-opencode-"));
  const config = join(directory, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ decision: { endpoint: "https://base.example/systemone", auth: { env: "OPENCODE_TEST_KEY" } } }),
  );
  const previousConfig = process.env.AJEVT_BROWSER_CONFIG;
  const previousKey = process.env.OPENCODE_TEST_KEY;
  process.env.AJEVT_BROWSER_CONFIG = config;
  process.env.OPENCODE_TEST_KEY = "secret";
  const context = {
    options: { decision: { endpoint: "https://override.example/systemone" } },
    tool: {
      async transform(register: (editor: { add(tool: RegisteredTool): void }) => void) {
        register({ add: (tool) => tools.push(tool) });
        return { async dispose() {} };
      },
    },
  };
  try {
    await plugin.setup(context as never);
    const [tool] = tools;
    assert.ok(tool);
    await assert.rejects(
      tool.execute(
        { goal: "test", url: "https://example.com" },
        { signal: new AbortController().signal, async progress() {} },
      ),
      /changes endpoint but does not provide auth/,
    );
  } finally {
    if (previousConfig === undefined) delete process.env.AJEVT_BROWSER_CONFIG;
    else process.env.AJEVT_BROWSER_CONFIG = previousConfig;
    if (previousKey === undefined) delete process.env.OPENCODE_TEST_KEY;
    else process.env.OPENCODE_TEST_KEY = previousKey;
  }
});
