#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const baseUrl = process.env.XUNDAO_SMOKE_BASE_URL || "http://127.0.0.1:8732";
const adminEmail = process.env.XUNDAO_SMOKE_ADMIN_EMAIL;
const adminPassword = process.env.XUNDAO_SMOKE_ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
  throw new Error("请设置 XUNDAO_SMOKE_ADMIN_EMAIL 和 XUNDAO_SMOKE_ADMIN_PASSWORD");
}

async function request(pathname, {
  method = "GET",
  cookie = "",
  body,
  form,
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined || form ? {} : { "content-type": "application/json" }),
    },
    ...(form
      ? { body: form }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status,
    data,
    cookie: String(response.headers.get("set-cookie") || "").split(";")[0],
  };
}

async function pollTask(taskId, cookie, predicate, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await request(`/api/tasks/${encodeURIComponent(taskId)}`, { cookie });
    assert.equal(result.status, 200);
    if (predicate(result.data.task)) return result.data.task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`任务 ${taskId} 未在预期时间内进入目标状态`);
}

const health = await request("/healthz");
assert.equal(health.status, 200);
assert.equal(health.data.ok, true);

const unauthenticated = await request("/api/profile");
assert.equal(unauthenticated.status, 401);

const adminLogin = await request("/api/auth/login", {
  method: "POST",
  body: { email: adminEmail, password: adminPassword },
});
assert.equal(adminLogin.status, 200);
assert.equal(adminLogin.data.user.role, "admin");
assert.match(adminLogin.cookie, /^xundao_session=/);

const sharedPgy = await request("/api/admin/pgy/shared-connection", {
  cookie: adminLogin.cookie,
});
assert.equal(sharedPgy.status, 200);
assert.equal(sharedPgy.data.connection.connected, false);
assert.equal(
  (await request("/api/admin/pgy/shared-connection", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: { allowedRoles: ["admin", "media"] },
  })).status,
  409,
);

const mediaEmail = "media.smoke@xundao.test";
const mediaPassword = "MediaSmoke#2026";
const createdUser = await request("/api/admin/users", {
  method: "POST",
  cookie: adminLogin.cookie,
  body: {
    displayName: "媒介冒烟账号",
    email: mediaEmail,
    password: mediaPassword,
    role: "media",
  },
});
assert.equal(createdUser.status, 201);

const mediaLogin = await request("/api/auth/login", {
  method: "POST",
  body: { email: mediaEmail, password: mediaPassword },
});
assert.equal(mediaLogin.status, 200);
assert.equal(mediaLogin.data.user.role, "media");
assert.equal(
  (await request("/api/admin/users", { cookie: mediaLogin.cookie })).status,
  403,
);
assert.equal(
  (await request("/api/admin/pgy/shared-connection", { cookie: mediaLogin.cookie })).status,
  403,
);
assert.equal(
  (await request("/api/pgy/connect/preview", { cookie: mediaLogin.cookie })).status,
  409,
);
assert.equal(
  (await request("/api/pgy/connect/input", {
    method: "POST",
    cookie: mediaLogin.cookie,
    body: { xRatio: 0.5, yRatio: 0.5 },
  })).status,
  409,
);

const tooManyLinks = Array.from(
  { length: 11 },
  (_, index) => `https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-${index}`,
).join("\n");
assert.equal(
  (await request("/api/tasks", {
    method: "POST",
    cookie: mediaLogin.cookie,
    body: { message: tooManyLinks, selectedFields: ["粉丝数"] },
  })).status,
  400,
);

const workbookRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-http-template-"));
const fixtureBuilder = path.resolve("tests/fixtures/create_portable_workbooks.py");
const fixtureResult = spawnSync("python3", [fixtureBuilder, workbookRoot], { encoding: "utf8" });
assert.equal(fixtureResult.status, 0, fixtureResult.stderr || fixtureResult.stdout);
const templateForm = new FormData();
templateForm.append(
  "file",
  new Blob([await fs.readFile(path.join(workbookRoot, "template-only.xlsx"))]),
  "template-only.xlsx",
);
templateForm.append("templateId", "dynamic");
templateForm.append("message", [
  "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/template-a",
  "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/template-b",
].join("\n"));
const templateUpload = await request("/api/upload", {
  method: "POST",
  cookie: mediaLogin.cookie,
  form: templateForm,
});
assert.equal(templateUpload.status, 200);
assert.equal(templateUpload.data.count, 2);
assert.equal(templateUpload.data.job.sourceType, "excel");
assert.equal(
  (await request(`/api/tasks/${encodeURIComponent(templateUpload.data.job.id)}`, {
    method: "DELETE",
    cookie: mediaLogin.cookie,
  })).status,
  200,
);

const createdTask = await request("/api/tasks", {
  method: "POST",
  cookie: mediaLogin.cookie,
  body: {
    message: "采集 https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-smoke",
    selectedFields: ["粉丝数"],
  },
});
assert.equal(createdTask.status, 201);
const taskId = createdTask.data.job.id;
assert.equal(createdTask.data.job.taskState, "READY_TO_CONFIRM");
assert.ok(createdTask.data.job.taskContract.scopeGroups.length >= 1);

const savedTemplate = await request(`/api/tasks/${encodeURIComponent(taskId)}/save-template`, {
  method: "POST",
  cookie: mediaLogin.cookie,
  body: { name: "冒烟历史任务模板" },
});
assert.equal(savedTemplate.status, 201);
assert.equal(savedTemplate.data.template.name, "冒烟历史任务模板");
assert.ok(savedTemplate.data.template.definition.fieldIds.includes("pgy.creator.fans"));
assert.ok(
  (await request("/api/collection-templates", { cookie: mediaLogin.cookie }))
    .data.templates.some((template) => template.id === savedTemplate.data.template.id),
);

const linksOnlyForm = new FormData();
linksOnlyForm.append(
  "file",
  new Blob([await fs.readFile(path.join(workbookRoot, "links-only.xlsx"))]),
  "links-only.xlsx",
);
linksOnlyForm.append("templateId", "dynamic");
linksOnlyForm.append(
  "selectedFields",
  JSON.stringify(savedTemplate.data.template.definition.fieldIds),
);
const linksOnlyUpload = await request("/api/upload", {
  method: "POST",
  cookie: mediaLogin.cookie,
  form: linksOnlyForm,
});
assert.equal(linksOnlyUpload.status, 200);
assert.equal(linksOnlyUpload.data.count, 1);
assert.ok(linksOnlyUpload.data.job.fieldMapping.pgyFieldCount >= 2);
assert.ok(linksOnlyUpload.data.job.selectedFields.includes("粉丝数"));
assert.equal(
  (await request(`/api/tasks/${encodeURIComponent(linksOnlyUpload.data.job.id)}`, {
    method: "DELETE",
    cookie: mediaLogin.cookie,
  })).status,
  200,
);
await fs.rm(workbookRoot, { recursive: true, force: true });

const vagueTask = await request("/api/tasks", {
  method: "POST",
  cookie: mediaLogin.cookie,
  body: {
    message: "采集 https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-vague 曝光中位数（90天）和阅读中位数（90天）",
  },
});
assert.equal(vagueTask.status, 201);
assert.equal(vagueTask.data.job.taskState, "NEEDS_CLARIFICATION");
assert.ok(vagueTask.data.job.taskContract.unresolvedCount >= 1);
assert.ok(vagueTask.data.job.taskContract.clarification.questions.length >= 1);
assert.equal(
  (await request(`/api/tasks/${encodeURIComponent(vagueTask.data.job.id)}`, {
    method: "DELETE",
    cookie: mediaLogin.cookie,
  })).status,
  200,
);

const confirmed = await request(`/api/tasks/${encodeURIComponent(taskId)}/confirm`, {
  method: "POST",
  cookie: mediaLogin.cookie,
  body: { version: createdTask.data.job.taskContract.version },
});
assert.equal(confirmed.status, 200);
assert.equal(confirmed.data.job.taskState, "CONFIRMED");

const started = await request(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
  method: "POST",
  cookie: mediaLogin.cookie,
  body: {},
});
assert.equal(started.status, 202);
const needsAttention = await pollTask(
  taskId,
  mediaLogin.cookie,
  (task) => task.taskState === "NEEDS_ATTENTION",
);
assert.equal(needsAttention.status, "failed");
assert.match(needsAttention.error, /尚未连接蒲公英|个人中心/);

const copied = await request(`/api/tasks/${encodeURIComponent(taskId)}/copy`, {
  method: "POST",
  cookie: mediaLogin.cookie,
});
assert.equal(copied.status, 201);
assert.match(copied.data.task.originalName, /副本/);

const listed = await request("/api/tasks", { cookie: mediaLogin.cookie });
assert.equal(listed.status, 200);
assert.equal(listed.data.tasks.length, 2);

const deleted = await request(`/api/tasks/${encodeURIComponent(taskId)}`, {
  method: "DELETE",
  cookie: mediaLogin.cookie,
});
assert.equal(deleted.status, 200);
assert.equal(
  (await request("/api/tasks", { cookie: mediaLogin.cookie })).data.tasks.length,
  1,
);

const adminAnalytics = await request("/api/admin/analytics?days=7", {
  cookie: adminLogin.cookie,
});
assert.equal(adminAnalytics.status, 200);
assert.ok(adminAnalytics.data.stability.loginExpired >= 1);
assert.equal(
  (await request("/api/admin/analytics?days=7", { cookie: mediaLogin.cookie })).status,
  403,
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "unauthenticated-healthz",
    "unauthenticated-401",
    "admin-login",
    "shared-pgy-admin-policy",
    "media-role-isolation",
    "pgy-preview-user-scoped",
    "direct-link-limit",
    "excel-template-external-links",
    "ambiguous-link-clarification",
    "dynamic-link-contract-confirmed",
    "history-task-saved-template",
    "saved-template-links-only-excel",
    "pgy-missing-needs-attention",
    "task-copy",
    "task-delete",
    "admin-analytics",
  ],
}));
