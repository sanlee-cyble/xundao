import assert from "node:assert/strict";
import test from "node:test";
import { transitionTask } from "../src/task_state_machine.mjs";

test("未解决歧义的任务不能进入待确认", () => {
  assert.throws(
    () => transitionTask(
      { state: "PARSING", unresolvedCount: 1, version: 1 },
      "READY_TO_CONFIRM",
    ),
    /仍有 1 个未解决问题/,
  );
});

test("未确认任务不能开始采集", () => {
  assert.throws(
    () => transitionTask(
      { state: "READY_TO_CONFIRM", confirmedVersion: 0, version: 2 },
      "COLLECTING",
    ),
    /任务合同尚未确认/,
  );
});

test("已确认任务可以进入采集", () => {
  const next = transitionTask(
    { state: "CONFIRMED", confirmedVersion: 2, version: 2 },
    "COLLECTING",
  );
  assert.equal(next.state, "COLLECTING");
});

test("采集已完成后可从失败状态只恢复校验与导出", () => {
  const next = transitionTask(
    { state: "FAILED", confirmedVersion: 2, version: 2 },
    "VALIDATING",
  );
  assert.equal(next.state, "VALIDATING");
});
