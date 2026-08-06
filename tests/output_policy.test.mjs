import assert from "node:assert/strict";
import test from "node:test";
import { outputPolicyForLabel } from "../src/output_policy.mjs";

test("CPC 使用公式", () => {
  assert.equal(outputPolicyForLabel("CPC").mode, "formula");
});

test("推荐理由使用证据模型", () => {
  assert.equal(outputPolicyForLabel("推荐理由").mode, "llm_evidence");
});

test("授权情况只能人工填写", () => {
  assert.equal(outputPolicyForLabel("授权情况").mode, "manual");
});

test("日文多级表头中的计划目标和实际结果保持人工字段", () => {
  assert.equal(outputPolicyForLabel("エンゲージメント / 計画 / 目標").mode, "manual");
  assert.equal(outputPolicyForLabel("エンゲージメント / 実績 / 結果").mode, "manual");
});
