import assert from "node:assert/strict";
import test from "node:test";
import { formatHandoff, handoffToast } from "../src/format.js";
import type { Handoff } from "../src/types.js";

const result: Handoff = {
  status: "done",
  goal: "Preview project",
  url: "https://example.com/result",
  observation: { title: "Result", text: "Preview ready", elements: [] },
  recent_actions: [
    {
      step: 1,
      operation: "CLICK",
      label: "Run preview",
      confidence: 0.87,
      changed: true,
      url: "https://example.com/result",
    },
  ],
  confidence: 0.91,
  reason: "Deterministic completion checks passed.",
  resumable: false,
  next: "No further action required.",
  verification: {
    passed: true,
    checks: [{ type: "text_contains", passed: true, detail: "page contains Preview ready" }],
  },
};

test("formats an OpenCode-friendly handoff summary", () => {
  const text = formatHandoff(result);
  assert.match(text, /^✓ Ajevt Browser · Completed/);
  assert.match(text, /Steps\s+1/);
  assert.match(text, /CLICK\s+Run preview · 87%/);
  assert.match(text, /✓ page contains Preview ready/);
  assert.doesNotMatch(text, /^\s*\{/);
});

test("omits meaningless zero confidence from verifier-only completion", () => {
  assert.doesNotMatch(formatHandoff({ ...result, confidence: 0 }), /Confidence/);
});

test("creates concise completion and handoff toasts", () => {
  assert.deepEqual(handoffToast(result), { message: "Completed · 1 step · verified", variant: "success" });
  assert.equal(
    handoffToast({ ...result, status: "needs_confirmation", reason: "External commitment" }).variant,
    "warning",
  );
});
