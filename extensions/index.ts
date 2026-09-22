import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatHandoff, HANDOFF_STATUS } from "../src/format.js";
import { executeAjevtBrowser, TOOL_DESCRIPTION, TOOL_NAME, type ToolProgress } from "../src/tool.js";
import type { Handoff, HandoffStatus, Verifier } from "../src/types.js";

const verifier = Type.Union([
  Type.Object({ type: Type.Literal("url_contains"), text: Type.String() }),
  Type.Object({ type: Type.Literal("url_matches"), pattern: Type.String() }),
  Type.Object({ type: Type.Literal("text_contains"), text: Type.String() }),
  Type.Object({ type: Type.Literal("text_absent"), text: Type.String() }),
  Type.Object({
    type: Type.Literal("element_exists"),
    role: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("element_gone"),
    role: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal("value_equals"), ref: Type.String(), value: Type.String() }),
  Type.Object({
    type: Type.Literal("element_value_equals"),
    role: Type.Optional(Type.String()),
    name: Type.String(),
    value: Type.String(),
  }),
  Type.Object({ type: Type.Literal("checked"), ref: Type.String(), state: Type.Optional(Type.Boolean()) }),
]);

const STATUS_COLOR: Record<HandoffStatus, "success" | "warning" | "error"> = {
  done: "success",
  likely_done: "warning",
  input_required: "warning",
  ambiguous: "warning",
  needs_confirmation: "warning",
  blocked: "warning",
  stuck: "warning",
  error: "error",
};

function progressLabel(progress: ToolProgress): string {
  const labels: Record<string, string> = {
    starting: "Starting browser",
    observed: "Page ready",
    deciding: "Choosing next action",
    decided: progress.operation ? `Selected ${progress.operation}` : "Action selected",
    executed: progress.operation ? `Executed ${progress.operation}` : "Action executed",
    "stale-reobserve": "Page changed · observing again",
  };
  return labels[progress.phase] ?? progress.phase;
}

function renderHandoff(
  result: Handoff,
  expanded: boolean,
  theme: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2],
): Text {
  const status = HANDOFF_STATUS[result.status];
  const summary = `${status.icon} ${status.title}`;
  let text = theme.fg(STATUS_COLOR[result.status], theme.bold(summary));
  text += theme.fg("muted", ` · ${result.recent_actions.length} step${result.recent_actions.length === 1 ? "" : "s"}`);
  if (result.verification?.passed) text += theme.fg("success", " · verified");

  if (!expanded) {
    text += theme.fg("dim", " · expand for details");
    return new Text(text, 0, 0);
  }

  text += `\n${theme.fg("dim", result.url)}`;
  if (result.recent_actions.length) {
    text += `\n${theme.fg("muted", "Actions")}`;
    for (const action of result.recent_actions) {
      text += `\n  ${theme.fg(action.changed ? "success" : "dim", action.changed ? "✓" : "·")} ${theme.fg("accent", action.operation)} ${action.label}`;
    }
  }
  if (result.verification?.checks.length) {
    text += `\n${theme.fg("muted", "Evidence")}`;
    for (const check of result.verification.checks) {
      text += `\n  ${theme.fg(check.passed ? "success" : "error", check.passed ? "✓" : "✗")} ${check.detail}`;
    }
  }
  if (result.pending_action)
    text += `\n${theme.fg("warning", `Pending · ${result.pending_action.operation} ${result.pending_action.label}`)}`;
  if (result.field) text += `\n${theme.fg("warning", `Input · ${result.field.name || result.field.ref}`)}`;
  if (result.session_id) text += `\n${theme.fg("dim", `Session · ${result.session_id}`)}`;
  text += `\n${theme.fg("muted", "Reason")} ${result.reason}`;
  text += `\n${theme.fg("muted", "Next")} ${result.next}`;
  return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Ajevt Browser",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Run a bounded browser subtask through the Jev fast path",
    promptGuidelines: [
      "Use ajevt_browser only for a clear bounded browser subtask with an observable stop condition; handle research, exploration, and complex reasoning yourself.",
      "Pass all known field contents through values. If input_required is returned, generate or ask for the value and call again.",
      "Treat likely_done as unverified; prefer deterministic verifiers.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "One bounded goal with an explicit observable completion condition." }),
      url: Type.String({ description: "Starting HTTP(S) URL." }),
      values: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Caller-provided logical values keyed by ref, field name, normalized name, or role:name. Secrets remain local and are never sent to Jev.",
        }),
      ),
      max_steps: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "Bounded action budget (default 12)." }),
      ),
      allow_risky: Type.Optional(
        Type.Boolean({ description: "Allow destructive/commitment actions after policy detection." }),
      ),
      allowed_domains: Type.Optional(
        Type.Array(Type.String(), { description: "Optional domain allowlist enforced by agent-browser and the loop." }),
      ),
      ignore_https_errors: Type.Optional(
        Type.Boolean({ description: "Ignore HTTPS certificate errors for development environments." }),
      ),
      ca_cert: Type.Optional(Type.String({ description: "Path to a CA certificate trusted by agent-browser." })),
      proxy: Type.Optional(Type.String({ description: "Explicit browser proxy URL." })),
      proxy_bypass: Type.Optional(
        Type.Array(Type.String(), { description: "Hosts that bypass the configured or inherited browser proxy." }),
      ),
      host_mappings: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Hostname-to-address mappings applied through Chromium host resolver rules.",
        }),
      ),
      session_id: Type.Optional(
        Type.String({ description: "Reuse a session_id returned by an earlier keep_session call." }),
      ),
      keep_session: Type.Optional(
        Type.Boolean({ description: "Keep browser state alive and return session_id for a follow-up call." }),
      ),
      require_action: Type.Optional(
        Type.Boolean({ description: "Require at least one browser action before completion checks may pass." }),
      ),
      verifiers: Type.Optional(
        Type.Array(verifier, { description: "Deterministic completion checks. All must pass for status=done." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await executeAjevtBrowser(
        { ...params, verifiers: params.verifiers as Verifier[] | undefined },
        {
          signal,
          onProgress: (event) =>
            onUpdate?.({ content: [{ type: "text", text: progressLabel(event) }], details: event }),
        },
      );
      return { content: [{ type: "text", text: formatHandoff(result) }], details: result };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const session = args.session_id ? theme.fg("dim", ` · session ${args.session_id}`) : "";
      text.setText(
        `${theme.fg("toolTitle", theme.bold("Ajevt Browser"))} ${theme.fg("accent", args.goal)}${session}\n${theme.fg("dim", args.url)}`,
      );
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const progress = result.details as ToolProgress | undefined;
        const message = progress ? progressLabel(progress) : "Working";
        const suffix = progress?.step ? ` · step ${progress.step}` : "";
        return new Text(theme.fg("warning", `◐ ${message}${suffix}`), 0, 0);
      }
      const handoff = result.details as Handoff | undefined;
      if (!handoff) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      return renderHandoff(handoff, expanded, theme);
    },
  });
}
