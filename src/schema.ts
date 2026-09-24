export const verifierJsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "url_contains" }, text: { type: "string" } },
      required: ["type", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "url_matches" }, pattern: { type: "string" } },
      required: ["type", "pattern"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "text_contains" }, text: { type: "string" } },
      required: ["type", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "text_absent" }, text: { type: "string" } },
      required: ["type", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "element_exists" }, role: { type: "string" }, name: { type: "string" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "element_gone" }, role: { type: "string" }, name: { type: "string" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "value_equals" }, ref: { type: "string" }, value: { type: "string" } },
      required: ["type", "ref", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "element_value_equals" },
        role: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
      },
      required: ["type", "name", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "checked" }, ref: { type: "string" }, state: { type: "boolean" } },
      required: ["type", "ref"],
      additionalProperties: false,
    },
  ],
} as const;

export const ajevtBrowserJsonSchema = {
  type: "object",
  properties: {
    goal: { type: "string", description: "One bounded goal with an explicit observable completion condition." },
    url: { type: "string", description: "Starting HTTP(S) URL." },
    values: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Caller-provided logical values keyed by ref, field name, normalized name, or role:name. A key that only partly matches a field name also binds when exactly one typable field matches. Secrets remain local and are never sent to Jev.",
    },
    max_steps: { type: "integer", minimum: 1, maximum: 50, description: "Bounded action budget (default 12)." },
    allow_risky: { type: "boolean", description: "Allow destructive/commitment actions after policy detection." },
    allowed_domains: {
      type: "array",
      items: { type: "string" },
      description: "Optional domain allowlist enforced by agent-browser and the loop.",
    },
    ignore_https_errors: {
      type: "boolean",
      description: "Ignore HTTPS certificate errors for development environments.",
    },
    ca_cert: { type: "string", description: "Path to a CA certificate trusted by agent-browser." },
    proxy: { type: "string", description: "Explicit browser proxy URL." },
    proxy_bypass: {
      type: "array",
      items: { type: "string" },
      description: "Hosts that bypass the configured or inherited browser proxy.",
    },
    host_mappings: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Hostname-to-address mappings applied through Chromium host resolver rules.",
    },
    session_id: { type: "string", description: "Reuse a session_id returned by an earlier keep_session call." },
    keep_session: {
      type: "boolean",
      description: "Keep browser state alive and return session_id for a follow-up call.",
    },
    require_action: {
      type: "boolean",
      description: "Require at least one browser action before completion checks may pass.",
    },
    verifiers: {
      type: "array",
      items: verifierJsonSchema,
      description: "Deterministic completion checks. All must pass for status=done.",
    },
  },
  required: ["goal", "url"],
  additionalProperties: false,
} as const;
