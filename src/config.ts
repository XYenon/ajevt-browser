import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { JevConfig } from "./jev.js";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_SECRET_BYTES = 16 * 1024;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "content-type",
]);
const SENSITIVE_HEADER = /(?:api[-_]?key|token|secret|credential)/i;

type SecretRef = { env: string } | { file: string };
type HeaderValue = string | SecretRef;

interface DecisionPatch {
  endpoint?: string;
  model?: string;
  auth?: SecretRef;
  headers?: Record<string, HeaderValue>;
  timeoutMs?: number;
  retries?: number;
}

export interface ResolveJevConfigOptions {
  env?: NodeJS.ProcessEnv;
  hostOptions?: unknown;
  userConfigPath?: string;
}

function object(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be an object`);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], source: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${source} contains unknown key ${JSON.stringify(key)}`);
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new Error(`${source} contains an unsafe key`);
  }
}

function secretRef(value: unknown, source: string): SecretRef {
  const record = object(value, source);
  knownKeys(record, ["env", "file"], source);
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== "env" && keys[0] !== "file"))
    throw new Error(`${source} must contain exactly one of env or file`);
  const key = keys[0] as "env" | "file";
  const target = record[key];
  if (typeof target !== "string" || target.length === 0) throw new Error(`${source}.${key} must be a non-empty string`);
  if (key === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target))
    throw new Error(`${source}.env is not a valid environment variable name`);
  if (key === "file" && !isAbsolute(target)) throw new Error(`${source}.file must be an absolute path`);
  return { [key]: target } as SecretRef;
}

function parseHeaders(value: unknown, source: string): Record<string, HeaderValue> {
  const record = object(value, source);
  const result = Object.create(null) as Record<string, HeaderValue>;
  for (const [name, raw] of Object.entries(record)) {
    const normalized = name.toLowerCase();
    if (!name || FORBIDDEN_HEADERS.has(normalized))
      throw new Error(`${source} cannot set reserved header ${JSON.stringify(name)}`);
    if (typeof raw === "string") {
      if (SENSITIVE_HEADER.test(name)) throw new Error(`${source}.${name} must use an env or file secret reference`);
      result[name] = raw;
    } else result[name] = secretRef(raw, `${source}.${name}`);
  }
  return result;
}

function parseDecision(value: unknown, source: string): DecisionPatch {
  const record = object(value, source);
  knownKeys(record, ["endpoint", "model", "auth", "headers", "timeoutMs", "retries"], source);
  const patch: DecisionPatch = {};
  if ("endpoint" in record) {
    if (typeof record.endpoint !== "string" || record.endpoint.length === 0)
      throw new Error(`${source}.endpoint must be a non-empty string`);
    try {
      new URL(record.endpoint);
    } catch {
      throw new Error(`${source}.endpoint must be a valid URL`);
    }
    patch.endpoint = record.endpoint;
  }
  if ("model" in record) {
    if (typeof record.model !== "string" || record.model.length === 0)
      throw new Error(`${source}.model must be a non-empty string`);
    patch.model = record.model;
  }
  if ("auth" in record) patch.auth = secretRef(record.auth, `${source}.auth`);
  if ("headers" in record) patch.headers = parseHeaders(record.headers, `${source}.headers`);
  if ("timeoutMs" in record) {
    if (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs) || record.timeoutMs < 1)
      throw new Error(`${source}.timeoutMs must be a positive number`);
    patch.timeoutMs = record.timeoutMs;
  }
  if ("retries" in record) {
    if (!Number.isInteger(record.retries) || (record.retries as number) < 0 || (record.retries as number) > 5)
      throw new Error(`${source}.retries must be an integer from 0 to 5`);
    patch.retries = record.retries as number;
  }
  return patch;
}

function parseDocument(value: unknown, source: string): DecisionPatch {
  const record = object(value, source);
  knownKeys(record, ["$schema", "decision"], source);
  if (!("decision" in record)) throw new Error(`${source} must contain decision`);
  return parseDecision(record.decision, `${source}.decision`);
}

function readConfig(path: string): DecisionPatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Jev config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseDocument(parsed, path);
}

function parseEnvironment(env: NodeJS.ProcessEnv): DecisionPatch {
  const patch: DecisionPatch = {};
  if (env.JEV_ENDPOINT) patch.endpoint = env.JEV_ENDPOINT;
  if (env.JEV_MODEL) patch.model = env.JEV_MODEL;
  const keyName = env.JEV_API_KEY ? "JEV_API_KEY" : env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY" : undefined;
  if (keyName) patch.auth = { env: keyName };
  if (env.JEV_HEADERS) {
    let headers: unknown;
    try {
      headers = JSON.parse(env.JEV_HEADERS);
    } catch {
      throw new Error("JEV_HEADERS must be a JSON object of HTTP headers");
    }
    patch.headers = parseHeaders(headers, "JEV_HEADERS");
  }
  if (env.JEV_TIMEOUT_MS) patch.timeoutMs = Number(env.JEV_TIMEOUT_MS);
  if (env.JEV_RETRIES) patch.retries = Number(env.JEV_RETRIES);
  return parseDecision(patch, "environment");
}

function readSecretFile(path: string): string {
  const link = lstatSync(path);
  if (!link.isFile() && !link.isSymbolicLink()) throw new Error(`Jev secret path is not a regular file: ${path}`);
  const resolved = realpathSync(path);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`Jev secret path is not a regular file: ${path}`);
  if (stat.size > MAX_SECRET_BYTES) throw new Error(`Jev secret file exceeds ${MAX_SECRET_BYTES} bytes: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error(`Jev secret file must not be accessible by group or others: ${path}`);
  const value = readFileSync(resolved, "utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error(`Jev secret file is empty: ${path}`);
  return value;
}

function resolveSecret(ref: SecretRef, env: NodeJS.ProcessEnv, source: string): string {
  if ("env" in ref) {
    const value = env[ref.env];
    if (!value) throw new Error(`${source} references missing or empty environment variable ${ref.env}`);
    return value;
  }
  try {
    return readSecretFile(ref.file);
  } catch (error) {
    throw new Error(`${source} could not read secret file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveHeaders(
  headers: Record<string, HeaderValue>,
  env: NodeJS.ProcessEnv,
  source: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === "string" ? value : resolveSecret(value, env, `${source}.${name}`),
    ]),
  );
}

export function defaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ajevt-browser", "config.json");
}

export function resolveJevConfig(options: ResolveJevConfigOptions = {}): JevConfig {
  const env = options.env ?? process.env;
  const explicitPath = env.AJEVT_BROWSER_CONFIG;
  if (explicitPath && !isAbsolute(explicitPath)) throw new Error("AJEVT_BROWSER_CONFIG must be an absolute path");
  const configPath = explicitPath || options.userConfigPath || defaultUserConfigPath(env);
  let merged: DecisionPatch = {
    endpoint: DEFAULT_ENDPOINT,
    model: "jev-latest",
    headers: {},
    timeoutMs: 2_000,
    retries: 5,
  };
  let endpointSource = "defaults";
  let authSource: string | undefined;

  const apply = (patch: DecisionPatch, source: string) => {
    if (patch.endpoint !== undefined && patch.endpoint !== merged.endpoint && merged.auth && patch.auth === undefined) {
      throw new Error(
        `${source} changes endpoint but does not provide auth; refusing to reuse credentials from ${authSource}`,
      );
    }
    const endpointChanged = patch.endpoint !== undefined && patch.endpoint !== merged.endpoint;
    merged = { ...merged, ...patch };
    if (endpointChanged && patch.headers === undefined) merged.headers = {};
    if (patch.endpoint !== undefined) endpointSource = source;
    if (patch.auth !== undefined) authSource = source;
  };

  if (existsSync(configPath)) apply(readConfig(configPath), configPath);
  else if (explicitPath) throw new Error(`AJEVT_BROWSER_CONFIG does not exist: ${configPath}`);
  apply(parseEnvironment(env), "environment");
  if (options.hostOptions !== undefined) {
    const hostOptions = object(options.hostOptions, "OpenCode plugin options");
    if (Object.keys(hostOptions).length > 0)
      apply(parseDocument(hostOptions, "OpenCode plugin options"), "OpenCode plugin options");
  }

  const endpoint = merged.endpoint!;
  const url = new URL(endpoint);
  if (!merged.auth)
    throw new Error(
      "No Jev authentication configured. Set JEV_API_KEY (or TYPESAFE_API_KEY), or configure decision.auth",
    );
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.username || url.password)
    throw new Error(`Jev endpoint from ${endpointSource} must not contain embedded credentials`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Jev endpoint from ${endpointSource} must use HTTPS, except HTTP on loopback`);
  }
  return {
    endpoint,
    apiKey: resolveSecret(merged.auth, env, authSource ?? "configuration"),
    model: merged.model!,
    headers: resolveHeaders(merged.headers!, env, authSource ?? "configuration"),
    timeoutMs: merged.timeoutMs!,
    retries: merged.retries!,
  };
}
