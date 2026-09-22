import type { Handoff, HandoffStatus, HistoryEntry } from "./types.js";

export const HANDOFF_STATUS: Record<HandoffStatus, { icon: string; title: string }> = {
  done: { icon: "✓", title: "Completed" },
  likely_done: { icon: "◐", title: "Likely complete" },
  input_required: { icon: "⌨", title: "Input required" },
  ambiguous: { icon: "?", title: "Ambiguous" },
  needs_confirmation: { icon: "⚠", title: "Confirmation required" },
  blocked: { icon: "⊘", title: "Blocked" },
  stuck: { icon: "↻", title: "Stuck" },
  error: { icon: "✗", title: "Error" },
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function actionLine(action: HistoryEntry, index: number): string {
  const target = action.label || action.target || "page";
  return `  ${index + 1}. ${action.operation.padEnd(6)} ${target} · ${percent(action.confidence)}`;
}

export function formatHandoff(result: Handoff): string {
  const status = HANDOFF_STATUS[result.status];
  const lines = [
    `${status.icon} Ajevt Browser · ${status.title}`,
    "",
    `URL           ${result.url}`,
    `Steps         ${result.recent_actions.length}`,
  ];
  if (result.confidence > 0) lines.push(`Confidence    ${percent(result.confidence)}`);
  if (result.session_id) lines.push(`Session       ${result.session_id}`);
  if (result.verification) lines.push(`Verification  ${result.verification.passed ? "Passed" : "Failed"}`);
  if (result.recent_actions.length) lines.push("", "Actions", ...result.recent_actions.map(actionLine));
  if (result.verification?.checks.length) {
    lines.push(
      "",
      "Evidence",
      ...result.verification.checks.map((check) => `  ${check.passed ? "✓" : "✗"} ${check.detail}`),
    );
  }
  if (result.field) lines.push("", `Field         ${result.field.name || result.field.ref}`);
  if (result.pending_action)
    lines.push("", `Pending       ${result.pending_action.operation} ${result.pending_action.label}`);
  lines.push("", `Reason        ${result.reason}`, `Next          ${result.next}`);
  return lines.join("\n");
}

export function handoffToast(result: Handoff): { message: string; variant: "success" | "warning" | "error" | "info" } {
  const status = HANDOFF_STATUS[result.status];
  const suffix =
    result.status === "done"
      ? `${result.recent_actions.length} step${result.recent_actions.length === 1 ? "" : "s"}${result.verification?.passed ? " · verified" : ""}`
      : result.reason;
  const variant =
    result.status === "done"
      ? "success"
      : result.status === "error"
        ? "error"
        : ["likely_done", "input_required", "ambiguous", "needs_confirmation", "blocked", "stuck"].includes(
              result.status,
            )
          ? "warning"
          : "info";
  return { message: `${status.title} · ${suffix}`, variant };
}
