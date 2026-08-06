#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createBackgroundCollectContext } from "./pgy_collect_core.mjs";
import { nowStamp, safeFilename, writeJson } from "./common.mjs";

function argsFrom(argv) {
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

async function creatorDirectory(rawDir, creatorId) {
  const entries = await fs.readdir(rawDir, { withFileTypes: true });
  const entry = entries.find((item) => item.isDirectory() && item.name.includes(creatorId));
  if (!entry) throw new Error(`未找到 ${creatorId} 的证据目录`);
  return path.join(rawDir, entry.name);
}

const options = argsFrom(process.argv.slice(2));
const creators = JSON.parse(await fs.readFile(required(options, "creators"), "utf8"));
const rawDir = path.join(required(options, "raw-run-dir"), "raw");
const storageStatePath = required(options, "storage-state");
const context = await createBackgroundCollectContext(storageStatePath);

try {
  for (const creator of creators) {
    const page = await context.newPage();
    let captured = null;
    page.on("response", (response) => {
      const url = response.url();
      if (!url.includes("/notes_detail") || !url.includes("pageNumber=2") || response.status() !== 200) return;
      captured = (async () => ({
        request: {
          method: response.request().method(),
          url,
          postData: response.request().postData() || "",
        },
        response: { status: response.status() },
        body: await response.json(),
      }))();
    });
    await page.goto(creator.pgyLink, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const clicked = await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll(".d-pagination .d-pagination-page-content"))
        .find((element) => (element.textContent || "").trim() === "2");
      const target = label?.closest(".d-pagination-page.d-clickable");
      if (!target) return false;
      target.click();
      return true;
    });
    if (!clicked) throw new Error(`${creator.nickname || creator.creatorId} 未找到近16篇分页按钮`);
    await page.waitForTimeout(1500);
    const record = captured ? await captured : null;
    if (!record) throw new Error(`${creator.nickname || creator.creatorId} 未捕获近16篇第二页接口`);
    const directory = await creatorDirectory(rawDir, creator.creatorId);
    const responseDir = path.join(directory, "responses");
    const filename = `${nowStamp()}_200_${safeFilename(new URL(record.request.url).pathname)}_page2.json`;
    await writeJson(path.join(responseDir, filename), record);
    console.log(`已补采近16篇第2页：${creator.nickname || creator.creatorId}`);
    await page.close();
  }
} finally {
  await context.close().catch(() => {});
}
