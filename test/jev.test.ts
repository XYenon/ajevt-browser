import assert from "node:assert/strict";
import test from "node:test";
import { resolveJevConfig } from "../src/config.js";
import { FetchJevTransport } from "../src/jev.js";

test("Jev defaults to a 2s per-attempt timeout and five retries", () => {
  const config = resolveJevConfig({ env: { JEV_API_KEY: "secret" }, userConfigPath: "/missing" });
  assert.equal(config.timeoutMs, 2_000);
  assert.equal(config.retries, 5);
});

test("custom endpoint, model, API key, and headers are first-class", async () => {
  const config = resolveJevConfig({
    env: {
      JEV_ENDPOINT: "https://jev.example/custom/path",
      JEV_API_KEY: "secret",
      JEV_MODEL: "custom-jev",
      JEV_HEADERS: '{"x-route":"fast"}',
    },
    userConfigPath: "/missing",
  });
  let seen: any;
  const transport = new FetchJevTransport(config, (async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ answers: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  await transport.decide({ model: config.model, state: {}, questions: {} });
  assert.equal(seen.url, "https://jev.example/custom/path");
  assert.equal(seen.init.headers.authorization, "Bearer secret");
  assert.equal(seen.init.headers["x-route"], "fast");
  assert.equal(JSON.parse(seen.init.body).model, "custom-jev");
});

test("each Jev request has a timeout and retries transient failures", async () => {
  const config = resolveJevConfig({
    env: {
      JEV_ENDPOINT: "https://jev.example/decision",
      JEV_API_KEY: "secret",
      JEV_TIMEOUT_MS: "1234",
      JEV_RETRIES: "2",
    },
    userConfigPath: "/missing",
  });
  let attempts = 0;
  const transport = new FetchJevTransport(config, (async (_url, init) => {
    attempts += 1;
    assert.ok(init?.signal);
    if (attempts < 3) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
    return new Response(JSON.stringify({ answers: {} }), { status: 200 });
  }) as typeof fetch);
  await transport.decide({ model: config.model, state: {}, questions: {} });
  assert.equal(config.timeoutMs, 1234);
  assert.equal(attempts, 3);
});
