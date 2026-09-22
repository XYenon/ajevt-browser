import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../tui.js";

interface EventLike {
  type: string;
  data: Record<string, any>;
}

test("OpenCode TUI plugin emits lifecycle toasts without adding UI slots", () => {
  const handlers = new Map<string, (event: EventLike) => void>();
  const toasts: Array<Record<string, unknown>> = [];
  let slotCalls = 0;
  const context = {
    data: {
      on(type: string, handler: (event: EventLike) => void) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
    ui: {
      toast: {
        show(value: Record<string, unknown>) {
          toasts.push(value);
        },
      },
      slot() {
        slotCalls += 1;
        return () => {};
      },
    },
  };

  const cleanup = plugin.setup(context as never) as () => void;
  handlers.get("session.tool.progress")!({
    type: "session.tool.progress",
    data: { id: "call-1", sessionID: "session-1", metadata: { tool: "ajevt_browser", phase: "deciding" } },
  });
  assert.equal(toasts[0]?.message, "Started · observing page");
  assert.equal(slotCalls, 0);

  handlers.get("session.tool.success")!({
    type: "session.tool.success",
    data: {
      id: "call-1",
      sessionID: "session-1",
      metadata: { status: "done", reason: "verified", recent_actions: [], verification: { passed: true } },
    },
  });
  assert.equal(toasts[1]?.variant, "success");
  cleanup();
  assert.equal(handlers.size, 0);
});
