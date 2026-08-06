import { randomUUID } from "node:crypto";

function publicUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.displayName || "",
    passwordHash: row.password_hash || row.passwordHash || "",
    role: row.role || "media",
    status: row.status || "active",
    mustChangePassword: Boolean(row.must_change_password ?? row.mustChangePassword),
    createdAt: row.created_at || row.createdAt || "",
    updatedAt: row.updated_at || row.updatedAt || "",
    lastLoginAt: row.last_login_at || row.lastLoginAt || "",
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function createIdentityRepository({ all, get, run }) {
  return {
    async createUser({
      id = randomUUID(),
      email,
      displayName,
      passwordHash,
      role = "media",
      status = "active",
      mustChangePassword = true,
    }) {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) throw new Error("邮箱不能为空");
      if (!passwordHash) throw new Error("密码哈希不能为空");
      if (!["admin", "media"].includes(role)) throw new Error("账号角色无效");
      if (!["active", "disabled"].includes(status)) throw new Error("账号状态无效");
      const now = new Date().toISOString();
      const params = [
        id,
        normalizedEmail,
        String(displayName || normalizedEmail.split("@")[0]),
        passwordHash,
        role,
        status,
        mustChangePassword ? 1 : 0,
        now,
        now,
      ];
      await run(
        `INSERT INTO users (
          id, email, display_name, password_hash, role, status,
          must_change_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
        `INSERT INTO users (
          id, email, display_name, password_hash, role, status,
          must_change_password, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::boolean, $8, $9)`,
        [...params.slice(0, 6), Boolean(mustChangePassword), ...params.slice(7)],
      );
      return await this.getUserById(id);
    },

    async getUserById(id) {
      return publicUserRow(await get(
        "SELECT * FROM users WHERE id = ?",
        [id],
        "SELECT * FROM users WHERE id = $1",
        [id],
      ));
    },

    async findUserByEmail(email) {
      const normalizedEmail = normalizeEmail(email);
      return publicUserRow(await get(
        "SELECT * FROM users WHERE email = ?",
        [normalizedEmail],
        "SELECT * FROM users WHERE email = $1",
        [normalizedEmail],
      ));
    },

    async listUsers() {
      return (await all(
        "SELECT * FROM users ORDER BY created_at ASC",
        [],
      )).map(publicUserRow);
    },

    async updateUserStatus(id, status) {
      if (!["active", "disabled"].includes(status)) throw new Error("账号状态无效");
      const now = new Date().toISOString();
      await run(
        "UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
        [status, now, id],
        "UPDATE users SET status = $1, updated_at = $2 WHERE id = $3",
        [status, now, id],
      );
      if (status === "disabled") {
        await run(
          "UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          [now, id],
          "UPDATE user_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL",
          [now, id],
        );
      }
      return await this.getUserById(id);
    },

    async updateProfile(id, { displayName }) {
      const cleanName = String(displayName || "").trim();
      if (!cleanName) throw new Error("显示名称不能为空");
      const now = new Date().toISOString();
      await run(
        "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?",
        [cleanName, now, id],
        "UPDATE users SET display_name = $1, updated_at = $2 WHERE id = $3",
        [cleanName, now, id],
      );
      return await this.getUserById(id);
    },

    async changePassword(id, passwordHash) {
      const now = new Date().toISOString();
      await run(
        `UPDATE users
         SET password_hash = ?, must_change_password = 0, updated_at = ?
         WHERE id = ?`,
        [passwordHash, now, id],
        `UPDATE users
         SET password_hash = $1, must_change_password = FALSE, updated_at = $2
         WHERE id = $3`,
        [passwordHash, now, id],
      );
      await run(
        "UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        [now, id],
        "UPDATE user_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL",
        [now, id],
      );
      return await this.getUserById(id);
    },

    async createSession({ userId, tokenHash, expiresAt }) {
      const id = randomUUID();
      const now = new Date().toISOString();
      await run(
        `INSERT INTO user_sessions (
          id, user_id, token_hash, expires_at, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId, tokenHash, expiresAt, now, now],
        `INSERT INTO user_sessions (
          id, user_id, token_hash, expires_at, created_at, last_seen_at
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, tokenHash, expiresAt, now, now],
      );
      await run(
        "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
        [now, now, userId],
        "UPDATE users SET last_login_at = $1, updated_at = $2 WHERE id = $3",
        [now, now, userId],
      );
      return { id, userId, expiresAt, createdAt: now };
    },

    async findSessionUser(tokenHash, now = new Date().toISOString()) {
      const row = await get(
        `SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL
           AND s.expires_at > ? AND u.status = 'active'`,
        [tokenHash, now],
        `SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL
           AND s.expires_at > $2 AND u.status = 'active'`,
        [tokenHash, now],
      );
      if (!row) return null;
      return {
        user: publicUserRow(row),
        sessionId: row.session_id,
        expiresAt: row.session_expires_at,
      };
    },

    async touchSession(sessionId) {
      const now = new Date().toISOString();
      await run(
        "UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
        [now, sessionId],
        "UPDATE user_sessions SET last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL",
        [now, sessionId],
      );
    },

    async revokeSessionByToken(tokenHash) {
      const now = new Date().toISOString();
      await run(
        "UPDATE user_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        [now, tokenHash],
        "UPDATE user_sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL",
        [now, tokenHash],
      );
    },
  };
}
