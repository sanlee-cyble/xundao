import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeDatabase,
  createDatabase,
  dbAll,
  dbExec,
  dbGet,
  dbRun,
} from "../src/database.mjs";
import { createIdentityRepository } from "../src/identity_repository.mjs";
import { hashPassword } from "../src/auth_service.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-identity-"));
  const database = await createDatabase({ sqlitePath: path.join(directory, "identity.sqlite") });
  await dbExec(database, `
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      must_change_password INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
  const repository = createIdentityRepository({
    all: (...args) => dbAll(database, ...args),
    get: (...args) => dbGet(database, ...args),
    run: (...args) => dbRun(database, ...args),
  });
  t.after(async () => {
    await closeDatabase(database);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return repository;
}

test("账号与会话持久化且停用后会话立即失效", async (t) => {
  const repository = await fixture(t);
  const user = await repository.createUser({
    email: "MEDIA@EXAMPLE.COM",
    displayName: "媒介一",
    passwordHash: await hashPassword("StrongPassword!23"),
    role: "media",
  });
  assert.equal(user.email, "media@example.com");

  await repository.createSession({
    userId: user.id,
    tokenHash: "token-hash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await repository.findSessionUser("token-hash")).user.id, user.id);

  await repository.updateUserStatus(user.id, "disabled");
  assert.equal(await repository.findSessionUser("token-hash"), null);
});

test("修改资料和密码后撤销旧会话", async (t) => {
  const repository = await fixture(t);
  const user = await repository.createUser({
    email: "profile@example.com",
    displayName: "旧名称",
    passwordHash: await hashPassword("StrongPassword!23"),
    role: "media",
  });
  await repository.createSession({
    userId: user.id,
    tokenHash: "old-session",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await repository.updateProfile(user.id, { displayName: "新名称" })).displayName, "新名称");
  const changed = await repository.changePassword(user.id, await hashPassword("NewStrongPassword!45"));
  assert.equal(changed.mustChangePassword, false);
  assert.equal(await repository.findSessionUser("old-session"), null);
});
