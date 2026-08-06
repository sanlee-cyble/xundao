import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteLegacyPlaintextStorageStates,
  decryptStorageState,
  encryptStorageState,
  loadEncryptedStorageState,
  memoryConnectionService,
  pgyProfileDirectory,
} from "../src/pgy_connection_service.mjs";

test("用户只能取得自己的蒲公英连接", async () => {
  const service = memoryConnectionService([
    { id: "c1", ownerType: "user", ownerId: "u1" },
    { id: "c2", ownerType: "user", ownerId: "u2" },
  ]);
  assert.equal((await service.getForUser("u1")).id, "c1");
});

test("storageState 使用 AES-GCM 加密并可解密", () => {
  const state = { cookies: [{ name: "session", value: "secret" }], origins: [] };
  const encrypted = encryptStorageState(state, "0123456789abcdef0123456789abcdef");
  assert.doesNotMatch(encrypted, /secret/);
  assert.deepEqual(
    JSON.parse(decryptStorageState(encrypted, "0123456789abcdef0123456789abcdef")),
    state,
  );
});

test("每个用户使用独立资料目录", () => {
  assert.equal(
    pgyProfileDirectory("/srv/xunda/pgy", "user", "u-1"),
    "/srv/xunda/pgy/user-u-1",
  );
});

test("加密连接可在服务重启后恢复为内存 storageState", async () => {
  const state = { cookies: [{ name: "session", value: "secret" }], origins: [] };
  const encrypted = encryptStorageState(state, "0123456789abcdef0123456789abcdef");
  const restored = await loadEncryptedStorageState(
    "/not-read-from-disk",
    "0123456789abcdef0123456789abcdef",
    { readImpl: async () => encrypted },
  );
  assert.deepEqual(restored, state);
});

test("启动迁移只清除旧明文 storageState，不删除任务文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-pgy-migration-"));
  const run = path.join(root, "job-1");
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, "storage-state.json"), "{\"cookies\":[]}");
  await fs.writeFile(path.join(run, "output.xlsx"), "keep");
  try {
    const deleted = await deleteLegacyPlaintextStorageStates(root);
    assert.equal(deleted.length, 1);
    await assert.rejects(fs.access(path.join(run, "storage-state.json")));
    await fs.access(path.join(run, "output.xlsx"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
