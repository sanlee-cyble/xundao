import assert from "node:assert/strict";
import test from "node:test";
import { profilePerformance } from "../src/profile_service.mjs";

test("个人数据表现只聚合当前用户最近 7 天任务", () => {
  const result = profilePerformance([
    { ownerUserId: "u1", status: "done", createdAt: "2026-07-29T00:00:00.000Z", progress: { total: 3 } },
    { ownerUserId: "u2", status: "done", createdAt: "2026-07-29T00:00:00.000Z", progress: { total: 9 } },
    { ownerUserId: "u1", status: "failed", createdAt: "2026-07-01T00:00:00.000Z", progress: { total: 2 } },
  ], { ownerUserId: "u1", now: "2026-07-30T00:00:00.000Z" });
  assert.equal(result.taskCount, 1);
  assert.equal(result.creatorCount, 3);
});
