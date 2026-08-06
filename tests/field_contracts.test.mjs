import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalFieldKey,
  groupFieldContracts,
  validateFieldContract,
} from "../src/field_contracts.mjs";

const cooperationAll = {
  fieldId: "pgy.note.exposure.median",
  metric: "exposure",
  statistic: "median",
  scene: "cooperation",
  contentType: "all",
  window: "90d",
  traffic: "all",
  view: "scale",
  source: "pgy",
  unit: "count",
};

test("字段唯一键包含所有影响取数的维度", () => {
  assert.equal(
    canonicalFieldKey(cooperationAll),
    "pgy.note.exposure.median|cooperation|all|90d|all|scale",
  );
});

test("缺少流量范围时不得成为可执行合同", () => {
  const result = validateFieldContract({ ...cooperationAll, traffic: "" });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingDimensions, ["traffic"]);
});

test("相同口径字段聚合为一个动态口径组", () => {
  const read = { ...cooperationAll, fieldId: "pgy.note.read.median", metric: "read" };
  assert.equal(groupFieldContracts([cooperationAll, read]).length, 1);
});
