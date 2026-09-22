import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentBrowserAdapter, AgentBrowserCommandError } from "../src/agent-browser.js";

function fakeBrowser(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-agent-"));
  const executable = join(directory, "agent-browser");
  writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(executable, 0o755);
  return executable;
}

test("agent-browser output is bounded", async () => {
  const binary = fakeBrowser(
    `process.stdout.write(JSON.stringify({ success: true, data: "x".repeat(3 * 1024 * 1024) }))`,
  );
  const browser = new AgentBrowserAdapter(binary);
  await assert.rejects(
    browser.open("https://example.test"),
    (error: unknown) => error instanceof AgentBrowserCommandError && error.code === "OUTPUT_LIMIT",
  );
});

test("initial load wait failures propagate from open", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("--load")) { console.error("load wait failed"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await assert.rejects(
    browser.open("https://example.test"),
    /agent-browser wait for DOM content failed: load wait failed/,
  );
});

test("post-action wait failures propagate from execution", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("500")) { console.error("settle wait failed"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  await assert.rejects(
    browser.execute({ id: "click", operation: "CLICK", ref: "@e1", label: "Open" }),
    /agent-browser wait after action failed: settle wait failed/,
  );
});

test("element state read failures propagate from observation", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("snapshot")) console.log(JSON.stringify({ success: true, data: { refs: { e1: { role: "textbox", name: "Query" } } } }));
else if (args.includes("url")) console.log(JSON.stringify({ success: true, data: { url: "https://example.test" } }));
else if (args.includes("title")) console.log(JSON.stringify({ success: true, data: { title: "Example" } }));
else if (args.includes("value")) { console.error("state unavailable"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  await assert.rejects(browser.observe(), /agent-browser get value failed: state unavailable/);
});
