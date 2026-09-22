import { spawn } from "node:child_process";
import { isSecretField, normalizeSnapshot } from "./observation.js";
import type { BrowserAdapter, BrowserOpenOptions, Candidate, Observation } from "./types.js";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

export class AgentBrowserCommandError extends Error {
  constructor(
    readonly code: "ABORTED" | "OUTPUT_LIMIT" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "AgentBrowserCommandError";
  }
}

function run(
  binary: string,
  session: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, ...args, "--json"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      outputBytes = 0,
      settled = false;
    let timer: NodeJS.Timeout;
    const done = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve({ code, stdout, stderr });
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        done(
          new AgentBrowserCommandError(
            "OUTPUT_LIMIT",
            `agent-browser command exceeded ${MAX_COMMAND_OUTPUT_BYTES} output bytes`,
          ),
        );
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", done);
    child.on("close", (code) => done(undefined, code ?? 1));
    const abort = () => {
      child.kill("SIGTERM");
      done(
        signal?.reason instanceof Error
          ? signal.reason
          : new AgentBrowserCommandError("ABORTED", "agent-browser command aborted"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(new AgentBrowserCommandError("TIMEOUT", `agent-browser command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function parse(result: CommandResult, command: string): any {
  if (result.code !== 0)
    throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  let payload: any;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
  if (payload?.success === false) throw new Error(`${command} failed: ${payload.error ?? "unknown error"}`);
  return payload;
}

export class AgentBrowserAdapter implements BrowserAdapter {
  readonly session: string;
  private opened = false;
  private globalArgs: string[] = [];
  private readonly resumed: boolean;
  constructor(
    private readonly binary = process.env.AGENT_BROWSER_BIN ?? "agent-browser",
    session?: string,
  ) {
    this.resumed = session !== undefined;
    this.session =
      session ?? `ajevt-browser-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private command(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<CommandResult> {
    return run(this.binary, this.session, [...this.globalArgs, ...args], signal, timeoutMs);
  }

  async open(url: string, options: BrowserOpenOptions = {}, signal?: AbortSignal): Promise<void> {
    const hostResolverRules: string[] = [];
    this.globalArgs = [];
    const allowedDomains = options.allowedDomains?.length ? options.allowedDomains : [new URL(url).hostname];
    this.globalArgs.push("--allowed-domains", allowedDomains.join(","));
    if (options.ignoreHttpsErrors) this.globalArgs.push("--ignore-https-errors");
    if (options.caCert) this.globalArgs.push("--ca-cert", options.caCert);
    if (options.proxy) this.globalArgs.push("--proxy", options.proxy);
    if (options.proxyBypass?.length) this.globalArgs.push("--proxy-bypass", options.proxyBypass.join(","));
    for (const [hostname, address] of Object.entries(options.hostMappings ?? {}))
      hostResolverRules.push(`MAP ${hostname} ${address}`);
    if (hostResolverRules.length)
      this.globalArgs.push("--args", `--host-resolver-rules=${hostResolverRules.join(",")}`);
    if (this.resumed) {
      const current = await this.command(["get", "url"], signal)
        .then((result) => parse(result, "agent-browser get url"))
        .catch(() => undefined);
      if (current?.data?.url === url) {
        this.opened = true;
        return;
      }
    }
    parse(await this.command(["open", url], signal), "agent-browser open");
    this.opened = true;
    parse(
      await this.command(["wait", "--load", "domcontentloaded"], signal, 10_000),
      "agent-browser wait for DOM content",
    );
  }

  private async observeOnce(signal?: AbortSignal): Promise<Observation> {
    // Commands targeting one agent-browser session share daemon/browser state.
    // Keep them sequential so navigation and value reads cannot race each other.
    const payload = parse(await this.command(["snapshot", "-i"], signal), "agent-browser snapshot");
    const urlPayload = parse(await this.command(["get", "url"], signal), "agent-browser get url");
    const titlePayload = parse(await this.command(["get", "title"], signal), "agent-browser get title");
    payload.data ??= {};
    payload.data.url = urlPayload.data?.url ?? payload.data.origin ?? "";
    payload.data.title = titlePayload.data?.title ?? "";
    const observation = normalizeSnapshot(payload);
    for (const element of observation.elements) {
      if (["textbox", "searchbox", "spinbutton", "combobox"].includes(element.role)) {
        const result = parse(await this.command(["get", "value", element.ref], signal), "agent-browser get value");
        if (typeof result?.data?.value !== "string")
          throw new Error(`agent-browser get value returned no string value for ${element.ref}`);
        element.value = isSecretField(element) ? "[redacted]" : result.data.value;
      }
      if (["checkbox", "radio", "switch"].includes(element.role)) {
        const result = parse(await this.command(["is", "checked", element.ref], signal), "agent-browser is checked");
        if (typeof result?.data?.checked !== "boolean")
          throw new Error(`agent-browser is checked returned no boolean state for ${element.ref}`);
        element.checked = result.data.checked;
      }
    }
    return normalizeSnapshot({
      data: {
        url: observation.url,
        title: observation.title,
        text: observation.text,
        refs: Object.fromEntries(observation.elements.map((element) => [element.ref.slice(1), element])),
      },
    });
  }

  async observe(signal?: AbortSignal): Promise<Observation> {
    let observation = await this.observeOnce(signal);
    const isTransientlyEmpty = () =>
      !observation.title &&
      !observation.elements.length &&
      (!observation.text || observation.text === "(no interactive elements)");
    for (let attempt = 0; attempt < 10 && isTransientlyEmpty(); attempt++) {
      await this.command(["wait", "500"], signal, 2_000);
      observation = await this.observeOnce(signal);
    }
    return observation;
  }

  async execute(candidate: Candidate, signal?: AbortSignal): Promise<void> {
    let args: string[];
    switch (candidate.operation) {
      case "CLICK":
        args = ["click", candidate.ref!];
        break;
      case "TYPE":
        args = ["fill", candidate.ref!, candidate.value!];
        break;
      case "SELECT":
        args = ["select", candidate.ref!, candidate.option!];
        break;
      case "PRESS":
        args = ["press", candidate.key!];
        break;
      case "SCROLL":
        args = ["scroll", candidate.direction ?? "down", "600"];
        break;
      case "BACK":
        args = ["back"];
        break;
      case "WAIT":
        args = ["wait", "750"];
        break;
      default:
        throw new Error(`Operation ${candidate.operation} is not executable`);
    }
    parse(await this.command(args, signal), `agent-browser ${args[0]}`);
    if (["CLICK", "PRESS", "BACK"].includes(candidate.operation)) {
      parse(await this.command(["wait", "500"], signal, 2_000), "agent-browser wait after action");
    }
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await this.command(["close"], undefined, 10_000).catch(() => undefined);
  }
}
