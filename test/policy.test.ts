import assert from "node:assert/strict";
import test from "node:test";
import { isRiskyActionLabel, requestsActionOnLabel } from "../src/policy.js";

test("policy centralizes multilingual risky action terms", () => {
  for (const label of ["确定", "保存", "删除", "Submit", "Confirm order"])
    assert.equal(isRiskyActionLabel(label), true);
  for (const label of ["取消", "返回", "查看", "Search"]) assert.equal(isRiskyActionLabel(label), false);
});

test("action-to-label matching stays within one clause", () => {
  assert.equal(requestsActionOnLabel("点击确定按钮", "确定"), true);
  assert.equal(requestsActionOnLabel("点击取消，成功条件：确定按钮消失", "确定"), false);
  assert.equal(requestsActionOnLabel("点击取消，成功条件：确定按钮消失", "取消"), true);
});
