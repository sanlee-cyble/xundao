#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { appendJsonl, nowStamp, pickInteresting, readJson, safeFilename, writeJson } from "./common.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = await readJson(path.join(ROOT, "config/pgy_config.json"));
const COMMAND = process.argv[2] || "capture";
const AUTO = process.argv.includes("--auto");

async function loadCreators() {
  try {
    return await readJson(path.join(ROOT, CONFIG.creatorsJson));
  } catch {
    return [];
  }
}

function allowedUrl(url) {
  return CONFIG.networkAllowHostPatterns.some((host) => url.includes(host));
}

function looksJson(response) {
  const contentType = response.headers()["content-type"] || "";
  return contentType.includes("json") || response.url().includes("/api/");
}

function shouldPersistResponse(url, interesting) {
  if (interesting.score > 0) return true;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "pgy.xiaohongshu.com" && parsed.pathname.includes("/api/");
  } catch {
    return false;
  }
}

async function launch() {
  const userDataDir = path.join(ROOT, CONFIG.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  return await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 980 },
    acceptDownloads: true
  });
}

async function attachCapture(page, captureDir, creators) {
  const requestMap = new Map();
  const networkLog = path.join(captureDir, "network.jsonl");

  page.on("request", async (request) => {
    const url = request.url();
    if (!allowedUrl(url)) return;
    const record = {
      ts: new Date().toISOString(),
      type: "request",
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      postData: request.postData() || ""
    };
    requestMap.set(request, record);
    await appendJsonl(networkLog, record);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const url = response.url();
    if (!allowedUrl(url) || !looksJson(response)) return;

    const base = requestMap.get(request) || {
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      postData: request.postData() || ""
    };
    const headers = response.headers();
    const record = {
      ts: new Date().toISOString(),
      type: "response",
      status: response.status(),
      method: base.method,
      url,
      resourceType: base.resourceType,
      contentType: headers["content-type"] || "",
      postData: base.postData
    };

    try {
      const body = await response.text();
      record.bodyBytes = Buffer.byteLength(body);
      if (record.bodyBytes <= CONFIG.responseMaxBytes) {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        if (parsed) {
          const interesting = pickInteresting(parsed, creators, CONFIG.metricsHints);
          record.matchedCreators = interesting.matchedCreators;
          record.hitHints = interesting.hitHints;
          record.score = interesting.score;
          if (shouldPersistResponse(url, interesting)) {
            const filename = `${nowStamp()}_${response.status()}_${safeFilename(new URL(url).pathname)}.json`;
            const rawPath = path.join(captureDir, "responses", filename);
            await writeJson(rawPath, {
              request: base,
              response: {
                status: response.status(),
                url,
                headers
              },
              interesting,
              body: parsed
            });
            record.rawPath = path.relative(ROOT, rawPath);
          }
        }
      }
    } catch (error) {
      record.error = error.message;
    }
    await appendJsonl(networkLog, record);
  });
}

async function findSearchBox(page) {
  const selectors = [
    "input[placeholder*='搜索']",
    "input[placeholder*='达人']",
    "input[placeholder*='博主']",
    "input[placeholder*='账号']",
    "input[type='search']",
    ".ant-input",
    "input"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && await locator.isVisible({ timeout: 800 })) {
        return locator;
      }
    } catch {
      // Continue trying selector candidates.
    }
  }
  return null;
}

async function autoSearch(page, creators) {
  for (const creator of creators) {
    const query = creator.redId || creator.nickname;
    if (!query) continue;
    console.log(`auto-search: ${creator.nickname} / ${creator.redId}`);
    const input = await findSearchBox(page);
    if (!input) {
      console.log("auto-search stopped: no visible search input found on current page");
      return;
    }
    await input.click({ timeout: 3000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(query, { delay: 35 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(CONFIG.autoSearchDelayMs);
  }
}

async function runLogin() {
  const userDataDir = path.join(ROOT, CONFIG.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  if (process.platform === "darwin") {
    const child = spawn(
      "open",
      [
        "-na",
        "Google Chrome",
        "--args",
        `--user-data-dir=${userDataDir}`,
        CONFIG.baseUrl
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    console.log("已用独立 Chrome 用户目录打开蒲公英。");
    console.log("请完成登录；登录成功后关闭这个 Chrome 窗口，再运行 npm run capture 或告诉我继续。");
    return;
  }
  const context = await launch();
  const page = context.pages()[0] || await context.newPage();
  await page.goto(CONFIG.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("Chrome 已打开蒲公英。请完成登录；登录后关闭浏览器，再运行 npm run capture。");
  await context.close();
}

async function runCapture() {
  const creators = await loadCreators();
  const captureDir = path.join(ROOT, CONFIG.rawDir, `capture-${nowStamp()}`);
  await fs.mkdir(path.join(captureDir, "responses"), { recursive: true });
  await writeJson(path.join(captureDir, "creators_snapshot.json"), creators);

  const context = await launch();
  const page = context.pages()[0] || await context.newPage();
  await attachCapture(page, captureDir, creators);
  console.log(`network capture dir: ${path.relative(ROOT, captureDir)}`);

  let loaded = false;
  for (const url of CONFIG.searchUrlCandidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      console.log(`opened: ${url}`);
      loaded = true;
      break;
    } catch (error) {
      console.log(`open failed: ${url} -> ${error.message}`);
    }
  }
  if (!loaded) {
    await page.goto(CONFIG.baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  }

  if (AUTO) {
    await page.waitForTimeout(3000);
    await autoSearch(page, creators);
    console.log("auto-capture finished. Browser remains open for manual validation.");
  } else {
    console.log("请在浏览器中手动搜索 1-2 个测试达人；所有 XHR/Fetch JSON 响应会自动写入 raw/capture-*/。");
  }
}

if (COMMAND === "login") {
  await runLogin();
} else if (COMMAND === "capture") {
  await runCapture();
} else {
  console.error(`Unknown command: ${COMMAND}`);
  process.exit(1);
}
