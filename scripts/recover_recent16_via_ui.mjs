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

function notesDetailParams(url, creatorId) {
  if (!url.includes("/api/solar/kol/data_v2/notes_detail")) return null;
  const params = new URL(url).searchParams;
  if (params.get("userId") !== creatorId || Number(params.get("noteType")) !== 4) return null;
  return {
    pageNumber: Number(params.get("pageNumber")),
    pageSize: Number(params.get("pageSize")),
  };
}

async function findCreatorDirectory(rawDir, creatorId) {
  const entries = await fs.readdir(rawDir, { withFileTypes: true }).catch(() => []);
  const entry = entries.find((item) => item.isDirectory() && item.name.includes(creatorId));
  return entry ? path.join(rawDir, entry.name) : "";
}

async function existingNotes(creatorDir, creatorId) {
  const responseDir = path.join(creatorDir, "responses");
  const filenames = (await fs.readdir(responseDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const records = [];
  for (const filename of filenames) {
    const record = JSON.parse(await fs.readFile(path.join(responseDir, filename), "utf8"));
    const params = notesDetailParams(record.request?.url || "", creatorId);
    if (!params || Number(record.response?.status) !== 200 || record.body?.code !== 0) continue;
    records.push({
      ...params,
      body: record.body,
      evidencePath: path.join(responseDir, filename),
    });
  }
  return records;
}

async function clickNotesData(page) {
  const clicked = await page.evaluate(() => {
    const normalize = (value) => String(value || "").trim().replace(/\s+/g, "");
    const candidates = Array.from(document.querySelectorAll("button,div,span,a"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return normalize(element.innerText || element.textContent) === "笔记数据"
          && rect.width > 0
          && rect.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden";
      });
    const element = candidates.find((candidate) => !Array.from(candidate.children)
      .some((child) => normalize(child.innerText || child.textContent) === "笔记数据")) || candidates[0];
    if (!element) return false;
    element.click();
    return true;
  });
  if (clicked) await page.waitForTimeout(800);
  return clicked;
}

async function clickPageTwo(page) {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll(".d-pagination .d-pagination-page-content"))
      .filter((element) => (element.textContent || "").trim() === "2");
    const target = labels.at(-1)?.closest(".d-pagination-page.d-clickable");
    if (!target) return false;
    target.scrollIntoView({ block: "center" });
    target.click();
    return true;
  });
}

async function collectOne(context, creator, runDir, scope) {
  const rawDir = path.join(runDir, "raw");
  const creatorDir = await findCreatorDirectory(rawDir, creator.creatorId);
  if (!creatorDir) throw new Error(`未找到 ${creator.nickname || creator.creatorId} 的原始证据目录`);
  const responseDir = path.join(creatorDir, "responses");
  const page = await context.newPage();
  const captured = [];
  const responseTasks = new Set();
  page.on("response", (response) => {
    const params = notesDetailParams(response.url(), creator.creatorId);
    if (!params || response.status() !== 200) return;
    const task = (async () => {
      const body = await response.json().catch(() => ({}));
      if (body?.code !== 0) return;
      captured.push({
        ...params,
        body,
        url: response.url(),
      });
    })();
    responseTasks.add(task);
    task.finally(() => responseTasks.delete(task));
  });

  try {
    await page.goto(creator.pgyLink, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await clickNotesData(page);
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.48)));
    await page.waitForTimeout(600);
    const pageTwoClicked = await clickPageTwo(page);
    if (pageTwoClicked) await page.waitForTimeout(1600);
    await Promise.allSettled([...responseTasks]);

    const existing = await existingNotes(creatorDir, creator.creatorId);
    const allRecords = [...existing, ...captured];
    const recordsByPage = new Map();
    for (const record of allRecords) {
      const current = recordsByPage.get(record.pageNumber);
      const currentLength = current?.body?.data?.list?.length || 0;
      const nextLength = record?.body?.data?.list?.length || 0;
      if (!current || nextLength >= currentLength) recordsByPage.set(record.pageNumber, record);
    }
    const notes = [...recordsByPage.values()]
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .flatMap((record) => record.body?.data?.list || [])
      .slice(0, 16);
    if (!notes.length) throw new Error(`${creator.nickname || creator.creatorId} 未找到近16篇笔记数据`);

    let pageTwoEvidencePath = "";
    const capturedPageTwo = captured.find((record) => record.pageNumber === 2);
    if (capturedPageTwo) {
      const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_200__api_solar_kol_data_v2_notes_detail_page2.json`;
      pageTwoEvidencePath = path.join(responseDir, filename);
      await fs.writeFile(pageTwoEvidencePath, `${JSON.stringify({
        request: {
          method: "GET",
          url: capturedPageTwo.url,
          postData: "",
        },
        response: { status: 200 },
        body: capturedPageTwo.body,
      }, null, 2)}\n`, "utf8");
    }
    const request = compileScopeRequest(scope, creator.creatorId);
    const contractValues = extractContractValues(request, {
      code: 0,
      success: true,
      data: { list: notes },
    });
    return {
      rowIndex: creator.rowIndex,
      creatorId: creator.creatorId,
      nickname: creator.nickname,
      ok: true,
      pageTwoClicked,
      noteCount: notes.length,
      contractValues,
      evidencePaths: [
        ...new Set([
          ...existing.map((record) => record.evidencePath),
          ...(pageTwoEvidencePath ? [pageTwoEvidencePath] : []),
        ]),
      ],
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const options = parseArgs(process.argv.slice(2));
const runDir = required(options, "run-dir");
const encryptedStatePath = path.resolve(options["encrypted-state"] || "data/pgy-profiles/user-local-admin/connection-state.enc");
const keyPath = path.resolve(options["key-file"] || "data/.pgy-connection.key");
const task = JSON.parse(await fs.readFile(path.join(runDir, "task.json"), "utf8"));
const creators = JSON.parse(await fs.readFile(path.join(runDir, "creators.json"), "utf8"));
const scope = (task.taskContract?.scopeGroups || task.scopeGroups || [])
  .find((item) => item.window === "recent16" && item.view === "list");
if (!scope) throw new Error("任务中未找到近16篇笔记口径");

const secret = String(await fs.readFile(keyPath, "utf8")).trim();
const storageState = await loadEncryptedStorageState(encryptedStatePath, secret);
const context = await createBackgroundCollectContext(storageState);
const outputPath = path.join(runDir, "recent16-ui-recovery.json");

try {
  const login = await verifyPgyLoginState(context);
  if (!login.authenticated) throw new Error(login.reason);
  const recovery = [];
  for (let index = 0; index < creators.length; index += 1) {
    const creator = creators[index];
    process.stdout.write(`近16篇 ${index + 1}/${creators.length} ${creator.nickname || creator.creatorId}... `);
    const result = await collectOne(context, creator, runDir, scope);
    recovery.push(result);
    await fs.writeFile(outputPath, `${JSON.stringify(recovery, null, 2)}\n`, "utf8");
    console.log(`成功（${result.noteCount} 篇）`);
  }
  console.log(JSON.stringify({
    ok: true,
    attempted: recovery.length,
    succeeded: recovery.filter((item) => item.ok).length,
    outputPath,
  }));
} finally {
  await context.close().catch(() => {});
}
