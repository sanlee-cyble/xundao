#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createBackgroundCollectContext, verifyPgyLoginState } from "../src/pgy_collect_core.mjs";
import { loadEncryptedStorageState } from "../src/pgy_connection_service.mjs";
import { compileScopeRequest, extractContractValues } from "../src/collection_plan.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`缺少参数 --${name}`);
  return path.resolve(options[name]);
}

function normalizedText(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function targetRequest(url, creatorId) {
  if (!url.includes("/api/solar/kol/data_v3/notes_rate")) return false;
  const params = new URL(url).searchParams;
  return params.get("userId") === creatorId
    && Number(params.get("business")) === 1
    && Number(params.get("noteType")) === 3
    && Number(params.get("dateType")) === 2
    && Number(params.get("advertiseSwitch")) === 1;
}

async function clickExact(page, text, { last = false, waitMs = 700 } = {}) {
  const clicked = await page.evaluate(({ target, useLast }) => {
    const normalize = (value) => String(value || "").trim().replace(/\s+/g, "");
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("button,div,span,a,li"))
      .filter((element) => visible(element) && normalize(element.innerText || element.textContent) === normalize(target));
    const leaves = candidates.filter((element) => !Array.from(element.children)
      .some((child) => visible(child) && normalize(child.innerText || child.textContent) === normalize(target)));
    const pool = leaves.length ? leaves : candidates;
    const element = useLast ? pool.at(-1) : pool[0];
    if (!element) return false;
    element.click();
    return true;
  }, { target: text, useLast: last });
  if (clicked) await page.waitForTimeout(waitMs);
  return clicked;
}

async function visibleSelectTexts(page) {
  return page.locator(".d-select-wrapper:visible").allTextContents()
    .then((values) => values.map(normalizedText))
    .catch(() => []);
}

async function selectDropdown(page, {
  currentPattern,
  desiredLabels,
  waitMs = 900,
  lastMatch = true,
}) {
  const wrappers = page.locator(".d-select-wrapper:visible");
  const count = await wrappers.count();
  let wrapper = null;
  let currentText = "";
  const indexes = lastMatch
    ? Array.from({ length: count }, (_, index) => count - index - 1)
    : Array.from({ length: count }, (_, index) => index);
  for (const index of indexes) {
    const candidate = wrappers.nth(index);
    const text = normalizedText(await candidate.innerText().catch(() => ""));
    if (currentPattern.test(text)) {
      wrapper = candidate;
      currentText = text;
      break;
    }
  }
  if (!wrapper) {
    return {
      opened: false,
      selected: false,
      currentText,
      optionTexts: [],
    };
  }
  await wrapper.click();
  await page.waitForTimeout(300);
  const options = page.locator(".d-popover:visible .d-option-content");
  const optionTexts = (await options.allTextContents()).map(normalizedText);
  let selectedText = "";
  for (let index = optionTexts.length - 1; index >= 0; index -= 1) {
    if (!desiredLabels.includes(optionTexts[index])) continue;
    await options.nth(index).click();
    selectedText = optionTexts[index];
    await page.waitForTimeout(waitMs);
    break;
  }
  if (!selectedText) await page.keyboard.press("Escape").catch(() => {});
  return {
    opened: true,
    selected: Boolean(selectedText),
    selectedText,
    currentText,
    optionTexts,
  };
}

async function waitForTarget(observed, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const success = observed.find((item) => item.target && item.status === 200 && item.body?.code === 0);
    if (success) return success;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function collectOne(context, creator, scope, outputRoot) {
  const page = await context.newPage();
  const observed = [];
  const targetResponses = [];
  const responseTasks = new Set();
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/solar/kol/data_v3/notes_rate")) return;
    const task = (async () => {
      const parsed = new URL(url);
      const params = Object.fromEntries(parsed.searchParams.entries());
      const isTarget = targetRequest(url, creator.creatorId);
      const body = await response.json().catch(() => ({}));
      const item = {
        status: response.status(),
        target: isTarget,
        params: {
          business: params.business,
          noteType: params.noteType,
          dateType: params.dateType,
          advertiseSwitch: params.advertiseSwitch,
        },
        body,
      };
      observed.push(item);
      if (isTarget) targetResponses.push(item);
    })();
    responseTasks.add(task);
    task.finally(() => responseTasks.delete(task));
  });

  const creatorDir = path.join(
    outputRoot,
    `${creator.rowIndex}_${String(creator.nickname || creator.creatorId).replace(/[^\p{L}\p{N}._-]+/gu, "_")}_${creator.creatorId}`,
  );
  await fs.mkdir(creatorDir, { recursive: true });

  try {
    await page.goto(creator.pgyLink, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const noteDataClicked = await clickExact(page, "笔记数据", { waitMs: 900 });
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.58)));
    await page.waitForTimeout(700);
    const cooperationClicked = await clickExact(page, "合作笔记", { last: true, waitMs: 900 });
    const noteType = await selectDropdown(page, {
      currentPattern: /^(图文\+视频|图文笔记\+视频笔记|图文笔记|视频笔记|图文|视频)$/,
      desiredLabels: ["图文+视频", "图文笔记+视频笔记"],
    });
    const flow = await selectDropdown(page, {
      currentPattern: /^(全流量|仅自然流量)$/,
      desiredLabels: ["全流量"],
    });
    const window = await selectDropdown(page, {
      currentPattern: /^近(30|90)日$/,
      desiredLabels: ["近90日"],
      waitMs: 1200,
      lastMatch: false,
    });
    const scaleClicked = await clickExact(page, "按规模", { last: true, waitMs: 900 });
    let success = await waitForTarget(observed, 9000);

    if (!success) {
      await selectDropdown(page, {
        currentPattern: /^近(30|90)日$/,
        desiredLabels: ["近30日"],
        waitMs: 900,
        lastMatch: false,
      });
      await selectDropdown(page, {
        currentPattern: /^近(30|90)日$/,
        desiredLabels: ["近90日"],
        waitMs: 1200,
        lastMatch: false,
      });
      success = await waitForTarget(observed, 9000);
    }

    await Promise.allSettled([...responseTasks]);
    const controls = await visibleSelectTexts(page);
    const actions = {
      noteDataClicked,
      cooperationClicked,
      noteType,
      flow,
      window,
      scaleClicked,
      controls,
    };

    if (!success) {
      await page.screenshot({ path: path.join(creatorDir, "failure.png"), fullPage: true }).catch(() => {});
      const pageText = await page.locator("body").innerText().catch(() => "");
      await fs.writeFile(path.join(creatorDir, "failure-page.txt"), pageText, "utf8");
      return {
        rowIndex: creator.rowIndex,
        creatorId: creator.creatorId,
        nickname: creator.nickname,
        ok: false,
        actions,
        observed: observed.map(({ body, ...item }) => ({
          ...item,
          code: body?.code ?? null,
          success: body?.success ?? null,
        })),
      };
    }

    const request = compileScopeRequest(scope, creator.creatorId);
    const contractValues = extractContractValues(request, success.body);
    const evidencePath = path.join(creatorDir, "scope2-notes-rate.json");
    await fs.writeFile(evidencePath, `${JSON.stringify({
      request: {
        endpoint: request.endpoint,
        method: request.method,
        params: request.params,
      },
      response: {
        status: success.status,
        body: success.body,
      },
    }, null, 2)}\n`, "utf8");
    return {
      rowIndex: creator.rowIndex,
      creatorId: creator.creatorId,
      nickname: creator.nickname,
      ok: true,
      actions,
      contractValues,
      evidencePath,
      noteNumber: success.body?.data?.noteNumber ?? null,
      observed: observed.map(({ body, ...item }) => ({
        ...item,
        code: body?.code ?? null,
        success: body?.success ?? null,
      })),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const options = parseArgs(process.argv.slice(2));
const runDir = required(options, "run-dir");
const encryptedStatePath = path.resolve(options["encrypted-state"] || "data/pgy-profiles/user-local-admin/connection-state.enc");
const keyPath = path.resolve(options["key-file"] || "data/.pgy-connection.key");
const limit = Math.max(0, Number(options.limit || 0));
const task = JSON.parse(await fs.readFile(path.join(runDir, "task.json"), "utf8"));
const creators = JSON.parse(await fs.readFile(path.join(runDir, "creators.json"), "utf8"));
const scope = (task.taskContract?.scopeGroups || task.scopeGroups || [])
  .find((item) => item.scene === "cooperation"
    && item.contentType === "all"
    && item.window === "90d"
    && item.traffic === "all"
    && item.view === "scale");
if (!scope) throw new Error("任务中未找到 90 天合作笔记图文+视频全流量口径");

const secret = String(await fs.readFile(keyPath, "utf8")).trim();
const storageState = await loadEncryptedStorageState(encryptedStatePath, secret);
const context = await createBackgroundCollectContext(storageState);
const outputRoot = path.join(runDir, "scope2-ui-recovery");
await fs.mkdir(outputRoot, { recursive: true });

try {
  const login = await verifyPgyLoginState(context);
  if (!login.authenticated) throw new Error(login.reason);
  const selectedCreators = limit ? creators.slice(0, limit) : creators;
  const recovery = [];
  for (let index = 0; index < selectedCreators.length; index += 1) {
    const creator = selectedCreators[index];
    process.stdout.write(`采集 ${index + 1}/${selectedCreators.length} ${creator.nickname || creator.creatorId}... `);
    const result = await collectOne(context, creator, scope, outputRoot);
    recovery.push(result);
    await fs.writeFile(
      path.join(runDir, "scope2-ui-recovery.json"),
      `${JSON.stringify(recovery, null, 2)}\n`,
      "utf8",
    );
    console.log(result.ok ? `成功（样本 ${result.noteNumber ?? "未知"}）` : "失败");
  }
  const succeeded = recovery.filter((item) => item.ok).length;
  console.log(JSON.stringify({
    ok: succeeded === recovery.length,
    attempted: recovery.length,
    succeeded,
    failed: recovery.length - succeeded,
    output: path.join(runDir, "scope2-ui-recovery.json"),
  }));
} finally {
  await context.close().catch(() => {});
}
