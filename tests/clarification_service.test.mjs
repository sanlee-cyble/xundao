import assert from "node:assert/strict";
import test from "node:test";
import { buildClarification } from "../src/clarification_service.mjs";

test("同类歧义合并为单轮问题并保留受影响列明细", () => {
  const unresolved = Array.from({ length: 8 }, (_, index) => ({
    letter: String.fromCharCode(65 + index),
    pathLabel: `字段${index + 1}`,
    missingDimensions: ["contentType"],
  }));
  const result = buildClarification({
    columns: unresolved,
    unresolved,
    unresolvedCount: unresolved.length,
  });
  assert.equal(result.questions.length, 1);
  assert.match(result.questions[0].prompt, /等 8 个字段/);
  assert.doesNotMatch(result.questions[0].prompt, /字段3、字段4/);
  assert.deepEqual(result.questions[0].affectedColumns, ["A", "B", "C", "D", "E", "F", "G", "H"]);
  assert.equal(result.questions[0].affectedLabels.length, 8);
});

test("一次澄清最多覆盖五个取数维度", () => {
  const unresolved = [{
    letter: "M",
    pathLabel: "曝光中位数",
    missingDimensions: ["scene", "contentType", "window", "traffic", "view"],
  }];
  const result = buildClarification({ columns: unresolved, unresolved, unresolvedCount: 1 });
  assert.equal(result.questions.length, 5);
  assert.match(result.recommendation, /合作笔记/);
  assert.match(result.recommendation, /全流量/);
});
