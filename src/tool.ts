import { AgentBrowserAdapter } from "./agent-browser.js";
import { resolveJevConfig } from "./config.js";
import { FetchJevTransport } from "./jev.js";
import { runBrowserLoop } from "./loop.js";
import type { Handoff, Verifier } from "./types.js";

export const TOOL_NAME = "ajevt_browser";
export const TOOL_DESCRIPTION =
  "Fast browser reflex for clear, bounded tasks with observable completion. Uses agent-browser as the only browser backend and Jev only for finite choices. Returns structured handoff instead of guessing. Do not use for exploratory research or complex reasoning.";

export interface AjevtBrowserParams {
  goal: string;
  url: string;
  values?: Record<string, string>;
  max_steps?: number;
  allow_risky?: boolean;
  allowed_domains?: string[];
  ignore_https_errors?: boolean;
  ca_cert?: string;
  proxy?: string;
  proxy_bypass?: string[];
  host_mappings?: Record<string, string>;
  session_id?: string;
  keep_session?: boolean;
  require_action?: boolean;
  verifiers?: Verifier[];
}

export interface ToolProgress {
  step: number;
  phase: string;
  url?: string;
  operation?: string;
}

export interface ExecuteAjevtBrowserOptions {
  signal?: AbortSignal;
  onProgress?: (event: ToolProgress) => void | Promise<void>;
  hostOptions?: unknown;
}

export async function executeAjevtBrowser(
  params: AjevtBrowserParams,
  options: ExecuteAjevtBrowserOptions = {},
): Promise<Handoff> {
  const config = resolveJevConfig({ hostOptions: options.hostOptions });
  return runBrowserLoop(new AgentBrowserAdapter(undefined, params.session_id), new FetchJevTransport(config), {
    goal: params.goal,
    url: params.url,
    values: params.values,
    maxSteps: params.max_steps,
    allowRisky: params.allow_risky,
    allowedDomains: params.allowed_domains,
    ignoreHttpsErrors: params.ignore_https_errors,
    caCert: params.ca_cert,
    proxy: params.proxy,
    proxyBypass: params.proxy_bypass,
    hostMappings: params.host_mappings,
    keepSession: params.keep_session,
    requireAction: params.require_action,
    verifiers: params.verifiers,
    model: config.model,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}
