import assert from "node:assert/strict";
import test from "node:test";
import { classifyActionRisk } from "../src/policy.js";
import { observation } from "./helpers.js";

test("contextual risk distinguishes harmless controls from commitments", () => {
  for (const [label, goal, expected] of [
    ["Submit search", "search for a book", "safe"],
    ["Save filter", "save the filter", "safe"],
    ["Confirm selection", "confirm selection", "safe"],
    ["Remove filter", "remove filter", "safe"],
    ["提交搜索", "搜索图书", "safe"],
    ["Submit application", "submit application", "risky"],
    ["Confirm order", "confirm order", "risky"],
    ["Remove account", "remove account", "risky"],
    ["删除", "删除记录", "risky"],
    ["Confirm", "confirm purchase", "risky"],
    ["Save", "save", "uncertain"],
    ["确定", "点击确定按钮", "uncertain"],
  ] as const) {
    const page = observation({ elements: [{ ref: "@e1", role: "button", name: label }] });
    assert.equal(
      classifyActionRisk({ id: "c1", operation: "CLICK", ref: "@e1", label: `Click button “${label}”` }, goal, page),
      expected,
      label,
    );
  }
});

test("generic confirmation on a checkout page remains risky", () => {
  const page = observation({ title: "Checkout", elements: [{ ref: "@e1", role: "button", name: "Confirm" }] });
  assert.equal(
    classifyActionRisk({ id: "c1", operation: "CLICK", ref: "@e1", label: "Confirm" }, "continue", page),
    "risky",
  );
});
