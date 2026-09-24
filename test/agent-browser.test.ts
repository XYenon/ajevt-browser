import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("a slow initial load wait does not fail the open", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("--load")) { console.error("load wait failed"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
});

test("an open failure still propagates from open", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("open")) { console.error("navigation failed"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await assert.rejects(browser.open("https://example.test"), /agent-browser open failed: navigation failed/);
});

test("a failed open still closes the started session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-args-"));
  const argsFile = join(directory, "args.jsonl");
  const binary = fakeBrowser(`
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + "\\n");
if (args.includes("open")) { console.error("navigation failed"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await assert.rejects(browser.open("https://example.test"), /agent-browser open failed/);
  await browser.close();
  const calls = readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    calls.some((args) => args.includes("close")),
    true,
  );
});

test("an untouched session is not closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-args-"));
  const argsFile = join(directory, "args.jsonl");
  const binary = fakeBrowser(`
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.close();
  assert.equal(existsSync(argsFile), false);
});

test("post-action settle failures do not fail execution", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "ajevt-browser-marker-")), "clicked");
  const binary = fakeBrowser(`
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("click")) {
  writeFileSync(${JSON.stringify(marker)}, "1");
  console.log(JSON.stringify({ success: true, data: {} }));
} else if ((args.includes("500") || args.includes("--load")) && existsSync(${JSON.stringify(marker)})) {
  console.error("settle wait failed");
  process.exitCode = 2;
} else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  await browser.execute({ id: "click", operation: "CLICK", ref: "@e1", label: "Open" });
});

test("a click that loses the page reports the new-tab cause", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("click")) { console.error("command timed out"); process.exitCode = 2; }
else if (args.includes("url")) console.log(JSON.stringify({ success: true, data: { url: "about:blank" } }));
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  await assert.rejects(
    browser.execute({ id: "click", operation: "CLICK", ref: "@e1", label: "Open" }),
    /about:blank, which happens when a click opens a new tab/,
  );
});

test("a failed action on an intact page keeps its original error", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("click")) { console.error("click failed"); process.exitCode = 2; }
else if (args.includes("url")) console.log(JSON.stringify({ success: true, data: { url: "https://example.test/page" } }));
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  await assert.rejects(browser.execute({ id: "click", operation: "CLICK", ref: "@e1", label: "Open" }), (error) => {
    const message = (error as Error).message;
    return message.includes("agent-browser click failed: click failed") && !message.includes("about:blank");
  });
});

test("a failed action still propagates from execution", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("click")) { console.error("click failed"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  await assert.rejects(
    browser.execute({ id: "click", operation: "CLICK", ref: "@e1", label: "Open" }),
    /agent-browser click failed: click failed/,
  );
});

test("the domain allowlist reaches agent-browser with subdomain patterns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-args-"));
  const argsFile = join(directory, "args.jsonl");
  const binary = fakeBrowser(`
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://en.wikipedia.org/wiki/Main_Page", {
    allowedDomains: ["wikipedia.org", "*.example.test"],
  });
  const calls = readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const openCall = calls.find((args) => args.includes("open"))!;
  const patterns = openCall[openCall.indexOf("--allowed-domains") + 1];
  assert.deepEqual(patterns.split(",").sort(), ["*.example.test", "*.wikipedia.org", "example.test", "wikipedia.org"]);
});

test("without a caller allowlist agent-browser containment stays off", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-args-"));
  const argsFile = join(directory, "args.jsonl");
  const binary = fakeBrowser(`
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://en.wikipedia.org/wiki/Main_Page");
  const calls = readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    calls.some((args) => args.includes("--allowed-domains")),
    false,
  );
});

test("rendered page text is kept beside the accessibility text", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("snapshot")) console.log(JSON.stringify({ success: true, data: { refs: { e1: { role: "button", name: "Continue" } }, snapshot: '- button "Continue" [ref=e1]' } }));
else if (args.includes("url")) console.log(JSON.stringify({ success: true, data: { url: "https://example.test" } }));
else if (args.includes("title")) console.log(JSON.stringify({ success: true, data: { title: "Example" } }));
else if (args.includes("read")) console.log(JSON.stringify({ success: true, data: { content: "Received!" } }));
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  const observation = await browser.observe();
  assert.equal(observation.text, '- button "Continue" [ref=e1]');
  assert.equal(observation.pageText, "Received!");
  assert.equal(observation.elements.length, 1);
});

test("a failing page text read falls back to the accessibility text", async () => {
  const binary = fakeBrowser(`
const args = process.argv.slice(2);
if (args.includes("snapshot")) console.log(JSON.stringify({ success: true, data: { refs: { e1: { role: "button", name: "Continue" } }, snapshot: '- button "Continue" [ref=e1]' } }));
else if (args.includes("url")) console.log(JSON.stringify({ success: true, data: { url: "https://example.test" } }));
else if (args.includes("title")) console.log(JSON.stringify({ success: true, data: { title: "Example" } }));
else if (args.includes("read")) { console.error("read unavailable"); process.exitCode = 2; }
else console.log(JSON.stringify({ success: true, data: {} }));
`);
  const browser = new AgentBrowserAdapter(binary);
  await browser.open("https://example.test");
  const observation = await browser.observe();
  assert.equal(observation.text, '- button "Continue" [ref=e1]');
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
