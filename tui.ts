import type { Definition as OpenCodeTuiPlugin } from "@opencode/plugin/tui/plugin";
import { handoffToast } from "./src/format.js";
import type { Handoff, HandoffStatus } from "./src/types.js";

const TOOL_NAME = "ajevt_browser";
const STATUSES = new Set<HandoffStatus>([
  "done",
  "likely_done",
  "input_required",
  "ambiguous",
  "needs_confirmation",
  "blocked",
  "stuck",
  "error",
]);

function handoff(value: unknown): Handoff | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Handoff>;
  return typeof candidate.status === "string" &&
    STATUSES.has(candidate.status as HandoffStatus) &&
    typeof candidate.reason === "string"
    ? (candidate as Handoff)
    : undefined;
}

const plugin = {
  id: "ajevt-browser.tui",
  setup(ctx) {
    const calls = new Set<string>();

    const stopProgress = ctx.data.on("session.tool.progress", (event) => {
      if (event.data.metadata.tool !== TOOL_NAME && !calls.has(event.data.id)) return;
      const first = !calls.has(event.data.id);
      calls.add(event.data.id);
      if (first)
        ctx.ui.toast.show({
          title: "Ajevt Browser",
          message: "Started · observing page",
          variant: "info",
          duration: 1800,
          sessionID: event.data.sessionID,
        });
    });

    const stopSuccess = ctx.data.on("session.tool.success", (event) => {
      if (!calls.delete(event.data.id)) return;
      const result = handoff(event.data.metadata);
      if (!result) return;
      const toast = handoffToast(result);
      ctx.ui.toast.show({ title: "Ajevt Browser", ...toast, duration: 3500, sessionID: event.data.sessionID });
    });

    const stopFailed = ctx.data.on("session.tool.failed", (event) => {
      if (!calls.delete(event.data.id)) return;
      ctx.ui.toast.show({
        title: "Ajevt Browser",
        message: event.data.error.message,
        variant: "error",
        duration: 4500,
        sessionID: event.data.sessionID,
      });
    });

    return () => {
      stopProgress();
      stopSuccess();
      stopFailed();
    };
  },
} satisfies OpenCodeTuiPlugin;

export default plugin;
