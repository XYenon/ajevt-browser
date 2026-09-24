import { spawn } from "node:child_process";
import { allowedDomainPatterns } from "./domains.js";
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
  // A session may have a live browser even when a command failed, so track
  // whether a session was started rather than whether the last navigation
  // succeeded: close() must still shut it down or the daemon keeps the browser.
  private started = false;
  private globalArgs: string[] = [];
  private readonly resumed: boolean;
  constructor(
    private readonly binary = process.env.AGENT_BROWSER_BIN ?? "agent-browser",
    session?: string,
  ) {
    this.resumed = session !== undefined;
    this.started = this.resumed;
    this.session =
      session ?? `ajevt-browser-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private command(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<CommandResult> {
    return run(this.binary, this.session, [...this.globalArgs, ...args], signal, timeoutMs);
  }

  async open(url: string, options: BrowserOpenOptions = {}, signal?: AbortSignal): Promise<void> {
    const hostResolverRules: string[] = [];
    this.globalArgs = [];
    // Only a caller-provided allowlist turns on agent-browser's browser-level
    // containment. Its network controls break some sites (Bing leaves the page
    // for about:blank), so the default stays with the loop's own origin checks.
    if (options.allowedDomains?.length)
      this.globalArgs.push("--allowed-domains", allowedDomainPatterns(options.allowedDomains).join(","));
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
        this.started = true;
        return;
      }
    }
    this.started = true;
    parse(await this.command(["open", url], signal), "agent-browser open");
    // `open` already waits for the load event, so this readiness wait is a
    // best-effort confirmation. A slow page must not turn a usable load into a
    // failed run; the observation retries an empty page on its own.
    await this.command(["wait", "--load", "domcontentloaded"], signal, 10_000).catch(() => undefined);
  }

  private async observeOnce(signal?: AbortSignal): Promise<Observation> {
    // Commands targeting one agent-browser session share daemon/browser state.
    // Keep them sequential so navigation and value reads cannot race each other.
    const payload = parse(await this.command(["snapshot", "-i"], signal), "agent-browser snapshot");
    const urlPayload = parse(await this.command(["get", "url"], signal), "agent-browser get url");
    const titlePayload = parse(await this.command(["get", "title"], signal), "agent-browser get title");
    const pageText = await this.readPageText(signal);
    payload.data ??= {};
    payload.data.url = urlPayload.data?.url ?? payload.data.origin ?? "";
    payload.data.title = titlePayload.data?.title ?? "";
    // `snapshot -i` only covers interactive nodes and headings, so the rendered
    // page text is what makes text verifiers and page context meaningful.
    if (pageText !== undefined) payload.data.text = pageText;
    const observation = normalizeSnapshot(payload);
    for (const element of observation.elements) {
      if (["textbox", "searchbox", "spinbutton", "combobox"].includes(element.role)) {
        const result = parse(await this.command(["get", "value", element.ref], signal), "agent-browser get value");
        if (typeof result?.data?.value !== "string")
          throw new Error(`agent-browser get value returned no string value for ${element.ref}`);
        element.filled = result.data.value.length > 0;
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
        snapshot: observation.text,
        text: observation.pageText,
        refs: Object.fromEntries(observation.elements.map((element) => [element.ref.slice(1), element])),
      },
    });
  }

  // Rendered page text. agent-browser's `read` reads the active tab, so a
  // failure here must not fail the observation; the accessibility text is the
  // fallback.
  private async readPageText(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const payload = parse(await this.command(["read"], signal), "agent-browser read");
      const content = payload?.data?.content;
      return typeof content === "string" && content.trim() ? content : undefined;
    } catch {
      return undefined;
    }
  }

  async observe(signal?: AbortSignal): Promise<Observation> {
    let observation = await this.observeOnce(signal);
    // A page that is still committing a navigation has a title from the new
    // document but no nodes or text yet, so only nodes and text decide emptiness.
    const isTransientlyEmpty = () =>
      !observation.elements.length && (!observation.text || observation.text === "(no interactive elements)");
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
    try {
      parse(await this.command(args, signal), `agent-browser ${args[0]}`);
    } catch (error) {
      const diagnosis = await this.diagnoseLostPage(signal);
      if (!diagnosis) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)} — ${diagnosis}`);
    }
    if (["CLICK", "PRESS", "BACK"].includes(candidate.operation)) {
      // A click can commit a new document a moment after the command returns.
      // Give the navigation a chance to start, then wait for the new document's
      // DOM so the following observation does not read the page being replaced.
      await this.command(["wait", "500"], signal, 2_000).catch(() => undefined);
      await this.command(["wait", "--load", "domcontentloaded"], signal, 10_000).catch(() => undefined);
    }
  }

  // A page that opens its own tab cannot inherit agent-browser's network
  // controls, so the action fails and the session lands on about:blank. Say so
  // instead of reporting a bare command timeout.
  private async diagnoseLostPage(signal?: AbortSignal): Promise<string | undefined> {
    const url = await this.command(["get", "url"], signal, 5_000)
      .then((result) => parse(result, "agent-browser get url")?.data?.url)
      .catch(() => undefined);
    if (url !== "about:blank") return undefined;
    return "the page is now about:blank, which happens when a click opens a new tab that cannot inherit the domain allowlist; retry without allowed_domains or choose a link that stays in this tab";
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.command(["close"], undefined, 10_000).catch(() => undefined);
  }
}
