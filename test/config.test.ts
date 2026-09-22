import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveJevConfig } from "../src/config.js";

function fixture(document: unknown, secret = "file-secret"): { config: string; secret: string } {
  const directory = mkdtempSync(join(tmpdir(), "ajevt-browser-config-"));
  const secretPath = join(directory, "api-key");
  const configPath = join(directory, "config.json");
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  writeFileSync(configPath, JSON.stringify(document), { mode: 0o600 });
  return { config: configPath, secret: secretPath };
}

test("loads the shared config file and resolves a protected file secret", () => {
  const files = fixture({
    decision: {
      endpoint: "https://jev.example/systemone",
      model: "file-model",
      auth: { file: "placeholder" },
      headers: {},
      timeoutMs: 2100,
      retries: 3,
    },
  });
  const document = JSON.parse(readFileSync(files.config, "utf8"));
  document.decision.auth.file = files.secret;
  writeFileSync(files.config, JSON.stringify(document), { mode: 0o600 });
  const config = resolveJevConfig({ env: { AJEVT_BROWSER_CONFIG: files.config } });
  assert.deepEqual(config, {
    endpoint: "https://jev.example/systemone",
    model: "file-model",
    apiKey: "file-secret",
    headers: {},
    timeoutMs: 2100,
    retries: 3,
  });
});

test("environment and OpenCode options override the shared file", () => {
  const files = fixture({
    decision: {
      endpoint: "https://jev.example/systemone",
      model: "file-model",
      auth: { env: "FILE_KEY" },
      timeoutMs: 2100,
      retries: 1,
    },
  });
  const config = resolveJevConfig({
    env: { AJEVT_BROWSER_CONFIG: files.config, FILE_KEY: "base", JEV_MODEL: "env-model", JEV_TIMEOUT_MS: "2200" },
    hostOptions: { decision: { model: "host-model", retries: 4 } },
  });
  assert.equal(config.model, "host-model");
  assert.equal(config.timeoutMs, 2200);
  assert.equal(config.retries, 4);
  assert.equal(config.apiKey, "base");
});

test("refuses to send inherited credentials to an overridden endpoint", () => {
  const files = fixture({ decision: { endpoint: "https://jev.example/systemone", auth: { env: "FILE_KEY" } } });
  assert.throws(
    () =>
      resolveJevConfig({
        env: { AJEVT_BROWSER_CONFIG: files.config, FILE_KEY: "base" },
        hostOptions: { decision: { endpoint: "https://attacker.example/systemone" } },
      }),
    /changes endpoint but does not provide auth/,
  );
});

test("clears inherited headers when endpoint and auth change together", () => {
  const files = fixture({
    decision: {
      endpoint: "https://old.example/systemone",
      auth: { env: "OLD_KEY" },
      headers: { "x-api-key": { env: "HEADER_KEY" }, "x-route": "old" },
    },
  });
  const config = resolveJevConfig({
    env: { AJEVT_BROWSER_CONFIG: files.config, OLD_KEY: "old", HEADER_KEY: "header", NEW_KEY: "new" },
    hostOptions: { decision: { endpoint: "https://new.example/systemone", auth: { env: "NEW_KEY" } } },
  });
  assert.deepEqual(config.headers, {});
  assert.equal(config.apiKey, "new");
});

test("rejects non-HTTP protocols and embedded URL credentials", () => {
  assert.throws(
    () =>
      resolveJevConfig({
        env: { JEV_ENDPOINT: "file://localhost/tmp/jev", JEV_API_KEY: "secret" },
        userConfigPath: "/missing",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      resolveJevConfig({
        env: { JEV_ENDPOINT: "https://user:pass@jev.example/systemone", JEV_API_KEY: "secret" },
        userConfigPath: "/missing",
      }),
    /embedded credentials/,
  );
});

test("rejects reserved and plaintext sensitive custom headers", () => {
  assert.throws(
    () =>
      resolveJevConfig({
        env: { JEV_API_KEY: "secret", JEV_HEADERS: '{"Authorization":"override"}' },
        userConfigPath: "/missing",
      }),
    /reserved header/,
  );
  assert.throws(
    () =>
      resolveJevConfig({
        env: { JEV_API_KEY: "secret", JEV_HEADERS: '{"x-api-key":"plaintext"}' },
        userConfigPath: "/missing",
      }),
    /must use an env or file secret reference/,
  );
});
