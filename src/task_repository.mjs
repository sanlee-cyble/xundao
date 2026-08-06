import {
  dbAll,
  dbGet,
  dbRun,
} from "./database.mjs";

function jsonValue(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTask(task) {
  return {
    ...task,
    ownerUserId: task.ownerUserId || task.owner_user_id || "",
    taskContract: jsonValue(task.taskContract || task.task_contract_json, {}),
    confirmation: jsonValue(task.confirmation || task.confirmation_json, {}),
    expiresAt: task.expiresAt || task.expires_at || "",
    deletedAt: task.deletedAt || task.deleted_at || "",
  };
}

export function memoryTaskRepository(seed = []) {
  const tasks = new Map(seed.map((item) => [item.id, normalizeTask(item)]));
  return {
    async create(task) {
      const normalized = normalizeTask(task);
      tasks.set(normalized.id, normalized);
      return normalized;
    },
    async getById(id, ownerUserId) {
      const task = tasks.get(id);
      if (!task || task.ownerUserId !== ownerUserId) return null;
      return task;
    },
    async listForUser(ownerUserId) {
      return Array.from(tasks.values()).filter((item) => item.ownerUserId === ownerUserId);
    },
    async listAllForAdmin() {
      return Array.from(tasks.values());
    },
    async updateState(id, ownerUserId, state) {
      const task = await this.getById(id, ownerUserId);
      if (!task) return null;
      task.state = state;
      return task;
    },
    async saveContract(id, ownerUserId, taskContract) {
      const task = await this.getById(id, ownerUserId);
      if (!task) return null;
      task.taskContract = taskContract;
      return task;
    },
    async saveConfirmation(id, ownerUserId, confirmation) {
      const task = await this.getById(id, ownerUserId);
      if (!task) return null;
      task.confirmation = confirmation;
      return task;
    },
    async listExpired(now) {
      const timestamp = new Date(now).getTime();
      return Array.from(tasks.values()).filter((item) => (
        !item.deletedAt && item.expiresAt && new Date(item.expiresAt).getTime() <= timestamp
      ));
    },
    async markExpired(id) {
      const task = tasks.get(id);
      if (!task) return null;
      task.state = "EXPIRED";
      return task;
    },
  };
}

export function createTaskRepository(database) {
  return {
    async create(task) {
      const row = normalizeTask(task);
      const params = [
        row.id,
        row.ownerUserId,
        row.workspaceId || "",
        row.state || "DRAFT",
        JSON.stringify(row.taskContract || {}),
        Number(row.taskContract?.version || 1),
        JSON.stringify(row.confirmation || {}),
        row.expiresAt || "",
        row.createdAt || new Date().toISOString(),
        row.updatedAt || new Date().toISOString(),
      ];
      await dbRun(
        database,
        `INSERT INTO jobs (
          id, owner_user_id, workspace_id, state, task_contract_json, task_contract_version,
          confirmation_json, expires_at, created_at, updated_at, status, run_dir, source_type,
          progress_json, logs_json, selected_fields_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', '', 'excel', '{}', '[]', '[]')`,
        params,
        `INSERT INTO jobs (
          id, owner_user_id, workspace_id, state, task_contract_json, task_contract_version,
          confirmation_json, expires_at, created_at, updated_at, status, run_dir, source_type,
          progress_json, logs_json, selected_fields_json
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10,
          'uploaded', '', 'excel', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb
        )`,
        params,
      );
      return row;
    },
    async getById(id, ownerUserId) {
      const row = await dbGet(
        database,
        "SELECT * FROM jobs WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL",
        [id, ownerUserId],
        "SELECT * FROM jobs WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL",
        [id, ownerUserId],
      );
      return row ? normalizeTask(row) : null;
    },
    async listForUser(ownerUserId) {
      return (await dbAll(
        database,
        "SELECT * FROM jobs WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
        [ownerUserId],
        "SELECT * FROM jobs WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
        [ownerUserId],
      )).map(normalizeTask);
    },
    async listAllForAdmin() {
      return (await dbAll(
        database,
        "SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC",
        [],
      )).map(normalizeTask);
    },
    async updateState(id, ownerUserId, state) {
      await dbRun(
        database,
        "UPDATE jobs SET state = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL",
        [state, new Date().toISOString(), id, ownerUserId],
        "UPDATE jobs SET state = $1, updated_at = $2 WHERE id = $3 AND owner_user_id = $4 AND deleted_at IS NULL",
        [state, new Date().toISOString(), id, ownerUserId],
      );
      return await this.getById(id, ownerUserId);
    },
    async saveContract(id, ownerUserId, taskContract) {
      const now = new Date().toISOString();
      await dbRun(
        database,
        "UPDATE jobs SET task_contract_json = ?, task_contract_version = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL",
        [JSON.stringify(taskContract), Number(taskContract?.version || 1), now, id, ownerUserId],
        "UPDATE jobs SET task_contract_json = $1::jsonb, task_contract_version = $2, updated_at = $3 WHERE id = $4 AND owner_user_id = $5 AND deleted_at IS NULL",
        [JSON.stringify(taskContract), Number(taskContract?.version || 1), now, id, ownerUserId],
      );
      return await this.getById(id, ownerUserId);
    },
    async saveConfirmation(id, ownerUserId, confirmation) {
      const now = new Date().toISOString();
      await dbRun(
        database,
        "UPDATE jobs SET confirmation_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL",
        [JSON.stringify(confirmation), now, id, ownerUserId],
        "UPDATE jobs SET confirmation_json = $1::jsonb, updated_at = $2 WHERE id = $3 AND owner_user_id = $4 AND deleted_at IS NULL",
        [JSON.stringify(confirmation), now, id, ownerUserId],
      );
      return await this.getById(id, ownerUserId);
    },
    async listExpired(now = new Date().toISOString()) {
      return (await dbAll(
        database,
        "SELECT * FROM jobs WHERE expires_at != '' AND expires_at <= ? AND deleted_at IS NULL",
        [now],
        "SELECT * FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= $1 AND deleted_at IS NULL",
        [now],
      )).map(normalizeTask);
    },
    async markExpired(id) {
      const now = new Date().toISOString();
      await dbRun(
        database,
        "UPDATE jobs SET state = 'EXPIRED', updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        [now, id],
        "UPDATE jobs SET state = 'EXPIRED', updated_at = $1 WHERE id = $2 AND deleted_at IS NULL",
        [now, id],
      );
    },
  };
}
