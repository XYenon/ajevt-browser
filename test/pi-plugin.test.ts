import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.js";
import { selectedPiModel } from "../extensions/jev.js";
import type { Handoff } from "../src/types.js";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function registeredTool(): any {
  let tool: unknown;
  extension({
    registerCommand() {},
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as never);
  return tool;
}

test("Pi model command selects authenticated classifiers and persists selection on the session branch", async () => {
  let command: any;
  const entries: any[] = [];
  extension({
    registerTool() {},
    registerCommand(name: string, definition: unknown) {
      assert.equal(name, "ajevt-model");
      command = definition;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as never);
  const models = [
    { provider: "typesafe", id: "jev-latest" },
    { provider: "cloudflare-workers-ai", id: "typesafe/jev" },
  ];
  let selection: string | undefined = "cloudflare-workers-ai/typesafe/jev";
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      async getAvailableOfType(type: string) {
        assert.equal(type, "classifier");
        return models;
      },
    },
    ui: {
      async select(title: string, options: string[]) {
        const current = selectedPiModel(ctx as never);
        assert.equal(title, `Browser classifier · ${current ? `${current.provider}/${current.id}` : "Default"}`);
        assert.deepEqual(options, [
          "Default (HTTP config or TypeSafe Jev)",
          ...models.map((model) => `${model.provider}/${model.id}`),
        ]);
        return selection;
      },
      notify() {},
    },
  };
  await command.handler("", ctx);
  assert.deepEqual(selectedPiModel(ctx as never), models[1]);
  const saved = [...entries];
  entries.length = 0;
  assert.equal(selectedPiModel(ctx as never), undefined);
  entries.push(...saved);
  assert.deepEqual(selectedPiModel(ctx as never), models[1]);

  selection = undefined;
  await command.handler("", ctx);
  assert.equal(entries.length, 1);
  assert.deepEqual(selectedPiModel(ctx as never), models[1]);

  selection = "Default (HTTP config or TypeSafe Jev)";
  await command.handler("", ctx);
  assert.equal(entries.length, 2);
  assert.equal(selectedPiModel(ctx as never), undefined);
  assert.deepEqual(entries[1].data, { model: null });
});

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

test("Pi guidance explains how to retain and close a resumable handoff", () => {
  const tool = registeredTool();
  assert.match(tool.description, /keep_session=true.*session_id.*handoff URL/);
  const guidance = tool.promptGuidelines.join(" ");
  for (const status of ["input_required", "ambiguous", "needs_confirmation", "likely_done"])
    assert.match(guidance, new RegExp(status));
  assert.match(guidance, /keep_session=true.*session_id.*handoff URL.*final call.*close/);
  assert.match(guidance, /no follow-up.*agent-browser --session <session_id> close/);
  assert.match(guidance, /Without keep_session.*starts over/);
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
