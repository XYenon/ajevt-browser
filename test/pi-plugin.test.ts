import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.js";
import type { Handoff } from "../src/types.js";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function registeredTool(): any {
  let tool: unknown;
  extension({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  return tool;
}

function text(component: { render(width: number): string[] }): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

const handoff: Handoff = {
  status: "done",
  goal: "Open settings",
  url: "https://example.test/settings",
  observation: { title: "Settings", text: "Ready", elements: [] },
  recent_actions: [
    {
      step: 1,
      operation: "CLICK",
      label: "Click Settings",
      confidence: 0.94,
      changed: true,
      url: "https://example.test/settings",
    },
  ],
  confidence: 0.94,
  reason: "Deterministic completion checks passed.",
  resumable: true,
  session_id: "browser-session",
  next: "No further action required.",
  verification: {
    passed: true,
    checks: [{ type: "text_contains", passed: true, detail: "page text contains Settings" }],
  },
};

test("Pi tool renders a concise call and progress state", () => {
  const tool = registeredTool();
  const call = text(
    tool.renderCall({ goal: handoff.goal, url: handoff.url, session_id: handoff.session_id }, theme, {}),
  );
  assert.match(call, /Ajevt Browser Open settings · session browser-session/);
  assert.match(call, /https:\/\/example\.test\/settings/);

  const progress = text(
    tool.renderResult(
      { content: [], details: { step: 2, phase: "deciding" } },
      { expanded: false, isPartial: true },
      theme,
    ),
  );
  assert.equal(progress, "◐ Choosing next action · step 2");
});

test("Pi tool renders compact and expanded handoff states", () => {
  const tool = registeredTool();
  const result = { content: [{ type: "text", text: "fallback" }], details: handoff };
  const compact = text(tool.renderResult(result, { expanded: false, isPartial: false }, theme));
  assert.match(compact, /^✓ Completed · 1 step · verified/);
  assert.doesNotMatch(compact, /Actions/);

  const expanded = text(tool.renderResult(result, { expanded: true, isPartial: false }, theme));
  assert.match(expanded, /Actions\n {2}✓ CLICK Click Settings/);
  assert.match(expanded, /Evidence\n {2}✓ page text contains Settings/);
  assert.match(expanded, /Session · browser-session/);
});
