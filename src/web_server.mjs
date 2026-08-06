#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPgyContext,
  createBackgroundCollectContext,
  collectCreators,
  openLoginPage,
  verifyPgyLoginState,
  ROOT,
} from "./pgy_collect_core.mjs";
import { PGY_CATEGORIES, creatorFromCandidate, enrichLikeCollectCount, searchCreators } from "./pgy_search_core.mjs";
import { nowStamp, readJson, writeJson } from "./common.mjs";
import { generateRecommendationReasons } from "./recommendation_service.mjs";
import {
  buildDeterministicRecommendation,
  enrichUnmatchedExcelFields,
} from "./evidence_enrichment_service.mjs";
import {
  compileCollectionPlan,
  fieldById,
  matchFieldLabel,
  publicFieldRegistry,
} from "./field_registry.mjs";
import { normalizeTemplateId, publicTemplateProfiles, templateProfile } from "./template_profiles.mjs";
import { buildClarification } from "./clarification_service.mjs";
import { resolveWorkbookColumns } from "./semantic_resolver.mjs";
import { createTaskContract } from "./task_contract.mjs";
import { assertTaskContractExecutable } from "./field_execution_gate.mjs";
import { resolveColumnsWithFieldLibrary } from "./field_resolution_service.mjs";
import {
  deleteExpiredArtifacts,
  expiresAtForJob,
  isExpired,
  sweepExpiredTasks,
} from "./retention_service.mjs";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  requireRole,
  verifyPassword,
} from "./auth_service.mjs";
import {
  clearSessionCookie,
  sessionCookie,
  sessionTokenFromRequest,
} from "./auth_http.mjs";
import { createIdentityRepository } from "./identity_repository.mjs";
import {
  deleteLegacyPlaintextStorageStates,
  encryptStorageState,
  loadEncryptedStorageState,
  pgyProfileDirectory,
} from "./pgy_connection_service.mjs";
import { profilePerformance } from "./profile_service.mjs";
import { sanitizeAnalyticsProperties as sanitizeAnalyticsEventProperties } from "./analytics_service.mjs";
import {
  attachLinksToWorkbook,
  discoverRuntimePgyColumns,
  exportDynamicWorkbook,
} from "./dynamic_workbook.mjs";
import { TASK_STATES, transitionTask } from "./task_state_machine.mjs";
import { recoverCollectedResults } from "./result_recovery_service.mjs";
import {
  interpretScopeReply,
  interpretTaskIntent,
} from "./agent_interpretation_service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DATA_DIR = path.resolve(PROJECT_ROOT, process.env.XUNDAO_DATA_DIR || "data");
const RUNS_DIR = path.resolve(PROJECT_ROOT, process.env.XUNDAO_RUNS_DIR || "runs");
const DB_PATH = path.resolve(PROJECT_ROOT, process.env.SQLITE_PATH || path.join(DATA_DIR, "xundao.sqlite"));
const CONFIG = {
  ...await readJson(path.join(PROJECT_ROOT, "config/pgy_config.json")),
  ...(process.env.PGY_USER_DATA_DIR ? { userDataDir: process.env.PGY_USER_DATA_DIR } : {}),
  ...(process.env.PGY_BASE_URL ? { baseUrl: process.env.PGY_BASE_URL } : {}),
  ...(process.env.PGY_BROWSER_CHANNEL ? { browserChannel: process.env.PGY_BROWSER_CHANNEL } : {}),
};
const PORT = Number(process.env.PORT || 8731);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_URL = process.env.DATABASE_URL || "";
const PGY_STORAGE_STATE_PATH = process.env.PGY_STORAGE_STATE_PATH
  ? path.resolve(PROJECT_ROOT, process.env.PGY_STORAGE_STATE_PATH)
  : "";
const ANALYTICS_ADMIN_TOKEN = process.env.ANALYTICS_ADMIN_TOKEN || "";
const ANALYTICS_DEFAULT_DAYS = Number(process.env.ANALYTICS_DEFAULT_DAYS || 14);
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS || 7);
const TASK_RETENTION_CLEANUP_ENABLED = process.env.TASK_RETENTION_CLEANUP_ENABLED === "true";
const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== "false";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 14);
const BOOTSTRAP_ADMIN_EMAIL = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const LOCAL_BIND = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const ALLOW_FIRST_RUN_SETUP = process.env.ALLOW_FIRST_RUN_SETUP === "true" || LOCAL_BIND;
const PGY_USER_DATA_ROOT = path.resolve(
  PROJECT_ROOT,
  process.env.PGY_USER_DATA_ROOT || path.join(DATA_DIR, "pgy-profiles"),
);
const DEFAULT_WORKSPACE_ID = String(process.env.XUNDAO_DEFAULT_WORKSPACE_ID || "team").trim() || "team";

async function localPgyEncryptionKey() {
  const keyPath = path.join(DATA_DIR, ".pgy-connection.key");
  try {
    return String(await fs.readFile(keyPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(DATA_DIR, { recursive: true });
    const key = randomBytes(32).toString("base64url");
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    return key;
  }
}

const PGY_CONNECTION_ENCRYPTION_KEY = process.env.PGY_CONNECTION_ENCRYPTION_KEY
  || (LOCAL_BIND ? await localPgyEncryptionKey() : "");

const jobs = new Map();
let db = null;
let sqlite = null;
let pgPool = null;
let identityRepository = null;
const sharedContexts = new Map();
const sharedContextOwners = new Map();

const LOCAL_USER = Object.freeze({
  id: "local-admin",
  email: "local@xundao.invalid",
  displayName: "本地管理员",
  role: "admin",
  status: "active",
  mustChangePassword: false,
});

const CORS_HEADERS = {
  "access-control-allow-origin": `http://localhost:${PORT}`,
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-analytics-token",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("上传文件过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const raw = (await readBody(req, limit)).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("缺少 multipart boundary");
  const boundary = `--${match[1] || match[2]}`;
  const raw = buffer.toString("latin1");
  const parts = raw.split(boundary).slice(1, -1);
  const files = [];
  const fields = {};
  for (const part of parts) {
    const cleanPart = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const splitAt = cleanPart.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;
    const header = cleanPart.slice(0, splitAt);
    let content = cleanPart.slice(splitAt + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    const name = /name="([^"]+)"/.exec(header)?.[1] || "";
    const rawFilename = /filename="([^"]*)"/.exec(header)?.[1] || "";
    const filename = rawFilename
      ? Buffer.from(rawFilename, "latin1").toString("utf8")
      : "";
    if (filename) {
      files.push({ name, filename, buffer: Buffer.from(content, "latin1") });
    } else if (name) {
      fields[name] = Buffer.from(content, "latin1").toString("utf8");
    }
  }
  return { files, fields };
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, { cwd: PROJECT_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `python exited with ${code}`));
      }
    });
  });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `node exited with ${code}`));
      }
    });
  });
}

function normalizeSelectedFields(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return normalizeSelectedFields(parsed);
  } catch {
    return String(value).split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  }
}

function parseJsonValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function repairMojibake(value) {
  const text = String(value || "");
  if (!/[\u00c0-\u00ff]/.test(text) || /[\u4e00-\u9fff]/.test(text)) return text;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  return /[\u4e00-\u9fff]/.test(decoded) ? decoded : text;
}

function jobExpired(job) {
  const expiresAt = job.expiresAt || (job.createdAt ? expiresAtForJob(job.createdAt, TASK_RETENTION_DAYS) : "");
  return Boolean(expiresAt && isExpired(expiresAt));
}

function taskStateFor(job) {
  if (jobExpired(job)) return "EXPIRED";
  if (TASK_STATES.includes(job.lifecycleState) && job.lifecycleState !== "DRAFT") {
    return job.lifecycleState;
  }
  if (job.templateId !== "dynamic") return "CONFIRMED";
  const contract = job.taskSpec?.taskContract;
  if (!contract) return "PARSING";
  if (Number(contract.unresolvedCount) > 0) return "NEEDS_CLARIFICATION";
  if (Number(contract.confirmedVersion) === Number(contract.version)) return "CONFIRMED";
  return "READY_TO_CONFIRM";
}

function moveJobState(job, target, eventType) {
  const contract = job.taskSpec?.taskContract || {};
  const legacyConfirmed = job.templateId !== "dynamic";
  const current = {
    state: taskStateFor(job),
    unresolvedCount: Number(contract.unresolvedCount || 0),
    version: Number(contract.version || 1),
    confirmedVersion: legacyConfirmed ? 1 : Number(contract.confirmedVersion || 0),
  };
  if (current.state === target) return target;
  const moved = transitionTask(current, target, {
    type: eventType,
    at: new Date().toISOString(),
  });
  job.lifecycleState = moved.state;
  return moved.state;
}

async function dbExec(sql) {
  if (db?.mode === "postgres") {
    await pgPool.query(sql);
    return;
  }
  sqlite.exec(sql);
}

async function dbAll(sqliteSql, sqliteParams = [], pgSql = sqliteSql, pgParams = sqliteParams) {
  if (db?.mode === "postgres") {
    return (await pgPool.query(pgSql, pgParams)).rows;
  }
  return sqlite.prepare(sqliteSql).all(...sqliteParams);
}

async function dbGet(sqliteSql, sqliteParams = [], pgSql = sqliteSql, pgParams = sqliteParams) {
  if (db?.mode === "postgres") {
    return (await pgPool.query(pgSql, pgParams)).rows[0];
  }
  return sqlite.prepare(sqliteSql).get(...sqliteParams);
}

async function dbRun(sqliteSql, sqliteParams = [], pgSql = sqliteSql, pgParams = sqliteParams) {
  if (db?.mode === "postgres") {
    await pgPool.query(pgSql, pgParams);
    return;
  }
  sqlite.prepare(sqliteSql).run(...sqliteParams);
}

async function ensureColumn(table, column, sqliteDefinition, postgresDefinition = sqliteDefinition) {
  try {
    await dbExec(
      db?.mode === "postgres"
        ? `ALTER TABLE ${table} ADD COLUMN ${column} ${postgresDefinition}`
        : `ALTER TABLE ${table} ADD COLUMN ${column} ${sqliteDefinition}`,
    );
  } catch (error) {
    if (!/duplicate column|already exists/i.test(error.message || "")) throw error;
  }
}

async function ensureJobColumns() {
  const columns = [
    ["template_id", "TEXT NOT NULL DEFAULT 'fuji'"],
    ["owner_user_id", "TEXT NOT NULL DEFAULT ''"],
    ["workspace_id", "TEXT NOT NULL DEFAULT ''"],
    ["state", "TEXT NOT NULL DEFAULT 'DRAFT'"],
    ["task_contract_json", "TEXT NOT NULL DEFAULT '{}'", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
    ["task_contract_version", "INTEGER NOT NULL DEFAULT 1"],
    ["confirmation_json", "TEXT NOT NULL DEFAULT '{}'", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
    ["expires_at", "TEXT"],
    ["deleted_at", "TEXT"],
    ["resumable", "INTEGER NOT NULL DEFAULT 1", "BOOLEAN NOT NULL DEFAULT TRUE"],
  ];
  for (const [column, sqliteDefinition, postgresDefinition] of columns) {
    await ensureColumn("jobs", column, sqliteDefinition, postgresDefinition);
  }
}

async function initDatabase() {
  if (DATABASE_URL) {
    const { Pool } = await import("pg");
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ...(process.env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    db = { mode: "postgres" };
    await dbExec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        original_name TEXT,
        input_path TEXT,
        run_dir TEXT NOT NULL,
        creators_path TEXT,
        results_path TEXT,
        output_path TEXT,
        source_type TEXT NOT NULL,
        template_id TEXT NOT NULL DEFAULT 'fuji',
        owner_user_id TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'DRAFT',
        task_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        task_contract_version INTEGER NOT NULL DEFAULT 1,
        confirmation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TEXT,
        deleted_at TEXT,
        resumable BOOLEAN NOT NULL DEFAULT TRUE,
        progress_json JSONB NOT NULL DEFAULT '{"done":0,"total":0}'::jsonb,
        logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        selected_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidate_pools (
        id TEXT PRIMARY KEY,
        name TEXT,
        filters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collection_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_template_id TEXT NOT NULL DEFAULT 'dynamic',
        definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        job_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        page TEXT,
        properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events (event_name);
      CREATE INDEX IF NOT EXISTS idx_analytics_events_job ON analytics_events (job_id);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'media')),
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions (token_hash);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);

      CREATE TABLE IF NOT EXISTS pgy_connections (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        encrypted_state_path TEXT NOT NULL,
        masked_account_name TEXT,
        status TEXT NOT NULL,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disconnected_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pgy_connections_owner ON pgy_connections (owner_type, owner_id);

      CREATE TABLE IF NOT EXISTS workspace_connection_grants (
        workspace_id TEXT NOT NULL,
        grantee_type TEXT NOT NULL CHECK (grantee_type IN ('role', 'user')),
        grantee_value TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, grantee_type, grantee_value)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_connection_grants_grantee
        ON workspace_connection_grants (grantee_type, grantee_value);
    `);
    await ensureJobColumns();
    return;
  }

  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new DatabaseSync(DB_PATH);
  db = { mode: "sqlite" };
  await dbExec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      original_name TEXT,
      input_path TEXT,
      run_dir TEXT NOT NULL,
      creators_path TEXT,
      results_path TEXT,
      output_path TEXT,
      source_type TEXT NOT NULL,
      template_id TEXT NOT NULL DEFAULT 'fuji',
      owner_user_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'DRAFT',
      task_contract_json TEXT NOT NULL DEFAULT '{}',
      task_contract_version INTEGER NOT NULL DEFAULT 1,
      confirmation_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT,
      deleted_at TEXT,
      resumable INTEGER NOT NULL DEFAULT 1,
      progress_json TEXT NOT NULL,
      logs_json TEXT NOT NULL,
      selected_fields_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidate_pools (
      id TEXT PRIMARY KEY,
      name TEXT,
      filters_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_template_id TEXT NOT NULL DEFAULT 'dynamic',
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      user_id TEXT,
      session_id TEXT,
      job_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      page TEXT,
      properties_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events (event_name);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_job ON analytics_events (job_id);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'media')),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions (token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);

    CREATE TABLE IF NOT EXISTS pgy_connections (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'workspace')),
      owner_id TEXT NOT NULL,
      encrypted_state_path TEXT NOT NULL,
      masked_account_name TEXT,
      status TEXT NOT NULL,
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disconnected_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pgy_connections_owner ON pgy_connections (owner_type, owner_id);

    CREATE TABLE IF NOT EXISTS workspace_connection_grants (
      workspace_id TEXT NOT NULL,
      grantee_type TEXT NOT NULL CHECK (grantee_type IN ('role', 'user')),
      grantee_value TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, grantee_type, grantee_value)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_connection_grants_grantee
      ON workspace_connection_grants (grantee_type, grantee_value);
  `);
  await ensureJobColumns();
}

function initializeIdentityRepository() {
  identityRepository = createIdentityRepository({
    all: dbAll,
    get: dbGet,
    run: dbRun,
  });
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
    lastLoginAt: user.lastLoginAt || "",
  };
}

async function bootstrapAdministrator() {
  if (!BOOTSTRAP_ADMIN_EMAIL || !BOOTSTRAP_ADMIN_PASSWORD) {
    if (AUTH_REQUIRED) {
      console.warn("AUTH_REQUIRED=true，但未配置 BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD");
    }
    return;
  }
  if (await identityRepository.findUserByEmail(BOOTSTRAP_ADMIN_EMAIL)) return;
  const passwordHash = await hashPassword(BOOTSTRAP_ADMIN_PASSWORD);
  await identityRepository.createUser({
    email: BOOTSTRAP_ADMIN_EMAIL,
    displayName: "寻达管理员",
    passwordHash,
    role: "admin",
    mustChangePassword: true,
  });
  console.log(`已创建首个管理员：${BOOTSTRAP_ADMIN_EMAIL}`);
}

async function resolveRequestIdentity(req) {
  if (!AUTH_REQUIRED) {
    req.currentUser = LOCAL_USER;
    req.sessionId = "";
    return LOCAL_USER;
  }
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const session = await identityRepository.findSessionUser(hashSessionToken(token));
  if (!session) return null;
  req.currentUser = session.user;
  req.sessionId = session.sessionId;
  identityRepository.touchSession(session.sessionId).catch(() => {});
  return session.user;
}

function jobBelongsToUser(job, user) {
  if (!job || !user) return false;
  if (!AUTH_REQUIRED && user.id === LOCAL_USER.id) return true;
  return job.ownerUserId === user.id;
}

function requireJobAccess(res, job, user) {
  if (!job) {
    json(res, 404, { error: "任务不存在" });
    return false;
  }
  if (!jobBelongsToUser(job, user)) {
    json(res, 403, { error: "无权访问该任务" });
    return false;
  }
  return true;
}

async function createAuthenticatedSession(res, user) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await identityRepository.createSession({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  res.setHeader("set-cookie", sessionCookie(token, {
    secure: COOKIE_SECURE,
    maxAgeSeconds: SESSION_TTL_DAYS * 24 * 60 * 60,
  }));
  return expiresAt;
}

async function firstRunSetupRequired() {
  if (!AUTH_REQUIRED) return false;
  return !(await identityRepository.listUsers())
    .some((user) => user.role === "admin" && user.status === "active");
}

function requestIsLoopback(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function migrateLocalWorkspaceToFirstAdmin(userId) {
  const now = new Date().toISOString();
  await dbRun(
    "UPDATE jobs SET owner_user_id = ?, updated_at = ? WHERE owner_user_id IN ('', 'local-admin')",
    [userId, now],
    "UPDATE jobs SET owner_user_id = $1, updated_at = $2 WHERE owner_user_id IN ('', 'local-admin')",
    [userId, now],
  );
  await dbRun(
    "UPDATE pgy_connections SET owner_id = ?, updated_at = ? WHERE owner_type = 'user' AND owner_id = 'local-admin'",
    [userId, now],
    "UPDATE pgy_connections SET owner_id = $1, updated_at = $2 WHERE owner_type = 'user' AND owner_id = 'local-admin'",
    [userId, now],
  );
  for (const job of jobs.values()) {
    if (!job.ownerUserId || job.ownerUserId === LOCAL_USER.id) job.ownerUserId = userId;
  }
  const localContext = sharedContexts.get(LOCAL_USER.id);
  if (localContext && !sharedContexts.has(userId)) {
    sharedContexts.set(userId, localContext);
    sharedContexts.delete(LOCAL_USER.id);
    const owner = sharedContextOwners.get(LOCAL_USER.id);
    if (owner) {
      sharedContextOwners.set(userId, { ...owner, id: userId });
      sharedContextOwners.delete(LOCAL_USER.id);
    }
  }
}

async function handleAccountSetup(req, res) {
  if (!AUTH_REQUIRED) return json(res, 409, { error: "当前环境使用本地免登录模式" });
  if (!ALLOW_FIRST_RUN_SETUP || !requestIsLoopback(req)) {
    return json(res, 403, { error: "首次管理员只能在服务器本机创建" });
  }
  if (!await firstRunSetupRequired()) {
    return json(res, 409, { error: "管理员已经创建，请直接登录" });
  }
  const body = await readJsonBody(req, 64 * 1024);
  const passwordHash = await hashPassword(body.password);
  const user = await identityRepository.createUser({
    email: body.email,
    displayName: body.displayName,
    passwordHash,
    role: "admin",
    mustChangePassword: false,
  });
  await migrateLocalWorkspaceToFirstAdmin(user.id);
  const expiresAt = await createAuthenticatedSession(res, user);
  trackEventSoon({
    eventName: "account_first_run_setup",
    userId: user.id,
    page: "login",
    properties: { role: user.role },
  });
  return json(res, 201, { user: publicUser(user), expiresAt });
}

async function handleAccountLogin(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const user = await identityRepository.findUserByEmail(body.email);
  if (!user || user.status !== "active" || !await verifyPassword(body.password, user.passwordHash)) {
    return json(res, 401, { error: "邮箱或密码错误" });
  }
  const expiresAt = await createAuthenticatedSession(res, user);
  trackEventSoon({
    eventName: "account_login",
    userId: user.id,
    page: "login",
    properties: { role: user.role },
  });
  return json(res, 200, { user: publicUser(user), expiresAt });
}

async function handleAccountLogout(req, res) {
  const token = sessionTokenFromRequest(req);
  if (token) await identityRepository.revokeSessionByToken(hashSessionToken(token));
  res.setHeader("set-cookie", clearSessionCookie({ secure: COOKIE_SECURE }));
  return json(res, 200, { ok: true });
}

async function handleCreateUser(req, res) {
  requireRole(req.currentUser, "admin");
  const body = await readJsonBody(req, 64 * 1024);
  const existing = await identityRepository.findUserByEmail(body.email);
  if (existing) return json(res, 409, { error: "该邮箱已存在" });
  const passwordHash = await hashPassword(body.password);
  const user = await identityRepository.createUser({
    email: body.email,
    displayName: body.displayName,
    passwordHash,
    role: body.role || "media",
    mustChangePassword: body.mustChangePassword !== false,
  });
  return json(res, 201, { user: publicUser(user) });
}

async function handleUpdateUserStatus(req, res, userId) {
  requireRole(req.currentUser, "admin");
  const body = await readJsonBody(req, 64 * 1024);
  if (userId === req.currentUser.id && body.status === "disabled") {
    return json(res, 409, { error: "不能停用当前管理员账号" });
  }
  const user = await identityRepository.updateUserStatus(userId, body.status);
  return user
    ? json(res, 200, { user: publicUser(user) })
    : json(res, 404, { error: "账号不存在" });
}

async function getPgyConnection(ownerUserId) {
  return await dbGet(
    `SELECT * FROM pgy_connections
     WHERE owner_type = 'user' AND owner_id = ? AND disconnected_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [ownerUserId],
    `SELECT * FROM pgy_connections
     WHERE owner_type = 'user' AND owner_id = $1 AND disconnected_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [ownerUserId],
  );
}

async function getWorkspacePgyConnection(workspaceId = DEFAULT_WORKSPACE_ID) {
  return await dbGet(
    `SELECT * FROM pgy_connections
     WHERE owner_type = 'workspace' AND owner_id = ? AND disconnected_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId],
    `SELECT * FROM pgy_connections
     WHERE owner_type = 'workspace' AND owner_id = $1 AND disconnected_at IS NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId],
  );
}

async function workspaceConnectionAllowed(user, workspaceId = DEFAULT_WORKSPACE_ID) {
  if (!user?.id || !user?.role) return false;
  const grant = await dbGet(
    `SELECT workspace_id FROM workspace_connection_grants
     WHERE workspace_id = ?
       AND ((grantee_type = 'role' AND grantee_value = ?)
         OR (grantee_type = 'user' AND grantee_value = ?))
     LIMIT 1`,
    [workspaceId, user.role, user.id],
    `SELECT workspace_id FROM workspace_connection_grants
     WHERE workspace_id = $1
       AND ((grantee_type = 'role' AND grantee_value = $2)
         OR (grantee_type = 'user' AND grantee_value = $3))
     LIMIT 1`,
    [workspaceId, user.role, user.id],
  );
  return Boolean(grant);
}

async function effectivePgyConnection(user, { contextOpen = false } = {}) {
  const personal = await getPgyConnection(user.id);
  const contextOwner = contextOpen ? sharedContextOwners.get(user.id) : null;
  if (contextOwner?.type === "workspace") {
    const workspace = await getWorkspacePgyConnection(contextOwner.id);
    return { row: workspace, source: "workspace", workspaceId: contextOwner.id };
  }
  if (contextOpen || personal?.status === "connected") {
    return { row: personal, source: "personal", workspaceId: "" };
  }
  if (await workspaceConnectionAllowed(user)) {
    const workspace = await getWorkspacePgyConnection();
    if (workspace?.status === "connected") {
      return { row: workspace, source: "workspace", workspaceId: DEFAULT_WORKSPACE_ID };
    }
  }
  return { row: personal, source: "personal", workspaceId: "" };
}

function publicPgyConnection(
  row,
  contextOpen = false,
  source = "personal",
  workspaceId = "",
  interactiveOpen = false,
) {
  if (!row && !contextOpen) return {
    status: "not_connected",
    connected: false,
    contextOpen: false,
    interactiveOpen: false,
    lastVerifiedAt: "",
    maskedAccountName: "",
    source,
    shared: source === "workspace",
    workspaceId,
  };
  return {
    status: row?.status || (contextOpen ? "pending_verification" : "not_connected"),
    connected: row?.status === "connected",
    contextOpen,
    interactiveOpen,
    lastVerifiedAt: row?.last_verified_at || "",
    maskedAccountName: row?.masked_account_name || "",
    source,
    shared: source === "workspace",
    workspaceId,
  };
}

function registerSharedContext(ownerId, context, connectionOwner = { type: "user", id: ownerId }) {
  sharedContexts.set(ownerId, context);
  sharedContextOwners.set(ownerId, connectionOwner);
  context.on("close", () => {
    if (sharedContexts.get(ownerId) === context) {
      sharedContexts.delete(ownerId);
      sharedContextOwners.delete(ownerId);
    }
  });
  return context;
}

function pgyConnectionError(message, code = "PGY_CONNECTION_EXPIRED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function markConnectionExpired(ownerType, ownerId, reason, eventUserId = "") {
  const now = new Date().toISOString();
  await dbRun(
    `UPDATE pgy_connections
     SET status = 'expired', last_verified_at = ?, updated_at = ?
     WHERE owner_type = ? AND owner_id = ? AND disconnected_at IS NULL`,
    [now, now, ownerType, ownerId],
    `UPDATE pgy_connections
     SET status = 'expired', last_verified_at = $1, updated_at = $2
     WHERE owner_type = $3 AND owner_id = $4 AND disconnected_at IS NULL`,
    [now, now, ownerType, ownerId],
  );
  trackEventSoon({
    eventName: "pgy_connection_expired",
    userId: eventUserId || (ownerType === "user" ? ownerId : ""),
    page: "settings",
    properties: { reason, ownerType },
  });
}

async function markPgyConnectionExpired(ownerUserId, reason) {
  return await markConnectionExpired("user", ownerUserId, reason, ownerUserId);
}

async function openInteractivePgyContext(user = LOCAL_USER) {
  const ownerId = user?.id || LOCAL_USER.id;
  const previous = sharedContexts.get(ownerId);
  if (previous) await previous.close().catch(() => {});
  const userDataDir = pgyProfileDirectory(PGY_USER_DATA_ROOT, "user", ownerId);
  return registerSharedContext(
    ownerId,
    await createPgyContext({ ...CONFIG, userDataDir }),
    { type: "user", id: ownerId, interactive: true },
  );
}

async function handleGetPgyConnection(req, res) {
  const contextOpen = sharedContexts.has(req.currentUser.id);
  const interactiveOpen = Boolean(sharedContextOwners.get(req.currentUser.id)?.interactive);
  const effective = await effectivePgyConnection(req.currentUser, { contextOpen });
  return json(res, 200, {
    connection: publicPgyConnection(
      effective.row,
      contextOpen,
      effective.source,
      effective.workspaceId,
      interactiveOpen,
    ),
  });
}

async function handleSyncPgyConnection(req, res) {
  if (!PGY_CONNECTION_ENCRYPTION_KEY) {
    return json(res, 409, { error: "服务端尚未配置蒲公英连接加密密钥" });
  }
  const context = sharedContexts.get(req.currentUser.id);
  if (!context) return json(res, 409, { error: "请先打开蒲公英连接并完成登录" });
  const body = await readJsonBody(req, 64 * 1024);
  const probe = await verifyPgyLoginState(context, CONFIG);
  if (!probe.authenticated) {
    await markPgyConnectionExpired(req.currentUser.id, probe.reason);
    return json(res, 409, { error: `${probe.reason}，请在登录窗口完成登录后再保存` });
  }
  const storageState = await context.storageState();
  const profileDir = pgyProfileDirectory(PGY_USER_DATA_ROOT, "user", req.currentUser.id);
  await fs.mkdir(profileDir, { recursive: true });
  const encryptedStatePath = path.join(profileDir, "connection-state.enc");
  await fs.writeFile(
    encryptedStatePath,
    encryptStorageState(storageState, PGY_CONNECTION_ENCRYPTION_KEY),
    { mode: 0o600 },
  );
  const existing = await getPgyConnection(req.currentUser.id);
  const id = existing?.id || `pgy-${nowStamp()}-${Math.random().toString(16).slice(2, 8)}`;
  const now = new Date().toISOString();
  const maskedAccountName = String(body.maskedAccountName || existing?.masked_account_name || "蒲公英账号").slice(0, 80);
  const params = [
    id,
    "user",
    req.currentUser.id,
    encryptedStatePath,
    maskedAccountName,
    "connected",
    now,
    existing?.created_at || now,
    now,
  ];
  await dbRun(
    `INSERT OR REPLACE INTO pgy_connections (
      id, owner_type, owner_id, encrypted_state_path, masked_account_name,
      status, last_verified_at, created_at, updated_at, disconnected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params,
    `INSERT INTO pgy_connections (
      id, owner_type, owner_id, encrypted_state_path, masked_account_name,
      status, last_verified_at, created_at, updated_at, disconnected_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
    ON CONFLICT (id) DO UPDATE SET
      encrypted_state_path = EXCLUDED.encrypted_state_path,
      masked_account_name = EXCLUDED.masked_account_name,
      status = EXCLUDED.status,
      last_verified_at = EXCLUDED.last_verified_at,
      updated_at = EXCLUDED.updated_at,
      disconnected_at = NULL`,
    params,
  );
  trackEventSoon({
    eventName: "pgy_connection_saved",
    userId: req.currentUser.id,
    page: "settings",
    properties: { status: "connected" },
  });
  await context.close().catch(() => {});
  return await handleGetPgyConnection(req, res);
}

async function handleDisconnectPgy(req, res) {
  const connection = await getPgyConnection(req.currentUser.id);
  const now = new Date().toISOString();
  await dbRun(
    `UPDATE pgy_connections
     SET status = 'disconnected', disconnected_at = ?, updated_at = ?
     WHERE owner_type = 'user' AND owner_id = ? AND disconnected_at IS NULL`,
    [now, now, req.currentUser.id],
    `UPDATE pgy_connections
     SET status = 'disconnected', disconnected_at = $1, updated_at = $2
     WHERE owner_type = 'user' AND owner_id = $3 AND disconnected_at IS NULL`,
    [now, now, req.currentUser.id],
  );
  const context = sharedContexts.get(req.currentUser.id);
  if (context) await context.close().catch(() => {});
  const profileDir = pgyProfileDirectory(PGY_USER_DATA_ROOT, "user", req.currentUser.id);
  if (
    !connection?.encrypted_state_path
    || path.resolve(connection.encrypted_state_path).startsWith(`${path.resolve(profileDir)}${path.sep}`)
  ) {
    await fs.rm(profileDir, { recursive: true, force: true });
  }
  trackEventSoon({
    eventName: "pgy_connection_disconnected",
    userId: req.currentUser.id,
    page: "settings",
    properties: { hadSavedConnection: Boolean(connection) },
  });
  return json(res, 200, { ok: true });
}

async function workspaceConnectionGrants(workspaceId = DEFAULT_WORKSPACE_ID) {
  return await dbAll(
    `SELECT grantee_type, grantee_value, created_by_user_id, created_at
     FROM workspace_connection_grants
     WHERE workspace_id = ?
     ORDER BY grantee_type, grantee_value`,
    [workspaceId],
    `SELECT grantee_type, grantee_value, created_by_user_id, created_at
     FROM workspace_connection_grants
     WHERE workspace_id = $1
     ORDER BY grantee_type, grantee_value`,
    [workspaceId],
  );
}

async function closeWorkspaceContexts(workspaceId = DEFAULT_WORKSPACE_ID) {
  const pending = [];
  for (const [userId, owner] of sharedContextOwners.entries()) {
    if (owner?.type !== "workspace" || owner.id !== workspaceId) continue;
    const context = sharedContexts.get(userId);
    if (context) pending.push(context.close().catch(() => {}));
  }
  await Promise.all(pending);
}

async function handleGetSharedPgyConnection(req, res) {
  requireRole(req.currentUser, "admin");
  const connection = await getWorkspacePgyConnection();
  const grants = await workspaceConnectionGrants();
  return json(res, 200, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    connection: publicPgyConnection(
      connection,
      false,
      "workspace",
      DEFAULT_WORKSPACE_ID,
    ),
    allowedRoles: grants
      .filter((grant) => grant.grantee_type === "role")
      .map((grant) => grant.grantee_value),
    allowedUserIds: grants
      .filter((grant) => grant.grantee_type === "user")
      .map((grant) => grant.grantee_value),
  });
}

async function handlePublishSharedPgyConnection(req, res) {
  requireRole(req.currentUser, "admin");
  if (!PGY_CONNECTION_ENCRYPTION_KEY) {
    return json(res, 409, { error: "服务端尚未配置蒲公英连接加密密钥" });
  }
  const personal = await getPgyConnection(req.currentUser.id);
  if (personal?.status !== "connected" || !personal.encrypted_state_path) {
    return json(res, 409, { error: "请先在个人中心连接并保存管理员自己的蒲公英账号" });
  }
  const body = await readJsonBody(req, 64 * 1024);
  const allowedRoles = Array.from(new Set(
    (Array.isArray(body.allowedRoles) ? body.allowedRoles : ["admin", "media"])
      .map((role) => String(role || "").trim())
      .filter((role) => ["admin", "media"].includes(role)),
  ));
  if (!allowedRoles.length) {
    return json(res, 400, { error: "至少授权一个账号角色" });
  }
  const storageState = await loadEncryptedStorageState(
    personal.encrypted_state_path,
    PGY_CONNECTION_ENCRYPTION_KEY,
  ).catch(() => null);
  if (!storageState) {
    return json(res, 409, { error: "管理员蒲公英登录态无法读取，请先重新连接并保存" });
  }
  const profileDir = pgyProfileDirectory(
    PGY_USER_DATA_ROOT,
    "workspace",
    DEFAULT_WORKSPACE_ID,
  );
  await fs.mkdir(profileDir, { recursive: true });
  const encryptedStatePath = path.join(profileDir, "connection-state.enc");
  await fs.writeFile(
    encryptedStatePath,
    encryptStorageState(storageState, PGY_CONNECTION_ENCRYPTION_KEY),
    { mode: 0o600 },
  );
  const existing = await getWorkspacePgyConnection();
  const now = new Date().toISOString();
  const id = existing?.id || `pgy-workspace-${nowStamp()}-${Math.random().toString(16).slice(2, 8)}`;
  const params = [
    id,
    "workspace",
    DEFAULT_WORKSPACE_ID,
    encryptedStatePath,
    String(body.maskedAccountName || personal.masked_account_name || "团队蒲公英账号").slice(0, 80),
    "connected",
    personal.last_verified_at || now,
    existing?.created_at || now,
    now,
  ];
  await dbRun(
    `INSERT OR REPLACE INTO pgy_connections (
      id, owner_type, owner_id, encrypted_state_path, masked_account_name,
      status, last_verified_at, created_at, updated_at, disconnected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params,
    `INSERT INTO pgy_connections (
      id, owner_type, owner_id, encrypted_state_path, masked_account_name,
      status, last_verified_at, created_at, updated_at, disconnected_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
    ON CONFLICT (id) DO UPDATE SET
      encrypted_state_path = EXCLUDED.encrypted_state_path,
      masked_account_name = EXCLUDED.masked_account_name,
      status = EXCLUDED.status,
      last_verified_at = EXCLUDED.last_verified_at,
      updated_at = EXCLUDED.updated_at,
      disconnected_at = NULL`,
    params,
  );
  await dbRun(
    "DELETE FROM workspace_connection_grants WHERE workspace_id = ?",
    [DEFAULT_WORKSPACE_ID],
    "DELETE FROM workspace_connection_grants WHERE workspace_id = $1",
    [DEFAULT_WORKSPACE_ID],
  );
  for (const role of allowedRoles) {
    const grantParams = [DEFAULT_WORKSPACE_ID, "role", role, req.currentUser.id, now];
    await dbRun(
      `INSERT OR REPLACE INTO workspace_connection_grants (
        workspace_id, grantee_type, grantee_value, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      grantParams,
      `INSERT INTO workspace_connection_grants (
        workspace_id, grantee_type, grantee_value, created_by_user_id, created_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (workspace_id, grantee_type, grantee_value) DO UPDATE SET
        created_by_user_id = EXCLUDED.created_by_user_id,
        created_at = EXCLUDED.created_at`,
      grantParams,
    );
  }
  await closeWorkspaceContexts();
  trackEventSoon({
    eventName: "workspace_pgy_connection_published",
    userId: req.currentUser.id,
    page: "analytics",
    properties: { allowedRoles },
  });
  return await handleGetSharedPgyConnection(req, res);
}

async function handleRevokeSharedPgyConnection(req, res) {
  requireRole(req.currentUser, "admin");
  const connection = await getWorkspacePgyConnection();
  const now = new Date().toISOString();
  await dbRun(
    `UPDATE pgy_connections
     SET status = 'disconnected', disconnected_at = ?, updated_at = ?
     WHERE owner_type = 'workspace' AND owner_id = ? AND disconnected_at IS NULL`,
    [now, now, DEFAULT_WORKSPACE_ID],
    `UPDATE pgy_connections
     SET status = 'disconnected', disconnected_at = $1, updated_at = $2
     WHERE owner_type = 'workspace' AND owner_id = $3 AND disconnected_at IS NULL`,
    [now, now, DEFAULT_WORKSPACE_ID],
  );
  await dbRun(
    "DELETE FROM workspace_connection_grants WHERE workspace_id = ?",
    [DEFAULT_WORKSPACE_ID],
    "DELETE FROM workspace_connection_grants WHERE workspace_id = $1",
    [DEFAULT_WORKSPACE_ID],
  );
  await closeWorkspaceContexts();
  const profileDir = pgyProfileDirectory(
    PGY_USER_DATA_ROOT,
    "workspace",
    DEFAULT_WORKSPACE_ID,
  );
  if (
    !connection?.encrypted_state_path
    || path.resolve(connection.encrypted_state_path).startsWith(`${path.resolve(profileDir)}${path.sep}`)
  ) {
    await fs.rm(profileDir, { recursive: true, force: true });
  }
  trackEventSoon({
    eventName: "workspace_pgy_connection_revoked",
    userId: req.currentUser.id,
    page: "analytics",
    properties: { workspaceId: DEFAULT_WORKSPACE_ID },
  });
  return json(res, 200, { ok: true });
}

async function handleProfile(req, res) {
  const contextOpen = sharedContexts.has(req.currentUser.id);
  const interactiveOpen = Boolean(sharedContextOwners.get(req.currentUser.id)?.interactive);
  const effective = await effectivePgyConnection(req.currentUser, { contextOpen });
  return json(res, 200, {
    user: publicUser(req.currentUser),
    connection: publicPgyConnection(
      effective.row,
      contextOpen,
      effective.source,
      effective.workspaceId,
      interactiveOpen,
    ),
    retentionDays: TASK_RETENTION_DAYS,
    authRequired: AUTH_REQUIRED,
  });
}

async function handleUpdateProfile(req, res) {
  if (!AUTH_REQUIRED) return json(res, 409, { error: "本地免登录账号无需修改" });
  const body = await readJsonBody(req, 64 * 1024);
  const user = await identityRepository.updateProfile(req.currentUser.id, body);
  return json(res, 200, { user: publicUser(user) });
}

async function handleChangePassword(req, res) {
  if (!AUTH_REQUIRED) return json(res, 409, { error: "本地免登录账号无需修改密码" });
  const body = await readJsonBody(req, 64 * 1024);
  const current = await identityRepository.getUserById(req.currentUser.id);
  if (!await verifyPassword(body.currentPassword, current.passwordHash)) {
    return json(res, 401, { error: "当前密码错误" });
  }
  const passwordHash = await hashPassword(body.newPassword);
  await identityRepository.changePassword(req.currentUser.id, passwordHash);
  res.setHeader("set-cookie", clearSessionCookie({ secure: COOKIE_SECURE }));
  return json(res, 200, { ok: true, reloginRequired: true });
}

async function handleProfilePerformance(req, res) {
  const visibleJobs = Array.from(jobs.values())
    .filter((job) => job.lifecycleState !== "DELETED" && jobBelongsToUser(job, req.currentUser))
    .map((job) => ({
      ...job,
      ownerUserId: job.ownerUserId || req.currentUser.id,
    }));
  return json(res, 200, {
    performance: profilePerformance(visibleJobs, {
      ownerUserId: req.currentUser.id,
      days: TASK_RETENTION_DAYS,
    }),
  });
}

async function handleDeleteTask(req, res, job) {
  if (!requireJobAccess(res, job, req.currentUser)) return;
  if (job.status === "running") return json(res, 409, { error: "采集中任务不能删除，请等待或停止任务" });
  await deleteExpiredArtifacts(job, { allowedRoots: [RUNS_DIR, DATA_DIR] });
  const now = new Date().toISOString();
  await dbRun(
    "UPDATE jobs SET state = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ?",
    [now, now, job.id],
    "UPDATE jobs SET state = 'DELETED', deleted_at = $1, updated_at = $2 WHERE id = $3",
    [now, now, job.id],
  );
  jobs.delete(job.id);
  trackEventSoon({
    eventName: "task_deleted",
    userId: req.currentUser.id,
    jobId: job.id,
    page: "profile",
    properties: { sourceType: job.sourceType },
  });
  return json(res, 200, { ok: true });
}

async function persistJob(job) {
  if (!db || !job?.id) return;
  const params = [
    job.id,
    job.status || "uploaded",
    job.originalName || "",
    job.inputPath || "",
    job.runDir || "",
    job.creatorsPath || "",
    job.resultsPath || "",
    job.outputPath || "",
    job.sourceType || "excel",
    normalizeTemplateId(job.templateId),
    job.ownerUserId || "",
    job.workspaceId || "",
    taskStateFor(job),
    JSON.stringify(job.taskSpec?.taskContract || {}),
    Number(job.taskSpec?.taskContract?.version || 1),
    JSON.stringify(job.confirmation || {}),
    job.expiresAt || expiresAtForJob(job.createdAt || new Date().toISOString(), TASK_RETENTION_DAYS),
    JSON.stringify(job.progress || { done: 0, total: 0 }),
    JSON.stringify(job.logs || []),
    JSON.stringify(job.selectedFields || []),
    job.error || "",
    job.createdAt || new Date().toISOString(),
    job.finishedAt || "",
    new Date().toISOString(),
  ];
  await dbRun(`
    INSERT OR REPLACE INTO jobs (
      id, status, original_name, input_path, run_dir, creators_path, results_path, output_path,
      source_type, template_id, owner_user_id, workspace_id, state, task_contract_json,
      task_contract_version, confirmation_json, expires_at, progress_json, logs_json,
      selected_fields_json, error, created_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  params,
  `
    INSERT INTO jobs (
      id, status, original_name, input_path, run_dir, creators_path, results_path, output_path,
      source_type, template_id, owner_user_id, workspace_id, state, task_contract_json,
      task_contract_version, confirmation_json, expires_at, progress_json, logs_json,
      selected_fields_json, error, created_at, finished_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17,
      $18::jsonb, $19::jsonb, $20::jsonb, $21, $22, $23, $24
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      original_name = EXCLUDED.original_name,
      input_path = EXCLUDED.input_path,
      run_dir = EXCLUDED.run_dir,
      creators_path = EXCLUDED.creators_path,
      results_path = EXCLUDED.results_path,
      output_path = EXCLUDED.output_path,
      source_type = EXCLUDED.source_type,
      template_id = EXCLUDED.template_id,
      owner_user_id = EXCLUDED.owner_user_id,
      workspace_id = EXCLUDED.workspace_id,
      state = EXCLUDED.state,
      task_contract_json = EXCLUDED.task_contract_json,
      task_contract_version = EXCLUDED.task_contract_version,
      confirmation_json = EXCLUDED.confirmation_json,
      expires_at = EXCLUDED.expires_at,
      progress_json = EXCLUDED.progress_json,
      logs_json = EXCLUDED.logs_json,
      selected_fields_json = EXCLUDED.selected_fields_json,
      error = EXCLUDED.error,
      finished_at = EXCLUDED.finished_at,
      updated_at = EXCLUDED.updated_at
  `,
  params,
  );
}

function persistJobSoon(job) {
  persistJob(job).catch((error) => {
    console.error(`persist job failed: ${error.message}`);
  });
}

async function trackEvent({
  eventName,
  userId = "",
  sessionId = "",
  jobId = "",
  entityType = "",
  entityId = "",
  page = "",
  properties = {},
} = {}) {
  if (!eventName) return;
  const id = `${nowStamp()}-${Math.random().toString(16).slice(2, 10)}`;
  const createdAt = new Date().toISOString();
  const cleanProperties = sanitizeAnalyticsEventProperties(properties || {});
  const params = [
    id,
    String(eventName),
    String(userId || ""),
    String(sessionId || ""),
    String(jobId || ""),
    String(entityType || ""),
    String(entityId || ""),
    String(page || ""),
    JSON.stringify(cleanProperties),
    createdAt,
  ];
  await dbRun(`
    INSERT INTO analytics_events (
      id, event_name, user_id, session_id, job_id, entity_type, entity_id, page, properties_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  params,
  `
    INSERT INTO analytics_events (
      id, event_name, user_id, session_id, job_id, entity_type, entity_id, page, properties_json, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
  `,
  params);
}

function trackEventSoon(payload) {
  trackEvent(payload).catch((error) => {
    console.error(`track event failed: ${error.message}`);
  });
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hydrateJob(row) {
  const job = {
    id: row.id,
    status: row.status || "uploaded",
    originalName: repairMojibake(row.original_name || ""),
    inputPath: row.input_path || "",
    runDir: row.run_dir || "",
    creatorsPath: row.creators_path || "",
    resultsPath: row.results_path || "",
    taskPath: path.join(row.run_dir || "", "task.json"),
    outputPath: row.output_path || "",
    sourceType: row.source_type || "excel",
    templateId: normalizeTemplateId(row.template_id),
    ownerUserId: row.owner_user_id || "",
    workspaceId: row.workspace_id || "",
    confirmation: parseJsonValue(row.confirmation_json, {}),
    lifecycleState: TASK_STATES.includes(row.state) && row.state !== "DRAFT" ? row.state : "",
    progress: parseJsonValue(row.progress_json, { done: 0, total: 0 }),
    logs: parseJsonValue(row.logs_json, []),
    selectedFields: parseJsonValue(row.selected_fields_json, []),
    error: row.error || "",
    createdAt: row.created_at || new Date().toISOString(),
    expiresAt: row.expires_at || expiresAtForJob(row.created_at || new Date().toISOString(), TASK_RETENTION_DAYS),
    finishedAt: row.finished_at || "",
  };
  if (await fileExists(job.creatorsPath)) {
    job.creators = await readJson(job.creatorsPath).catch(() => []);
  }
  if (job.templateId === "dynamic" && await fileExists(job.taskPath)) {
    job.taskSpec = await readJson(job.taskPath).catch(() => null);
  } else if (parseJsonValue(row.task_contract_json, null)?.scopeGroups) {
    job.taskSpec = { taskContract: parseJsonValue(row.task_contract_json, {}) };
  }
  if (!job.lifecycleState) {
    job.lifecycleState = job.status === "done"
      ? "COMPLETED"
      : job.status === "failed"
        ? "FAILED"
        : taskStateFor(job);
  }
  if (
    job.status === "uploaded"
    && job.templateId === "dynamic"
    && job.taskSpec
    && Number(job.taskSpec.resolutionVersion || 0) < 3
  ) {
    const previousUnresolved = Number(job.taskSpec.taskContract?.unresolvedCount || 0);
    const defaults = contractDefaultsFromJob(job);
    const reconciled = await reconcileDynamicTaskFields(job.taskSpec, defaults, { useModel: false });
    job.taskSpec = { ...reconciled.taskSpec, resolutionVersion: 3 };
    const nextUnresolved = Number(job.taskSpec.taskContract?.unresolvedCount || 0);
    job.lifecycleState = nextUnresolved > 0 ? "NEEDS_CLARIFICATION" : "READY_TO_CONFIRM";
    job.logs = [
      ...(Array.isArray(job.logs) ? job.logs : []),
      {
        ts: new Date().toISOString(),
        stage: "parsing",
        level: "success",
        message: `已按最新字段规则重新校验，待确认字段由 ${previousUnresolved} 个更新为 ${nextUnresolved} 个`,
      },
    ];
    await writeJson(job.taskPath, job.taskSpec);
    await persistJob(job);
  }
  job.taskState = taskStateFor(job);
  if (job.status === "running") {
    job.status = "failed";
    job.lifecycleState = "FAILED";
    job.error = job.error || "服务重启后运行进程已中断，请重新开始采集";
    job.logs = [
      ...(Array.isArray(job.logs) ? job.logs : []),
      { ts: new Date().toISOString(), message: "服务重启后已将未完成任务标记为可重试" },
    ];
    await persistJob(job);
  }
  return job;
}

async function loadPersistedJobs() {
  const rows = await dbAll("SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC");
  for (const row of rows) {
    const job = await hydrateJob(row);
    jobs.set(job.id, job);
  }
}

async function recoverRunsAsJobs() {
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("finder-") || entry.name === "uploads") continue;
    if (jobs.has(entry.name)) continue;
    const runDir = path.join(RUNS_DIR, entry.name);
    const creatorsPath = path.join(runDir, "creators.json");
    if (!(await fileExists(creatorsPath))) continue;
    const candidatesPath = path.join(runDir, "finder-candidates.json");
    const resultsPath = path.join(runDir, "results.json");
    const outputPath = path.join(runDir, "output.xlsx");
    const creators = await readJson(creatorsPath).catch(() => []);
    const outputReady = await fileExists(outputPath);
    const resultsReady = await fileExists(resultsPath);
    const createdAt = /^\d{4}-\d{2}-\d{2}T/.test(entry.name)
      ? entry.name.replace(/-(\d{3})Z$/, ".$1Z").replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3")
      : new Date().toISOString();
    const job = {
      id: entry.name,
      status: outputReady ? "done" : resultsReady ? "failed" : "uploaded",
      originalName: await fileExists(candidatesPath) ? "历史候选池采集" : "历史 Excel 任务",
      inputPath: "",
      runDir,
      creatorsPath,
      resultsPath,
      outputPath,
      sourceType: await fileExists(candidatesPath) ? "finder" : "excel",
      templateId: "fuji",
      progress: { done: outputReady ? creators.length : 0, total: creators.length },
      logs: [{ ts: new Date().toISOString(), message: "已从历史运行目录恢复任务记录" }],
      selectedFields: [],
      ownerUserId: "",
      lifecycleState: outputReady ? "COMPLETED" : resultsReady ? "FAILED" : "CONFIRMED",
      createdAt,
      finishedAt: outputReady ? new Date().toISOString() : "",
      creators,
    };
    jobs.set(job.id, job);
    await persistJob(job);
  }
}

async function runRetentionSweep() {
  if (!TASK_RETENTION_CLEANUP_ENABLED) return { expired: 0, deleted: 0 };
  return await sweepExpiredTasks(Array.from(jobs.values()), {
    isExpiredFn: jobExpired,
    deleteTask: async (job) => {
      await deleteExpiredArtifacts(job, { allowedRoots: [RUNS_DIR, DATA_DIR] });
    },
    markExpired: async (job) => {
      const now = new Date().toISOString();
      await dbRun(
        "UPDATE jobs SET state = 'EXPIRED', deleted_at = ?, updated_at = ? WHERE id = ?",
        [now, now, job.id],
        "UPDATE jobs SET state = 'EXPIRED', deleted_at = $1, updated_at = $2 WHERE id = $3",
        [now, now, job.id],
      );
      jobs.delete(job.id);
      trackEventSoon({
        eventName: "task_expired",
        userId: job.ownerUserId,
        jobId: job.id,
        page: "retention",
        properties: { retentionDays: TASK_RETENTION_DAYS },
      });
    },
    onError: (error, job) => {
      console.error(`retention cleanup failed for ${job.id}: ${error.message}`);
    },
  });
}

function publicCandidatePool(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || "当前候选池",
    filters: parseJsonValue(row.filters_json, {}),
    candidates: parseJsonValue(row.candidates_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventProperties(row) {
  return parseJsonValue(row.properties_json, {});
}

function percent(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

function average(values) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return clean.length ? Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length) : 0;
}

function eventCount(events, names) {
  const set = new Set(Array.isArray(names) ? names : [names]);
  return events.filter((event) => set.has(event.event_name)).length;
}

function topList(events, getKey, decorate = () => ({}), limit = 8) {
  const map = new Map();
  for (const event of events) {
    const key = getKey(event);
    if (!key) continue;
    const hit = map.get(key) || { label: key, count: 0, events: [] };
    hit.count += 1;
    hit.events.push(event);
    map.set(key, hit);
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((item) => {
      const { events: itemEvents, ...rest } = item;
      return { ...rest, ...decorate(itemEvents) };
    });
}

function analyticsAccessFromRequest(req) {
  const token = req.headers["x-analytics-token"] || new URL(req.url, `http://${req.headers.host}`).searchParams.get("token") || "";
  if (!ANALYTICS_ADMIN_TOKEN) {
    return { allowed: true, mode: "open-local", viewer: "本地管理员" };
  }
  return {
    allowed: token === ANALYTICS_ADMIN_TOKEN,
    mode: "token",
    viewer: token === ANALYTICS_ADMIN_TOKEN ? "管理员/投放负责人" : "未授权",
  };
}

async function loadAnalyticsEvents(days = ANALYTICS_DEFAULT_DAYS) {
  const safeDays = Math.min(Math.max(Number(days) || ANALYTICS_DEFAULT_DAYS, 1), 180);
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  return await dbAll(
    "SELECT * FROM analytics_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 5000",
    [since],
    "SELECT * FROM analytics_events WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 5000",
    [since],
  );
}

function analyticsSummary(events, days) {
  const searchSubmits = eventCount(events, "finder_search_submit");
  const searchSuccesses = eventCount(events, "finder_search_success");
  const searchFailures = eventCount(events, "finder_search_failed");
  const resultCandidates = events
    .filter((event) => event.event_name === "finder_search_success")
    .reduce((sum, event) => sum + Number(eventProperties(event).returned || 0), 0);
  const selectedCreators = eventCount(events, "creator_select");
  const unselectedCreators = eventCount(events, "creator_unselect");
  const importedCreators = events
    .filter((event) => event.event_name === "candidate_pool_import")
    .reduce((sum, event) => sum + Number(eventProperties(event).candidateCount || 0), 0);
  const collectJobs = eventCount(events, "collect_job_create");
  const collectStarts = eventCount(events, "collect_start");
  const collectDone = eventCount(events, "collect_job_done");
  const collectFailed = eventCount(events, "collect_job_failed");
  const downloads = eventCount(events, "excel_download");
  const fieldMissing = eventCount(events, "field_missing");
  const loginExpired = eventCount(events, [
    "pgy_login_state_expired",
    "pgy_connection_expired",
    "pgy_connection_required",
  ]);
  const apiTimeout = eventCount(events, "pgy_api_timeout");
  const clarificationRequested = eventCount(events, "clarification_requested");
  const clarificationResolved = eventCount(events, "clarification_resolved");
  const taskConfirmed = eventCount(events, "task_confirmed");
  const scopeGroupCompleted = eventCount(events, "scope_group_completed");
  const validationFailed = eventCount(events, "validation_failed");
  const modelCallCompleted = eventCount(events, "model_call_completed");
  const modelCallFailed = eventCount(events, "model_call_failed");
  const searchDurations = events
    .filter((event) => event.event_name === "finder_search_success" || event.event_name === "finder_search_failed")
    .map((event) => eventProperties(event).durationMs);
  const collectDurations = events
    .filter((event) => event.event_name === "collect_job_done" || event.event_name === "collect_job_failed")
    .map((event) => eventProperties(event).durationMs);

  return {
    access: {
      visibleTo: ["管理员", "投放负责人", "数据分析"],
      hiddenFrom: ["普通媒介执行同学", "外部协作者"],
      policy: AUTH_REQUIRED
        ? "生产环境按寻达账号角色授权，普通媒介账号无法访问管理员接口。"
        : "当前为本地免登录管理员模式；团队部署后按账号角色授权。",
      dataScope: "只看行为漏斗、采集稳定性和聚合效率，不展示 Cookie、请求头、密码或完整登录态。",
    },
    windowDays: days,
    updatedAt: new Date().toISOString(),
    funnel: {
      searchSubmits,
      searchSuccesses,
      searchFailures,
      searchSuccessRate: percent(searchSuccesses, searchSubmits || searchSuccesses + searchFailures),
      resultCandidates,
      selectedCreators,
      unselectedCreators,
      netSelectedCreators: Math.max(selectedCreators - unselectedCreators, 0),
      importedCreators,
      collectJobs,
      collectStarts,
      collectDone,
      collectFailed,
      downloads,
      selectionRate: percent(selectedCreators, resultCandidates),
      importRate: percent(importedCreators, selectedCreators),
      downloadRate: percent(downloads, collectDone),
    },
    stability: {
      collectSuccessRate: percent(collectDone, collectDone + collectFailed),
      avgSearchMs: average(searchDurations),
      avgCollectMs: average(collectDurations),
      fieldMissing,
      loginExpired,
      apiTimeout,
      failedEvents: searchFailures + collectFailed + fieldMissing + loginExpired + apiTimeout,
    },
    agent: {
      clarificationRequested,
      clarificationResolved,
      clarificationResolutionRate: percent(clarificationResolved, clarificationRequested),
      taskConfirmed,
      scopeGroupCompleted,
      validationFailed,
      modelCallCompleted,
      modelCallFailed,
      modelSuccessRate: percent(modelCallCompleted, modelCallCompleted + modelCallFailed),
      providers: topList(
        events.filter((event) => ["model_call_completed", "model_call_failed"].includes(event.event_name)),
        (event) => eventProperties(event).provider,
        (items) => ({
          completed: items.filter((event) => event.event_name === "model_call_completed").length,
          failed: items.filter((event) => event.event_name === "model_call_failed").length,
        }),
      ),
    },
    topKeywords: topList(
      events.filter((event) => event.event_name === "finder_search_submit" || event.event_name === "finder_search_success"),
      (event) => eventProperties(event).keyword,
      (items) => ({
        searches: items.filter((event) => event.event_name === "finder_search_submit").length,
        successes: items.filter((event) => event.event_name === "finder_search_success").length,
        returned: items.reduce((sum, event) => sum + Number(eventProperties(event).returned || 0), 0),
      }),
    ),
    topCategories: topList(
      events.filter((event) => event.event_name === "finder_search_submit"),
      (event) => eventProperties(event).category,
    ),
    topFanRanges: topList(
      events.filter((event) => event.event_name === "finder_search_submit"),
      (event) => eventProperties(event).fanRange,
    ),
    recentEvents: events.slice(0, 20).map((event) => ({
      eventName: event.event_name,
      page: event.page || "",
      jobId: event.job_id || "",
      properties: eventProperties(event),
      createdAt: event.created_at,
    })),
  };
}

function candidatePoolId(ownerUserId) {
  return `user-${String(ownerUserId || LOCAL_USER.id).replace(/[^\w-]/g, "")}`;
}

async function saveCandidatePool({
  ownerUserId,
  name = "当前候选池",
  filters = {},
  candidates = [],
} = {}) {
  if (!db) throw new Error("数据库未初始化");
  const poolId = candidatePoolId(ownerUserId);
  const now = new Date().toISOString();
  const existing = await dbGet(
    "SELECT created_at FROM candidate_pools WHERE id = ?",
    [poolId],
    "SELECT created_at FROM candidate_pools WHERE id = $1",
    [poolId],
  );
  const params = [
    poolId,
    name || "当前候选池",
    JSON.stringify(filters || {}),
    JSON.stringify(Array.isArray(candidates) ? candidates : []),
    existing?.created_at || now,
    now,
  ];
  await dbRun(`
    INSERT OR REPLACE INTO candidate_pools (
      id, name, filters_json, candidates_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
  params,
  `
    INSERT INTO candidate_pools (
      id, name, filters_json, candidates_json, created_at, updated_at
    ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      filters_json = EXCLUDED.filters_json,
      candidates_json = EXCLUDED.candidates_json,
      updated_at = EXCLUDED.updated_at
  `,
  params,
  );
  return await readCurrentCandidatePool(ownerUserId);
}

async function readCurrentCandidatePool(ownerUserId) {
  if (!db) throw new Error("数据库未初始化");
  const poolId = candidatePoolId(ownerUserId);
  return await dbGet(
    "SELECT * FROM candidate_pools WHERE id = ?",
    [poolId],
    "SELECT * FROM candidate_pools WHERE id = $1",
    [poolId],
  );
}

async function clearCurrentCandidatePool(ownerUserId) {
  if (!db) throw new Error("数据库未初始化");
  const poolId = candidatePoolId(ownerUserId);
  await dbRun(
    "DELETE FROM candidate_pools WHERE id = ?",
    [poolId],
    "DELETE FROM candidate_pools WHERE id = $1",
    [poolId],
  );
}

async function listCollectionTemplates() {
  const rows = await dbAll(
    "SELECT * FROM collection_templates ORDER BY updated_at DESC",
    [],
    "SELECT * FROM collection_templates ORDER BY updated_at DESC",
    [],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseTemplateId: normalizeTemplateId(row.base_template_id || "dynamic"),
    definition: parseJsonValue(row.definition_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function saveCollectionTemplate(body = {}) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("模板名称不能为空");
  const id = String(body.id || `template-${nowStamp()}`).replace(/[^\w-]/g, "-");
  const now = new Date().toISOString();
  const existing = await dbGet(
    "SELECT created_at FROM collection_templates WHERE id = ?",
    [id],
    "SELECT created_at FROM collection_templates WHERE id = $1",
    [id],
  );
  const definition = {
    fieldIds: normalizeSelectedFields(body.fieldIds || body.definition?.fieldIds),
    columnMappings: body.columnMappings || body.definition?.columnMappings || [],
    formulas: body.formulas || body.definition?.formulas || [],
    llmFields: body.llmFields || body.definition?.llmFields || [],
    scopeGroups: body.scopeGroups || body.definition?.scopeGroups || [],
    sourceJobId: String(body.sourceJobId || body.definition?.sourceJobId || ""),
    version: Number(body.version || body.definition?.version || 1),
  };
  const params = [
    id,
    name,
    normalizeTemplateId(body.baseTemplateId || "dynamic"),
    JSON.stringify(definition),
    existing?.created_at || now,
    now,
  ];
  await dbRun(
    `INSERT OR REPLACE INTO collection_templates
      (id, name, base_template_id, definition_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    params,
    `INSERT INTO collection_templates
      (id, name, base_template_id, definition_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        base_template_id = EXCLUDED.base_template_id,
        definition_json = EXCLUDED.definition_json,
        updated_at = EXCLUDED.updated_at`,
    params,
  );
  return (await listCollectionTemplates()).find((item) => item.id === id);
}

function createJob(inputPath, originalName, selectedFields = [], templateId = "fuji", ownerUserId = "") {
  const id = nowStamp();
  const runDir = path.join(RUNS_DIR, id);
  const job = {
    id,
    status: "uploaded",
    originalName,
    inputPath,
    runDir,
    creatorsPath: path.join(runDir, "creators.json"),
    resultsPath: path.join(runDir, "results.json"),
    taskPath: path.join(runDir, "task.json"),
    outputPath: path.join(runDir, "output.xlsx"),
    sourceType: "excel",
    templateId: normalizeTemplateId(templateId),
    ownerUserId,
    progress: { done: 0, total: 0 },
    logs: [],
    selectedFields,
    taskState: normalizeTemplateId(templateId) === "dynamic" ? "PARSING" : "CONFIRMED",
    lifecycleState: normalizeTemplateId(templateId) === "dynamic" ? "PARSING" : "CONFIRMED",
    createdAt: new Date().toISOString(),
  };
  job.expiresAt = expiresAtForJob(job.createdAt, TASK_RETENTION_DAYS);
  jobs.set(id, job);
  persistJobSoon(job);
  return job;
}

function createFinderJob(originalName = "找达人候选池", selectedFields = [], ownerUserId = "") {
  const id = nowStamp();
  const runDir = path.join(RUNS_DIR, id);
  const job = {
    id,
    status: "uploaded",
    originalName,
    inputPath: "",
    runDir,
    creatorsPath: path.join(runDir, "creators.json"),
    resultsPath: path.join(runDir, "results.json"),
    outputPath: path.join(runDir, "output.xlsx"),
    sourceType: "finder",
    templateId: "fuji",
    ownerUserId,
    progress: { done: 0, total: 0 },
    logs: [],
    selectedFields,
    taskState: "CONFIRMED",
    lifecycleState: "CONFIRMED",
    createdAt: new Date().toISOString(),
  };
  job.expiresAt = expiresAtForJob(job.createdAt, TASK_RETENTION_DAYS);
  jobs.set(id, job);
  persistJobSoon(job);
  return job;
}

function pushLog(job, message, metadata = {}) {
  job.logs.push({ ts: new Date().toISOString(), message, ...metadata });
  if (job.logs.length > 300) job.logs = job.logs.slice(-300);
  return persistJob(job);
}

function appendRuntimeLog(job, message, metadata = {}) {
  job.logs.push({ ts: new Date().toISOString(), message, ...metadata });
  if (job.logs.length > 300) job.logs = job.logs.slice(-300);
  persistJobSoon(job);
}

function scopeProgressLabel(group = {}) {
  const scene = group.scene === "cooperation"
    ? "合作笔记"
    : group.scene === "daily"
      ? "日常笔记"
      : group.window === "recent16"
        ? "笔记列表"
        : "笔记数据";
  const contentType = group.contentType === "image"
    ? "图文"
    : group.contentType === "video"
      ? "视频"
      : "图文+视频";
  const window = group.window === "30d"
    ? "近30日"
    : group.window === "90d"
      ? "近90日"
      : group.window === "recent16"
        ? "近16篇"
        : "";
  const traffic = group.traffic === "natural"
    ? "仅自然流量"
    : group.traffic === "all"
      ? "全流量"
      : "";
  return [scene, contentType, window, traffic].filter(Boolean).join(" · ");
}

function logScopeProgress(job, event) {
  const creator = creatorProgressName(event.creator)
    || event.creatorId
    || "当前达人";
  const scope = scopeProgressLabel(event.group);
  const metadata = {
    stage: event.type === "scope_retry" ? "recovery" : "scope",
    type: event.type,
    creatorId: event.creatorId || "",
    groupId: event.groupId || "",
    transport: event.transport || "",
    status: event.status || event.directStatus || 0,
  };
  if (event.type === "scope_started") {
    appendRuntimeLog(job, `正在读取 ${creator} 的${scope}。`, metadata);
  } else if (event.type === "scope_retry") {
    appendRuntimeLog(
      job,
      `直接取数${event.directStatus ? `返回 HTTP ${event.directStatus}` : "受阻"}，已仅对本任务切换蒲公英原生页面交互；共享采集逻辑和其他任务不受影响。`,
      { ...metadata, level: "warning" },
    );
  } else if (event.type === "scope_resumed") {
    appendRuntimeLog(job, `${creator} 的${scope}已从检查点恢复，无需重复采集。`, metadata);
  } else if (event.type === "scope_completed") {
    const transport = event.transport === "native-ui" ? "原生页面交互" : "蒲公英接口";
    appendRuntimeLog(job, `${creator} 的${scope}已通过${transport}完成。`, metadata);
  } else if (event.type === "scope_failed") {
    appendRuntimeLog(
      job,
      `${creator} 的${scope}仍未完成：${event.error || `HTTP ${event.status || 0}`}。已保留其他已完成口径。`,
      { ...metadata, level: "error" },
    );
  }
}

function creatorProgressName(creator = {}, result = null) {
  const currentValueName = Object.values(creator.currentValues || {})
    .map((value) => String(value || "").trim())
    .find((value) => value && !/^https?:\/\//i.test(value));
  return String(
    result?.fields?.["达人名称"]
    || result?.nickname
    || creator.nickname
    || creator.redId
    || currentValueName
    || "",
  ).trim();
}

async function ensureContext(user = LOCAL_USER) {
  const ownerId = user?.id || LOCAL_USER.id;
  if (sharedContexts.has(ownerId)) return sharedContexts.get(ownerId);
  if (!AUTH_REQUIRED && PGY_STORAGE_STATE_PATH && await fileExists(PGY_STORAGE_STATE_PATH)) {
    return registerSharedContext(
      ownerId,
      await createBackgroundCollectContext(PGY_STORAGE_STATE_PATH, CONFIG),
    );
  }
  const effective = await effectivePgyConnection(user);
  const saved = effective.row;
  const connectionOwner = effective.source === "workspace"
    ? { type: "workspace", id: effective.workspaceId }
    : { type: "user", id: ownerId };
  const reconnectMessage = effective.source === "workspace"
    ? "团队共享蒲公英连接已失效，请联系管理员重新共享"
    : "蒲公英连接无法恢复，请在个人中心重新连接";
  if (saved?.status === "connected" || saved?.status === "expired") {
    if (!PGY_CONNECTION_ENCRYPTION_KEY || !saved.encrypted_state_path) {
      await markConnectionExpired(
        connectionOwner.type,
        connectionOwner.id,
        "服务端缺少可恢复的加密登录态",
        ownerId,
      );
      throw pgyConnectionError(reconnectMessage);
    }
    let context = null;
    try {
      const storageState = await loadEncryptedStorageState(
        saved.encrypted_state_path,
        PGY_CONNECTION_ENCRYPTION_KEY,
      );
      context = await createBackgroundCollectContext(storageState, CONFIG);
      const probe = await verifyPgyLoginState(context, CONFIG);
      if (!probe.authenticated) {
        await context.close().catch(() => {});
        await markConnectionExpired(connectionOwner.type, connectionOwner.id, probe.reason, ownerId);
        throw pgyConnectionError(
          effective.source === "workspace"
            ? `${probe.reason}，请联系管理员重新共享蒲公英`
            : `${probe.reason}，请在个人中心重新连接蒲公英`,
        );
      }
      const now = new Date().toISOString();
      await dbRun(
        `UPDATE pgy_connections SET status = 'connected', last_verified_at = ?, updated_at = ?
         WHERE id = ?`,
        [now, now, saved.id],
        `UPDATE pgy_connections SET status = 'connected', last_verified_at = $1, updated_at = $2
         WHERE id = $3`,
        [now, now, saved.id],
      );
      return registerSharedContext(ownerId, context, connectionOwner);
    } catch (error) {
      if (context) await context.close().catch(() => {});
      if (error?.code === "PGY_CONNECTION_EXPIRED") throw error;
      await markConnectionExpired(
        connectionOwner.type,
        connectionOwner.id,
        error.message || "加密登录态恢复失败",
        ownerId,
      );
      throw pgyConnectionError(reconnectMessage);
    }
  }
  if (AUTH_REQUIRED) {
    trackEventSoon({
      eventName: "pgy_connection_required",
      userId: ownerId,
      page: "collector",
      properties: { reason: "no_saved_connection" },
    });
    throw pgyConnectionError(
      "尚未连接蒲公英，请先在个人中心完成首次连接",
      "PGY_CONNECTION_REQUIRED",
    );
  }
  return await openInteractivePgyContext(user);
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  const { files, fields } = parseMultipart(body, req.headers["content-type"]);
  const file = files.find((item) => item.name === "file") || files[0];
  if (!file) return json(res, 400, { error: "未找到上传文件" });
  if (!/\.(xlsx|xlsm)$/i.test(file.filename)) return json(res, 400, { error: "请上传 .xlsx 或 .xlsm 文件" });

  const tempDir = path.join(RUNS_DIR, "uploads");
  await fs.mkdir(tempDir, { recursive: true });
  const inputPath = path.join(tempDir, `${nowStamp()}_${file.filename.replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_")}`);
  await fs.writeFile(inputPath, file.buffer);
  const templateId = normalizeTemplateId(fields.templateId);
  const profile = templateProfile(templateId);
  const selectedFields = normalizeSelectedFields(fields.selectedFields);
  const externalLinks = pgyLinksFromText(fields.message || "");
  const job = createJob(inputPath, file.filename, selectedFields, templateId, req.currentUser.id);
  try {
    await fs.mkdir(job.runDir, { recursive: true });
    if (templateId === "dynamic" && externalLinks.length) {
      await attachLinksToWorkbook(job.inputPath, externalLinks);
      await pushLog(job, `已把对话中的 ${externalLinks.length} 个蒲公英链接写入字段模板`);
    }

    const result = templateId === "medela"
      ? await runNode([
        "src/medela_workbook.mjs",
        "extract",
        "--input",
        job.inputPath,
        "--creators",
        job.creatorsPath,
      ])
    : templateId === "dynamic"
      ? await runNode([
          "src/dynamic_workbook.mjs",
          "extract",
          "--input",
          job.inputPath,
          "--task",
          job.taskPath,
          "--creators",
          job.creatorsPath,
        ])
        : await runPython([
        "src/prototype_excel.py",
        "extract",
        "--input",
        job.inputPath,
        "--creators",
        job.creatorsPath,
        ]);
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    const creators = await readJson(job.creatorsPath);
    if (templateId === "dynamic") {
      job.taskSpec = await readJson(job.taskPath);
      if (selectedFields.length) {
        job.taskSpec = filterDynamicTaskBySelection(job.taskSpec, selectedFields);
      }
      const uploadDefaults = validatedContractDefaults(
        contractDefaultsFromMessage({ message: fields.message || "" }),
      );
      const reconciled = await reconcileDynamicTaskFields(job.taskSpec, uploadDefaults, {
        useModel: true,
      });
      job.taskSpec = reconciled.taskSpec;
      for (const warning of reconciled.warnings) {
        await pushLog(job, `字段“${warning.label || warning.columnKey}”的模型候选未采用：${warning.error}`, {
          stage: "parsing",
          level: "warning",
          code: "FIELD_CANDIDATE_SKIPPED",
        });
      }
      await writeJson(job.taskPath, job.taskSpec);
      job.selectedFields = [...new Set((job.taskSpec.columns || [])
        .map((column) => column.mapping?.name)
        .filter(Boolean))];
      moveJobState(
        job,
        job.taskSpec.taskContract?.unresolvedCount > 0 ? "NEEDS_CLARIFICATION" : "READY_TO_CONFIRM",
        job.taskSpec.taskContract?.unresolvedCount > 0
          ? "clarification.requested"
          : "task.ready_to_confirm",
      );
      job.taskState = taskStateFor(job);
    }
    job.creators = creators;
    job.progress = { done: 0, total: creators.length };
    await pushLog(job, `已按${profile.label}识别 ${creators.length} 个达人主页链接`);
    if (selectedFields.length) await pushLog(job, `采集字段：${selectedFields.join("、")}`);
    trackEventSoon({
      eventName: "excel_upload_success",
      jobId: job.id,
      entityType: "job",
      entityId: job.id,
      page: "collector",
      properties: {
        count: creators.length,
        fieldCount: selectedFields.length,
        externalLinkCount: externalLinks.length,
        originalName: file.filename,
        templateId,
      },
    });
    if (job.taskSpec?.taskContract?.unresolvedCount > 0) {
      trackEventSoon({
        eventName: "clarification_requested",
        userId: req.currentUser.id,
        jobId: job.id,
        page: "workbench",
        properties: { unresolvedCount: job.taskSpec.taskContract.unresolvedCount },
      });
    }
    return json(res, 200, { jobId: job.id, count: creators.length, creators, parsed, job: publicJob(job) });
  } catch (error) {
    jobs.delete(job.id);
    await deleteExpiredArtifacts(job, { allowedRoots: [RUNS_DIR, DATA_DIR] }).catch(() => {});
    await dbRun(
      "DELETE FROM jobs WHERE id = ?",
      [job.id],
      "DELETE FROM jobs WHERE id = $1",
      [job.id],
    ).catch(() => {});
    trackEventSoon({
      eventName: "excel_upload_failed",
      userId: req.currentUser.id,
      jobId: job.id,
      page: "workbench",
      properties: { originalName: file.filename, templateId, error: error.message },
    });
    throw error;
  }
}

const CONTRACT_DEFAULTS = Object.freeze({
  sceneDefault: new Set(["cooperation", "daily"]),
  contentTypeDefault: new Set(["all", "video", "image"]),
  windowDefault: new Set(["90d", "30d"]),
  naturalWindowDefault: new Set(["90d", "30d"]),
  trafficDefault: new Set(["all", "natural"]),
  viewDefault: new Set(["scale", "cost"]),
});

async function reconcileDynamicTaskFields(taskSpec, defaults = {}, { useModel = false } = {}) {
  const resolution = resolveWorkbookColumns(taskSpec.columns || [], defaults);
  const assisted = await resolveColumnsWithFieldLibrary(resolution.columns, {
    defaults,
    apiKey: useModel ? process.env.QWEN_API_KEY || "" : "",
  });
  const originalUnmatched = new Map(
    (taskSpec.unmatchedColumns || []).map((column) => [column.key, column]),
  );
  const columns = assisted.columns;
  const unmatchedColumns = columns
    .filter((column) => column.displayLabel && !column.mapping)
    .map((column) => ({
      ...(originalUnmatched.get(column.key) || column),
      ...column,
    }));
  const taskContract = createTaskContract({
    columns,
    creators: taskSpec.creators || [],
    source: taskSpec.taskContract?.source || {
      type: "excel",
      sheetName: taskSpec.sheetName,
      headerDepth: taskSpec.headerDepth,
    },
    version: Number(taskSpec.taskContract?.version || 1),
  });
  return {
    taskSpec: {
      ...taskSpec,
      resolutionVersion: 3,
      contractDefaults: {
        ...(taskSpec.contractDefaults || {}),
        ...defaults,
      },
      columns,
      pgyFieldIds: [...new Set(columns
        .filter((column) => column.mapping?.source === "pgy")
        .map((column) => column.mapping.id))],
      unmatchedColumns,
      taskContract,
      scopeGroups: taskContract.scopeGroups,
      unresolved: taskContract.unresolved,
      unresolvedCount: taskContract.unresolvedCount,
      executable: false,
      fieldResolutionWarnings: assisted.warnings,
    },
    warnings: assisted.warnings,
  };
}

function validatedContractDefaults(input = {}) {
  const result = {};
  for (const [key, allowed] of Object.entries(CONTRACT_DEFAULTS)) {
    if (input[key] === undefined || input[key] === "") continue;
    if (!allowed.has(input[key])) throw new Error(`不支持的任务默认口径：${key}=${input[key]}`);
    result[key] = input[key];
  }
  return result;
}

async function handleResolveTaskContract(req, res, job, providedBody = null) {
  if (job.templateId !== "dynamic" || !job.taskSpec) {
    return json(res, 409, { error: "当前任务不是智能 Excel 任务" });
  }
  const body = providedBody || await readJsonBody(req);
  const defaults = {
    ...validatedContractDefaults(job.taskSpec.contractDefaults || {}),
    ...validatedContractDefaults(body.defaults || {}),
  };
  moveJobState(job, "PARSING", "task.scope_changed");
  const nextVersion = Number(job.taskSpec.taskContract?.version || 1) + 1;
  const reconciled = await reconcileDynamicTaskFields({
    ...job.taskSpec,
    taskContract: {
      ...(job.taskSpec.taskContract || {}),
      version: nextVersion,
    },
  }, defaults, { useModel: true });
  job.taskSpec = reconciled.taskSpec;
  const taskContract = job.taskSpec.taskContract;
  moveJobState(
    job,
    taskContract.unresolvedCount > 0 ? "NEEDS_CLARIFICATION" : "READY_TO_CONFIRM",
    taskContract.unresolvedCount > 0 ? "clarification.requested" : "task.ready_to_confirm",
  );
  job.taskState = taskStateFor(job);
  if (taskContract.unresolvedCount > 0) {
    trackEventSoon({
      eventName: "clarification_requested",
      userId: req.currentUser.id,
      jobId: job.id,
      page: "workbench",
      properties: { unresolvedCount: taskContract.unresolvedCount },
    });
  }
  await writeJson(job.taskPath, job.taskSpec);
  await pushLog(
    job,
    taskContract.unresolvedCount
      ? `已应用口径确认，仍有 ${taskContract.unresolvedCount} 个字段需要澄清`
      : "字段口径已完整解析，等待最终确认",
  );
  return json(res, 200, { job: publicJob(job) });
}

async function handleConfirmTaskContract(_req, res, job) {
  if (job.templateId !== "dynamic" || !job.taskSpec?.taskContract) {
    return json(res, 409, { error: "当前任务没有可确认的字段合同" });
  }
  const contract = job.taskSpec.taskContract;
  if (Number(contract.unresolvedCount) > 0) {
    return json(res, 409, { error: `仍有 ${contract.unresolvedCount} 个字段口径需要澄清` });
  }
  try {
    assertTaskContractExecutable(contract);
  } catch (error) {
    return json(res, 409, {
      error: error.message,
      code: error.code || "FIELD_CONTRACT_NOT_EXECUTABLE",
      validation: error.validation || null,
    });
  }
  contract.confirmedVersion = contract.version;
  contract.confirmedAt = new Date().toISOString();
  job.confirmation = {
    contractVersion: contract.version,
    confirmedAt: contract.confirmedAt,
    confirmedBy: _req.currentUser?.id || "",
  };
  job.taskSpec.executable = true;
  moveJobState(job, "CONFIRMED", "task.confirmed");
  job.taskState = taskStateFor(job);
  await writeJson(job.taskPath, job.taskSpec);
  await pushLog(job, `已确认第 ${contract.version} 版字段合同`);
  return json(res, 200, { job: publicJob(job) });
}

async function handlePgyLogin(req, res) {
  const context = await openInteractivePgyContext(req.currentUser);
  const page = await openLoginPage(context, CONFIG);
  trackEventSoon({ eventName: "pgy_login_open", page: "global", properties: { url: page.url() } });
  json(res, 200, {
    ok: true,
    url: page.url(),
    previewUrl: "/api/pgy/connect/preview",
    message: "蒲公英连接页面已准备好，请在下方登录画面完成授权。",
  });
}

async function handlePgyLoginPreview(req, res) {
  const context = sharedContexts.get(req.currentUser.id);
  if (!context) return json(res, 409, { error: "请先点击连接或重新连接" });
  const page = context.pages()[0] || await openLoginPage(context, CONFIG);
  await page.waitForTimeout(500);
  const image = await page.screenshot({ type: "png", fullPage: false });
  res.writeHead(200, {
    ...CORS_HEADERS,
    "content-type": "image/png",
    "content-length": image.length,
    "cache-control": "no-store, max-age=0",
  });
  return res.end(image);
}

async function handlePgyLoginInput(req, res) {
  const context = sharedContexts.get(req.currentUser.id);
  if (!context) return json(res, 409, { error: "请先点击连接或重新连接" });
  const body = await readJsonBody(req, 64 * 1024);
  const xRatio = Number(body.xRatio);
  const yRatio = Number(body.yRatio);
  if (
    !Number.isFinite(xRatio)
    || !Number.isFinite(yRatio)
    || xRatio < 0
    || xRatio > 1
    || yRatio < 0
    || yRatio > 1
  ) {
    return json(res, 400, { error: "登录画面点击位置无效" });
  }
  const page = context.pages()[0] || await openLoginPage(context, CONFIG);
  const viewport = page.viewportSize();
  if (!viewport) return json(res, 409, { error: "登录画面尚未准备好" });
  await page.mouse.click(
    Math.max(1, Math.min(viewport.width - 1, xRatio * viewport.width)),
    Math.max(1, Math.min(viewport.height - 1, yRatio * viewport.height)),
  );
  await page.waitForTimeout(600);
  trackEventSoon({
    eventName: "pgy_login_interaction",
    userId: req.currentUser.id,
    page: "profile",
    properties: { inputType: "click" },
  });
  return json(res, 200, { ok: true });
}

async function handleStatus(req, res) {
  const ownerId = req.currentUser?.id || LOCAL_USER.id;
  const contextOpen = sharedContexts.has(ownerId);
  const effective = await effectivePgyConnection(req.currentUser || LOCAL_USER, { contextOpen });
  const savedConnection = effective.row;
  const connected = savedConnection?.status === "connected";
  json(res, 200, {
    ok: true,
    authRequired: AUTH_REQUIRED,
    user: publicUser(req.currentUser || LOCAL_USER),
    loginState: connected ? "connected" : contextOpen ? "pending" : "unknown",
    loginText: connected
      ? effective.source === "workspace"
        ? "团队蒲公英连接可用"
        : "蒲公英连接已加密保存"
      : contextOpen
        ? "蒲公英连接待确认"
        : savedConnection?.status === "expired"
          ? "蒲公英连接已失效，请重新连接"
          : "尚未打开蒲公英连接",
    serverTime: new Date().toISOString(),
  });
}

function jobErrorType(job) {
  const error = String(job?.error || "");
  if (/DeepSeek|模型|推荐理由|非蒲公英字段审计/.test(error)) return "MODEL_ENRICHMENT";
  if (/蒲公英连接|PGY_CONNECTION|登录态|重新连接/.test(error)) return "PGY_CONNECTION";
  if (/Excel|回填|导出|校验|workbook/i.test(error)) return "EXPORT";
  return "COLLECTION";
}

function postCollectionResumeAvailable(job) {
  const done = Number(job?.progress?.done || 0);
  const total = Number(job?.progress?.total || job?.creators?.length || 0);
  return job?.templateId === "dynamic"
    && total > 0
    && done >= total
    && Boolean(job?.runDir)
    && jobErrorType(job) !== "COLLECTION";
}

async function enrichAndExportJob({
  job,
  collectedResults,
  dynamicTask = null,
  userId = "",
  skipModel = false,
}) {
  moveJobState(job, "VALIDATING", "task.validation_started");
  await pushLog(job, "达人数据已采集完成，开始校验并补充非蒲公英字段", {
    stage: "validation",
    level: "info",
  });
  const modelWarnings = [];
  if (job.templateId === "dynamic" && dynamicTask) {
    const resolvedTask = discoverRuntimePgyColumns(dynamicTask, collectedResults);
    if (resolvedTask !== dynamicTask) {
      dynamicTask = resolvedTask;
      job.taskSpec = resolvedTask;
      await writeJson(job.taskPath, resolvedTask);
      await pushLog(
        job,
        `已从本次蒲公英返回值中确定性补充 ${resolvedTask.runtimeDiscoveredColumns?.length || 0} 个未登记字段映射`,
        { stage: "validation", level: "success", code: "RUNTIME_FIELD_DISCOVERY" },
      );
    }
  }
  const trackDeepSeekCall = (event) => {
    trackEventSoon({
      eventName: event.status === "succeeded" ? "model_call_completed" : "model_call_failed",
      userId,
      jobId: job.id,
      page: "collector",
      properties: {
        provider: "deepseek",
        purpose: job.templateId === "medela" ? "recommendation_reason" : "evidence_enrichment",
        model: event.model,
        durationMs: event.durationMs,
        ...(event.error ? { error: event.error } : {}),
      },
    });
  };

  let enrichedResults = collectedResults;
  if (skipModel) {
    modelWarnings.push({
      message: "已按用户选择跳过模型补充；非蒲公英字段保持空白，可在导出后人工填写",
    });
  } else if (job.templateId === "medela") {
    try {
      enrichedResults = await generateRecommendationReasons(collectedResults, {
        onCall: trackDeepSeekCall,
      });
      await pushLog(job, "DeepSeek 已生成并校验 80-120 字客观推荐理由", {
        stage: "model",
        level: "success",
      });
    } catch (error) {
      modelWarnings.push({
        message: `DeepSeek 推荐理由暂不可用，已改用确定性证据摘要；证据不足的单元格保持空白：${error.message}`,
      });
      enrichedResults = collectedResults.map((result, index) => {
        const recommendationReason = buildDeterministicRecommendation(result, {
          creator: job.creators?.[index] || result,
          sequence: index + 1,
        });
        return {
          ...result,
          recommendationReason,
          recommendationModel: recommendationReason ? "deterministic-evidence-v1" : "",
          llmWarning: error.message,
        };
      });
    }
  } else if (job.templateId === "dynamic") {
    enrichedResults = await enrichUnmatchedExcelFields(collectedResults, dynamicTask, {
      onCall: trackDeepSeekCall,
      failOpen: true,
      batchSize: 1,
      concurrency: 2,
      maxAttempts: 2,
      timeoutMs: 90000,
      onWarning: (warning) => modelWarnings.push(warning),
    });
    if (!modelWarnings.length) {
      await pushLog(job, "DeepSeek 已分批审计非蒲公英字段，证据不足项保持空白", {
        stage: "model",
        level: "success",
      });
    }
  }

  for (const warning of modelWarnings) {
    await pushLog(job, warning.message, {
      stage: "model",
      level: "warning",
      code: warning.code || "MODEL_ENRICHMENT_SKIPPED",
      rowIndexes: warning.rowIndexes || [],
    });
  }
  await writeJson(job.resultsPath, enrichedResults);

  await pushLog(job, job.inputPath ? "开始回填 Excel" : "开始导出 Excel", {
    stage: "export",
    level: "info",
  });
  moveJobState(job, "EXPORTING", "task.export_started");
  if (job.templateId === "medela") {
    if (!job.inputPath) throw new Error("美德乐模板需要上传原始项目执行表后回填");
    await runNode([
      "src/medela_workbook.mjs",
      "fill",
      "--input",
      job.inputPath,
      "--results",
      job.resultsPath,
      "--output",
      job.outputPath,
      "--preview",
      path.join(job.runDir, "output-preview.svg"),
      "--validation",
      path.join(job.runDir, "output-validation.json"),
    ]);
  } else if (job.templateId === "dynamic") {
    if (job.inputPath) {
      await runNode([
        "src/dynamic_workbook.mjs",
        "fill",
        "--input",
        job.inputPath,
        "--task",
        job.taskPath,
        "--results",
        job.resultsPath,
        "--output",
        job.outputPath,
        "--preview",
        path.join(job.runDir, "output-preview.svg"),
        "--validation",
        path.join(job.runDir, "output-validation.json"),
      ]);
    } else {
      await exportDynamicWorkbook({
        task: dynamicTask,
        results: enrichedResults,
        outputPath: job.outputPath,
        previewPath: path.join(job.runDir, "output-preview.svg"),
        validationPath: path.join(job.runDir, "output-validation.json"),
      });
    }
  } else {
    const excelArgs = job.inputPath
      ? [
          "src/prototype_excel.py",
          "fill",
          "--input",
          job.inputPath,
          "--results",
          job.resultsPath,
          "--output",
          job.outputPath,
          ...(job.selectedFields?.length ? ["--fields", JSON.stringify(job.selectedFields)] : []),
        ]
      : [
          "src/prototype_excel.py",
          "export",
          "--results",
          job.resultsPath,
          "--output",
          job.outputPath,
          ...(job.selectedFields?.length ? ["--fields", JSON.stringify(job.selectedFields)] : []),
        ];
    await runPython(excelArgs);
  }

  job.status = "done";
  moveJobState(job, "COMPLETED", "task.completed");
  job.finishedAt = new Date().toISOString();
  job.error = "";
  await pushLog(job, modelWarnings.length
    ? "Excel 已生成；部分模型字段因服务不可用保持空白"
    : "Excel 已生成", {
    stage: "result",
    level: modelWarnings.length ? "warning" : "success",
  });
  return { enrichedResults, modelWarnings };
}

function userFacingExecutionError(error) {
  const message = String(error?.message || error || "任务执行失败");
  if (/Executable doesn't exist|playwright install/i.test(message)) {
    return "采集浏览器运行环境不可用，任务尚未发起取数；请管理员恢复浏览器运行时后继续失败部分";
  }
  if (/Target page, context or browser has been closed/i.test(message)) {
    return "本任务的采集页面意外关闭，已保存完成部分；继续失败部分即可重新建立页面";
  }
  if (/Timeout|timeout/i.test(message) && message.length > 220) {
    return "蒲公英页面在等待时间内没有完成响应；已保存完成部分，继续失败部分时会重新尝试";
  }
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

async function failRunningJob(job, error) {
  const message = userFacingExecutionError(error);
  job.status = "failed";
  try {
    moveJobState(job, "FAILED", "task.failed");
  } catch {
    job.lifecycleState = "FAILED";
  }
  job.error = message;
  await pushLog(job, `失败：${message}`, {
    stage: jobErrorType({ error: message }).toLowerCase(),
    level: "error",
  });
}

async function handleCollect(req, res, providedBody = null) {
  const body = providedBody || await readJsonBody(req);
  const job = jobs.get(body.jobId);
  if (!requireJobAccess(res, job, req.currentUser)) return;
  if (jobExpired(job)) return json(res, 410, { error: "任务已超过 7 天保存期" });
  if (job.status === "running") {
    return json(res, 200, { ok: true, jobId: job.id, alreadyRunning: true, job: publicJob(job) });
  }
  job.taskState = taskStateFor(job);
  const taskContractConfirmed = job.templateId !== "dynamic"
    || Number(job.taskSpec?.taskContract?.confirmedVersion || 0)
      === Number(job.taskSpec?.taskContract?.version || -1);
  if (!taskContractConfirmed) {
    return json(res, 409, {
      error: job.taskState === "NEEDS_CLARIFICATION"
        ? "字段口径尚有歧义，请先完成澄清"
        : "请先确认字段合同，再开始采集",
    });
  }
  if (job.templateId === "dynamic") {
    try {
      assertTaskContractExecutable(job.taskSpec?.taskContract || {});
    } catch (error) {
      return json(res, 409, {
        error: error.message,
        code: error.code || "FIELD_CONTRACT_NOT_EXECUTABLE",
        validation: error.validation || null,
      });
    }
  }

  const selectedFields = normalizeSelectedFields(body.selectedFields);
  if (selectedFields.length) {
    const before = JSON.stringify(job.selectedFields || []);
    job.selectedFields = selectedFields;
    if (JSON.stringify(job.selectedFields) !== before) {
      await pushLog(job, `采集字段已确认：${selectedFields.join("、")}`);
    } else {
      await persistJob(job);
    }
  }
  moveJobState(job, "COLLECTING", "task.collection_started");
  job.status = "running";
  job.error = "";
  job.startedAt = new Date().toISOString();
  await pushLog(job, "开始采集");
  trackEventSoon({
    eventName: "collect_start",
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    page: "collector",
    properties: { total: job.progress?.total || job.creators?.length || 0, sourceType: job.sourceType, fieldCount: job.selectedFields?.length || 0 },
  });
  json(res, 202, { ok: true, jobId: job.id });

  queueMicrotask(async () => {
    let collectContext = null;
    try {
      const loginContext = await ensureContext(req.currentUser);
      const creators = job.creators || await readJson(job.creatorsPath);
      job.progress = { done: 0, total: creators.length };
      const storageState = await loginContext.storageState();
      await pushLog(job, "已同步登录态，后台采集开始。可见登录窗口不会再跳转。");
      collectContext = await createBackgroundCollectContext(storageState, CONFIG);
      const dynamicTask = job.templateId === "dynamic"
        ? job.taskSpec || await readJson(job.taskPath)
        : null;
      const dynamicFieldIds = dynamicTask
        ? dynamicTask.pgyFieldIds.filter((id) => (
            !job.selectedFields?.length || job.selectedFields.includes(fieldById(id)?.name)
          ))
        : [];
      const dynamicRequiredFields = dynamicFieldIds.map((id) => fieldById(id)?.name).filter(Boolean);
      const noteContentTypes = new Set((dynamicTask?.taskContract?.scopeGroups || [])
        .filter((group) => group.scene === "cooperation")
        .map((group) => group.contentType));
      const dynamicNoteScope = noteContentTypes.size === 1 && noteContentTypes.has("all")
        ? "mixed"
        : "video";
      const results = await collectCreators({
        context: collectContext,
        creators,
        runDir: job.runDir,
        config: {
          ...CONFIG,
          collectionTemplate: job.templateId,
          onScopeProgress: (event) => logScopeProgress(job, event),
          ...(dynamicTask ? {
            fieldIds: dynamicFieldIds,
            requiredFieldNames: dynamicRequiredFields,
            noteScope: dynamicNoteScope,
            taskContract: dynamicTask.taskContract,
            jobId: job.id,
          } : {}),
        },
        onProgress: (event) => {
          const position = Number(event.status === "running" ? event.index + 1 : event.index);
          const total = Number(event.total || creators.length);
          const creatorName = creatorProgressName(event.creator, event.result)
            || `达人 ${position}`;
          if (event.status === "running") {
            pushLog(job, `第 ${position}/${total} 位 · ${creatorName}：开始采集`, {
              stage: "collection",
              type: "creator_started",
              creatorIndex: position,
              creatorTotal: total,
              creatorName,
            });
          } else {
            job.progress.done = event.index;
            const succeeded = !["failed", "失败"].includes(event.result?.dataStatus);
            pushLog(
              job,
              `第 ${position}/${total} 位 · ${creatorName}：${succeeded ? "采集成功" : "采集失败"}`,
              {
                stage: "collection",
                type: succeeded ? "creator_completed" : "creator_failed",
                level: succeeded ? "success" : "error",
                creatorIndex: position,
                creatorTotal: total,
                creatorName,
                dataStatus: event.result?.dataStatus || "",
              },
            );
            if (["failed", "失败"].includes(event.result?.dataStatus)) {
              trackEventSoon({
                eventName: "collect_creator_failed",
                jobId: job.id,
                entityType: "creator",
                entityId: event.creator.creatorId || event.creator.redId || "",
                page: "collector",
                properties: { index: event.index, reason: event.result?.error || event.result?.dataStatus || "failed" },
              });
            } else {
              trackEventSoon({
                eventName: "collect_creator_done",
                jobId: job.id,
                entityType: "creator",
                entityId: event.creator.creatorId || event.creator.redId || "",
                page: "collector",
                properties: { index: event.index, dataStatus: event.result?.dataStatus || "" },
              });
              for (const request of event.result?.metricScope?.requests || []) {
                if (!request.ok) continue;
                trackEventSoon({
                  eventName: "scope_group_completed",
                  jobId: job.id,
                  entityType: "creator",
                  entityId: event.creator.creatorId || event.creator.redId || "",
                  page: "collector",
                  properties: { resumed: Boolean(request.resumed), status: request.status || 200 },
                });
              }
              if (event.result?.missingFields?.length) {
                trackEventSoon({
                  eventName: "field_missing",
                  jobId: job.id,
                  entityType: "creator",
                  entityId: event.creator.creatorId || event.creator.redId || "",
                  page: "collector",
                  properties: { count: event.result.missingFields.length },
                });
              }
            }
          }
        },
      });
      await writeJson(path.join(job.runDir, "collected-results.json"), results);
      const failedScopes = results.flatMap((result) => (
        (result.metricScope?.requests || [])
          .filter((request) => request.ok === false)
          .map((request) => ({
            creator: result.nickname || result.creatorId || result.pgyLink,
            scope: request.id,
            error: request.error || `HTTP ${request.status || 0}`,
          }))
      ));
      if (failedScopes.length) {
        const preview = failedScopes
          .slice(0, 3)
          .map((item) => `${item.creator}：${item.error}`)
          .join("；");
        throw new Error(
          `有 ${failedScopes.length} 个取数口径未完成（${preview}）。已完成口径已保存，点击继续执行时只重试失败部分。`,
        );
      }
      await enrichAndExportJob({
        job,
        collectedResults: results,
        dynamicTask,
        userId: req.currentUser.id,
      });
      trackEventSoon({
        eventName: "collect_job_done",
        jobId: job.id,
        entityType: "job",
        entityId: job.id,
        page: "collector",
        properties: {
          total: creators.length,
          sourceType: job.sourceType,
          templateId: job.templateId,
          durationMs: job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0,
        },
      });
    } catch (error) {
      const failedState = taskStateFor(job);
      const connectionProblem = ["PGY_CONNECTION_EXPIRED", "PGY_CONNECTION_REQUIRED"].includes(error?.code);
      if (connectionProblem) {
        job.status = "failed";
        try {
          moveJobState(job, "NEEDS_ATTENTION", "task.pgy_connection_required");
        } catch {
          job.lifecycleState = "NEEDS_ATTENTION";
        }
        job.error = error.message;
        await pushLog(job, `需要处理：${error.message}`, {
          stage: "collection",
          level: "error",
          code: error.code,
        });
      } else {
        await failRunningJob(job, error);
      }
      trackEventSoon({
        eventName: connectionProblem
          ? "collect_job_attention"
          : ["VALIDATING", "EXPORTING"].includes(failedState)
            ? "validation_failed"
          : error.message?.includes("timeout") || error.message?.includes("Timeout")
            ? "pgy_api_timeout"
            : "collect_job_failed",
        jobId: job.id,
        entityType: "job",
        entityId: job.id,
        page: "collector",
        properties: {
          error: error.message,
          sourceType: job.sourceType,
          durationMs: job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0,
        },
      });
    } finally {
      if (collectContext) await collectContext.close().catch(() => {});
    }
  });
}

function pgyLinksFromText(text) {
  return [...new Set(
    String(text || "").match(/https?:\/\/[^\s，。；;]+/g) || [],
  )].filter((value) => {
    try {
      const url = new URL(value);
      return url.hostname === "pgy.xiaohongshu.com"
        && /\/blogger-detail\/[^/?#]+/.test(url.pathname);
    } catch {
      return false;
    }
  });
}

function fieldItemsFromSelection(selection = []) {
  const resolved = new Map();
  const visit = (item) => {
    if (!item || resolved.has(item.id)) return;
    for (const dependencyId of item.dependencies || []) visit(fieldById(dependencyId));
    resolved.set(item.id, item);
  };
  for (const value of normalizeSelectedFields(selection)) {
    visit(fieldById(value) || matchFieldLabel(value));
  }
  return [...resolved.values()];
}

function fieldNamesMentionedInText(text) {
  let remaining = String(text || "").replace(/https?:\/\/[^\s，。；;]+/g, " ");
  const selected = [];
  const registry = publicFieldRegistry();
  const nameFrequency = registry.reduce((counts, field) => {
    counts.set(field.name, (counts.get(field.name) || 0) + 1);
    return counts;
  }, new Map());
  const candidates = registry
    .flatMap((field) => [
      { field, label: field.semanticName },
      { field, label: field.internalName },
      ...((nameFrequency.get(field.name) || 0) === 1 ? [{ field, label: field.name }] : []),
    ])
    .filter((item, index, items) => (
      item.label
      && items.findIndex((candidate) => candidate.field.id === item.field.id && candidate.label === item.label) === index
    ))
    .sort((a, b) => b.label.length - a.label.length);
  for (const { field, label } of candidates) {
    if (!remaining.toLowerCase().includes(label.toLowerCase())) continue;
    selected.push(field.id);
    remaining = remaining.replaceAll(label, " ");
  }
  return [...new Set(selected)];
}

function spreadsheetColumnLetter(index) {
  let current = Number(index) + 1;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function ambiguousLinkTaskFromMessage(message, creators) {
  const text = String(message || "").replace(/https?:\/\/[^\s，。；;]+/g, " ").trim();
  const definitions = [
    { metric: "exposure", pattern: /曝光/, label: /曝光[^，,、；;\n]{0,12}中位/.test(text) ? "曝光中位数" : "曝光量" },
    { metric: "read", pattern: /阅读/, label: /阅读[^，,、；;\n]{0,12}中位/.test(text) ? "阅读中位数" : "阅读量" },
    { metric: "like", pattern: /点赞|赞量/, label: /(?:点赞|赞量)[^，,、；;\n]{0,12}中位|中位点赞/.test(text) ? "点赞中位数" : "点赞量" },
    { metric: "collect", pattern: /收藏/, label: /收藏[^，,、；;\n]{0,12}中位|中位收藏/.test(text) ? "收藏中位数" : "收藏量" },
  ].filter((item) => item.pattern.test(text));
  if (!definitions.length) return null;
  const conflictingScope = [
    /合作/.test(text) && /日常|非合作/.test(text),
    /(?:30\s*(?:天|日)|近一个月)/.test(text) && /(?:90\s*(?:天|日)|近三个月)/.test(text),
    /仅?自然流|自然流量/.test(text) && /全流量|含投流|全部流量/.test(text),
  ].some(Boolean);
  const scopeContext = conflictingScope
    ? ""
    : text
      .replace(/曝光[^，,、；;\n]{0,16}/g, " ")
      .replace(/阅读[^，,、；;\n]{0,16}/g, " ")
      .replace(/(?:点赞|赞量)[^，,、；;\n]{0,16}/g, " ")
      .replace(/收藏[^，,、；;\n]{0,16}/g, " ")
      .trim();
  const columns = definitions.map((definition, index) => ({
    index,
    letter: spreadsheetColumnLetter(index),
    key: `message:${definition.metric}:${index}`,
    topLabel: scopeContext,
    childLabel: definition.label,
    parentLabel: scopeContext,
    displayLabel: definition.label,
    pathLabel: scopeContext ? `${scopeContext} / ${definition.label}` : definition.label,
    mapping: null,
  }));
  const defaults = conflictingScope ? {} : contractDefaultsFromMessage({ message: text });
  const resolution = resolveWorkbookColumns(columns, defaults);
  const taskContract = createTaskContract({
    columns: resolution.columns,
    creators,
    source: { type: "links", linkCount: creators.length, parsedFrom: "message" },
  });
  return {
    version: 2,
    sheetName: "",
    headerDepth: 0,
    columns: resolution.columns,
    pgyFieldIds: [...new Set(resolution.columns
      .filter((column) => column.mapping?.source === "pgy")
      .map((column) => column.mapping.id))],
    derivedFieldIds: [],
    unmatchedColumns: [],
    collectionPlan: { fieldIds: [], requiredFieldNames: [], requests: [] },
    creators,
    taskContract,
    scopeGroups: taskContract.scopeGroups,
    unresolved: taskContract.unresolved,
    unresolvedCount: taskContract.unresolvedCount,
    executable: false,
  };
}

function createDynamicLinkTask(selectedFields, creators) {
  const fieldItems = fieldItemsFromSelection(selectedFields);
  if (!fieldItems.length) throw new Error("请说明需要采集的字段，或选择全量采集");
  const publicFields = new Map(publicFieldRegistry().map((item) => [item.id, item]));
  const columns = fieldItems.map((item, index) => {
    const display = publicFields.get(item.id) || item;
    return {
      index,
      letter: spreadsheetColumnLetter(index),
      key: `${item.id}:${display.name}`,
      topLabel: display.group || "",
      childLabel: display.name,
      parentLabel: display.group || "",
      displayLabel: display.name,
      pathLabel: display.group ? `${display.group} / ${display.name}` : display.name,
      mapping: {
        id: item.id,
        name: item.name,
        label: display.name,
        source: item.source,
        unit: item.unit || "",
      },
      contract: item.contract || null,
      missingDimensions: [],
      requiresResolution: false,
      resolvedBy: ["field_registry"],
    };
  });
  const taskContract = createTaskContract({
    columns,
    creators,
    source: { type: "links", linkCount: creators.length },
  });
  const pgyFieldIds = fieldItems
    .filter((item) => item.source === "pgy")
    .map((item) => item.id);
  return {
    version: 2,
    sheetName: "",
    headerDepth: 2,
    columns,
    pgyFieldIds,
    derivedFieldIds: fieldItems
      .filter((item) => item.source === "formula")
      .map((item) => item.id),
    unmatchedColumns: [],
    collectionPlan: compileCollectionPlan(pgyFieldIds),
    creators,
    taskContract,
    scopeGroups: taskContract.scopeGroups,
    unresolved: taskContract.unresolved,
    unresolvedCount: taskContract.unresolvedCount,
    executable: false,
  };
}

function filterDynamicTaskBySelection(taskSpec, selectedFields) {
  const selectedItems = fieldItemsFromSelection(selectedFields);
  if (!selectedItems.length) return taskSpec;
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  selectedIds.add("pgy.creator.pgy_profile");
  const columns = (taskSpec.columns || []).filter((column) => (
    !column.mapping
    || selectedIds.has(column.mapping.id)
  ));
  const existingIds = new Set(columns.map((column) => column.mapping?.id).filter(Boolean));
  const publicFields = new Map(publicFieldRegistry().map((item) => [item.id, item]));
  let nextIndex = Math.max(-1, ...columns.map((column) => Number(column.index))) + 1;
  for (const item of selectedItems) {
    if (item.id === "pgy.creator.pgy_profile" || existingIds.has(item.id)) continue;
    const display = publicFields.get(item.id) || item;
    columns.push({
      index: nextIndex,
      letter: spreadsheetColumnLetter(nextIndex),
      key: `${item.id}:${display.name}`,
      topLabel: display.group || "",
      childLabel: display.name,
      parentLabel: display.group || "",
      displayLabel: display.name,
      pathLabel: display.group ? `${display.group} / ${display.name}` : display.name,
      mapping: {
        id: item.id,
        name: item.name,
        label: display.name,
        source: item.source,
        unit: item.unit || "",
      },
      contract: item.contract || null,
      missingDimensions: [],
      requiresResolution: false,
      resolvedBy: ["saved_template"],
      appendedByTemplate: true,
    });
    existingIds.add(item.id);
    nextIndex += 1;
  }
  const taskContract = createTaskContract({
    columns,
    creators: taskSpec.creators || [],
    source: taskSpec.taskContract?.source || {
      type: "excel",
      sheetName: taskSpec.sheetName,
      headerDepth: taskSpec.headerDepth,
    },
    version: Number(taskSpec.taskContract?.version || 1),
  });
  const pgyFieldIds = [...new Set(columns
    .filter((column) => column.mapping?.source === "pgy")
    .map((column) => column.mapping.id))];
  return {
    ...taskSpec,
    columns,
    pgyFieldIds,
    derivedFieldIds: [...new Set(columns
      .filter((column) => column.mapping?.source === "formula")
      .map((column) => column.mapping.id))],
    collectionPlan: compileCollectionPlan(pgyFieldIds),
    taskContract,
    scopeGroups: taskContract.scopeGroups,
    unresolved: taskContract.unresolved,
    unresolvedCount: taskContract.unresolvedCount,
    executable: false,
  };
}

function contractDefaultsFromMessage(body = {}) {
  if (body.defaults && typeof body.defaults === "object") return body.defaults;
  const text = String(body.message || body.text || "");
  const defaults = {};
  if (/图文\s*[+＋]\s*视频|全部内容|不区分图文和视频/.test(text)) defaults.contentTypeDefault = "all";
  else if (/视频/.test(text)) defaults.contentTypeDefault = "video";
  else if (/图文/.test(text)) defaults.contentTypeDefault = "image";
  if (/日常笔记/.test(text)) defaults.sceneDefault = "daily";
  else if (/合作笔记/.test(text)) defaults.sceneDefault = "cooperation";
  if (/仅自然流|自然流量/.test(text)) defaults.trafficDefault = "natural";
  else if (/全流量/.test(text)) defaults.trafficDefault = "all";
  if (/30\s*天|近30日/.test(text)) defaults.windowDefault = "30d";
  else if (/90\s*天|近90日/.test(text)) defaults.windowDefault = "90d";
  return defaults;
}

function contractDefaultsFromJob(job = {}) {
  const defaults = { ...(job.taskSpec?.contractDefaults || {}) };
  const pattern = /(sceneDefault|contentTypeDefault|windowDefault|naturalWindowDefault|trafficDefault|viewDefault)=([a-z0-9]+)/gi;
  for (const entry of job.logs || []) {
    const message = String(entry.message || "");
    let match = pattern.exec(message);
    while (match) {
      defaults[match[1]] = match[2];
      match = pattern.exec(message);
    }
    pattern.lastIndex = 0;
  }
  return validatedContractDefaults(defaults);
}

async function handleCreateTask(req, res) {
  const body = await readJsonBody(req, 2 * 1024 * 1024);
  const routing = await interpretTaskIntent({
    hasExcel: false,
    text: body.message || body.text || "",
    requestedIntent: body.intent,
  });
  if (routing.confidence === "model_candidate_validated") {
    trackEventSoon({
      eventName: "model_call_completed",
      userId: req.currentUser.id,
      page: "workbench",
      properties: { provider: "qwen", purpose: "task_intent" },
    });
  }
  if (routing.intent === "finder" || routing.intent === "workflow") {
    return json(res, 200, {
      intent: routing.intent,
      stages: routing.stages,
      nextAction: "open_finder",
      assistant: routing.intent === "workflow"
        ? "我会先进入寻找达人，再把确认的候选池作为采集任务输入。"
        : "我已识别为寻找达人任务，请补充或确认筛选条件。",
    });
  }
  const links = pgyLinksFromText(body.message || body.text || "");
  if (!links.length) {
    return json(res, 400, {
      error: "请上传 Excel，或在消息中粘贴至少一个蒲公英链接",
      intent: routing.intent,
    });
  }
  if (links.length > 10) {
    return json(res, 400, {
      error: `已识别 ${links.length} 个蒲公英链接；超过 10 位达人时，请把链接放入 Excel 或同时上传字段模板，便于校验行对应关系`,
      intent: routing.intent,
      creatorCount: links.length,
    });
  }
  const creators = links.map((pgyLink, index) => ({
    rowIndex: index + 2,
    pgyLink,
    nickname: `达人 ${index + 1}`,
  }));
  const requestedFields = normalizeSelectedFields(body.selectedFields);
  const fullCollectionRequested = /(?:全量|全部|所有).{0,8}(?:采集|数据|字段)|蒲公英.{0,8}(?:全量|全部|所有)/.test(
    String(body.message || body.text || "").replace(/https?:\/\/[^\s，。；;]+/g, " "),
  );
  const mentionedFields = requestedFields.length
    ? requestedFields
    : fullCollectionRequested
      ? publicFieldRegistry()
        .filter((field) => field.source === "pgy")
        .map((field) => field.id)
      : fieldNamesMentionedInText(body.message || body.text || "");
  const selectedItems = fieldItemsFromSelection(mentionedFields);
  const ambiguousTask = selectedItems.length
    ? null
    : ambiguousLinkTaskFromMessage(body.message || body.text || "", creators);
  if (!selectedItems.length && !ambiguousTask) {
    return json(res, 200, {
      nextAction: "choose_collection_scope",
      assistant: `我识别到 ${creators.length} 位达人，但这条消息没有限定字段。你希望全量采集蒲公英可用数据，还是补充需要的笔记类型、内容形式、周期、流量范围和指标？`,
      intent: routing.intent,
      creatorCount: creators.length,
    });
  }
  const selectedFields = selectedItems.length
    ? selectedItems.map((item) => item.name)
    : ambiguousTask.columns.map((column) => column.mapping?.name || column.displayLabel);
  const job = createJob(
    "",
    body.name || "链接",
    selectedFields,
    "dynamic",
    req.currentUser.id,
  );
  job.sourceType = "links";
  job.taskSpec = ambiguousTask || createDynamicLinkTask(mentionedFields, creators);
  await fs.mkdir(job.runDir, { recursive: true });
  await writeJson(job.creatorsPath, creators);
  await writeJson(job.taskPath, job.taskSpec);
  job.creators = creators;
  job.progress = { done: 0, total: creators.length };
  const needsClarification = Number(job.taskSpec.taskContract?.unresolvedCount || 0) > 0;
  moveJobState(
    job,
    needsClarification ? "NEEDS_CLARIFICATION" : "READY_TO_CONFIRM",
    needsClarification ? "clarification.requested" : "task.ready_to_confirm",
  );
  job.taskState = taskStateFor(job);
  await pushLog(job, `已从对话识别 ${creators.length} 个蒲公英链接`);
  await pushLog(job, `已解析 ${selectedFields.length} 个字段（含公式依赖）`);
  if (needsClarification) {
    trackEventSoon({
      eventName: "clarification_requested",
      userId: req.currentUser.id,
      jobId: job.id,
      page: "workbench",
      properties: { unresolvedCount: job.taskSpec.taskContract.unresolvedCount },
    });
  }
  const clarification = buildClarification(job.taskSpec.taskContract);
  return json(res, 201, {
    job: publicJob(job),
    assistant: needsClarification
      ? `${clarification.summary}${clarification.questions[0]?.prompt ? ` ${clarification.questions[0].prompt}` : ""}`
      : `我已识别 ${creators.length} 位达人和 ${selectedFields.length} 个蒲公英字段；请确认口径后开始采集。`,
  });
}

async function handleTaskMessage(req, res, job) {
  if (!requireJobAccess(res, job, req.currentUser)) return;
  if (job.templateId !== "dynamic") {
    return json(res, 200, {
      job: publicJob(job),
      assistant: "这项任务的字段已经明确，可以直接开始采集。",
    });
  }
  const body = await readJsonBody(req, 256 * 1024);
  const userReply = String(body.message || body.text || "").trim()
    || Object.entries(body.defaults || {})
      .map(([key, value]) => `${key}=${value}`)
      .join("，");
  if (userReply) {
    await pushLog(job, userReply, {
      actor: "user",
      type: "clarification_reply",
      stage: "clarification",
      level: "info",
    });
  }
  let defaults = contractDefaultsFromMessage(body);
  if (!Object.keys(defaults).length && process.env.QWEN_API_KEY) {
    const unresolvedDimensions = [...new Set(
      (job.taskSpec?.taskContract?.unresolved || [])
        .flatMap((item) => item.missingDimensions || []),
    )];
    const startedAt = Date.now();
    try {
      defaults = await interpretScopeReply({
        text: body.message || body.text || "",
        unresolvedDimensions,
      });
      trackEventSoon({
        eventName: "model_call_completed",
        userId: req.currentUser.id,
        jobId: job.id,
        page: "workbench",
        properties: { provider: "qwen", purpose: "scope_reply", durationMs: Date.now() - startedAt },
      });
    } catch (error) {
      trackEventSoon({
        eventName: "model_call_failed",
        userId: req.currentUser.id,
        jobId: job.id,
        page: "workbench",
        properties: { provider: "qwen", purpose: "scope_reply", durationMs: Date.now() - startedAt, error: error.message },
      });
    }
  }
  if (!Object.keys(defaults).length) {
    return json(res, 200, {
      job: publicJob(job),
      assistant: job.taskSpec?.taskContract?.unresolvedCount
        ? buildClarification(job.taskSpec.taskContract).summary
        : "字段口径已经完整，请确认后开始采集。",
    });
  }
  trackEventSoon({
    eventName: "clarification_resolved",
    userId: req.currentUser.id,
    jobId: job.id,
    page: "workbench",
    properties: { dimensions: Object.keys(defaults) },
  });
  return await handleResolveTaskContract(req, res, job, { defaults });
}

async function handleTaskConfirm(req, res, job) {
  if (!requireJobAccess(res, job, req.currentUser)) return;
  const body = await readJsonBody(req, 64 * 1024);
  const currentVersion = Number(job.taskSpec?.taskContract?.version || 0);
  if (body.version && Number(body.version) !== currentVersion) {
    return json(res, 409, { error: "字段合同已更新，请确认最新理解" });
  }
  trackEventSoon({
    eventName: "task_confirmed",
    userId: req.currentUser.id,
    jobId: job.id,
    page: "workbench",
    properties: { version: currentVersion },
  });
  return await handleConfirmTaskContract(req, res, job);
}

async function resumePostCollection(req, res, job, { skipModel = false } = {}) {
  const dynamicTask = job.taskSpec || await readJson(job.taskPath);
  moveJobState(job, "VALIDATING", "task.post_collection_resumed");
  job.status = "running";
  job.error = "";
  job.resumedAt = new Date().toISOString();
  await pushLog(job, skipModel
    ? "达人采集结果已保留，本次跳过模型补充并直接重新生成 Excel"
    : "达人采集结果已保留，仅重试模型补充和 Excel 导出", {
    stage: "validation",
    level: "info",
    resumeScope: "post_collection",
  });
  json(res, 202, {
    ok: true,
    jobId: job.id,
    retryScope: "post_collection",
    skipModel,
  });

  queueMicrotask(async () => {
    try {
      const creators = job.creators || await readJson(job.creatorsPath);
      const collectedPath = path.join(job.runDir, "collected-results.json");
      let collectedResults;
      if (await fileExists(collectedPath)) {
        collectedResults = await readJson(collectedPath);
      } else if (await fileExists(job.resultsPath) && jobErrorType(job) === "EXPORT") {
        collectedResults = await readJson(job.resultsPath);
      } else {
        collectedResults = await recoverCollectedResults({
          runDir: job.runDir,
          creators,
          task: dynamicTask,
          jobId: job.id,
        });
        await writeJson(collectedPath, collectedResults);
        await pushLog(job, `已从原始证据恢复 ${collectedResults.length} 位达人，无需重新访问蒲公英`, {
          stage: "collection",
          level: "success",
          resumed: true,
        });
      }
      job.progress = { done: collectedResults.length, total: creators.length };
      await enrichAndExportJob({
        job,
        collectedResults,
        dynamicTask,
        userId: req.currentUser.id,
        skipModel,
      });
      trackEventSoon({
        eventName: "collect_job_done",
        userId: req.currentUser.id,
        jobId: job.id,
        entityType: "job",
        entityId: job.id,
        page: "collector",
        properties: {
          total: creators.length,
          sourceType: job.sourceType,
          templateId: job.templateId,
          resumedFrom: "post_collection",
          skipModel,
        },
      });
    } catch (error) {
      await failRunningJob(job, error);
    }
  });
}

async function handleTaskRetry(req, res, job) {
  if (!requireJobAccess(res, job, req.currentUser)) return;
  if (!["failed", "uploaded"].includes(job.status)) {
    return json(res, 409, { error: "当前任务不需要重试" });
  }
  const body = await readJsonBody(req, 64 * 1024).catch(() => ({}));
  if (postCollectionResumeAvailable(job)) {
    return await resumePostCollection(req, res, job, {
      skipModel: body.skipModel === true,
    });
  }
  job.status = "uploaded";
  job.error = "";
  await persistJob(job);
  return await handleCollect(req, res, { jobId: job.id });
}

async function handleTaskCopy(req, res, sourceJob) {
  if (!requireJobAccess(res, sourceJob, req.currentUser)) return;
  if (sourceJob.status === "running") {
    return json(res, 409, { error: "采集中任务暂不能复制" });
  }
  if (
    !["finder", "links"].includes(sourceJob.sourceType)
    && (!sourceJob.inputPath || !await fileExists(sourceJob.inputPath))
  ) {
    return json(res, 409, { error: "原始 Excel 已不存在，无法复制该任务" });
  }
  const copiedName = `${sourceJob.originalName || "未命名任务"}（副本）`;
  const copied = sourceJob.sourceType === "finder"
    ? createFinderJob(copiedName, sourceJob.selectedFields || [], req.currentUser.id)
    : createJob("", copiedName, sourceJob.selectedFields || [], sourceJob.templateId, req.currentUser.id);
  copied.sourceType = sourceJob.sourceType;
  await fs.mkdir(copied.runDir, { recursive: true });

  if (!["finder", "links"].includes(sourceJob.sourceType)) {
    const extension = path.extname(sourceJob.inputPath) || ".xlsx";
    copied.inputPath = path.join(copied.runDir, `input${extension}`);
    await fs.copyFile(sourceJob.inputPath, copied.inputPath);
  }
  if (sourceJob.creatorsPath && await fileExists(sourceJob.creatorsPath)) {
    await fs.copyFile(sourceJob.creatorsPath, copied.creatorsPath);
    copied.creators = await readJson(copied.creatorsPath).catch(() => []);
  } else {
    copied.creators = structuredClone(sourceJob.creators || []);
    await writeJson(copied.creatorsPath, copied.creators);
  }
  copied.progress = { done: 0, total: copied.creators.length };

  if (sourceJob.templateId === "dynamic" && sourceJob.taskSpec) {
    copied.taskSpec = JSON.parse(JSON.stringify(sourceJob.taskSpec));
    copied.taskSpec.executable = false;
    copied.taskSpec.taskContract.confirmedVersion = 0;
    copied.taskSpec.taskContract.confirmedAt = "";
    copied.confirmation = {};
    copied.lifecycleState = Number(copied.taskSpec.taskContract.unresolvedCount) > 0
      ? "NEEDS_CLARIFICATION"
      : "READY_TO_CONFIRM";
    copied.taskState = copied.lifecycleState;
    await writeJson(copied.taskPath, copied.taskSpec);
  }
  copied.logs = [{
    ts: new Date().toISOString(),
    message: `已从任务“${sourceJob.originalName || sourceJob.id}”复制；采集结果与登录态未复制`,
  }];
  await persistJob(copied);
  trackEventSoon({
    eventName: "task_copied",
    userId: req.currentUser.id,
    jobId: copied.id,
    entityType: "job",
    entityId: sourceJob.id,
    page: "profile",
    properties: { sourceType: sourceJob.sourceType, templateId: sourceJob.templateId },
  });
  return json(res, 201, { task: publicJob(copied) });
}

function sameContract(left, right) {
  const dimensions = [
    "metric",
    "statistic",
    "scene",
    "contentType",
    "window",
    "traffic",
    "view",
    "source",
    "unit",
  ];
  return dimensions.every((dimension) => String(left?.[dimension] || "") === String(right?.[dimension] || ""));
}

function registryFieldIdForColumn(column) {
  const mappingId = column?.mapping?.id;
  if (fieldById(mappingId)) return mappingId;
  if (!column?.contract) return "";
  return publicFieldRegistry().find((field) => sameContract(field.contract, column.contract))?.id || "";
}

async function handleSaveTaskAsTemplate(req, res, job) {
  if (!requireJobAccess(res, job, req.currentUser)) return;
  if (job.templateId !== "dynamic" || !job.taskSpec?.taskContract) {
    return json(res, 409, { error: "只有完成字段解析的动态采集任务可以固化" });
  }
  if (Number(job.taskSpec.taskContract.unresolvedCount || 0) > 0) {
    return json(res, 409, { error: "字段口径仍有歧义，请完成澄清后再固化模板" });
  }
  const body = await readJsonBody(req, 64 * 1024);
  const columns = job.taskSpec.columns || [];
  const fieldIds = [...new Set(columns.map(registryFieldIdForColumn).filter(Boolean))];
  if (!fieldIds.length) {
    return json(res, 409, { error: "当前任务没有可复用的字段合同" });
  }
  const template = await saveCollectionTemplate({
    name: String(body.name || `${job.originalName || "历史任务"}模板`).trim(),
    baseTemplateId: "dynamic",
    fieldIds,
    columnMappings: columns
      .filter((column) => column.mapping)
      .map((column) => ({
        id: column.mapping.id,
        displayLabel: column.displayLabel,
        contract: column.contract || null,
      })),
    formulas: columns
      .filter((column) => column.mapping?.source === "formula")
      .map((column) => column.mapping.id),
    llmFields: (job.taskSpec.unmatchedColumns || []).map((column) => column.displayLabel).filter(Boolean),
    scopeGroups: job.taskSpec.taskContract.scopeGroups || [],
    sourceJobId: job.id,
  });
  trackEventSoon({
    eventName: "collection_template_saved_from_task",
    userId: req.currentUser.id,
    jobId: job.id,
    page: "workbench",
    properties: { templateId: template.id, fieldCount: fieldIds.length },
  });
  return json(res, 201, { template });
}

async function handleFinderSearch(req, res) {
  const body = await readJsonBody(req);
  const filters = body.filters || body;
  const startedAt = Date.now();
  const runDir = path.join(RUNS_DIR, `finder-${nowStamp()}`);
  await fs.mkdir(runDir, { recursive: true });
  const loginContext = await ensureContext(req.currentUser);
  const storageState = await loginContext.storageState();
  let searchContext = null;
  try {
    searchContext = await createBackgroundCollectContext(storageState, CONFIG);
    const result = await searchCreators({
      context: searchContext,
      runDir,
      config: CONFIG,
      filters,
    });
    trackEventSoon({
      eventName: "finder_search_success",
      page: "finder",
      properties: {
        keyword: filters.keyword || "",
        category: filters.category || "",
        fanRange: filters.fanRange || "",
        sort: filters.sort || "",
        limit: filters.limit || 0,
        batchIndex: filters.batchIndex || 0,
        returned: result.candidates?.length || 0,
        total: result.total || result.candidates?.length || 0,
        durationMs: Date.now() - startedAt,
      },
    });
    return json(res, 200, { ...result, runDir: path.relative(ROOT, runDir) });
  } catch (error) {
    trackEventSoon({
      eventName: "finder_search_failed",
      page: "finder",
      properties: {
        keyword: filters.keyword || "",
        category: filters.category || "",
        fanRange: filters.fanRange || "",
        limit: filters.limit || 0,
        batchIndex: filters.batchIndex || 0,
        error: error.message,
        durationMs: Date.now() - startedAt,
      },
    });
    throw error;
  } finally {
    if (searchContext) await searchContext.close().catch(() => {});
  }
}

async function handleFinderEnrichInteractions(req, res) {
  const body = await readJsonBody(req, 4 * 1024 * 1024);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 40) : [];
  if (!candidates.length) return json(res, 200, { candidates: [] });

  const runDir = path.join(RUNS_DIR, `finder-enrich-${nowStamp()}`);
  await fs.mkdir(runDir, { recursive: true });
  const loginContext = await ensureContext(req.currentUser);
  const storageState = await loginContext.storageState();
  let enrichContext = null;
  try {
    enrichContext = await createBackgroundCollectContext(storageState, CONFIG);
    await enrichLikeCollectCount(enrichContext, candidates, CONFIG);
    return json(res, 200, { candidates });
  } finally {
    if (enrichContext) await enrichContext.close().catch(() => {});
  }
}

async function handleCreateCollectJob(req, res) {
  const body = await readJsonBody(req, 4 * 1024 * 1024);
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (candidates.length === 0) return json(res, 400, { error: "请先选择候选达人" });

  const creators = candidates.map((candidate, index) => creatorFromCandidate(candidate, index));
  const selectedFields = normalizeSelectedFields(body.selectedFields);
  const job = createFinderJob(body.name || "找达人候选池", selectedFields, req.currentUser.id);
  await fs.mkdir(job.runDir, { recursive: true });
  await writeJson(job.creatorsPath, creators);
  await writeJson(path.join(job.runDir, "finder-candidates.json"), candidates);
  job.creators = creators;
  job.progress = { done: 0, total: creators.length };
  await pushLog(job, `已从候选池导入 ${creators.length} 位达人`);
  if (selectedFields.length) await pushLog(job, `采集字段：${selectedFields.join("、")}`);
  trackEventSoon({
    eventName: "candidate_pool_import",
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    page: "collector",
    properties: { candidateCount: creators.length, fieldCount: selectedFields.length, sourceType: "finder" },
  });
  trackEventSoon({
    eventName: "collect_job_create",
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    page: "collector",
    properties: { total: creators.length, sourceType: "finder" },
  });
  return json(res, 200, { jobId: job.id, count: creators.length, creators, job: publicJob(job) });
}

async function handleGetCandidatePool(req, res) {
  const row = await readCurrentCandidatePool(req.currentUser.id);
  return json(res, 200, { pool: publicCandidatePool(row) });
}

async function handleSaveCandidatePool(req, res) {
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 1000) : [];
  const row = await saveCandidatePool({
    ownerUserId: req.currentUser.id,
    name: body.name || "当前候选池",
    filters: body.filters || {},
    candidates,
  });
  return json(res, 200, { pool: publicCandidatePool(row) });
}

async function handleClearCandidatePool(req, res) {
  await clearCurrentCandidatePool(req.currentUser.id);
  return json(res, 200, { ok: true });
}

async function handleTrackEvent(req, res) {
  const body = await readJsonBody(req, 256 * 1024);
  await trackEvent({
    eventName: body.eventName || body.event_name,
    userId: req.currentUser?.id || "",
    sessionId: req.sessionId || body.sessionId || "",
    jobId: body.jobId || "",
    entityType: body.entityType || "",
    entityId: body.entityId || "",
    page: body.page || "",
    properties: body.properties || {},
  });
  return json(res, 200, { ok: true });
}

async function handleAnalyticsSummary(req, res) {
  const access = AUTH_REQUIRED
    ? {
        allowed: req.currentUser?.role === "admin",
        mode: "role",
        viewer: req.currentUser?.role === "admin" ? "管理员" : "未授权",
      }
    : analyticsAccessFromRequest(req);
  if (!access.allowed) {
    return json(res, 403, {
      error: "无权查看数据表现",
      access: {
        visibleTo: ["管理员", "投放负责人", "数据分析"],
        hiddenFrom: ["普通媒介执行同学", "外部协作者"],
        policy: "当前环境启用了管理密钥。请输入管理员提供的数据表现密钥。",
      },
    });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") || ANALYTICS_DEFAULT_DAYS), 1), 180);
  const events = await loadAnalyticsEvents(days);
  return json(res, 200, { ...analyticsSummary(events, days), viewer: access.viewer, accessMode: access.mode });
}

function publicJob(job) {
  const taskContract = job.taskSpec?.taskContract || null;
  const taskState = taskStateFor(job);
  const publicError = job.error ? userFacingExecutionError(job.error) : "";
  const publicLogs = (job.logs || []).map((entry) => {
    if (entry.level !== "error") return entry;
    const rawMessage = String(entry.message || "");
    const prefix = rawMessage.startsWith("失败：") ? "失败：" : "";
    const content = prefix ? rawMessage.slice(prefix.length) : rawMessage;
    return { ...entry, message: `${prefix}${userFacingExecutionError(content)}` };
  });
  const warnings = (job.logs || [])
    .filter((entry) => entry.level === "warning")
    .slice(-20);
  return {
    id: job.id,
    status: job.status,
    originalName: job.originalName,
    progress: job.progress,
    error: publicError,
    errorType: publicError ? jobErrorType({ ...job, error: publicError }) : "",
    retryScope: postCollectionResumeAvailable(job) ? "post_collection" : "full_collection",
    warnings,
    logs: publicLogs,
    creators: job.creators || [],
    selectedFields: job.selectedFields || [],
    sourceType: job.sourceType || "excel",
    templateId: normalizeTemplateId(job.templateId),
    templateLabel: templateProfile(job.templateId).label,
    taskState,
    taskContract: taskContract ? {
      version: taskContract.version,
      confirmedVersion: taskContract.confirmedVersion,
      unresolvedCount: taskContract.unresolvedCount,
      scopeGroups: taskContract.scopeGroups,
      defaults: job.taskSpec?.contractDefaults || {},
      clarification: buildClarification(taskContract),
    } : null,
    fieldMapping: job.templateId === "dynamic" && job.taskSpec
      ? {
          pgyFieldCount: job.taskSpec.pgyFieldIds?.length || 0,
          unmatchedFieldCount: job.taskSpec.unmatchedColumns?.length || 0,
          requestCount: job.taskSpec.collectionPlan?.requests?.length || 0,
          scopeGroupCount: taskContract?.scopeGroups?.length || 0,
          unresolvedCount: taskContract?.unresolvedCount || 0,
        }
      : null,
    outputReady: job.status === "done" && taskState !== "EXPIRED",
    createdAt: job.createdAt,
    expiresAt: job.expiresAt || expiresAtForJob(job.createdAt, TASK_RETENTION_DAYS),
    finishedAt: job.finishedAt || "",
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { ...CORS_HEADERS, "content-type": type, "cache-control": "no-cache" });
    res.end(content);
  } catch {
    notFound(res);
  }
}

async function router(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        database: db?.mode || "initializing",
        serverTime: new Date().toISOString(),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/config") {
      const setupRequired = await firstRunSetupRequired();
      return json(res, 200, {
        authRequired: AUTH_REQUIRED,
        setupRequired,
        setupAllowed: setupRequired && ALLOW_FIRST_RUN_SETUP && requestIsLoopback(req),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/setup") {
      return await handleAccountSetup(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      return await handleAccountLogin(req, res);
    }
    if (url.pathname.startsWith("/api/")) {
      const user = await resolveRequestIdentity(req);
      if (!user) return json(res, 401, { error: "请先登录寻达" });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      return json(res, 200, { user: publicUser(req.currentUser) });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      return await handleAccountLogout(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      requireRole(req.currentUser, "admin");
      return json(res, 200, { users: (await identityRepository.listUsers()).map(publicUser) });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/users") {
      return await handleCreateUser(req, res);
    }
    const userStatusRoute = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (req.method === "POST" && userStatusRoute) {
      return await handleUpdateUserStatus(req, res, decodeURIComponent(userStatusRoute[1]));
    }
    if (req.method === "GET" && url.pathname === "/api/admin/jobs") {
      requireRole(req.currentUser, "admin");
      return json(res, 200, {
        jobs: Array.from(jobs.values())
          .filter((job) => !jobExpired(job))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map(publicJob),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/analytics") {
      requireRole(req.currentUser, "admin");
      return await handleAnalyticsSummary(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/pgy/shared-connection") {
      return await handleGetSharedPgyConnection(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/admin/pgy/shared-connection") {
      return await handlePublishSharedPgyConnection(req, res);
    }
    if (req.method === "DELETE" && url.pathname === "/api/admin/pgy/shared-connection") {
      return await handleRevokeSharedPgyConnection(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/profile") return await handleProfile(req, res);
    if (req.method === "PATCH" && url.pathname === "/api/profile") return await handleUpdateProfile(req, res);
    if (req.method === "POST" && url.pathname === "/api/profile/change-password") {
      return await handleChangePassword(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/profile/performance") {
      return await handleProfilePerformance(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/tasks") return await handleCreateTask(req, res);
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const ownJobs = Array.from(jobs.values())
        .filter((job) => job.lifecycleState !== "DELETED" && !jobExpired(job) && jobBelongsToUser(job, req.currentUser))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(publicJob);
      return json(res, 200, { tasks: ownJobs });
    }
    const taskActionRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(messages|confirm|start|retry|copy|save-template|download)$/);
    if (taskActionRoute) {
      const job = jobs.get(decodeURIComponent(taskActionRoute[1]));
      if (!requireJobAccess(res, job, req.currentUser)) return;
      const action = taskActionRoute[2];
      if (req.method === "POST" && action === "messages") return await handleTaskMessage(req, res, job);
      if (req.method === "POST" && action === "confirm") return await handleTaskConfirm(req, res, job);
      if (req.method === "POST" && action === "start") return await handleCollect(req, res, { jobId: job.id });
      if (req.method === "POST" && action === "retry") return await handleTaskRetry(req, res, job);
      if (req.method === "POST" && action === "copy") return await handleTaskCopy(req, res, job);
      if (req.method === "POST" && action === "save-template") return await handleSaveTaskAsTemplate(req, res, job);
      if (req.method === "GET" && action === "download") {
        res.writeHead(302, { ...CORS_HEADERS, location: `/api/download/${encodeURIComponent(job.id)}` });
        return res.end();
      }
    }
    const taskDetailRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDetailRoute) {
      const job = jobs.get(decodeURIComponent(taskDetailRoute[1]));
      if (!requireJobAccess(res, job, req.currentUser)) return;
      if (req.method === "GET") return json(res, 200, { task: publicJob(job) });
      if (req.method === "DELETE") return await handleDeleteTask(req, res, job);
    }
    if (req.method === "GET" && url.pathname === "/api/templates") {
      return json(res, 200, { templates: publicTemplateProfiles() });
    }
    if (req.method === "GET" && url.pathname === "/api/field-registry") {
      return json(res, 200, { fields: publicFieldRegistry() });
    }
    if (req.method === "GET" && url.pathname === "/api/collection-templates") {
      return json(res, 200, { templates: await listCollectionTemplates() });
    }
    if (req.method === "POST" && url.pathname === "/api/collection-templates") {
      return json(res, 200, { template: await saveCollectionTemplate(await readJsonBody(req)) });
    }
    if (req.method === "GET" && url.pathname === "/api/finder/categories") return json(res, 200, { categories: PGY_CATEGORIES });
    if (req.method === "GET" && url.pathname === "/api/status") return await handleStatus(req, res);
    if (req.method === "GET" && url.pathname === "/api/pgy/connection") return await handleGetPgyConnection(req, res);
    if (req.method === "POST" && url.pathname === "/api/pgy/connect") return await handlePgyLogin(req, res);
    if (req.method === "GET" && url.pathname === "/api/pgy/connect/preview") {
      return await handlePgyLoginPreview(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/pgy/connect/input") {
      return await handlePgyLoginInput(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/pgy/connection/sync") return await handleSyncPgyConnection(req, res);
    if (req.method === "DELETE" && url.pathname === "/api/pgy/connection") return await handleDisconnectPgy(req, res);
    if (req.method === "GET" && url.pathname === "/api/candidate-pool/current") return await handleGetCandidatePool(req, res);
    if (req.method === "POST" && url.pathname === "/api/candidate-pool/current") return await handleSaveCandidatePool(req, res);
    if (req.method === "DELETE" && url.pathname === "/api/candidate-pool/current") return await handleClearCandidatePool(req, res);
    if (req.method === "POST" && url.pathname === "/api/analytics/track") return await handleTrackEvent(req, res);
    if (req.method === "GET" && url.pathname === "/api/analytics/summary") return await handleAnalyticsSummary(req, res);
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const allJobs = Array.from(jobs.values())
        .filter((job) => job.lifecycleState !== "DELETED" && !jobExpired(job) && jobBelongsToUser(job, req.currentUser))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(publicJob);
      return json(res, 200, { jobs: allJobs });
    }
    if (req.method === "POST" && url.pathname === "/api/finder/search") return await handleFinderSearch(req, res);
    if (req.method === "POST" && url.pathname === "/api/finder/enrich-interactions") return await handleFinderEnrichInteractions(req, res);
    if (req.method === "POST" && url.pathname === "/api/finder/create-collect-job") return await handleCreateCollectJob(req, res);
    if (req.method === "POST" && url.pathname === "/api/upload") return await handleUpload(req, res);
    if (req.method === "POST" && url.pathname === "/api/login") return await handlePgyLogin(req, res);
    if (req.method === "POST" && url.pathname === "/api/collect") return await handleCollect(req, res);
    const contractRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/contract\/(resolve|confirm)$/);
    if (req.method === "POST" && contractRoute) {
      const job = jobs.get(decodeURIComponent(contractRoute[1]));
      if (!requireJobAccess(res, job, req.currentUser)) return;
      return contractRoute[2] === "resolve"
        ? await handleResolveTaskContract(req, res, job)
        : await handleConfirmTaskContract(req, res, job);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      const job = jobs.get(id);
      if (!requireJobAccess(res, job, req.currentUser)) return;
      if (job && jobExpired(job)) return json(res, 410, { error: "任务已超过 7 天保存期" });
      return json(res, 200, publicJob(job));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      const job = jobs.get(id);
      if (!requireJobAccess(res, job, req.currentUser)) return;
      if (job && jobExpired(job)) return json(res, 410, { error: "任务已超过 7 天保存期" });
      if (!job || job.status !== "done") return json(res, 404, { error: "文件未生成" });
      const content = await fs.readFile(job.outputPath);
      const suffix = job.sourceType === "finder" ? "候选池采集" : "回填";
      const filename = encodeURIComponent(`达人表现数据_${templateProfile(job.templateId).label}_${suffix}_${id}.xlsx`);
      trackEventSoon({
        eventName: "excel_download",
        jobId: job.id,
        entityType: "job",
        entityId: job.id,
        page: "records",
        properties: { sourceType: job.sourceType, total: job.progress?.total || job.creators?.length || 0 },
      });
      res.writeHead(200, {
        ...CORS_HEADERS,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      });
      return res.end(content);
    }
    return await serveStatic(req, res);
  } catch (error) {
    const message = error?.message || "服务异常";
    const status = /无管理员权限|无权访问/.test(message)
      ? 403
      : /账号未登录|请先登录/.test(message)
        ? 401
        : /蒲公英连接|重新连接蒲公英|尚未连接蒲公英|登录态/.test(message)
          ? 409
          : /不能为空|无效|不支持|至少需要|缺少/.test(message)
          ? 400
          : 500;
    json(res, status, { error: message });
  }
}

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(RUNS_DIR, { recursive: true });
const removedLegacyStorageStates = await deleteLegacyPlaintextStorageStates(RUNS_DIR);
if (removedLegacyStorageStates.length) {
  console.warn(`已清除 ${removedLegacyStorageStates.length} 个旧版明文蒲公英登录态临时文件`);
}
await initDatabase();
initializeIdentityRepository();
await bootstrapAdministrator();
await loadPersistedJobs();
await recoverRunsAsJobs();
await runRetentionSweep();
const retentionTimer = setInterval(() => {
  runRetentionSweep().catch((error) => console.error(`retention sweep failed: ${error.message}`));
}, 60 * 60 * 1000);
retentionTimer.unref();
const server = http.createServer(router);
server.listen(PORT, HOST, () => {
  console.log(`Xundao web tool: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
