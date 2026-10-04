import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiDecision } from "../extensions/jev.js";
import { AgentBrowserAdapter } from "../src/agent-browser.js";
import { resolveJevConfig } from "../src/config.js";
import { FetchJevTransport } from "../src/jev.js";
import { runBrowserLoop } from "../src/loop.js";
import { executeAjevtBrowser } from "../src/tool.js";
import { FakeBrowser, observation } from "./helpers.js";

type Registry = ExtensionContext["modelRegistry"];
type Result = Awaited<ReturnType<Registry["classify"]>>;

function registry(classify: Registry["classify"], provider = "typesafe", id = "jev-latest"): Registry {
  const model = { type: "classifier", provider, id, api: "typesafe-system-one" };
  return {
    findOfType(type: string, requestedProvider: string, requestedId: string) {
      assert.deepEqual([type, requestedProvider, requestedId], ["classifier", provider, id]);
      return model;
    },
    async classify(
      selected: unknown,
      context: Parameters<Registry["classify"]>[1],
      options: Parameters<Registry["classify"]>[2],
    ) {
      assert.equal(selected, model);
      return classify(model as never, context, options);
    },
  } as Registry;
}

function result(answers: Result["answers"], overrides: Partial<Result> = {}): Result {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

test("Pi uses native credentials and converts choice and boolean questions and answers", async () => {
  const signal = new AbortController().signal;
  const state = { goal: "Open settings", page: { title: "Dashboard" } };
  const operation = {
    type: "choice" as const,
    choice: "CLICK",
    confidence: 0.91,
    probabilities: { CLICK: 0.91, DONE: 0.09 },
  };
  const decision = resolvePiDecision(
    registry(async (_model, context, options) => {
      assert.deepEqual(context.state, state);
      assert.deepEqual(context.questions.operation, {
        type: "choice",
        instructions: "Choose an operation",
        criteria: { CLICK: "Click", DONE: "Finish" },
      });
      assert.deepEqual(context.questions.goal_completed, {
        type: "bool",
        instructions: "Goal is complete",
        criteria: { true: "Goal is complete", false: "Not: Goal is complete" },
      });
      assert.equal(context.questions.risky.type, "bool");
      assert.deepEqual(options, { signal, timeoutMs: 3210, maxRetries: 3, headers: { "x-route": "fast" } });
      return result({
        operation,
        goal_completed: { type: "bool", probability: 0.17 },
        risky: { type: "bool", probability: 0.83 },
      });
    }),
    {
      env: { JEV_TIMEOUT_MS: "3210", JEV_RETRIES: "3", JEV_HEADERS: '{"x-route":"fast"}' },
      userConfigPath: "/missing",
    },
  );
  assert.equal(decision.model, "jev-latest");
  const response = await decision.transport.decide(
    {
      model: decision.model,
      state,
      questions: {
        operation: {
          type: "choice",
          instructions: "Choose an operation",
          criteria: { CLICK: "Click", DONE: "Finish" },
        },
        goal_completed: { type: "noul", instructions: "Goal is complete" },
        risky: { type: "noul", instructions: "Action sends data" },
      },
    },
    signal,
  );
  assert.deepEqual(response.answers, { operation, goal_completed: { noul: 0.17 }, risky: { noul: 0.83 } });
});

test("Pi session model selection is independent of the shared HTTP model and credentials", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-pi-jev-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ decision: { model: "http-model" } }));
  const decision = resolvePiDecision(
    registry(async () => result({}), "openrouter", "typesafe/jev-1.13"),
    {
      env: {},
      userConfigPath: configPath,
    },
    { provider: "openrouter", id: "typesafe/jev-1.13" },
  );
  assert.equal(decision.model, "typesafe/jev-1.13");
  const overridden = resolvePiDecision(
    registry(
      async (_model, _context, options) => {
        assert.equal(options?.apiKey, undefined);
        assert.equal(options?.headers, undefined);
        return result({});
      },
      "cloudflare-workers-ai",
      "typesafe/jev",
    ),
    {
      env: {
        JEV_MODEL: "http-env-model",
        JEV_API_KEY: "http-key",
        JEV_ENDPOINT: "https://http.example/systemone",
        JEV_HEADERS: '{"x-api-key":{"env":"HTTP_HEADER_KEY"}}',
        HTTP_HEADER_KEY: "http-header-secret",
      },
      userConfigPath: configPath,
    },
    { provider: "cloudflare-workers-ai", id: "typesafe/jev" },
  );
  assert.equal(overridden.model, "typesafe/jev");
  await overridden.transport.decide({ model: overridden.model, state: {}, questions: {} });
  const defaultDecision = resolvePiDecision(
    registry(async () => result({})),
    {
      env: { JEV_MODEL: "http-env-model" },
      userConfigPath: configPath,
    },
  );
  assert.equal(defaultDecision.model, "jev-latest");
  assert.equal(resolveJevConfig({ env: { JEV_API_KEY: "key" }, userConfigPath: configPath }).model, "http-model");
});

test("native boolean risk assessment prevents execution in the browser loop", async () => {
  const browser = new FakeBrowser([observation({ elements: [{ ref: "@e1", role: "button", name: "Save" }] })]);
  let calls = 0;
  const decision = resolvePiDecision(
    registry(async (_model, context) => {
      calls++;
      if (context.questions.risky) return result({ risky: { type: "bool", probability: 0.87 } });
      const ids = Object.keys((context.questions.operation as { criteria: Record<string, string> }).criteria);
      return result({
        operation: {
          type: "choice",
          choice: "CLICK",
          confidence: 0.96,
          probabilities: Object.fromEntries(ids.map((id) => [id, id === "CLICK" ? 0.96 : 0.04 / (ids.length - 1)])),
        },
        goal_completed: { type: "bool", probability: 0.03 },
        stuck: { type: "bool", probability: 0.08 },
      });
    }),
    { env: {}, userConfigPath: "/missing" },
  );
  const handoff = await runBrowserLoop(browser, decision.transport, {
    goal: "Continue",
    url: "https://example.test/",
    model: decision.model,
  });
  assert.equal(calls, 2);
  assert.equal(handoff.status, "needs_confirmation");
  assert.equal(browser.actions.length, 0);
});

test("shared executor uses the injected native classifier without resolving HTTP credentials", async (t) => {
  const page = observation();
  t.mock.method(AgentBrowserAdapter.prototype, "open", async () => {});
  t.mock.method(AgentBrowserAdapter.prototype, "observe", async () => page);
  const close = t.mock.method(AgentBrowserAdapter.prototype, "close", async () => {});
  let calls = 0;
  const decision = resolvePiDecision(
    registry(async (_model, context) => {
      calls++;
      const ids = Object.keys((context.questions.operation as { criteria: Record<string, string> }).criteria);
      return result({
        operation: {
          type: "choice",
          choice: "DONE",
          confidence: 0.97,
          probabilities: Object.fromEntries(ids.map((id) => [id, id === "DONE" ? 0.97 : 0.03 / (ids.length - 1)])),
        },
        goal_completed: { type: "bool", probability: 0.97 },
        stuck: { type: "bool", probability: 0.02 },
      });
    }),
    { env: {}, userConfigPath: "/missing" },
  );
  const handoff = await executeAjevtBrowser(
    { goal: "Inspect the page", url: page.url },
    { decision, hostOptions: { invalid_http_config: true } },
  );
  assert.equal(calls, 1);
  assert.equal(handoff.status, "likely_done");
  assert.equal(handoff.confidence, 0.97);
  assert.equal(close.mock.callCount(), 1);
});

test("Pi error and aborted results become transport failures", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const decision = resolvePiDecision(
      registry(async () => result({}, { stopReason, errorMessage: "Provider unavailable" })),
      {
        env: {},
        userConfigPath: "/missing",
      },
    );
    await assert.rejects(
      decision.transport.decide({ model: decision.model, state: {}, questions: {} }),
      /Provider unavailable/,
    );
  }
  const controller = new AbortController();
  const reason = new Error("Caller cancelled");
  controller.abort(reason);
  const decision = resolvePiDecision(
    registry(async () => result({}, { stopReason: "aborted" })),
    { env: {}, userConfigPath: "/missing" },
  );
  await assert.rejects(
    decision.transport.decide({ model: decision.model, state: {}, questions: {} }, controller.signal),
    (error) => error === reason,
  );
});

test("explicit HTTP credentials preserve direct transport even on older Pi", () => {
  for (const env of [{ JEV_API_KEY: "test-key" }, { TYPESAFE_API_KEY: "test-key" }]) {
    const decision = resolvePiDecision({} as Registry, { env, userConfigPath: "/missing" });
    assert.ok(decision.transport instanceof FetchJevTransport);
  }
  assert.throws(() => resolvePiDecision({} as Registry, { env: {}, userConfigPath: "/missing" }), /Pi 1.0.0 or newer/);
});

test("missing native models and custom endpoints fail without leaking Pi credentials", () => {
  const missing = { findOfType: () => undefined, classify: async () => result({}) } as unknown as Registry;
  assert.throws(
    () => resolvePiDecision(missing, { env: {}, userConfigPath: "/missing" }),
    /no classifier model typesafe\/jev-latest/,
  );
  assert.throws(
    () =>
      resolvePiDecision(missing, {
        env: { JEV_ENDPOINT: "https://custom.example/systemone" },
        userConfigPath: "/missing",
      }),
    /custom Jev endpoint requires/,
  );
  assert.throws(() => resolveJevConfig({ env: {}, userConfigPath: "/missing" }), /No Jev authentication/);
});
