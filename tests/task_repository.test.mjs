import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeDatabase,
  createDatabase,
  dbExec,
} from "../src/database.mjs";
import {
  createTaskRepository,
  memoryTaskRepository,
} from "../src/task_repository.mjs";

test("普通用户只能读取自己的任务", async () => {
  const repository = memoryTaskRepository([
    { id: "a", ownerUserId: "user-1" },
    { id: "b", ownerUserId: "user-2" },
  ]);
  const rows = await repository.listForUser("user-1");
  assert.deepEqual(rows.map((item) => item.id), ["a"]);
  assert.equal(await repository.getById("b", "user-1"), null);
});

test("管理员列表使用显式入口", async () => {
  const repository = memoryTaskRepository([
    { id: "a", ownerUserId: "user-1" },
    { id: "b", ownerUserId: "user-2" },
  ]);
  assert.deepEqual((await repository.listAllForAdmin()).map((item) => item.id), ["a", "b"]);
});

test("SQLite 任务仓库保存字段合同并按用户隔离", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-tasks-"));
  const database = await createDatabase({ sqlitePath: path.join(directory, "tasks.sqlite") });
  t.after(async () => {
    await closeDatabase(database);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await dbExec(database, `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      run_dir TEXT NOT NULL,
      source_type TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL,
      task_contract_json TEXT NOT NULL,
      task_contract_version INTEGER NOT NULL,
      confirmation_json TEXT NOT NULL,
      expires_at TEXT,
      deleted_at TEXT,
      progress_json TEXT NOT NULL,
      logs_json TEXT NOT NULL,
      selected_fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const repository = createTaskRepository(database);
  await repository.create({
    id: "task-1",
    ownerUserId: "u1",
    taskContract: { version: 2, scopeGroups: [{ id: "g1" }] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await repository.getById("task-1", "u1")).ownerUserId, "u1");
  assert.equal(await repository.getById("task-1", "u2"), null);
  await repository.saveConfirmation("task-1", "u1", { confirmedVersion: 2 });
  assert.deepEqual((await repository.getById("task-1", "u1")).confirmation, { confirmedVersion: 2 });
});
