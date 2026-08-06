import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("黄金任务同时包含合作90天全流量、合作90天自然流和日常30天", async () => {
  const task = JSON.parse(await fs.readFile(
    new URL("./fixtures/medela-mixed-scope-task.json", import.meta.url),
    "utf8",
  ));
  assert.equal(task.scopeGroups.length, 4);
  assert.ok(task.scopeGroups.some((item) => item.scene === "cooperation" && item.window === "90d" && item.traffic === "all"));
  assert.ok(task.scopeGroups.some((item) => item.scene === "cooperation" && item.window === "90d" && item.traffic === "natural"));
  assert.ok(task.scopeGroups.some((item) => item.scene === "daily" && item.window === "30d" && item.traffic === "all"));
});

test("模糊字段保留缺失维度", async () => {
  const task = JSON.parse(await fs.readFile(
    new URL("./fixtures/ambiguous-header-task.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(task.columns[0].missingDimensions, ["scene", "contentType", "traffic"]);
});
