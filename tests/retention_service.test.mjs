import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRetainedPath,
  expiresAtForJob,
  isExpired,
  sweepExpiredTasks,
} from "../src/retention_service.mjs";

test("任务创建后七天过期", () => {
  assert.equal(
    expiresAtForJob("2026-07-29T00:00:00.000Z"),
    "2026-08-05T00:00:00.000Z",
  );
});

test("到期时间之前不删除", () => {
  assert.equal(
    isExpired("2026-08-05T00:00:00.000Z", "2026-08-04T23:59:59.000Z"),
    false,
  );
});

test("拒绝清理任务目录之外的路径", () => {
  assert.throws(
    () => assertRetainedPath("/Users/example/other/file.xlsx", ["/srv/xunda/runs"]),
    /拒绝清理/,
  );
  assert.equal(
    assertRetainedPath("/srv/xunda/runs/job-1/output.xlsx", ["/srv/xunda/runs"]),
    "/srv/xunda/runs/job-1/output.xlsx",
  );
});

test("七天清理只删除过期任务并完成状态标记", async () => {
  const deleted = [];
  const marked = [];
  const result = await sweepExpiredTasks(
    [
      { id: "expired", expiresAt: "2026-08-01T00:00:00.000Z" },
      { id: "retained", expiresAt: "2026-08-10T00:00:00.000Z" },
    ],
    {
      isExpiredFn: (task) => isExpired(task.expiresAt, "2026-08-05T00:00:00.000Z"),
      deleteTask: async (task) => deleted.push(task.id),
      markExpired: async (task) => marked.push(task.id),
    },
  );
  assert.deepEqual(result, { expired: 1, deleted: 1, failed: 0 });
  assert.deepEqual(deleted, ["expired"]);
  assert.deepEqual(marked, ["expired"]);
});
