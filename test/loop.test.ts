import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionRequest } from "../src/decision.js";
import { runBrowserLoop } from "../src/loop.js";
import { buildCandidates, normalizeSnapshot } from "../src/observation.js";
import { FakeBrowser, FakeJev, observation, responseFor } from "./helpers.js";

test("combobox without inline options offers both type and expand candidates", () => {
  const page = observation({ elements: [{ ref: "@e1", role: "combobox", name: "Tenant" }] });
  const space = buildCandidates(page, "expand tenant");
  assert.ok(space.byOperation.get("TYPE")?.some((candidate) => candidate.ref === "@e1"));
  assert.ok(space.byOperation.get("CLICK")?.some((candidate) => candidate.ref === "@e1"));
});

test("low confidence returns ambiguous without execution", async () => {
  const browser = new FakeBrowser([observation()]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK", undefined, { confidence: 0.4 }));
  const result = await runBrowserLoop(browser, jev, { goal: "continue", url: "https://example.test" });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.resumable, false);
  assert.equal(browser.actions.length, 0);
});

test("waits for asynchronously loaded caller-bound fields", async () => {
  const loading = observation({ elements: [{ ref: "@e1", role: "button", name: "Menu" }], fingerprint: "a" });
  const ready = observation({ elements: [{ ref: "@e2", role: "textbox", name: "Query" }], fingerprint: "b" });
  const filled = observation({
    elements: [{ ref: "@e2", role: "textbox", name: "Query", value: "hello" }],
    fingerprint: "c",
  });
  const browser = new FakeBrowser([loading, ready, ready, filled, filled]);
  const jev = new FakeJev((request) => responseFor(request, "DONE", undefined, { done: 0.95 }));
  await runBrowserLoop(browser, jev, { goal: "enter query", url: loading.url, values: { Query: "hello" } });
  assert.deepEqual(
    browser.actions.map((action) => action.operation),
    ["WAIT", "TYPE"],
  );
});

test("caller-bound values are typed deterministically before consulting Jev", async () => {
  const before = observation({ elements: [{ ref: "@e1", role: "textbox", name: "Email" }], fingerprint: "a" });
  const after = observation({
    elements: [{ ref: "@e1", role: "textbox", name: "Email", value: "me@example.test" }],
    fingerprint: "b",
  });
  const browser = new FakeBrowser([before, before, after, after]);
  const jev = new FakeJev((request) => responseFor(request, "DONE", undefined, { done: 0.95 }));
  await runBrowserLoop(browser, jev, { goal: "enter email", url: before.url, values: { Email: "me@example.test" } });
  assert.equal(browser.actions[0]?.operation, "TYPE");
  assert.equal(browser.actions[0]?.value, "me@example.test");
  assert.equal(jev.calls.length, 1);
});

test("keepSession returns a resumable session without closing it", async () => {
  const browser = new FakeBrowser([observation()]);
  Object.defineProperty(browser, "session", { value: "shared-session" });
  const jev = new FakeJev((request) => responseFor(request, "DONE", undefined, { done: 0.95 }));
  const result = await runBrowserLoop(browser, jev, {
    goal: "inspect",
    url: "https://example.test",
    keepSession: true,
  });
  assert.equal(result.session_id, "shared-session");
  assert.equal(result.resumable, true);
  assert.equal(browser.closed, false);
});

test("stale page is re-observed and never executes the stale ref", async () => {
  const browser = new FakeBrowser([
    observation({ fingerprint: "a" }),
    observation({ fingerprint: "b", elements: [{ ref: "@e2", role: "button", name: "Continue" }] }),
    observation({ fingerprint: "b", elements: [{ ref: "@e2", role: "button", name: "Continue" }] }),
    observation({ fingerprint: "c", text: "Complete" }),
    observation({ fingerprint: "c", text: "Complete" }),
  ]);
  const jev = new FakeJev((request, index) =>
    index === 0 ? responseFor(request, "CLICK") : responseFor(request, "DONE", undefined, { done: 0.95 }),
  );
  const result = await runBrowserLoop(browser, jev, { goal: "continue", url: "https://example.test" });
  assert.equal(browser.actions.length, 0);
  assert.equal(result.status, "likely_done");
});

test("a lazy-loading page still executes once the chosen target survives", async () => {
  const target = { ref: "@e1", role: "button", name: "Continue" };
  const browser = new FakeBrowser([
    observation({ fingerprint: "a", elements: [target] }),
    observation({ fingerprint: "b", elements: [target] }),
    observation({ fingerprint: "c", elements: [target] }),
    observation({ fingerprint: "d", elements: [target] }),
    observation({ fingerprint: "e", elements: [target], text: "Complete" }),
  ]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "continue",
    url: "https://example.test",
    maxSteps: 3,
  });
  assert.equal(browser.actions.length, 1);
  assert.match(result.reason, /Maximum step budget/);
});

test("a decision whose target disappears is never executed", async () => {
  const browser = new FakeBrowser([
    observation({ fingerprint: "a", elements: [{ ref: "@e1", role: "button", name: "Continue" }] }),
    observation({ fingerprint: "b", elements: [{ ref: "@e2", role: "button", name: "Other" }] }),
    observation({ fingerprint: "c", elements: [{ ref: "@e3", role: "button", name: "Other" }] }),
    observation({ fingerprint: "d", elements: [{ ref: "@e4", role: "button", name: "Other" }] }),
  ]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "continue",
    url: "https://example.test",
    maxSteps: 3,
  });
  assert.equal(browser.actions.length, 0);
  assert.match(result.reason, /Maximum step budget/);
});

test("a covered click is recorded in history and does not abort the run", async () => {
  const page = observation({ elements: [{ ref: "@e1", role: "button", name: "Continue" }] });
  const browser = new FakeBrowser([page, page, page, page]);
  browser.failures.set("@e1", new Error("Element '@e1' is covered by a banner at its click point"));
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, { goal: "continue", url: page.url, maxSteps: 2 });
  assert.equal(result.status, "stuck");
  assert.equal(browser.actions.length, 0);
  assert.match(result.recent_actions[0]?.error ?? "", /covered by a banner/);
});

test("a browser command failure still ends the run with an error", async () => {
  const page = observation({ elements: [{ ref: "@e1", role: "button", name: "Continue" }] });
  const browser = new FakeBrowser([page, page]);
  browser.failures.set("@e1", Object.assign(new Error("agent-browser command timed out"), { code: "TIMEOUT" }));
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, { goal: "continue", url: page.url, maxSteps: 2 });
  assert.equal(result.status, "error");
  assert.match(result.reason, /timed out/);
});

test("repeated action stops with bounded recovery", async () => {
  const same = observation();
  const browser = new FakeBrowser(Array(10).fill(same));
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, { goal: "continue", url: "https://example.test", repeatLimit: 1 });
  assert.equal(result.status, "stuck");
  assert.equal(browser.actions.length, 1);
});

test("consecutive waits use the step budget instead of the repeat-action limit", async () => {
  const same = observation();
  const browser = new FakeBrowser(Array(20).fill(same));
  const jev = new FakeJev((request) => responseFor(request, "WAIT"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "wait for result",
    url: same.url,
    maxSteps: 4,
    repeatLimit: 1,
  });
  assert.equal(result.status, "stuck");
  assert.match(result.reason, /Maximum step budget/);
  assert.equal(browser.actions.length, 4);
});

test("missing TYPE value returns input_required", async () => {
  const page = observation({ elements: [{ ref: "@e1", role: "textbox", name: "Email" }] });
  const browser = new FakeBrowser([page]);
  const jev = new FakeJev((request) => responseFor(request, "TYPE"));
  const result = await runBrowserLoop(browser, jev, { goal: "enter email", url: page.url });
  assert.equal(result.status, "input_required");
  assert.equal(result.field?.name, "Email");
  assert.equal(browser.actions.length, 0);
});

test("secret values and ordinary values are not sent to Jev", () => {
  const page = normalizeSnapshot({
    data: {
      url: "https://example.test",
      refs: {
        e1: { role: "textbox", name: "Password", value: "hunter2" },
        e2: { role: "textbox", name: "Email" },
      },
      snapshot: '- textbox "Password" value="hunter2" [ref=e1]\n- textbox "Email" [ref=e2]',
    },
  });
  const space = buildCandidates(page, "log in", { Password: "secret-value", Email: "me@example.test" });
  const request = buildDecisionRequest("log in", page, space, [], "jev");
  const serialized = JSON.stringify(request);
  assert.doesNotMatch(serialized, /hunter2|secret-value|me@example\.test/);
  assert.match(serialized, /\[redacted\]/);
});

test("explicit Chinese control names receive strong relevance", () => {
  const page = observation({
    elements: [
      { ref: "@e1", role: "button", name: "其他操作" },
      { ref: "@e2", role: "button", name: "确定" },
    ],
  });
  const space = buildCandidates(page, "点击当前对话框中的确定按钮");
  assert.equal(space.byOperation.get("CLICK")?.[0]?.ref, "@e2");
});

test("Chinese commitment buttons are marked risky", () => {
  const page = observation({
    elements: [
      { ref: "@e1", role: "button", name: "确定" },
      { ref: "@e2", role: "button", name: "取消" },
    ],
  });
  const space = buildCandidates(page, "填写表单");
  assert.equal(space.byOperation.get("CLICK")?.find((candidate) => candidate.ref === "@e1")?.risky, true);
  assert.notEqual(space.byOperation.get("CLICK")?.find((candidate) => candidate.ref === "@e2")?.risky, true);
});

test("explicitly named risky action is intercepted before Jev", async () => {
  const page = observation({
    elements: [
      { ref: "@e1", role: "button", name: "确定" },
      { ref: "@e2", role: "button", name: "取消" },
    ],
  });
  const browser = new FakeBrowser([page]);
  const jev = new FakeJev((request) => responseFor(request, "BLOCKED"));
  const result = await runBrowserLoop(browser, jev, { goal: "点击确定按钮", url: page.url });
  assert.equal(result.status, "needs_confirmation");
  assert.match(result.pending_action?.label ?? "", /确定/);
  assert.equal(jev.calls.length, 0);
  assert.equal(browser.actions.length, 0);
});

test("risky commitment returns needs_confirmation", async () => {
  const page = observation({ elements: [{ ref: "@e1", role: "button", name: "Send message" }] });
  const browser = new FakeBrowser([page]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK", undefined, { risky: 0.9 }));
  const result = await runBrowserLoop(browser, jev, { goal: "send message", url: page.url });
  assert.equal(result.status, "needs_confirmation");
  assert.equal(browser.actions.length, 0);
});

test("text verifier does not pass solely because TYPE placed the text in an input", async () => {
  const before = observation({ elements: [{ ref: "@e1", role: "textbox", name: "Message" }], fingerprint: "a" });
  const typed = observation({
    text: "Success",
    elements: [
      { ref: "@e1", role: "textbox", name: "Message", value: "Success" },
      { ref: "@e2", role: "button", name: "Send" },
    ],
    fingerprint: "b",
  });
  const browser = new FakeBrowser([before, before, typed, typed, typed]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  await runBrowserLoop(browser, jev, {
    goal: "send message",
    url: before.url,
    values: { Message: "Success" },
    allowRisky: true,
    verifiers: [{ type: "text_contains", text: "Success" }],
  });
  assert.deepEqual(
    browser.actions.map((action) => action.operation),
    ["TYPE", "CLICK"],
  );
});

test("element_value_equals survives changing element refs", async () => {
  const before = observation({ elements: [{ ref: "@e1", role: "textbox", name: "Query" }], fingerprint: "a" });
  const after = observation({
    elements: [{ ref: "@e9", role: "textbox", name: "Query", value: "hello" }],
    fingerprint: "b",
  });
  const browser = new FakeBrowser([before, before, after]);
  const jev = new FakeJev((request) => responseFor(request, "DONE", undefined, { done: 0.95 }));
  const result = await runBrowserLoop(browser, jev, {
    goal: "enter query",
    url: before.url,
    values: { Query: "hello" },
    verifiers: [{ type: "element_value_equals", role: "textbox", name: "Query", value: "hello" }],
  });
  assert.equal(result.status, "done");
});

test("waits briefly for sparse async pages to satisfy read-only verifiers", async () => {
  const loading = observation({ text: "Loading", elements: [], fingerprint: "a" });
  const ready = observation({
    text: "Models",
    elements: [{ ref: "@e1", role: "button", name: "Models" }],
    fingerprint: "b",
  });
  const browser = new FakeBrowser([loading, ready]);
  const jev = new FakeJev((request) => responseFor(request, "BLOCKED"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "verify models",
    url: loading.url,
    verifiers: [{ type: "text_contains", text: "Models" }],
  });
  assert.equal(result.status, "done");
  assert.deepEqual(
    browser.actions.map((action) => action.operation),
    ["WAIT"],
  );
  assert.equal(jev.calls.length, 0);
});

test("deterministic verifier can prove an initially satisfied read-only goal", async () => {
  const page = observation({ text: "Dashboard", elements: [{ ref: "@e1", role: "button", name: "Add" }] });
  const browser = new FakeBrowser([page]);
  const jev = new FakeJev((request) => responseFor(request, "BLOCKED"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "verify dashboard",
    url: page.url,
    verifiers: [
      { type: "text_contains", text: "Dashboard" },
      { type: "element_exists", role: "button", name: "Add" },
    ],
  });
  assert.equal(result.status, "done");
  assert.equal(jev.calls.length, 0);
});

test("requireAction prevents an initially matching verifier from skipping the action", async () => {
  const before = observation({ text: "Settings", fingerprint: "a" });
  const after = observation({ url: "https://example.test/settings", text: "Settings", fingerprint: "b" });
  const browser = new FakeBrowser([before, before, after]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "open settings",
    url: before.url,
    requireAction: true,
    verifiers: [{ type: "text_contains", text: "Settings" }],
  });
  assert.equal(result.status, "done");
  assert.equal(browser.actions.length, 1);
});

test("an initial cross-origin redirect requires confirmation before verification", async () => {
  const redirected = observation({ url: "https://other.test/done", text: "Success" });
  const browser = new FakeBrowser([redirected]);
  const jev = new FakeJev((request) => responseFor(request, "DONE", undefined, { done: 0.98 }));
  const result = await runBrowserLoop(browser, jev, {
    goal: "reach success",
    url: "https://example.test",
    verifiers: [{ type: "text_contains", text: "Success" }],
  });
  assert.equal(result.status, "needs_confirmation");
  assert.equal(jev.calls.length, 0);
});

test("a page that ends up on about:blank reports the new-tab cause", async () => {
  const blank = observation({ url: "about:blank", text: "", elements: [] });
  const browser = new FakeBrowser([blank]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "open the new window",
    url: "https://example.test/windows",
    allowedDomains: ["example.test"],
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /opens a new tab that cannot inherit the domain allowlist/);
  assert.equal(jev.calls.length, 0);
});

test("an out-of-allowlist redirect is blocked before verification", async () => {
  const redirected = observation({ url: "https://other.test/done", text: "Success" });
  const browser = new FakeBrowser([redirected]);
  const jev = new FakeJev((request) => responseFor(request, "DONE", undefined, { done: 0.98 }));
  const result = await runBrowserLoop(browser, jev, {
    goal: "reach success",
    url: "https://example.test",
    allowedDomains: ["example.test"],
    verifiers: [{ type: "text_contains", text: "Success" }],
  });
  assert.equal(result.status, "blocked");
  assert.equal(jev.calls.length, 0);
});

test("a post-action redirect is checked before its verifier", async () => {
  const before = observation({ text: "Continue", fingerprint: "a" });
  const redirected = observation({ url: "https://other.test/done", text: "Success", fingerprint: "b" });
  const browser = new FakeBrowser([before, before, redirected]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "reach success",
    url: before.url,
    allowedDomains: ["example.test"],
    verifiers: [{ type: "text_contains", text: "Success" }],
  });
  assert.equal(result.status, "blocked");
  assert.equal(browser.actions.length, 1);
});

test("deterministic verifier ends a progressed run before another Jev call", async () => {
  const before = observation({ text: "Continue", fingerprint: "a" });
  const after = observation({ text: "Success", elements: [], fingerprint: "b" });
  const browser = new FakeBrowser([before, before, after]);
  const jev = new FakeJev((request) => responseFor(request, "CLICK"));
  const result = await runBrowserLoop(browser, jev, {
    goal: "reach success",
    url: before.url,
    verifiers: [{ type: "text_contains", text: "Success" }],
  });
  assert.equal(result.status, "done");
  assert.equal(jev.calls.length, 1);
});

test("fake browser + fake Jev completes a full offline action loop", async () => {
  const before = observation({ text: "Continue", fingerprint: "a" });
  const after = observation({ url: "https://example.test/done", text: "Success", elements: [], fingerprint: "b" });
  const browser = new FakeBrowser([before, before, after, after]);
  const jev = new FakeJev((request, index) =>
    index === 0 ? responseFor(request, "CLICK") : responseFor(request, "DONE", undefined, { done: 0.98 }),
  );
  const result = await runBrowserLoop(browser, jev, {
    goal: "reach success",
    url: before.url,
    verifiers: [{ type: "text_contains", text: "Success" }],
  });
  assert.equal(result.status, "done");
  assert.equal(browser.actions.length, 1);
  assert.equal(jev.calls.length, 1);
});
