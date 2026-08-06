import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkpointsForCreator,
  nextPendingScopes,
  readCheckpoints,
  writeCheckpoint,
} from "../src/collection_checkpoint.mjs";

test("恢复任务时跳过已成功口径组", () => {
  const pending = nextPendingScopes(
    [{ id: "a" }, { id: "b" }],
    { a: { status: "COMPLETED" }, b: { status: "FAILED" } },
  );
  assert.deepEqual(pending.map((item) => item.id), ["b"]);
});

test("口径请求签名变化时重新采集", () => {
  const pending = nextPendingScopes(
    [{ id: "a" }],
    { a: { status: "COMPLETED", requestSignature: "old" } },
    { a: "new" },
  );
  assert.deepEqual(pending.map((item) => item.id), ["a"]);
});

test("检查点按任务、达人和口径组隔离并可恢复", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xunda-checkpoint-"));
  const filePath = path.join(directory, "checkpoints.json");
  await writeCheckpoint(filePath, {
    jobId: "job-1",
    creatorId: "creator-1",
    groupId: "coop-full",
    status: "COMPLETED",
  });
  const all = await readCheckpoints(filePath);
  assert.equal(checkpointsForCreator(all, "job-1", "creator-1")["coop-full"].status, "COMPLETED");
});
