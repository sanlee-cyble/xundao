import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { nowStamp, safeFilename, writeJson } from "./common.mjs";
import { MEDELA_REQUIRED_FIELDS, normalizeTemplateId } from "./template_profiles.mjs";
import {
  PGY_SCOPES,
  compileCollectionPlan,
  extractRegisteredFieldsFromApi,
} from "./field_registry.mjs";
import {
  compileTaskCollectionPlan,
  contractProvenanceForRequest,
  extractContractValues,
} from "./collection_plan.mjs";
import {
  checkpointsForCreator,
  nextPendingScopes,
  readCheckpoints,
  writeCheckpoint,
} from "./collection_checkpoint.mjs";
import { canonicalFieldKey } from "./field_contracts.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_CONFIG = {
  userDataDir: ".pgy-browser-profile",
  baseUrl: "https://pgy.xiaohongshu.com",
  responseMaxBytes: 2500000,
};

export const MEDELA_VIDEO_SCOPE = PGY_SCOPES.COOP_VIDEO_90_FULL;

export const MEDELA_VIDEO_NATURAL_SCOPE = PGY_SCOPES.COOP_VIDEO_90_NATURAL;

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function browserLaunchOptions(config = {}, { headless = true } = {}) {
  const channel = process.env.PGY_BROWSER_CHANNEL ?? config.browserChannel ?? "chrome";
  const options = { headless };
  if (channel && channel !== "bundled") options.channel = channel;
  return options;
}

function compactLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function nextValue(rows, label, start = 0) {
  for (let i = start; i < rows.length - 1; i += 1) {
    if (rows[i] === label) return rows[i + 1];
  }
  return "";
}

function lastIndexOf(rows, label) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] === label) return i;
  }
  return -1;
}

function cleanMoney(value) {
  const cleaned = String(value || "").replace(/[¥,]/g, "").trim();
  return cleaned && cleaned !== "-" ? Number(cleaned) : "";
}

function cleanNumber(value) {
  const cleaned = String(value || "").replace(/,/g, "").trim();
  return cleaned && cleaned !== "-" ? Number(cleaned) : "";
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return `${Number(percent.toFixed(1))}%`;
}

function parseAgeBucketText(text) {
  const buckets = {};
  const patterns = [
    ["25-34", /25\s*[-~—]\s*34[^\d]*(\d+(?:\.\d+)?)%/],
    ["35-44", /35\s*[-~—]\s*44[^\d]*(\d+(?:\.\d+)?)%/],
    ["45+", /(?:45\+|45岁以上|>=45|45以上|>44)[^\d]*(\d+(?:\.\d+)?)%/],
  ];
  for (const [key, pattern] of patterns) {
    const match = String(text || "").match(pattern);
    if (match) buckets[key] = Number(match[1]);
  }
  if (Object.keys(buckets).length === 0) return "";
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  return `${Number(total.toFixed(1))}%`;
}

function isOver25AgeGroup(group) {
  const label = String(group || "").replace(/\s+/g, "");
  return /^(25[-~—]34|35[-~—]44|45\+|45岁以上|45以上|>44|>=45)$/.test(label);
}

function ageOver25FromProfile(profile) {
  const ages = profile?.data?.ages || profile?.ages;
  if (!Array.isArray(ages)) return "";
  const total = ages
    .filter((item) => isOver25AgeGroup(item.group || item.name || item.label))
    .reduce((sum, item) => sum + Number(item.percent || item.value || 0), 0);
  return total > 0 ? formatPercent(total) : "";
}

function top3RegionsFromProfile(profile) {
  const provinces = profile?.data?.provinces || profile?.provinces;
  if (!Array.isArray(provinces) || provinces.length === 0) return "";
  const top = provinces
    .slice()
    .sort((a, b) => Number(b.percent || b.value || 0) - Number(a.percent || a.value || 0))
    .slice(0, 3)
    .map((item) => `${item.name || item.province || item.group || item.label}（${formatPercent(item.percent || item.value)}）`);
  return top.length ? `国内最高的三个省份：${top.join("、")}` : "";
}

function parseRequestData(url, postData = "") {
  const values = Object.fromEntries(new URL(url).searchParams.entries());
  if (!postData) return values;
  try {
    return { ...values, ...JSON.parse(postData) };
  } catch {
    return { ...values, ...Object.fromEntries(new URLSearchParams(postData).entries()) };
  }
}

function isMedelaVideoMetricRequest(url, postData = "") {
  const values = parseRequestData(url, postData);
  return Number(values.business) === MEDELA_VIDEO_SCOPE.business
    && Number(values.noteType) === MEDELA_VIDEO_SCOPE.noteType
    && Number(values.dateType) === MEDELA_VIDEO_SCOPE.dateType
    && Number(values.advertiseSwitch) === MEDELA_VIDEO_SCOPE.advertiseSwitch;
}

function isMedelaVideoNaturalMetricRequest(url, postData = "") {
  const values = parseRequestData(url, postData);
  return Number(values.business) === MEDELA_VIDEO_NATURAL_SCOPE.business
    && Number(values.noteType) === MEDELA_VIDEO_NATURAL_SCOPE.noteType
    && Number(values.dateType) === MEDELA_VIDEO_NATURAL_SCOPE.dateType
    && Number(values.advertiseSwitch) === MEDELA_VIDEO_NATURAL_SCOPE.advertiseSwitch;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function isRelevantPgyResponse(url) {
  return [
    "/api/solar/cooperator/user/blogger/",
    "/api/solar/kol/data_v3/",
    "/api/solar/kol/data_v2/notes_detail",
    "/api/pgy/kol/data/",
    "/fans_profile",
    "/data_summary",
    "/kol_content_tags",
    "/kol_feature_tags",
  ].some((fragment) => url.includes(fragment));
}

export function extractFieldsFromApi(url, body, { postData = "", collectionTemplate = "fuji", noteScope = "video" } = {}) {
  const fields = extractRegisteredFieldsFromApi(url, body, { postData, noteScope });
  const templateId = normalizeTemplateId(collectionTemplate);
  if (url.includes("/api/solar/cooperator/user/blogger/")) {
    const data = body?.data || {};
    const fansCount = finiteNumber(data.fansCount);
    const videoPrice = finiteNumber(data.videoPrice);
    if (fansCount !== "") {
      fields["粉丝数"] = fansCount;
      fields["粉丝数（w）"] = Number((fansCount / 10000).toFixed(4));
    }
    if (videoPrice !== "") {
      fields["视频报价"] = videoPrice;
      fields["报价"] = videoPrice;
    }
    if (data.redId) fields["小红书号"] = String(data.redId);
    const totalEngagement = finiteNumber(data.likeCollectCountInfo);
    if (totalEngagement !== "") fields["总互动数"] = totalEngagement;
    if (data.name) fields["达人名称"] = String(data.name);
    if (data.userId) fields["小红书主页链接"] = `https://www.xiaohongshu.com/user/profile/${data.userId}`;
  }
  if (url.includes("/fans_summary")) {
    const data = body?.data || {};
    const mapping = {
      "活跃粉丝占比": data.activeFansRate,
      "阅读粉丝占比": data.readFansRate,
      "互动粉丝占比": data.engageFansRate,
      "下单粉丝占比": data.payFansUserRate30d,
    };
    for (const [name, value] of Object.entries(mapping)) {
      const number = finiteNumber(value);
      if (number !== "") fields[name] = number > 1 ? `${number}%` : number;
    }
  }
  if (url.includes("/fans_profile")) {
    const age = ageOver25FromProfile(body);
    const region = top3RegionsFromProfile(body);
    if (age) fields["25岁以上粉丝占比"] = age;
    if (region) fields["粉丝地域分布前3位"] = region;
  }
  if (url.includes("/data_summary")) {
    const data = body?.data || {};
    if (data.readMedian !== undefined) {
      fields["阅读中位数"] = data.readMedian;
      fields["近30日阅读中位数"] = data.readMedian;
    }
    if (data.mEngagementNum !== undefined) {
      fields["互动中位数"] = data.mEngagementNum;
      fields["近30日互动中位数"] = data.mEngagementNum;
    }
    if (data.videoCompleteRate !== undefined) fields["视频完播率"] = formatPercent(data.videoCompleteRate);
    if (data.picRead3sRate !== undefined) fields["图文3秒阅读率"] = formatPercent(data.picRead3sRate);
    if (data.readCost !== undefined) fields["预估阅读单价"] = Number(Number(data.readCost).toFixed(2));
    if (data.interactionCost !== undefined) fields["预估互动单价"] = Number(Number(data.interactionCost).toFixed(2));
  }
  if (
    templateId === "medela"
    && url.includes("/notes_rate")
    && isMedelaVideoMetricRequest(url, postData)
  ) {
    const data = body?.data || {};
    const page = data.pagePercentVo || {};
    const mapping = {
      "合作笔记曝光中位数（90天）": data.impMedian,
      "合作笔记阅读中位数（90天）": data.readMedian,
      "曝光来源-发现页": page.impHomefeedPercent,
      "曝光来源-搜索页": page.impSearchPercent,
      "曝光来源-关注页": page.impFollowPercent,
      "曝光来源-博主个人页": page.impDetailPercent,
      "曝光来源-附近页": page.impNearbyPercent,
      "曝光来源-其他": page.impOtherPercent,
    };
    for (const [name, value] of Object.entries(mapping)) {
      const number = finiteNumber(value);
      if (number !== "") fields[name] = number;
    }
  }
  if (
    templateId === "medela"
    && url.includes("/core_data")
    && isMedelaVideoNaturalMetricRequest(url, postData)
  ) {
    const sumData = body?.data?.sumData || {};
    const imp = finiteNumber(sumData.imp);
    const read = finiteNumber(sumData.read);
    if (imp !== "") fields["预估合作笔记自然流曝光（90天）"] = imp;
    if (read !== "") fields["预估合作笔记自然流阅读（90天）"] = read;
  }
  return fields;
}

export function parseDetailText(text) {
  const rows = compactLines(text);
  const dataStart = Math.max(lastIndexOf(rows, "数据表现"), 0);
  const fanStart = Math.max(lastIndexOf(rows, "粉丝分析"), 0);
  const readMedian = cleanNumber(nextValue(rows, "阅读中位数", dataStart)) || cleanNumber(nextValue(rows, "阅读中位数"));
  const interactionMedian = cleanNumber(nextValue(rows, "互动中位数", dataStart)) || cleanNumber(nextValue(rows, "互动中位数"));
  const fields = {
    "粉丝数": nextValue(rows, "粉丝数"),
    "总互动数": nextValue(rows, "获赞与收藏"),
    "图文报价": cleanMoney(nextValue(rows, "图文笔记一口价")),
    "视频报价": cleanMoney(nextValue(rows, "视频笔记一口价")),
    "预估阅读单价": cleanNumber(nextValue(rows, "预估阅读单价", dataStart)),
    "预估互动单价": cleanNumber(nextValue(rows, "预估互动单价", dataStart)),
    "阅读中位数": readMedian,
    "互动中位数": interactionMedian,
    "近30日阅读中位数": readMedian,
    "近30日互动中位数": interactionMedian,
    "视频完播率": nextValue(rows, "视频完播率", dataStart),
    "图文3秒阅读率": nextValue(rows, "图文3秒阅读率", dataStart),
    "活跃粉丝占比": nextValue(rows, "活跃粉丝占比", fanStart),
    "阅读粉丝占比": nextValue(rows, "阅读粉丝占比", fanStart),
    "互动粉丝占比": nextValue(rows, "互动粉丝占比", fanStart),
    "下单粉丝占比": nextValue(rows, "下单粉丝占比", fanStart),
    "25岁以上粉丝占比": parseAgeBucketText(text),
    "粉丝地域分布前3位": nextValue(rows, "地域分布", fanStart),
  };
  const updateDateLine = rows.find((row) => row.startsWith("数据更新至：")) || "";
  return {
    fields,
    dataUpdateDate: updateDateLine.replace("数据更新至：", "").trim(),
  };
}

export function creatorIdFromUrl(url) {
  const match = String(url || "").match(/\/blogger-detail\/([^/?#]+)/);
  return match ? match[1] : "";
}

function looksJson(response) {
  const contentType = response.headers()["content-type"] || "";
  return contentType.includes("json") || response.url().includes("/api/");
}

async function clickByVisibleText(page, text, options = {}) {
  const result = await page.evaluate(
    ({ text: targetText, contains, last }) => {
      const all = Array.from(document.querySelectorAll("button,div,span,a,li"));
      const visible = all.filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const label = (el.innerText || el.textContent || "").trim().replace(/\s+/g, "");
        const target = String(targetText).replace(/\s+/g, "");
        const matched = contains ? label.includes(target) : label === target;
        return matched && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const el = last ? visible[visible.length - 1] : visible[0];
      if (!el) return false;
      el.click();
      return true;
    },
    { text, contains: !!options.contains, last: !!options.last },
  );
  if (result) await page.waitForTimeout(options.waitMs || 500);
  return result;
}

async function selectVisibleOption(page, currentText, optionText, { last = false } = {}) {
  const matchingSelects = page.locator(".d-select-wrapper:visible").filter({ hasText: currentText });
  const select = last ? matchingSelects.last() : matchingSelects.first();
  if (!(await select.count())) return false;
  await select.click();
  await page.waitForTimeout(350);
  const escaped = String(optionText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const option = page
    .locator(".d-popover:visible .d-option-content")
    .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
    .last();
  if (!(await option.count())) return false;
  await option.click();
  await page.waitForTimeout(700);
  return true;
}

function normalizedControlText(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

async function selectNativeScopeOption(page, currentPattern, desiredLabels, {
  last = true,
  waitMs = 900,
} = {}) {
  const wrappers = page.locator(".d-select-wrapper:visible");
  const count = await wrappers.count();
  const indexes = last
    ? Array.from({ length: count }, (_, index) => count - index - 1)
    : Array.from({ length: count }, (_, index) => index);
  let wrapper = null;
  let currentText = "";
  for (const index of indexes) {
    const candidate = wrappers.nth(index);
    const text = normalizedControlText(await candidate.innerText().catch(() => ""));
    if (!currentPattern.test(text)) continue;
    wrapper = candidate;
    currentText = text;
    break;
  }
  if (!wrapper) return { found: false, changed: false, currentText };
  if (desiredLabels.includes(currentText)) {
    return { found: true, changed: false, currentText, selectedText: currentText };
  }
  await wrapper.click();
  await page.waitForTimeout(300);
  const options = page.locator(".d-popover:visible .d-option-content");
  const optionTexts = (await options.allTextContents()).map(normalizedControlText);
  for (let index = optionTexts.length - 1; index >= 0; index -= 1) {
    if (!desiredLabels.includes(optionTexts[index])) continue;
    await options.nth(index).click();
    await page.waitForTimeout(waitMs);
    return {
      found: true,
      changed: true,
      currentText,
      selectedText: optionTexts[index],
    };
  }
  await page.keyboard.press("Escape").catch(() => {});
  return { found: true, changed: false, currentText, optionTexts };
}

async function dismissBlockingPgyPrompts(page) {
  await page.evaluate(() => {
    const selectors = [
      ".d-popover",
      ".d-modal",
      ".semi-modal",
      "[class*='popover']",
      "[class*='modal']",
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = (element.innerText || "").trim();
        if (text.includes("去选择合作品牌") || text.includes("请选择您的合作品牌")) {
          element.remove();
        }
      }
    }
  });
}

async function prepareDetailPage(page, collectionTemplate = "fuji", noteScope = "video") {
  await dismissBlockingPgyPrompts(page);

  await clickByVisibleText(page, "笔记数据", { last: false, waitMs: 800 });
  await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.55)));
  await page.waitForTimeout(600);
  await clickByVisibleText(page, collectionTemplate === "medela" ? "合作笔记" : "日常笔记", { last: true, waitMs: 700 });
  if (collectionTemplate === "medela") {
    if (noteScope === "mixed") {
      const alreadyMixed = await page.locator(".d-select-wrapper:visible")
        .filter({ hasText: "图文+视频" })
        .count();
      if (!alreadyMixed) {
        const selectedMixed = await selectVisibleOption(page, "视频", "图文+视频", { last: true });
        if (!selectedMixed) throw new Error("无法将合作笔记类型切换为图文+视频，已停止以避免采集错误口径");
      }
    } else {
      const selectedVideo = await selectVisibleOption(page, "图文+视频", "视频", { last: true });
      if (!selectedVideo) throw new Error("无法将合作笔记类型切换为视频，已停止以避免采集图文+视频混合口径");
    }
    const selected90Days = await selectVisibleOption(page, "近30日", "近90日");
    if (!selected90Days) throw new Error("无法将合作笔记周期切换为近90日");
    await page.waitForTimeout(900);
    const selectedNaturalFlow = await selectVisibleOption(page, "全流量", "仅自然流量", { last: true });
    if (!selectedNaturalFlow) throw new Error("无法将合作笔记流量类型切换为仅自然流量");
    await clickByVisibleText(page, "按规模", { last: true, waitMs: 900 });
  } else {
    await clickByVisibleText(page, "图文笔记+视频笔记", { contains: true, last: true, waitMs: 500 });
    await clickByVisibleText(page, "图文+视频", { contains: true, last: true, waitMs: 500 });
    await clickByVisibleText(page, "近30日", { contains: true, last: true, waitMs: 500 });
    await clickByVisibleText(page, "按成本", { last: true, waitMs: 900 });
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.55)));
  await page.waitForTimeout(600);
}

export function nativeRequestMatches(request, url, postData = "") {
  if (!request?.endpoint || !String(url || "").includes(request.endpoint)) return false;
  const values = parseRequestData(url, postData);
  if (request.endpoint.includes("/notes_detail")) {
    return String(values.userId || "") === String(request.params?.userId || "")
      && Number(values.noteType) === 4;
  }
  return Object.entries(request.params || {}).every(([key, expected]) => (
    String(values[key] ?? "") === String(expected)
  ));
}

export function mergeRecentNotesPayloads(payloads = [], limit = 16) {
  const byPage = new Map();
  for (const item of payloads) {
    const pageNumber = Number(item.pageNumber || 1);
    const notes = Array.isArray(item.payload?.data?.list) ? item.payload.data.list : [];
    if (!byPage.has(pageNumber) || notes.length >= byPage.get(pageNumber).length) {
      byPage.set(pageNumber, notes);
    }
  }
  const seen = new Set();
  const list = [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, notes]) => notes)
    .filter((note) => {
      const key = String(note?.noteId || note?.id || note?.note_id || JSON.stringify(note));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
  return {
    code: 0,
    success: true,
    data: { list },
  };
}

async function clickRecentNotesPage(page, pageNumber) {
  const clicked = await page.evaluate((targetPage) => {
    const labels = Array.from(document.querySelectorAll(".d-pagination .d-pagination-page-content"))
      .filter((element) => (element.textContent || "").trim() === String(targetPage));
    const target = labels.at(-1)?.closest(".d-pagination-page.d-clickable");
    if (!target) return false;
    target.scrollIntoView({ block: "center" });
    target.click();
    return true;
  }, pageNumber);
  if (clicked) await page.waitForTimeout(1200);
  return clicked;
}

async function captureRecentNotesViaNativeUi(page, request) {
  const captured = [];
  const tasks = new Set();
  const onResponse = (response) => {
    const postData = response.request().postData() || "";
    if (response.status() !== 200 || !nativeRequestMatches(request, response.url(), postData)) return;
    const task = (async () => {
      const payload = await response.json().catch(() => null);
      if (!payload || (payload.code !== undefined && Number(payload.code) !== 0)) return;
      const values = parseRequestData(response.url(), postData);
      captured.push({
        pageNumber: Number(values.pageNumber || 1),
        pageSize: Number(values.pageSize || 0),
        payload,
      });
    })();
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  };
  page.on("response", onResponse);
  try {
    await dismissBlockingPgyPrompts(page);
    await clickByVisibleText(page, "笔记数据", { waitMs: 900 });
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.48)));
    await page.waitForTimeout(700);
    await clickRecentNotesPage(page, 2);
    await clickRecentNotesPage(page, 1);
    await clickRecentNotesPage(page, 2);
    await Promise.race([
      Promise.allSettled([...tasks]),
      page.waitForTimeout(3500),
    ]);
    const payload = mergeRecentNotesPayloads(captured, 16);
    const noteCount = payload.data.list.length;
    return {
      ok: noteCount > 0,
      status: noteCount > 0 ? 200 : 0,
      payload,
      error: noteCount > 0 ? "" : "蒲公英原生列表未返回近16篇笔记",
      transport: "native-ui",
      nativePageCount: new Set(captured.map((item) => item.pageNumber)).size,
    };
  } finally {
    page.off("response", onResponse);
  }
}

function nativeScopeLabels(request) {
  const params = request.params || {};
  return {
    scene: Number(params.business) === 1 ? "合作笔记" : "日常笔记",
    content: {
      1: ["图文", "图文笔记"],
      2: ["视频", "视频笔记"],
      3: ["图文+视频", "图文笔记+视频笔记"],
    }[Number(params.noteType)] || [],
    window: Number(params.dateType) === 2 ? ["近90日"] : ["近30日"],
    traffic: Number(params.advertiseSwitch) === 0 ? ["仅自然流量"] : ["全流量"],
  };
}

async function configureNativeScope(page, request, { forceRefresh = false } = {}) {
  const labels = nativeScopeLabels(request);
  await dismissBlockingPgyPrompts(page);
  await clickByVisibleText(page, "笔记数据", { waitMs: 900 });
  await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.58)));
  await page.waitForTimeout(650);
  const sceneSelected = await clickByVisibleText(page, labels.scene, { last: true, waitMs: 850 });
  if (!sceneSelected) throw new Error(`蒲公英页面未找到“${labels.scene}”`);
  const content = await selectNativeScopeOption(
    page,
    /^(图文\+视频|图文笔记\+视频笔记|图文笔记|视频笔记|图文|视频)$/,
    labels.content,
  );
  if (!content.found || !content.selectedText) throw new Error(`蒲公英页面无法切换内容类型为“${labels.content[0]}”`);
  const traffic = await selectNativeScopeOption(
    page,
    /^(全流量|仅自然流量)$/,
    labels.traffic,
  );
  if (!traffic.found || !traffic.selectedText) throw new Error(`蒲公英页面无法切换流量为“${labels.traffic[0]}”`);
  const windowResult = await selectNativeScopeOption(
    page,
    /^近(30|90)日$/,
    labels.window,
    { last: false, waitMs: 1100 },
  );
  if (!windowResult.found || !windowResult.selectedText) throw new Error(`蒲公英页面无法切换周期为“${labels.window[0]}”`);
  await clickByVisibleText(page, "按规模", { last: true, waitMs: 900 });
  if (forceRefresh) {
    const alternate = labels.window[0] === "近90日" ? ["近30日"] : ["近90日"];
    await selectNativeScopeOption(page, /^近(30|90)日$/, alternate, { last: false, waitMs: 700 });
    await selectNativeScopeOption(page, /^近(30|90)日$/, labels.window, { last: false, waitMs: 1100 });
  }
}

async function captureScopeViaNativeUi(page, request) {
  if (request.endpoint.includes("/notes_detail")) {
    return captureRecentNotesViaNativeUi(page, request);
  }
  const captured = [];
  const tasks = new Set();
  const onResponse = (response) => {
    const postData = response.request().postData() || "";
    if (response.status() !== 200 || !nativeRequestMatches(request, response.url(), postData)) return;
    const task = (async () => {
      const payload = await response.json().catch(() => null);
      if (!payload || (payload.code !== undefined && Number(payload.code) !== 0)) return;
      captured.push({ payload, status: response.status() });
    })();
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  };
  page.on("response", onResponse);
  try {
    await configureNativeScope(page, request);
    await Promise.race([
      Promise.allSettled([...tasks]),
      page.waitForTimeout(2200),
    ]);
    if (!captured.length) {
      await configureNativeScope(page, request, { forceRefresh: true });
      await Promise.race([
        Promise.allSettled([...tasks]),
        page.waitForTimeout(3500),
      ]);
    }
    const success = captured.at(-1);
    return {
      ok: Boolean(success),
      status: success?.status || 0,
      payload: success?.payload || null,
      error: success ? "" : "蒲公英原生交互未返回目标口径",
      transport: "native-ui",
    };
  } finally {
    page.off("response", onResponse);
  }
}

async function executeCollectionPlan(page, creatorId, fieldIds = [], { noteScope = "video" } = {}) {
  const plan = compileCollectionPlan(fieldIds, { noteScope });
  const requests = plan.requests.map((request) => ({
    id: request.id,
    method: request.method,
    path: request.path({ creatorId }),
    body: request.body ? request.body({ creatorId }) : null,
  }));
  if (!requests.length) return [];
  return page.evaluate(async (plannedRequests) => Promise.all(plannedRequests.map(async (request) => {
    const response = await fetch(request.path, {
      method: request.method,
      credentials: "include",
      headers: request.body ? { "content-type": "application/json" } : undefined,
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    const payload = await response.json().catch(() => null);
    return {
      id: request.id,
      ok: response.ok,
      status: response.status,
      hasData: payload?.data !== null && payload?.data !== undefined,
    };
  })), requests);
}

async function executeCompiledTaskPlan(page, plan, onScopeProgress = () => {}) {
  const requests = (plan.requests || []).map((request) => ({
    id: request.id,
    method: request.method,
    path: request.method === "GET"
      ? `${request.endpoint}?${new URLSearchParams(
        Object.fromEntries(Object.entries(request.params || {}).map(([key, value]) => [key, String(value)])),
      )}`
      : request.endpoint,
    body: request.method === "POST" ? request.params : null,
  }));
  if (!requests.length) return [];
  const results = [];
  for (let index = 0; index < requests.length; index += 1) {
    const planned = requests[index];
    const request = plan.requests[index];
    onScopeProgress({
      type: "scope_started",
      index,
      total: requests.length,
      request,
    });
    const direct = await page.evaluate(async (item) => {
      try {
        const response = await fetch(item.path, {
          method: item.method,
          credentials: "include",
          headers: item.body ? { "content-type": "application/json" } : undefined,
          body: item.body ? JSON.stringify(item.body) : undefined,
        });
        const payload = await response.json().catch(() => null);
        const applicationOk = payload?.code === undefined || Number(payload.code) === 0;
        return {
          id: item.id,
          ok: response.ok && applicationOk,
          status: response.status,
          payload,
          error: response.ok && applicationOk
            ? ""
            : payload?.msg || payload?.message || `HTTP ${response.status}`,
          transport: "fetch",
        };
      } catch (error) {
        return {
          id: item.id,
          ok: false,
          status: 0,
          payload: null,
          error: error.message,
          transport: "fetch",
        };
      }
    }, planned);
    let finalResult = direct;
    if (!direct.ok && (
      request.endpoint.includes("/notes_rate")
      || request.endpoint.includes("/notes_detail")
      || request.endpoint.includes("/core_data")
    )) {
      onScopeProgress({
        type: "scope_retry",
        index,
        total: requests.length,
        request,
        transport: "native-ui",
        directStatus: direct.status,
        error: direct.error,
      });
      const native = await captureScopeViaNativeUi(page, request).catch((error) => ({
        ok: false,
        status: 0,
        payload: null,
        error: error.message,
        transport: "native-ui",
      }));
      finalResult = native.ok ? { ...native, id: planned.id } : {
        ...direct,
        error: `${direct.error || "直接请求失败"}；原生交互失败：${native.error}`,
        fallbackStatus: native.status,
      };
    }
    onScopeProgress({
      type: finalResult.ok ? "scope_completed" : "scope_failed",
      index: index + 1,
      total: requests.length,
      request,
      transport: finalResult.transport,
      status: finalResult.status,
      error: finalResult.error || "",
    });
    results.push({ ...finalResult, request });
  }
  return results;
}

async function loadRecentNotesSecondPage(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const clicked = await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll(".d-pagination .d-pagination-page-content"))
      .find((element) => (element.textContent || "").trim() === "2");
    const target = label?.closest(".d-pagination-page.d-clickable");
    if (!target) return false;
    target.click();
    return true;
  });
  if (clicked) await page.waitForTimeout(900);
  return clicked;
}

function mergeApiFields(target, incoming) {
  const maxFields = new Set([
    "近16篇最高阅读量",
    "近16篇最高点赞量",
    "近16篇最高收藏量",
  ]);
  for (const [name, value] of Object.entries(incoming || {})) {
    if (maxFields.has(name) && Number.isFinite(Number(target[name])) && Number.isFinite(Number(value))) {
      target[name] = Math.max(Number(target[name]), Number(value));
    } else {
      target[name] = value;
    }
  }
}

export async function createPgyContext(config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const userDataDir = path.resolve(ROOT, merged.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  return chromium.launchPersistentContext(userDataDir, {
    ...browserLaunchOptions(merged, { headless: envBoolean("PGY_LOGIN_HEADLESS", false) }),
    viewport: { width: 1440, height: 980 },
    acceptDownloads: true,
  });
}

export async function createBackgroundCollectContext(storageStatePath, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const browser = await chromium.launch({
    ...browserLaunchOptions(merged, { headless: true }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 980 },
    acceptDownloads: true,
    storageState: storageStatePath,
    baseURL: merged.baseUrl,
  });
  context.on("close", () => {
    browser.close().catch(() => {});
  });
  return context;
}

export function classifyPgyLoginProbe({ url = "", text = "", cookieCount = 0 } = {}) {
  const normalizedUrl = String(url || "").toLowerCase();
  const normalizedText = String(text || "").replace(/\s+/g, "");
  const explicitLogin = /(?:passport|login|signin|sign-in)/.test(normalizedUrl)
    || /(?:扫码登录|手机号登录|验证码登录|请先登录|登录后使用)/.test(normalizedText);
  const onPgy = /pgy\.xiaohongshu\.com/.test(normalizedUrl);
  if (explicitLogin) return { authenticated: false, reason: "蒲公英要求重新登录" };
  if (!onPgy) return { authenticated: false, reason: "当前页面不在蒲公英域名" };
  if (Number(cookieCount) <= 0) return { authenticated: false, reason: "未检测到蒲公英会话 Cookie" };
  return { authenticated: true, reason: "蒲公英登录态有效" };
}

export async function verifyPgyLoginState(context, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const existingPage = context.pages()[0];
  const page = existingPage || await context.newPage();
  try {
    await page.goto(merged.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: Number(merged.navigationTimeoutMs || 60000),
    });
    await page.waitForTimeout(600);
    const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    const cookies = await context.cookies(merged.baseUrl);
    return {
      ...classifyPgyLoginProbe({
        url: page.url(),
        text: text.slice(0, 12000),
        cookieCount: cookies.length,
      }),
      url: page.url(),
      cookieCount: cookies.length,
    };
  } finally {
    if (!existingPage) await page.close().catch(() => {});
  }
}

export async function openLoginPage(context, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const page = context.pages()[0] || await context.newPage();
  await page.goto(merged.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  return page;
}

export async function collectCreator(context, creator, runDir, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const creatorKey = safeFilename(`${creator.rowIndex || ""}_${creator.nickname || ""}_${creator.redId || creator.creatorId || ""}`) || nowStamp();
  const creatorDir = path.join(runDir, "raw", creatorKey);
  const responseDir = path.join(creatorDir, "responses");
  await fs.mkdir(responseDir, { recursive: true });

  const page = await context.newPage();
  const responses = [];
  const apiFields = {};
  const responseTasks = new Set();
  page.on("response", (response) => {
    const task = (async () => {
      const url = response.url();
      if (!url.includes("xiaohongshu.com") || !looksJson(response) || !isRelevantPgyResponse(url)) return;
      try {
        const bodyText = await response.text();
        if (Buffer.byteLength(bodyText) > merged.responseMaxBytes) return;
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return;
        }
        const postData = response.request().postData() || "";
        const filename = `${nowStamp()}_${response.status()}_${safeFilename(new URL(url).pathname)}.json`;
        const filePath = path.join(responseDir, filename);
        await writeJson(filePath, {
          request: {
            method: response.request().method(),
            url,
            postData,
          },
          response: {
            status: response.status(),
          },
          body,
        });
        mergeApiFields(apiFields, extractFieldsFromApi(url, body, {
          postData,
          collectionTemplate: merged.collectionTemplate || "fuji",
          noteScope: merged.noteScope || "video",
        }));
        responses.push(path.relative(ROOT, filePath));
      } catch {
        // Response bodies may be unavailable after navigation; this is non-fatal.
      }
    })();
    responseTasks.add(task);
    task.finally(() => responseTasks.delete(task));
  });

  try {
    await page.goto(creator.pgyLink, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const taskContract = merged.taskContract || null;
    const creatorId = creator.creatorId || creatorIdFromUrl(creator.pgyLink);
    const loadedRecentNotesSecondPage = (merged.collectionTemplate || "fuji") === "dynamic" && !taskContract
      ? await loadRecentNotesSecondPage(page)
      : false;
    const selectedFieldIds = Array.isArray(merged.fieldIds) ? merged.fieldIds : [];
    let collectionPlanEvidence = [];
    let contractValues = {};
    let contractProvenance = {};
    let executableGroupIds = new Set();
    if (taskContract) {
      const checkpointPath = path.join(runDir, "checkpoints.json");
      const allCheckpoints = await readCheckpoints(checkpointPath);
      const creatorCheckpoints = checkpointsForCreator(
        allCheckpoints,
        merged.jobId || path.basename(runDir),
        creatorId,
      );
      const completePlan = compileTaskCollectionPlan(taskContract, creatorId);
      const signatures = Object.fromEntries(
        completePlan.requests.map((request) => [request.groupId, request.signature]),
      );
      executableGroupIds = new Set(
        completePlan.requests.map((request) => request.groupId),
      );
      const pendingGroups = nextPendingScopes(
        (taskContract.scopeGroups || []).filter((group) => executableGroupIds.has(group.id)),
        creatorCheckpoints,
        signatures,
      );
      for (const checkpoint of Object.values(creatorCheckpoints)) {
        if (checkpoint.status === "COMPLETED" && checkpoint.requestSignature === signatures[checkpoint.groupId]) {
          Object.assign(contractValues, checkpoint.contractValues || {});
          Object.assign(contractProvenance, checkpoint.contractProvenance || {});
          merged.onScopeProgress?.({
            type: "scope_resumed",
            creator,
            creatorId,
            group: (taskContract.scopeGroups || []).find((item) => item.id === checkpoint.groupId),
            groupId: checkpoint.groupId,
            transport: "checkpoint",
            status: 200,
          });
        }
      }
      const plan = compileTaskCollectionPlan({ ...taskContract, scopeGroups: pendingGroups }, creatorId);
      const groupsById = new Map((taskContract.scopeGroups || []).map((group) => [group.id, group]));
      const plannedResults = await executeCompiledTaskPlan(page, plan, (event) => {
        merged.onScopeProgress?.({
          ...event,
          creator,
          creatorId,
          group: groupsById.get(event.request?.groupId),
          groupId: event.request?.groupId,
        });
      });
      for (const item of plannedResults) {
        const values = item.ok ? extractContractValues(item.request, item.payload) : {};
        const provenance = contractProvenanceForRequest(item.request, values, {
          ok: item.ok,
          status: item.status,
          transport: item.transport,
          error: item.error,
        });
        Object.assign(contractValues, values);
        Object.assign(contractProvenance, provenance);
        await writeCheckpoint(checkpointPath, {
          jobId: merged.jobId || path.basename(runDir),
          creatorId,
          groupId: item.request.groupId,
          status: item.ok ? "COMPLETED" : "FAILED",
          requestSignature: item.request.signature,
          completedAt: item.ok ? new Date().toISOString() : "",
          error: item.error,
          contractValues: values,
          contractProvenance: provenance,
          fieldStatuses: Object.fromEntries((item.request.contracts || []).map((contract) => {
            const key = canonicalFieldKey(contract);
            return [key, provenance[key]?.valueStatus || "COLLECTION_FAILED"];
          })),
        });
      }
      collectionPlanEvidence = [
        ...Object.values(creatorCheckpoints)
          .filter((checkpoint) => checkpoint.status === "COMPLETED")
          .map((checkpoint) => ({
            id: `${creatorId}:${checkpoint.groupId}`,
            ok: true,
            status: 200,
            resumed: true,
          })),
        ...plannedResults.map((item) => ({
          id: item.id,
          ok: item.ok,
          status: item.status,
          error: item.error,
          resumed: false,
        })),
      ];
    } else if (selectedFieldIds.length) {
      collectionPlanEvidence = await executeCollectionPlan(
          page,
          creatorId,
          selectedFieldIds,
          { noteScope: merged.noteScope || "video" },
        );
    }
    if (taskContract) {
      await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.55)));
      await page.waitForTimeout(500);
    } else {
      await prepareDetailPage(
        page,
        (merged.collectionTemplate || "fuji") === "dynamic"
          ? "medela"
          : merged.collectionTemplate || "fuji",
        merged.noteScope || "video",
      );
    }
    const rawText = await page.evaluate(() => document.body.innerText || "");
    const parsed = parseDetailText(rawText);
    const xhsProfileLink = await page.evaluate((creatorId) => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const href = anchors
        .map((anchor) => anchor.href)
        .find((value) => /xiaohongshu\.com\/user\/profile\//i.test(value));
      return href || (creatorId ? `https://www.xiaohongshu.com/user/profile/${creatorId}` : "");
    }, creatorId);
    await page.waitForTimeout(500);
    // 蒲公英页面可能保留长连接；只等待已触发响应的短窗口，避免一个未结束请求阻塞整批导出。
    await Promise.race([
      Promise.allSettled(Array.from(responseTasks)),
      page.waitForTimeout(4000),
    ]);
    const fields = { ...parsed.fields, ...apiFields };
    if (xhsProfileLink) fields["小红书主页链接"] = xhsProfileLink;
    fields["蒲公英链接"] = creator.pgyLink;
    const textPath = path.join(creatorDir, "page_text.txt");
    await fs.writeFile(textPath, rawText, "utf8");
    const screenshotPath = path.join(creatorDir, "page.png");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const evidenceFiles = [
      path.relative(ROOT, textPath),
      path.relative(ROOT, screenshotPath),
      ...responses,
    ];
    contractProvenance = Object.fromEntries(
      Object.entries(contractProvenance).map(([key, provenance]) => [
        key,
        {
          ...provenance,
          evidenceFiles,
          platformDataUpdateDate: parsed.dataUpdateDate || "",
        },
      ]),
    );

    const templateId = normalizeTemplateId(merged.collectionTemplate);
    const requiredFields = Array.isArray(merged.requiredFieldNames) && merged.requiredFieldNames.length
      ? merged.requiredFieldNames
      : templateId === "medela" ? MEDELA_REQUIRED_FIELDS : [];
    const missingFields = taskContract
      ? [
          ...(taskContract.columns || [])
            .filter((column) => column.contract?.scene === "creator" && column.mapping?.name)
            .filter((column) => {
              try {
                if (Object.hasOwn(contractValues, canonicalFieldKey(column.contract))) return false;
              } catch {
                // Legacy creator fields continue to use the display-name result map.
              }
              const value = fields[column.mapping.name];
              return value === undefined || value === null || value === "";
            })
            .map((column) => column.mapping.name)
            .filter((name, index, values) => values.indexOf(name) === index),
          ...(taskContract.scopeGroups || [])
            .filter((group) => executableGroupIds.has(group.id))
            .flatMap((group) => group.contracts || [])
            .map(canonicalFieldKey)
            .filter((key) => !Object.hasOwn(contractValues, key)),
        ]
      : requiredFields
        .filter((name) => fields[name] === undefined || fields[name] === null || fields[name] === "");
    return {
      ...creator,
      creatorId: creator.creatorId || creatorIdFromUrl(creator.pgyLink),
      dataStatus: missingFields.length ? "部分缺失" : "成功",
      errorReason: missingFields.length ? `缺少字段：${missingFields.join("、")}` : "",
      dataUpdateDate: parsed.dataUpdateDate,
      metricScope: templateId === "medela"
        ? {
          label: "合作笔记 · 视频 · 近90日 · L/S全流量 · T/U仅自然流量 · 按规模",
          allTraffic: MEDELA_VIDEO_SCOPE,
          naturalTraffic: MEDELA_VIDEO_NATURAL_SCOPE,
        }
        : templateId === "dynamic"
          ? {
              label: taskContract
                ? `动态字段合同第 ${taskContract.version} 版（每列独立口径）`
                : `动态字段计划（合作笔记·${(merged.noteScope || "video") === "mixed" ? "图文+视频" : "视频"}·近90日；按字段锁定口径）`,
              requests: collectionPlanEvidence,
              recentNotesSecondPage: loadedRecentNotesSecondPage,
            }
          : undefined,
      fields,
      contractValues,
      contractProvenance,
      missingFields,
      evidenceFiles,
      rawTextFile: path.relative(ROOT, textPath),
    };
  } catch (error) {
    return {
      ...creator,
      creatorId: creator.creatorId || creatorIdFromUrl(creator.pgyLink),
      dataStatus: "失败",
      errorReason: error.message,
      fields: {},
      contractValues: {},
      contractProvenance: {},
      missingFields: [],
      evidenceFiles: responses,
      rawTextFile: "",
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function collectCreatorPlan(context, creator, runDir, taskContract, config = {}) {
  if (!Array.isArray(taskContract?.scopeGroups)) throw new Error("缺少已确认的采集任务合同");
  if (Number(taskContract.confirmedVersion) !== Number(taskContract.version)) {
    throw new Error("采集任务合同尚未确认");
  }
  return collectCreator(context, creator, runDir, { ...config, taskContract });
}

export async function collectCreators({ context, creators, runDir, config = {}, onProgress = () => {} }) {
  const results = [];
  for (let index = 0; index < creators.length; index += 1) {
    const creator = creators[index];
    onProgress({ index, total: creators.length, creator, status: "running" });
    const result = await collectCreator(context, creator, runDir, config);
    results.push(result);
    onProgress({ index: index + 1, total: creators.length, creator, result, status: "done" });
  }
  return results;
}
