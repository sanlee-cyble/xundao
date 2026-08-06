# 寻达 Agent LUI 达人工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有“找达人＋品牌模板采集＋Excel 回填”升级为由确定性状态机管理、支持动态字段合同、Qwen/DeepSeek Agent、账户权限、蒲公英长期连接、7 天任务留存和统一 LUI 的团队工作台。

**Architecture:** 以结构化 `TaskContract` 为事实来源，状态机控制解析、澄清、确认、采集、校验、导出和过期；Qwen 负责语义理解与澄清，DeepSeek 负责复核、异常解释和证据文本；现有蒲公英采集器被改造成只执行已验证计划的确定性工具。SQLite 保持本地可用，PostgreSQL 用于团队部署，两个数据库共享同一逻辑 Schema。

**Tech Stack:** Node.js ESM、原生 HTTP Server、SQLite/PostgreSQL、Playwright、Python/OpenPyXL、Qwen3.7-Max、DeepSeek V4-Pro、原生 HTML/CSS/JavaScript、Node test runner。

---

## 当前实施进度（2026-07-30）

| Release | 状态 | 已完成 | 仍需生产验收 |
|---|---|---|---|
| R0 字段合同与状态机 | 已完成 | 完整字段唯一键、动态口径组、歧义门、版本确认、非法转换测试 | 无 |
| R1 通用采集与 Excel | 已完成代码与离线验收 | 精确蒲公英参数、按口径组检查点、公式/模型/人工字段分流、真实美德乐表解析、字段模板与另贴链接合并、仅链接 Excel 自动追加模板字段 | 使用有效蒲公英登录态跑完 3 位达人并人工抽查页面值 |
| R2 账户、连接、留存 | 已完成 | scrypt、HttpOnly Cookie、管理员/媒介、用户隔离、站内扫码连接、加密连接恢复与验活、显式工作区共享连接、任务复制、7 天清理 | 用真实账号验证 ECS 站内扫码与共享回退 |
| R3 LUI、个人中心、管理后台 | 已完成第一版 | 单一输入框、最小追问、字段库勾选、历史任务固化模板、模板字段微调、无 Excel 通用导出、最近任务、个人中心、角色管理后台 | 业务同学可用性走查 |
| R4 寻找达人统一入口 | 已接入 | 统一意图切换、规则优先路由、复用现有寻找后端 | “先找再采集”的真实连续任务验收 |

自动化发布门为 `npm run test:release`，当前 81 项全量测试与 55 项集成测试通过。强制登录隔离实例已验证未登录 401、管理员登录与会话恢复、媒介访问管理员接口 403、共享连接管理权限、10 位以上链接导入限制、字段模板与另贴链接合并、模糊链接任务追问、历史任务固化模板和仅链接 Excel 自动追加字段，并通过连接缺失回到需处理、复制、删除和管理员观测的 16 项真实 HTTP 冒烟测试。Qwen3.7-Max 与 DeepSeek V4-Pro 的真实最小连通请求已通过。详见 `docs/release-checklist.md`。

---

## 0. 实施边界与提交策略

本计划拆成五个可独立验收的 Release：

```text
R0 字段合同与状态机
R1 通用采集与 Excel 闭环
R2 账户、蒲公英连接和 7 天留存
R3 统一 LUI、个人中心和管理后台
R4 寻找达人统一入口
```

每个 Release 必须通过自己的测试和验收，后一个 Release 不得替代前一个 Release 的确定性能力。

## Task 1: 建立基线和端到端黄金样例

**Files:**
- Create: `tests/fixtures/medela-mixed-scope-task.json`
- Create: `tests/fixtures/ambiguous-header-task.json`
- Create: `tests/task_acceptance.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 保存当前测试表对应的黄金任务合同**

`tests/fixtures/medela-mixed-scope-task.json` 固定四个口径组：

```json
{
  "scopeGroups": [
    {
      "id": "coop-90-all",
      "scene": "cooperation",
      "contentType": "all",
      "window": "90d",
      "traffic": "all",
      "fields": ["exposure_median", "read_median", "like_median", "collect_median", "traffic_sources"]
    },
    {
      "id": "coop-90-natural",
      "scene": "cooperation",
      "contentType": "all",
      "window": "90d",
      "traffic": "natural",
      "fields": ["exposure", "read"]
    },
    {
      "id": "daily-30-all",
      "scene": "daily",
      "contentType": "all",
      "window": "30d",
      "traffic": "all",
      "fields": ["exposure_median", "read_median", "like_median", "collect_median"]
    },
    {
      "id": "recent-16",
      "scene": "all",
      "contentType": "all",
      "window": "recent16",
      "traffic": "original",
      "fields": ["max_read", "max_like", "max_collect"]
    }
  ]
}
```

- [ ] **Step 2: 写入一个不可自动执行的模糊表头样例**

`tests/fixtures/ambiguous-header-task.json`：

```json
{
  "columns": [
    {
      "column": "M",
      "label": "曝光中位数（90天）",
      "resolved": {
        "metric": "exposure",
        "statistic": "median",
        "window": "90d"
      },
      "missingDimensions": ["scene", "contentType", "traffic"]
    }
  ]
}
```

- [ ] **Step 3: 编写基线验收测试**

`tests/task_acceptance.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("黄金任务同时包含合作90天全流量、合作90天自然流和日常30天", async () => {
  const task = JSON.parse(await fs.readFile(
    new URL("./fixtures/medela-mixed-scope-task.json", import.meta.url),
    "utf8",
  ));
  assert.equal(task.scopeGroups.length, 4);
  assert.ok(task.scopeGroups.some((item) => item.scene === "cooperation" && item.window === "90d" && item.traffic === "all"));
  assert.ok(task.scopeGroups.some((item) => item.scene === "cooperation" && item.window === "90d" && item.traffic === "natural"));
  assert.ok(task.scopeGroups.some((item) => item.scene === "daily" && item.window === "30d" && item.traffic === "all"));
});

test("模糊字段保留缺失维度", async () => {
  const task = JSON.parse(await fs.readFile(
    new URL("./fixtures/ambiguous-header-task.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(task.columns[0].missingDimensions, ["scene", "contentType", "traffic"]);
});
```

- [ ] **Step 4: 增加分层测试命令**

在 `package.json` 增加：

```json
{
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "test:contracts": "node --test tests/field_contracts.test.mjs tests/task_state_machine.test.mjs tests/task_acceptance.test.mjs",
    "test:integration": "node --test tests/task_orchestrator.test.mjs tests/auth_service.test.mjs tests/retention_service.test.mjs",
    "test:release": "npm test && npm run test:integration"
  }
}
```

- [ ] **Step 5: 运行基线**

Run:

```bash
npm test
```

Expected: 当前 12 项测试和新增 2 项黄金样例测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add package.json tests/fixtures tests/task_acceptance.test.mjs
git commit -m "test: add agent workbench acceptance fixtures"
```

## Task 2: 建立完整字段合同

**Files:**
- Create: `src/field_contracts.mjs`
- Create: `tests/field_contracts.test.mjs`
- Modify: `src/field_registry.mjs`

- [ ] **Step 1: 编写字段合同验证测试**

`tests/field_contracts.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalFieldKey,
  groupFieldContracts,
  validateFieldContract,
} from "../src/field_contracts.mjs";

const cooperationAll = {
  fieldId: "pgy.note.exposure.median",
  metric: "exposure",
  statistic: "median",
  scene: "cooperation",
  contentType: "all",
  window: "90d",
  traffic: "all",
  view: "scale",
  source: "pgy",
  unit: "count",
};

test("字段唯一键包含所有影响取数的维度", () => {
  assert.equal(
    canonicalFieldKey(cooperationAll),
    "pgy.note.exposure.median|cooperation|all|90d|all|scale",
  );
});

test("缺少流量范围时不得成为可执行合同", () => {
  const result = validateFieldContract({ ...cooperationAll, traffic: "" });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingDimensions, ["traffic"]);
});

test("相同口径字段聚合为一个动态口径组", () => {
  const read = { ...cooperationAll, fieldId: "pgy.note.read.median", metric: "read" };
  assert.equal(groupFieldContracts([cooperationAll, read]).length, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test tests/field_contracts.test.mjs
```

Expected: FAIL，提示找不到 `src/field_contracts.mjs`。

- [ ] **Step 3: 实现字段合同**

`src/field_contracts.mjs`：

```js
const REQUIRED_DIMENSIONS = Object.freeze([
  "fieldId",
  "metric",
  "scene",
  "contentType",
  "window",
  "traffic",
  "view",
  "source",
  "unit",
]);

export function validateFieldContract(contract = {}) {
  const missingDimensions = REQUIRED_DIMENSIONS.filter((key) => {
    const value = contract[key];
    return value === undefined || value === null || String(value).trim() === "";
  });
  return { valid: missingDimensions.length === 0, missingDimensions };
}

export function canonicalFieldKey(contract) {
  const validation = validateFieldContract(contract);
  if (!validation.valid) {
    throw new Error(`字段合同缺少维度：${validation.missingDimensions.join("、")}`);
  }
  return [
    contract.fieldId,
    contract.scene,
    contract.contentType,
    contract.window,
    contract.traffic,
    contract.view,
  ].join("|");
}

export function scopeGroupKey(contract) {
  return [
    contract.scene,
    contract.contentType,
    contract.window,
    contract.traffic,
    contract.view,
  ].join("|");
}

export function groupFieldContracts(contracts = []) {
  const groups = new Map();
  for (const contract of contracts) {
    const validation = validateFieldContract(contract);
    if (!validation.valid) continue;
    const key = scopeGroupKey(contract);
    const group = groups.get(key) || {
      id: `scope-${groups.size + 1}`,
      key,
      scene: contract.scene,
      contentType: contract.contentType,
      window: contract.window,
      traffic: contract.traffic,
      view: contract.view,
      contracts: [],
    };
    group.contracts.push(contract);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}
```

- [ ] **Step 4: 将现有字段注册表暴露为合同**

在 `src/field_registry.mjs` 中保留原字段 ID 兼容层，同时为每个字段增加 `contract`。通用合作字段不得再把 `video` 作为未展示的默认语义；旧 ID 通过 `legacyIds` 映射。

核心导出：

```js
export function contractByFieldId(id, overrides = {}) {
  const item = fieldById(id);
  if (!item?.contract) return null;
  return { ...item.contract, ...overrides };
}
```

- [ ] **Step 5: 运行测试**

Run:

```bash
npm run test:contracts
```

Expected: PASS，默认视频兼容测试仍通过，新增合同测试通过。

- [ ] **Step 6: 提交**

```bash
git add src/field_contracts.mjs src/field_registry.mjs tests/field_contracts.test.mjs
git commit -m "feat: add canonical PGY field contracts"
```

## Task 3: 建立确定性任务状态机

**Files:**
- Create: `src/task_state_machine.mjs`
- Create: `tests/task_state_machine.test.mjs`

- [ ] **Step 1: 编写合法和非法转换测试**

`tests/task_state_machine.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { transitionTask } from "../src/task_state_machine.mjs";

test("未解决歧义的任务不能进入待确认", () => {
  assert.throws(
    () => transitionTask(
      { state: "PARSING", unresolvedCount: 1, version: 1 },
      "READY_TO_CONFIRM",
    ),
    /仍有 1 个未解决问题/,
  );
});

test("未确认任务不能开始采集", () => {
  assert.throws(
    () => transitionTask(
      { state: "READY_TO_CONFIRM", confirmedVersion: 0, version: 2 },
      "COLLECTING",
    ),
    /任务合同尚未确认/,
  );
});

test("已确认任务可以进入采集", () => {
  const next = transitionTask(
    { state: "CONFIRMED", confirmedVersion: 2, version: 2 },
    "COLLECTING",
  );
  assert.equal(next.state, "COLLECTING");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test tests/task_state_machine.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现状态机**

`src/task_state_machine.mjs`：

```js
export const TASK_STATES = Object.freeze([
  "DRAFT",
  "PARSING",
  "NEEDS_CLARIFICATION",
  "READY_TO_CONFIRM",
  "CONFIRMED",
  "COLLECTING",
  "NEEDS_ATTENTION",
  "VALIDATING",
  "EXPORTING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "DELETED",
]);

const ALLOWED = Object.freeze({
  DRAFT: ["PARSING", "DELETED"],
  PARSING: ["NEEDS_CLARIFICATION", "READY_TO_CONFIRM", "FAILED"],
  NEEDS_CLARIFICATION: ["PARSING", "DELETED"],
  READY_TO_CONFIRM: ["CONFIRMED", "PARSING", "DELETED"],
  CONFIRMED: ["COLLECTING", "PARSING", "DELETED"],
  COLLECTING: ["NEEDS_ATTENTION", "VALIDATING", "FAILED"],
  NEEDS_ATTENTION: ["COLLECTING", "VALIDATING", "FAILED", "DELETED"],
  VALIDATING: ["NEEDS_ATTENTION", "EXPORTING", "FAILED"],
  EXPORTING: ["COMPLETED", "FAILED"],
  COMPLETED: ["EXPIRED", "DELETED"],
  FAILED: ["PARSING", "COLLECTING", "DELETED"],
  EXPIRED: ["DELETED"],
  DELETED: [],
});

export function transitionTask(task, target, event = {}) {
  if (!TASK_STATES.includes(target)) throw new Error(`未知任务状态：${target}`);
  if (!(ALLOWED[task.state] || []).includes(target)) {
    throw new Error(`非法状态转换：${task.state} → ${target}`);
  }
  if (target === "READY_TO_CONFIRM" && Number(task.unresolvedCount) > 0) {
    throw new Error(`仍有 ${task.unresolvedCount} 个未解决问题`);
  }
  if (target === "COLLECTING" && Number(task.confirmedVersion) !== Number(task.version)) {
    throw new Error("任务合同尚未确认");
  }
  return {
    ...task,
    state: target,
    updatedAt: event.at || new Date().toISOString(),
    lastEvent: event.type || `task.${target.toLowerCase()}`,
  };
}
```

- [ ] **Step 4: 运行测试**

```bash
npm run test:contracts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/task_state_machine.mjs tests/task_state_machine.test.mjs
git commit -m "feat: add deterministic task state machine"
```

## Task 4: 将 Excel 解析升级为任务合同解析

**Files:**
- Create: `src/task_contract.mjs`
- Create: `src/semantic_resolver.mjs`
- Create: `tests/task_contract.test.mjs`
- Modify: `src/dynamic_workbook.mjs`

- [ ] **Step 1: 编写多口径和歧义测试**

`tests/task_contract.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbookColumns } from "../src/semantic_resolver.mjs";

test("父级90天合作笔记与自然流列拆成不同口径组", () => {
  const columns = [
    { letter: "M", parentLabel: "90天合作笔记", displayLabel: "曝光中位数（90天）" },
    { letter: "AE", parentLabel: "", displayLabel: "预估合作笔记自然流曝光" },
    { letter: "AG", parentLabel: "30天日常笔记", displayLabel: "曝光中位数（30天）" },
  ];
  const result = resolveWorkbookColumns(columns, {
    contentTypeDefault: "all",
    naturalWindowDefault: "90d",
  });
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.scopeGroups.length, 3);
  assert.equal(result.columns.find((item) => item.letter === "M").contract.traffic, "all");
  assert.equal(result.columns.find((item) => item.letter === "AE").contract.traffic, "natural");
  assert.equal(result.columns.find((item) => item.letter === "AG").contract.window, "30d");
});

test("曝光中位数缺少业务维度时生成澄清问题", () => {
  const result = resolveWorkbookColumns([
    { letter: "M", parentLabel: "", displayLabel: "曝光中位数（90天）" },
  ]);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.unresolved[0].missingDimensions, ["scene", "contentType", "traffic"]);
});
```

- [ ] **Step 2: 实现任务合同骨架**

`src/task_contract.mjs`：

```js
import { groupFieldContracts, validateFieldContract } from "./field_contracts.mjs";

export function createTaskContract({ columns = [], creators = [], source = {} } = {}) {
  const contracts = columns.map((item) => item.contract).filter(Boolean);
  const unresolved = columns
    .map((item) => {
      if (!item.contract) return item;
      const validation = validateFieldContract(item.contract);
      return validation.valid ? null : { ...item, missingDimensions: validation.missingDimensions };
    })
    .filter(Boolean);
  return {
    version: 1,
    source,
    creators,
    columns,
    scopeGroups: groupFieldContracts(contracts),
    unresolved,
    unresolvedCount: unresolved.length,
    confirmedVersion: 0,
  };
}
```

- [ ] **Step 3: 实现规则优先的语义解析器**

`src/semantic_resolver.mjs` 必须：

- 先使用父级和子级表头。
- 再使用任务级默认值。
- 输出 `resolvedBy`。
- 不使用隐藏品牌默认值。
- 无法确定时保留 `missingDimensions`。

核心接口：

```js
export function resolveWorkbookColumns(columns, defaults = {}) {
  const resolvedColumns = columns.map((column) => resolveColumn(column, defaults));
  const unresolved = resolvedColumns.filter((item) => item.missingDimensions.length > 0);
  const contracts = resolvedColumns.map((item) => item.contract).filter(Boolean);
  return {
    columns: resolvedColumns,
    unresolved,
    scopeGroups: groupFieldContracts(contracts),
  };
}
```

- [ ] **Step 4: 修改动态 Excel 解析**

`src/dynamic_workbook.mjs` 的 `analyzeWorkbookValues` 保留当前返回字段，并增加：

```js
{
  taskContract,
  scopeGroups: taskContract.scopeGroups,
  unresolved: taskContract.unresolved,
  unresolvedCount: taskContract.unresolvedCount
}
```

- [ ] **Step 5: 运行测试**

```bash
node --test tests/task_contract.test.mjs tests/dynamic_fields.test.mjs
```

Expected: PASS；当前美德乐动态字段映射不回归。

- [ ] **Step 6: 提交**

```bash
git add src/task_contract.mjs src/semantic_resolver.mjs src/dynamic_workbook.mjs tests/task_contract.test.mjs
git commit -m "feat: resolve Excel columns into task contracts"
```

## Task 5: 建立 Qwen/DeepSeek 模型网关和密钥边界

**Files:**
- Create: `src/model_gateway.mjs`
- Create: `src/qwen_service.mjs`
- Create: `src/clarification_service.mjs`
- Create: `scripts/run_with_qwen_csv_key.mjs`
- Create: `tests/model_gateway.test.mjs`
- Modify: `src/recommendation_service.mjs`
- Modify: `.env.example`

- [ ] **Step 1: 编写模型超时、重试和备用测试**

`tests/model_gateway.test.mjs` 使用注入的 `fetchImpl`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { callModelWithFallback } from "../src/model_gateway.mjs";

test("主模型失败后调用备用模型", async () => {
  const calls = [];
  const providers = {
    qwen: async () => {
      calls.push("qwen");
      throw new Error("timeout");
    },
    deepseek: async () => {
      calls.push("deepseek");
      return { ok: true };
    },
  };
  const result = await callModelWithFallback({
    primary: "qwen",
    fallback: "deepseek",
    providers,
    request: { purpose: "field_resolution" },
    attempts: 1,
  });
  assert.deepEqual(calls, ["qwen", "deepseek"]);
  assert.deepEqual(result, { ok: true });
});
```

- [ ] **Step 2: 实现模型网关**

`src/model_gateway.mjs`：

```js
export async function callModelWithFallback({
  primary,
  fallback,
  providers,
  request,
  attempts = 2,
}) {
  const order = [primary, fallback].filter(Boolean);
  let lastError = null;
  for (const providerName of order) {
    const provider = providers[providerName];
    if (!provider) continue;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await provider(request);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error("没有可用模型");
}
```

- [ ] **Step 3: 实现 Qwen Function Calling 客户端**

`src/qwen_service.mjs` 必须：

- 使用 `QWEN_API_KEY`。
- 使用 `QWEN_API_BASE` 和 `QWEN_MODEL=qwen3.7-max`。
- 只接受白名单工具。
- 验证工具名称和参数。
- 设置超时。
- 不依赖自由文本 JSON。

核心导出：

```js
export async function qwenToolCall({
  apiKey,
  baseUrl,
  model,
  messages,
  tools,
  timeoutMs = 90000,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `Qwen HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 实现澄清服务**

`src/clarification_service.mjs` 输出：

```js
{
  summary: "我理解……",
  questions: [
    {
      id: "clarify-1",
      prompt: "近16篇是否统计全部笔记？",
      options: ["全部笔记", "仅合作笔记", "仅日常笔记"],
      recommended: "全部笔记",
      affectedColumns: ["AN", "AO", "AP"]
    }
  ]
}
```

每轮 `questions` 不得超过 3 个，同类缺失维度合并。

- [ ] **Step 5: 增加 CSV 密钥启动器**

`scripts/run_with_qwen_csv_key.mjs` 只读取传入 CSV 中的密钥列，设置子进程环境变量，不输出密钥。通过 `QWEN_API_KEY_FILE` 传入用户提供的仓库外路径，代码和文档不硬编码个人绝对路径。

- [ ] **Step 6: 给 DeepSeek 增加超时**

修改 `src/recommendation_service.mjs` 的 `deepSeekJson`，增加 `AbortController` 和 `timeoutMs`，保持 JSON 校验和证据约束。

- [ ] **Step 7: 更新环境变量样例**

`.env.example` 增加：

```dotenv
QWEN_API_KEY=replace-with-qwen-key
QWEN_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-max
MODEL_TIMEOUT_MS=90000
DEEPSEEK_MODEL=deepseek-v4-pro
```

- [ ] **Step 8: 运行测试**

```bash
node --test tests/model_gateway.test.mjs
```

Expected: PASS，不产生真实网络请求。

- [ ] **Step 9: 提交**

```bash
git add src/model_gateway.mjs src/qwen_service.mjs src/clarification_service.mjs scripts/run_with_qwen_csv_key.mjs tests/model_gateway.test.mjs src/recommendation_service.mjs .env.example
git commit -m "feat: add bounded Qwen and DeepSeek model gateway"
```

## Task 6: 建立通用采集计划编译器

**Files:**
- Create: `src/collection_plan.mjs`
- Create: `tests/collection_plan.test.mjs`
- Modify: `src/field_registry.mjs`
- Modify: `src/pgy_collect_core.mjs`

- [ ] **Step 1: 编写精确参数测试**

`tests/collection_plan.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { compileTaskCollectionPlan } from "../src/collection_plan.mjs";

test("90天合作图文加视频全流量编译为 noteType=3 advertiseSwitch=1", () => {
  const plan = compileTaskCollectionPlan({
    scopeGroups: [{
      id: "group-a",
      scene: "cooperation",
      contentType: "all",
      window: "90d",
      traffic: "all",
      view: "scale",
      contracts: [{ fieldId: "pgy.note.exposure.median" }],
    }],
  }, "creator-1");
  assert.equal(plan.requests[0].params.business, 1);
  assert.equal(plan.requests[0].params.noteType, 3);
  assert.equal(plan.requests[0].params.dateType, 2);
  assert.equal(plan.requests[0].params.advertiseSwitch, 1);
});

test("同一任务允许全流量和自然流两个合作口径", () => {
  const plan = compileTaskCollectionPlan({
    scopeGroups: [
      { id: "all", scene: "cooperation", contentType: "all", window: "90d", traffic: "all", view: "scale", contracts: [] },
      { id: "natural", scene: "cooperation", contentType: "all", window: "90d", traffic: "natural", view: "scale", contracts: [] },
    ],
  }, "creator-1");
  assert.deepEqual(plan.requests.map((item) => item.params.advertiseSwitch).sort(), [0, 1]);
});
```

- [ ] **Step 2: 实现维度到蒲公英参数的确定性映射**

`src/collection_plan.mjs` 定义：

```js
const SCENE = Object.freeze({ daily: 0, cooperation: 1 });
const CONTENT_TYPE = Object.freeze({ video: 2, all: 3, image: 1 });
const WINDOW = Object.freeze({ "30d": 1, "90d": 2 });
const TRAFFIC = Object.freeze({ natural: 0, all: 1 });

export function compileScopeRequest(group, creatorId) {
  if (!(group.scene in SCENE)) throw new Error(`不支持的笔记属性：${group.scene}`);
  if (!(group.contentType in CONTENT_TYPE)) throw new Error(`不支持的内容类型：${group.contentType}`);
  if (!(group.window in WINDOW)) throw new Error(`不支持的时间周期：${group.window}`);
  if (!(group.traffic in TRAFFIC)) throw new Error(`不支持的流量范围：${group.traffic}`);
  return {
    id: `${creatorId}:${group.id}`,
    groupId: group.id,
    endpoint: "/api/solar/kol/data_v3/notes_rate",
    method: "GET",
    params: {
      userId: creatorId,
      business: SCENE[group.scene],
      noteType: CONTENT_TYPE[group.contentType],
      dateType: WINDOW[group.window],
      advertiseSwitch: TRAFFIC[group.traffic],
    },
    expectedFieldIds: group.contracts.map((item) => item.fieldId),
  };
}

export function compileTaskCollectionPlan(taskContract, creatorId) {
  return {
    creatorId,
    requests: taskContract.scopeGroups
      .filter((group) => group.window !== "recent16")
      .map((group) => compileScopeRequest(group, creatorId)),
  };
}
```

- [ ] **Step 3: 改造采集器只执行计划**

`src/pgy_collect_core.mjs` 增加：

```js
export async function collectCreatorPlan(context, creator, runDir, plan, config = {}) {
  if (!Array.isArray(plan?.requests)) throw new Error("缺少已编译采集计划");
  return collectCreator(context, creator, runDir, {
    ...config,
    plannedRequests: plan.requests,
  });
}
```

`prepareDetailPage` 不再根据品牌模板决定视频或图文+视频；它只接受已编译请求对应的明确 UI 操作参数。

- [ ] **Step 4: 保留旧模板兼容适配器**

旧富士和美德乐入口先转换成 `TaskContract`，再调用新计划编译器。不得维持两套独立采集逻辑。

- [ ] **Step 5: 运行测试**

```bash
node --test tests/collection_plan.test.mjs tests/medela_core.test.mjs tests/dynamic_fields.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/collection_plan.mjs src/field_registry.mjs src/pgy_collect_core.mjs tests/collection_plan.test.mjs
git commit -m "feat: compile task contracts into deterministic PGY plans"
```

## Task 7: 增加检查点、空值状态和中断续跑

**Files:**
- Create: `src/collection_checkpoint.mjs`
- Create: `src/value_status.mjs`
- Create: `tests/collection_checkpoint.test.mjs`
- Modify: `src/pgy_collect_core.mjs`
- Modify: `src/resume_dynamic_excel.mjs`

- [ ] **Step 1: 编写检查点测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { nextPendingScopes } from "../src/collection_checkpoint.mjs";

test("恢复任务时跳过已成功口径组", () => {
  const pending = nextPendingScopes(
    [{ id: "a" }, { id: "b" }],
    { a: { status: "COMPLETED" }, b: { status: "FAILED" } },
  );
  assert.deepEqual(pending.map((item) => item.id), ["b"]);
});
```

- [ ] **Step 2: 实现值状态**

`src/value_status.mjs`：

```js
export const VALUE_STATUS = Object.freeze({
  VALUE: "VALUE",
  ZERO: "ZERO",
  NO_SAMPLE: "NO_SAMPLE",
  UNSUPPORTED: "UNSUPPORTED",
  UNRESOLVED: "UNRESOLVED",
  COLLECTION_FAILED: "COLLECTION_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  MODEL_UNSUPPORTED: "MODEL_UNSUPPORTED",
  MANUAL_REQUIRED: "MANUAL_REQUIRED",
});

export function valueRecord({ value = null, status, source, evidence = [] }) {
  if (!Object.hasOwn(VALUE_STATUS, status)) throw new Error(`未知值状态：${status}`);
  return { value, status, source, evidence };
}
```

- [ ] **Step 3: 实现检查点**

`src/collection_checkpoint.mjs` 以 `jobId/creatorId/groupId` 为键，原子写入 JSON：

```js
export function nextPendingScopes(groups, checkpoints = {}) {
  return groups.filter((group) => checkpoints[group.id]?.status !== "COMPLETED");
}
```

文件写入使用临时文件后 `rename`，避免服务中断留下半个 JSON。

- [ ] **Step 4: 修改采集循环**

每完成一个口径组立即保存：

```js
{
  "status": "COMPLETED",
  "requestSignature": "business=1&noteType=3&dateType=2&advertiseSwitch=1",
  "completedAt": "2026-07-29T00:00:00.000Z",
  "fieldStatuses": {
    "pgy.note.exposure.median": "VALUE"
  }
}
```

- [ ] **Step 5: 修改恢复脚本**

`src/resume_dynamic_excel.mjs` 优先读取检查点，不再重新解析所有历史响应；只有缺少检查点的旧任务才使用兼容恢复。

- [ ] **Step 6: 运行测试**

```bash
node --test tests/collection_checkpoint.test.mjs
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/collection_checkpoint.mjs src/value_status.mjs src/pgy_collect_core.mjs src/resume_dynamic_excel.mjs tests/collection_checkpoint.test.mjs
git commit -m "feat: add resumable scope-level collection checkpoints"
```

## Task 8: 统一公式、模型和人工字段策略

**Files:**
- Create: `src/output_policy.mjs`
- Create: `tests/output_policy.test.mjs`
- Modify: `src/evidence_enrichment_service.mjs`
- Modify: `src/dynamic_workbook.mjs`

- [ ] **Step 1: 编写策略测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { outputPolicyForLabel } from "../src/output_policy.mjs";

test("CPC 使用公式", () => {
  assert.equal(outputPolicyForLabel("CPC").mode, "formula");
});

test("推荐理由使用证据模型", () => {
  assert.equal(outputPolicyForLabel("推荐理由").mode, "llm_evidence");
});

test("授权情况只能人工填写", () => {
  assert.equal(outputPolicyForLabel("授权情况").mode, "manual");
});
```

- [ ] **Step 2: 实现输出策略注册表**

`src/output_policy.mjs`：

```js
const POLICY = new Map([
  ["下单价", { mode: "formula", formulaId: "order_price" }],
  ["实际花费", { mode: "formula", formulaId: "actual_spend" }],
  ["CPC", { mode: "formula", formulaId: "cpc_natural_read" }],
  ["推荐理由", { mode: "llm_evidence", evidenceProfile: "recommendation" }],
  ["账号数据表现", { mode: "llm_evidence", evidenceProfile: "performance_summary" }],
  ["达人类型", { mode: "llm_restricted", evidenceProfile: "content_tags" }],
  ["内容方向", { mode: "llm_restricted", evidenceProfile: "content_tags" }],
  ["是否合作", { mode: "manual" }],
  ["合作方式", { mode: "manual" }],
  ["授权情况", { mode: "manual" }],
]);

export function outputPolicyForLabel(label) {
  return POLICY.get(String(label).trim()) || { mode: "source_or_unsupported" };
}
```

- [ ] **Step 3: 将 DeepSeek 调用改成按策略生成**

`src/evidence_enrichment_service.mjs` 只把 `llm_evidence` 和 `llm_restricted` 字段发送给模型；`manual` 直接生成 `MANUAL_REQUIRED`。

- [ ] **Step 4: 保持公式依赖**

`src/dynamic_workbook.mjs` 的 CPC 公式继续使用：

```excel
=IF(AF3>0,Z3/AF3,"")
```

计划编译时验证 CPC 依赖字段存在；不存在则记录 `UNSUPPORTED`，不生成错误公式。

- [ ] **Step 5: 运行测试**

```bash
node --test tests/output_policy.test.mjs tests/dynamic_fields.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/output_policy.mjs src/evidence_enrichment_service.mjs src/dynamic_workbook.mjs tests/output_policy.test.mjs
git commit -m "feat: enforce source formula model and manual output policies"
```

## Task 9: 扩展数据库和任务仓库

**Files:**
- Create: `src/database.mjs`
- Create: `src/task_repository.mjs`
- Create: `tests/task_repository.test.mjs`
- Modify: `deploy/postgres/schema.sql`
- Modify: `src/web_server.mjs`

- [ ] **Step 1: 将数据库适配器从 Web Server 提取**

`src/database.mjs` 统一导出：

```js
export async function createDatabase({ databaseUrl, sqlitePath });
export async function dbExec(database, sql);
export async function dbAll(database, sqliteSql, sqliteParams, pgSql, pgParams);
export async function dbGet(database, sqliteSql, sqliteParams, pgSql, pgParams);
export async function dbRun(database, sqliteSql, sqliteParams, pgSql, pgParams);
```

保持当前 SQLite/PostgreSQL 双模式行为。

- [ ] **Step 2: 扩展 Schema**

`jobs` 增加：

```sql
owner_user_id TEXT,
workspace_id TEXT,
state TEXT NOT NULL DEFAULT 'DRAFT',
task_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
task_contract_version INTEGER NOT NULL DEFAULT 1,
confirmation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
expires_at TEXT,
deleted_at TEXT,
resumable BOOLEAN NOT NULL DEFAULT TRUE
```

新增 `job_scope_groups` 和 `job_artifacts`，并为 `owner_user_id`、`expires_at`、`job_id` 建立索引。

- [ ] **Step 3: 实现任务仓库**

`src/task_repository.mjs` 提供：

```js
export function createTaskRepository(database) {
  return {
    create,
    getById,
    listForUser,
    updateState,
    saveContract,
    saveConfirmation,
    listExpired,
    markExpired,
  };
}
```

所有用户列表查询必须包含 `owner_user_id`；管理员查询通过显式 `listAllForAdmin`。

- [ ] **Step 4: 编写仓库隔离测试**

```js
test("普通用户只能读取自己的任务", async () => {
  const repository = await memoryTaskRepository([
    { id: "a", ownerUserId: "user-1" },
    { id: "b", ownerUserId: "user-2" },
  ]);
  const rows = await repository.listForUser("user-1");
  assert.deepEqual(rows.map((item) => item.id), ["a"]);
});
```

- [ ] **Step 5: 修改 Web Server 使用仓库**

`src/web_server.mjs` 不再直接拼接任务 SQL。先保持现有路由，逐步调用 `taskRepository`。

- [ ] **Step 6: 运行测试**

```bash
node --test tests/task_repository.test.mjs
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/database.mjs src/task_repository.mjs tests/task_repository.test.mjs deploy/postgres/schema.sql src/web_server.mjs
git commit -m "refactor: add database adapter and scoped task repository"
```

## Task 10: 建立 7 天留存和自动清理

**Files:**
- Create: `src/retention_service.mjs`
- Create: `tests/retention_service.test.mjs`
- Modify: `src/web_server.mjs`
- Modify: `.env.example`

- [ ] **Step 1: 编写到期测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { expiresAtForJob, isExpired } from "../src/retention_service.mjs";

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
```

- [ ] **Step 2: 实现留存服务**

`src/retention_service.mjs`：

```js
const DAY_MS = 24 * 60 * 60 * 1000;

export function expiresAtForJob(createdAt, days = 7) {
  return new Date(new Date(createdAt).getTime() + days * DAY_MS).toISOString();
}

export function isExpired(expiresAt, now = new Date().toISOString()) {
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}
```

清理函数必须使用数据库中已经解析的明确文件路径，确认路径位于 `RUNS_DIR` 或 `DATA_DIR` 后逐个删除，不接受用户输入路径。

- [ ] **Step 3: 服务启动时和定时执行**

`src/web_server.mjs`：

- 启动后执行一次。
- 每小时检查一次。
- 完成任务创建时写入 `expires_at`。
- 下载过期任务返回 HTTP 410。
- 提前删除写入 `task_deleted` 埋点。

- [ ] **Step 4: 更新配置**

`.env.example`：

```dotenv
TASK_RETENTION_DAYS=7
ANALYTICS_RETENTION_DAYS=180
```

- [ ] **Step 5: 运行测试**

```bash
node --test tests/retention_service.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/retention_service.mjs tests/retention_service.test.mjs src/web_server.mjs .env.example
git commit -m "feat: expire task data after seven days"
```

## Task 11: 建立寻达账户、会话和角色

**Files:**
- Create: `src/auth_service.mjs`
- Create: `src/auth_http.mjs`
- Create: `tests/auth_service.test.mjs`
- Modify: `deploy/postgres/schema.sql`
- Modify: `src/web_server.mjs`
- Modify: `.env.example`

- [ ] **Step 1: 新增用户和会话表**

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'media')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

- [ ] **Step 2: 编写密码和权限测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword, requireRole } from "../src/auth_service.mjs";

test("密码使用哈希验证", async () => {
  const encoded = await hashPassword("StrongPassword!23");
  assert.notEqual(encoded, "StrongPassword!23");
  assert.equal(await verifyPassword("StrongPassword!23", encoded), true);
  assert.equal(await verifyPassword("wrong", encoded), false);
});

test("媒介用户不能访问管理员接口", () => {
  assert.throws(() => requireRole({ role: "media" }, "admin"), /无管理员权限/);
});
```

- [ ] **Step 3: 使用 Node crypto.scrypt 实现密码哈希**

`src/auth_service.mjs` 使用随机 16 字节盐、`scrypt` 和 `timingSafeEqual`，编码为：

```text
scrypt$<salt-base64>$<hash-base64>
```

会话 Token 只把 SHA-256 哈希写入数据库。

- [ ] **Step 4: 实现认证 Cookie**

`src/auth_http.mjs`：

- Cookie 名：`xundao_session`。
- HttpOnly。
- SameSite=Lax。
- Path=/。
- 生产 HTTPS 环境增加 Secure。
- 登录、退出和当前用户 API。

- [ ] **Step 5: 增加路由**

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
POST /api/admin/users
PATCH /api/admin/users/:id
```

所有任务、蒲公英连接、历史和管理接口都必须读取服务端用户，不能再信任前端传入 `userId`。

- [ ] **Step 6: 增加首个管理员配置**

`.env.example`：

```dotenv
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=change-this-on-first-login
SESSION_TTL_DAYS=14
```

服务只在用户表为空时创建初始管理员，并记录强制修改密码状态。

- [ ] **Step 7: 运行测试**

```bash
node --test tests/auth_service.test.mjs
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/auth_service.mjs src/auth_http.mjs tests/auth_service.test.mjs deploy/postgres/schema.sql src/web_server.mjs .env.example
git commit -m "feat: add invited users sessions and role-based access"
```

## Task 12: 建立按用户隔离的蒲公英连接

**Files:**
- Create: `src/pgy_connection_service.mjs`
- Create: `tests/pgy_connection_service.test.mjs`
- Modify: `deploy/postgres/schema.sql`
- Modify: `src/pgy_collect_core.mjs`
- Modify: `src/web_server.mjs`
- Modify: `.env.example`

- [ ] **Step 1: 新增连接表**

```sql
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
```

- [ ] **Step 2: 编写隔离和状态测试**

```js
test("用户只能取得自己的蒲公英连接", async () => {
  const service = memoryConnectionService([
    { id: "c1", ownerType: "user", ownerId: "u1" },
    { id: "c2", ownerType: "user", ownerId: "u2" },
  ]);
  assert.equal((await service.getForUser("u1")).id, "c1");
});
```

- [ ] **Step 3: 加密保存 storageState**

`src/pgy_connection_service.mjs` 使用 `PGY_CONNECTION_ENCRYPTION_KEY` 派生 32 字节 AES-256-GCM 密钥，保存 `iv + authTag + ciphertext`；服务重启后在内存中解密并验活，任务目录不再写出明文 storageState。

- [ ] **Step 4: 改造持久化浏览器目录**

`src/pgy_collect_core.mjs` 的用户目录改成：

```text
<PGY_USER_DATA_ROOT>/<ownerType>-<ownerId>/
```

禁止不同用户复用同一个默认 `.pgy-browser-profile`。工作区共享连接必须通过管理员显式授权。

- [ ] **Step 5: 增加连接 API**

```text
POST   /api/pgy-connections/connect
GET    /api/pgy-connections/current
POST   /api/pgy-connections/verify
DELETE /api/pgy-connections/current
```

返回值只包含：

```json
{
  "status": "connected",
  "maskedAccountName": "浙***司",
  "lastVerifiedAt": "2026-07-29T00:00:00.000Z"
}
```

- [ ] **Step 6: 更新环境变量**

```dotenv
PGY_USER_DATA_ROOT=/app/pgy-profiles
PGY_CONNECTION_ENCRYPTION_KEY=replace-with-32-byte-secret
```

- [ ] **Step 7: 运行测试**

```bash
node --test tests/pgy_connection_service.test.mjs tests/medela_core.test.mjs
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/pgy_connection_service.mjs tests/pgy_connection_service.test.mjs deploy/postgres/schema.sql src/pgy_collect_core.mjs src/web_server.mjs .env.example
git commit -m "feat: persist isolated PGY connections per user"
```

## Task 13: 建立任务编排 API

**Files:**
- Create: `src/task_orchestrator.mjs`
- Create: `tests/task_orchestrator.test.mjs`
- Modify: `src/web_server.mjs`

- [ ] **Step 1: 编写状态驱动测试**

```js
test("上传模糊Excel后进入等待澄清", async () => {
  const task = await orchestrator.createFromParsedWorkbook({
    ownerUserId: "u1",
    parsed: { unresolvedCount: 1, unresolved: [{ id: "q1" }] },
  });
  assert.equal(task.state, "NEEDS_CLARIFICATION");
});

test("确认合同版本后才能开始采集", async () => {
  const confirmed = await orchestrator.confirm("job-1", "u1", 3);
  assert.equal(confirmed.confirmedVersion, 3);
  const running = await orchestrator.start("job-1", "u1");
  assert.equal(running.state, "COLLECTING");
});
```

- [ ] **Step 2: 实现编排器**

`src/task_orchestrator.mjs` 组合：

```text
taskRepository
taskStateMachine
semanticResolver
clarificationService
collectionPlanner
pgyConnectionService
retentionService
analyticsService
```

编排器是唯一允许改变任务状态的服务。

- [ ] **Step 3: 增加任务 API**

```text
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:id
POST /api/tasks/:id/messages
POST /api/tasks/:id/confirm
POST /api/tasks/:id/start
POST /api/tasks/:id/retry
DELETE /api/tasks/:id
GET  /api/tasks/:id/download
```

`messages` 接口只能生成候选修改；任何修改必须经过 `apply_scope_decision` 并形成版本事件。

- [ ] **Step 4: 保留旧 API 适配层**

`/api/upload` 和 `/api/collect` 暂时调用新编排器，前端完成迁移后再停止使用，避免一次性破坏当前工作台。

- [ ] **Step 5: 运行测试**

```bash
node --test tests/task_orchestrator.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/task_orchestrator.mjs tests/task_orchestrator.test.mjs src/web_server.mjs
git commit -m "feat: orchestrate task lifecycle through validated APIs"
```

## Task 14: 建立统一 LUI

**Files:**
- Create: `public/workbench.js`
- Create: `public/auth.js`
- Create: `public/history.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Create: `tests/lui_contract.test.mjs`

- [ ] **Step 1: 编写静态结构测试**

`tests/lui_contract.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("统一输入框同时提供采集和寻找模式", async () => {
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /data-intent="collect"/);
  assert.match(html, /data-intent="finder"/);
  assert.match(html, /id="luiComposer"/);
  assert.match(html, /id="recentTasks"/);
});
```

- [ ] **Step 2: 替换默认首页**

主工作区必须包含：

```html
<main class="lui-workbench">
  <section class="recent-tasks" id="recentTasks" aria-label="最近7天任务"></section>
  <section class="conversation" id="conversation" aria-live="polite"></section>
  <form class="lui-composer" id="luiComposer">
    <div class="intent-switch" aria-label="任务类型">
      <button type="button" data-intent="collect" aria-pressed="true">采集数据</button>
      <button type="button" data-intent="finder" aria-pressed="false">寻找达人</button>
    </div>
    <textarea id="luiInput" aria-label="任务描述" placeholder="上传Excel、粘贴蒲公英链接，或描述你需要的达人"></textarea>
    <input id="luiFile" type="file" accept=".xlsx,.xls" />
    <button type="submit">发送</button>
  </form>
</main>
```

- [ ] **Step 3: 实现对话驱动**

`public/workbench.js`：

- 提交文本和文件。
- 展示 AI 理解复述。
- 用文本问题和少量选择按钮展示澄清。
- 用户回复后调用 `/api/tasks/:id/messages`。
- 明确显示“确认并开始采集”。
- 采集中轮询任务状态。
- 异常时展示重试、跳过和重新连接。

不得要求普通用户默认展开完整字段合同。

- [ ] **Step 4: 实现最近任务**

`public/history.js` 读取 `/api/tasks`，展示：

- 状态。
- 达人数量。
- 创建和到期时间。
- 继续、复制、下载和删除。

- [ ] **Step 5: 保留寻找达人现有能力**

`public/app.js` 的现有寻找逻辑封装成：

```js
window.XundaoFinder = {
  search: handleFinderSearch,
  createCollectJob: handleCreateCollectJob,
};
```

统一 LUI 的 finder 模式调用该适配器。第一版不重写 `src/pgy_search_core.mjs`。

- [ ] **Step 6: 可访问性和反馈**

- 所有按钮具有文字标签。
- 键盘可完成模式切换、发送、确认和重试。
- 加载时按钮禁用并显示进度。
- 错误紧邻任务消息。
- 不依赖颜色单独表达状态。

- [ ] **Step 7: 运行测试**

```bash
node --test tests/lui_contract.test.mjs
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add public/index.html public/styles.css public/app.js public/workbench.js public/auth.js public/history.js tests/lui_contract.test.mjs
git commit -m "feat: replace split entry with unified conversational workbench"
```

## Task 15: 建立个人中心

**Files:**
- Create: `public/profile.js`
- Create: `src/profile_service.mjs`
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `src/web_server.mjs`

- [ ] **Step 1: 增加个人中心接口**

```text
GET  /api/profile
PATCH /api/profile
POST /api/profile/change-password
GET  /api/profile/performance
```

`/api/profile/performance` 只聚合当前用户最近 7 天任务。

- [ ] **Step 2: 个人中心界面**

包含四个区域：

```text
我的账号
蒲公英连接
我的数据表现
数据与隐私
```

展示连接状态、最后验证时间、重新连接和解除连接；不展示 Cookie 或本地目录。

- [ ] **Step 3: 增加提前删除**

“删除任务数据”调用 `DELETE /api/tasks/:id`，二次确认中显示任务名和不可恢复说明。

- [ ] **Step 4: 验证**

以普通用户登录：

- 只能看到自己的表现。
- 无法打开 `/api/admin/*`。
- 解除蒲公英连接后采集任务进入 `NEEDS_ATTENTION`。

- [ ] **Step 5: 提交**

```bash
git add public/profile.js src/profile_service.mjs public/index.html public/styles.css src/web_server.mjs
git commit -m "feat: add personal profile connection and performance views"
```

## Task 16: 升级管理员埋点和后台

**Files:**
- Create: `src/analytics_service.mjs`
- Create: `public/admin.js`
- Create: `tests/analytics_service.test.mjs`
- Modify: `src/web_server.mjs`
- Modify: `public/index.html`

- [ ] **Step 1: 将现有 analyticsSummary 提取为服务**

`src/analytics_service.mjs` 继续使用敏感字段清洗，并新增：

```text
clarification_requested
clarification_resolved
task_confirmed
scope_group_completed
validation_failed
model_call_completed
model_call_failed
pgy_connection_expired
task_expired
```

- [ ] **Step 2: 编写敏感字段测试**

```js
test("埋点清除凭据字段", () => {
  const clean = sanitizeAnalyticsProperties({
    token: "secret",
    cookie: "secret",
    password: "secret",
    taskCount: 3,
  });
  assert.deepEqual(clean, { taskCount: 3 });
});
```

- [ ] **Step 3: 管理接口改成角色认证**

移除共享 `ANALYTICS_ADMIN_TOKEN` 作为生产权限来源。`GET /api/admin/analytics` 必须要求 `role=admin`。

本地开发可以通过初始管理员登录，不再使用 open-local 绕过。

- [ ] **Step 4: 实现管理界面**

`public/admin.js` 展示：

- 用户和角色。
- 日活、任务、完成、失败和导出。
- 采集耗时和失败原因。
- 登录态健康。
- Qwen/DeepSeek 延迟、失败和调用量。
- AI 追问次数和一次确认率。

- [ ] **Step 5: 运行测试**

```bash
node --test tests/analytics_service.test.mjs tests/auth_service.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/analytics_service.mjs public/admin.js tests/analytics_service.test.mjs src/web_server.mjs public/index.html
git commit -m "feat: add role-protected admin analytics"
```

## Task 17: 接入寻找达人统一入口

**Files:**
- Create: `src/intent_router.mjs`
- Create: `tests/intent_router.test.mjs`
- Modify: `public/workbench.js`
- Modify: `src/web_server.mjs`
- Modify: `src/pgy_search_core.mjs`

- [ ] **Step 1: 编写确定性意图优先级测试**

```js
test("上传Excel优先识别为采集", () => {
  assert.equal(routeIntent({ hasExcel: true, text: "帮我处理" }).intent, "collect");
});

test("明确寻找表达识别为finder", () => {
  assert.equal(routeIntent({ hasExcel: false, text: "寻找50位母婴达人" }).intent, "finder");
});

test("先找再采集识别为两阶段", () => {
  assert.deepEqual(
    routeIntent({ hasExcel: false, text: "先找20位母婴达人，再采集90天合作笔记" }).stages,
    ["finder", "collect"],
  );
});
```

- [ ] **Step 2: 实现规则优先意图路由**

`src/intent_router.mjs` 先使用文件、链接和明确关键词；规则无法确定时才调用 Qwen。

- [ ] **Step 3: 将寻找结果保存为上游任务产物**

两阶段任务保存：

```json
{
  "stages": [
    { "id": "stage-1", "type": "finder", "status": "COMPLETED" },
    { "id": "stage-2", "type": "collect", "dependsOn": "stage-1", "status": "DRAFT" }
  ]
}
```

- [ ] **Step 4: 复用现有寻找后端**

`src/pgy_search_core.mjs` 的搜索和候选规范化保持独立工具；统一的是 LUI 和任务编排，不合并搜索与采集数据模型。

- [ ] **Step 5: 运行测试**

```bash
node --test tests/intent_router.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/intent_router.mjs tests/intent_router.test.mjs public/workbench.js src/web_server.mjs src/pgy_search_core.mjs
git commit -m "feat: route finder and collection through one LUI"
```

## Task 18: 更新部署、操作文档和生产安全配置

**Files:**
- Modify: `README.md`
- Modify: `docs/ecs-deployment.md`
- Modify: `deploy/postgres/schema.sql`
- Modify: `deploy/nginx/xundao.conf`
- Modify: `.env.example`

- [ ] **Step 1: 更新 README**

README 必须说明：

- 统一 LUI。
- 字段合同和状态机。
- Qwen/DeepSeek 分工。
- 用户登录和蒲公英连接。
- 7 天任务留存。
- 管理员权限。
- 本地和生产启动方法。

删除“美德乐模板固定视频口径”等已经不再作为系统默认的描述；保留旧模板兼容说明。

- [ ] **Step 2: 更新 ECS 文档**

明确：

- HTTPS 是生产登录必需条件。
- 初始化管理员。
- 数据库迁移。
- `PGY_CONNECTION_ENCRYPTION_KEY`。
- Qwen/DeepSeek 密钥。
- 任务和埋点留存。
- 蒲公英交互式重新连接方式。

- [ ] **Step 3: 配置安全响应头**

Nginx 增加：

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "same-origin" always;
add_header X-Frame-Options "DENY" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

- [ ] **Step 4: 验证 Schema**

在空 PostgreSQL 数据库执行 `deploy/postgres/schema.sql`，Expected: 所有表和索引成功创建，无重复迁移错误。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/ecs-deployment.md deploy/postgres/schema.sql deploy/nginx/xundao.conf .env.example
git commit -m "docs: document secure agent workbench deployment"
```

## Task 19: Release 级验证

**Files:**
- Create: `tests/release_gates.test.mjs`
- Create: `docs/release-checklist.md`

- [ ] **Step 1: 编写自动发布门测试**

`tests/release_gates.test.mjs` 覆盖：

```text
模糊字段不能进入确认
未确认不能采集
同任务允许多个口径组
视频与图文+视频参数不同
CPC 引用自然流阅读
业务事实保持人工字段
用户任务隔离
蒲公英连接隔离
七天到期
敏感埋点清洗
管理员角色保护
```

- [ ] **Step 2: 运行完整测试**

```bash
npm run test:release
```

Expected: 全部通过，0 fail。

- [ ] **Step 3: 运行当前美德乐测试表**

使用用户已经授权的蒲公英登录态和仓库外模型密钥执行当前测试表。Expected:

- 三位达人完成。
- 合作 90 天全流量使用 `business=1,noteType=3,dateType=2,advertiseSwitch=1`。
- 合作 90 天自然流使用 `business=1,noteType=3,dateType=2,advertiseSwitch=0`。
- 日常 30 天使用 `business=0,noteType=3,dateType=1,advertiseSwitch=1`。
- CPC 分母为自然流阅读。
- 是否合作、合作方式和授权情况保持人工字段。
- 公式错误扫描为 0。

- [ ] **Step 4: 浏览器验收**

以管理员和媒介账号分别验证：

```text
登录
连接蒲公英
上传测试表
完成自然语言澄清
确认任务
采集
查看进度
下载 Excel
打开最近任务
查看个人中心
查看或拒绝管理后台
```

- [ ] **Step 5: 验证中断恢复**

在完成至少一个达人后停止服务并重启。Expected:

- 任务进入可恢复状态。
- 已完成达人不重复采集。
- 继续后生成同一任务的最终 Excel。

- [ ] **Step 6: 验证 7 天清理**

使用测试时钟将任务推进到第 8 天。Expected:

- 下载返回 HTTP 410。
- 输入、输出和原始证据文件已删除。
- 聚合埋点仍存在。
- 管理后台不显示达人明细。

- [ ] **Step 7: 完成发布检查表**

`docs/release-checklist.md` 记录每项验证的执行时间、操作者、结果和证据路径，不记录密钥或登录态。

- [ ] **Step 8: 提交**

```bash
git add tests/release_gates.test.mjs docs/release-checklist.md
git commit -m "test: add agent workbench release gates"
```

## 20. 自审结果

### 规格覆盖

- 动态口径组：Task 2、4、6。
- 自然语言最小追问：Task 5、13、14。
- 确定性状态机：Task 3、13。
- 通用蒲公英采集：Task 6、7。
- 公式、模型和人工边界：Task 8。
- Qwen 与 DeepSeek：Task 5。
- 7 天历史和导出：Task 9、10、14。
- 寻达账号、角色和管理员：Task 11、16。
- 蒲公英长期连接：Task 12。
- 个人中心：Task 15。
- 统一 LUI：Task 14。
- 寻找达人 UI 合并：Task 17。
- 部署和发布门：Task 18、19。

### 类型一致性

- 任务状态统一使用大写枚举。
- 用户角色统一使用 `admin`、`media`。
- 蒲公英连接 owner 类型统一使用 `user`、`workspace`。
- 字段口径统一使用 `scene`、`contentType`、`window`、`traffic`、`view`。
- 任务合同版本统一使用 `version` 和 `confirmedVersion`。

### 安全边界

- 模型密钥不进入仓库。
- 蒲公英密码不保存。
- 登录态按用户隔离并加密。
- 管理员只能查看连接健康和聚合指标。
- 任务内容 7 天后删除。
