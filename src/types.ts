export type Operation = "CLICK" | "TYPE" | "SELECT" | "PRESS" | "SCROLL" | "BACK" | "WAIT" | "DONE" | "BLOCKED";
export type HandoffStatus =
  | "done"
  | "likely_done"
  | "input_required"
  | "ambiguous"
  | "needs_confirmation"
  | "blocked"
  | "stuck"
  | "error";

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  // Whether the field currently holds a value. Recorded before redaction so a
  // filled secret field is still recognizable as filled.
  filled?: boolean;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  options?: Array<{ label: string; value: string; disabled?: boolean; selected?: boolean }>;
}

export interface Observation {
  url: string;
  title: string;
  text: string;
  pageText: string;
  elements: BrowserElement[];
  fingerprint: string;
}

export interface Candidate {
  id: string;
  operation: Operation;
  label: string;
  ref?: string;
  valueKey?: string;
  value?: string;
  option?: string;
  key?: string;
  direction?: "up" | "down";
  risky?: boolean;
  secret?: boolean;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  noul: number;
}
export interface JevResponse {
  answers: Record<string, ChoiceAnswer | NoulAnswer | unknown>;
  model?: string;
  usage?: unknown;
}

export interface Decision {
  operation: Operation;
  candidate?: Candidate;
  confidence: number;
  goalCompleted: number;
  stuck: number;
  risky: number;
  raw: JevResponse;
}

export type Verifier =
  | { type: "url_contains"; text: string }
  | { type: "url_matches"; pattern: string }
  | { type: "text_contains"; text: string }
  | { type: "text_absent"; text: string }
  | { type: "element_exists"; role?: string; name?: string }
  | { type: "element_gone"; role?: string; name?: string }
  | { type: "value_equals"; ref: string; value: string }
  | { type: "element_value_equals"; role?: string; name: string; value: string }
  | { type: "checked"; ref: string; state?: boolean };

export interface HistoryEntry {
  step: number;
  operation: Operation;
  target?: string;
  label: string;
  valueKey?: string;
  confidence: number;
  changed: boolean;
  url: string;
  error?: string;
}

export interface Handoff {
  status: HandoffStatus;
  session_id?: string;
  goal: string;
  url: string;
  observation: { title: string; text: string; elements: Array<Pick<BrowserElement, "ref" | "role" | "name">> };
  recent_actions: HistoryEntry[];
  confidence: number;
  reason: string;
  resumable: boolean;
  next: string;
  field?: { ref: string; role: string; name: string; context: string; value_key?: string };
  pending_action?: { operation: Operation; ref?: string; label: string };
  verification?: { passed: boolean; checks: Array<{ type: string; passed: boolean; detail: string }> };
}

export interface BrowserOpenOptions {
  allowedDomains?: string[];
  ignoreHttpsErrors?: boolean;
  caCert?: string;
  proxy?: string;
  proxyBypass?: string[];
  hostMappings?: Record<string, string>;
}

export interface BrowserAdapter {
  readonly session?: string;
  open(url: string, options?: BrowserOpenOptions, signal?: AbortSignal): Promise<void>;
  observe(signal?: AbortSignal): Promise<Observation>;
  execute(candidate: Candidate, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface JevTransport {
  decide(
    request: { model: string; state: unknown; questions: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<JevResponse>;
}
