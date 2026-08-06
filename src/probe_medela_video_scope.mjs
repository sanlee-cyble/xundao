#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createBackgroundCollectContext } from "./pgy_collect_core.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function normalizedText(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

async function clickExact(page, text, { last = false, waitMs = 600 } = {}) {
  const clicked = await page.evaluate(({ target, useLast }) => {
    const candidates = Array.from(document.querySelectorAll("button,div,span,a,li"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return normalizedText(element.innerText || element.textContent) === normalizedText(target)
          && rect.width > 0
          && rect.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden";
      });
    const leafCandidates = candidates.filter((element) => !Array.from(element.children)
      .some((child) => normalizedText(child.innerText || child.textContent) === normalizedText(target)));
    const pool = leafCandidates.length ? leafCandidates : candidates;
    const element = useLast ? pool[pool.length - 1] : pool[0];
    if (!element) return false;
    element.click();
    return true;

    function normalizedText(value) {
      return String(value || "").trim().replace(/\s+/g, "");
    }
  }, { target: text, useLast: last });
  if (clicked) await page.waitForTimeout(waitMs);
  return clicked;
}

async function visibleControls(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("button,div,span,a,li"))
    .filter((element) => {
      const text = String(element.innerText || element.textContent || "").trim().replace(/\s+/g, "");
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return /^(图文\+视频|图文笔记\+视频笔记|图文笔记|视频笔记)$/.test(text)
        && rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    })
    .map((element) => ({
      tag: element.tagName,
      className: String(element.className || "").slice(0, 180),
      text: String(element.innerText || element.textContent || "").trim().replace(/\s+/g, ""),
      top: Math.round(element.getBoundingClientRect().top),
      left: Math.round(element.getBoundingClientRect().left),
      parentClassName: String(element.parentElement?.className || "").slice(0, 180),
    }))
    .slice(-30));
}

async function selectNear90(page) {
  const select = page.locator(".d-select-wrapper:visible").filter({ hasText: "近30日" }).first();
  if (!(await select.count())) return false;
  await select.click();
  await page.waitForTimeout(300);
  const optionElement = page.locator(".d-popover:visible .d-option-content").filter({ hasText: "近90日" }).last();
  if (!(await optionElement.count())) return false;
  await optionElement.click();
  await page.waitForTimeout(900);
  return true;
}

async function selectFlowType(page, optionText) {
  const select = page.locator(".d-select-wrapper:visible").filter({ hasText: "全流量" }).last();
  if (!(await select.count())) return { opened: false, optionTexts: [], selected: false };
  await select.click();
  await page.waitForTimeout(350);
  const options = page.locator(".d-popover:visible .d-option-content");
  const optionTexts = await options.allTextContents();
  const escaped = String(optionText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionElement = options.filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).last();
  if (!(await optionElement.count())) return { opened: true, optionTexts, selected: false };
  await optionElement.click();
  await page.waitForTimeout(1100);
  return { opened: true, optionTexts, selected: true };
}

async function selectNoteType(page, optionText) {
  const select = page.locator(".d-select-wrapper:visible").filter({ hasText: "图文+视频" }).last();
  if (!(await select.count())) return { opened: false, optionTexts: [], selected: false };
  await select.click();
  await page.waitForTimeout(350);
  const options = page.locator(".d-popover:visible .d-option-content");
  const optionTexts = await options.allTextContents();
  const optionElement = options.filter({ hasText: optionText }).last();
  if (!(await optionElement.count())) return { opened: true, optionTexts, selected: false };
  await optionElement.click();
  await page.waitForTimeout(1100);
  return { opened: true, optionTexts, selected: true };
}

const storageStatePath = path.resolve(option("storage-state") || "");
const creatorsPath = path.resolve(option("creators") || "");
if (!option("storage-state") || !option("creators")) {
  throw new Error("usage: node src/probe_medela_video_scope.mjs --storage-state <json> --creators <json>");
}

const creators = JSON.parse(await fs.readFile(creatorsPath, "utf8"));
const creator = creators[0];
if (!creator?.pgyLink) throw new Error("creators file has no usable pgyLink");

const context = await createBackgroundCollectContext(storageStatePath);
const page = await context.newPage();
const observed = [];

page.on("response", async (response) => {
  const url = response.url();
  if (!url.includes("/notes_rate") && !url.includes("/core_data")) return;
  try {
    const body = await response.json();
    const request = response.request();
    const postData = request.postData() || "";
    const params = Object.fromEntries(new URL(url).searchParams.entries());
    if (postData) {
      try {
        Object.assign(params, JSON.parse(postData));
      } catch {
        Object.assign(params, Object.fromEntries(new URLSearchParams(postData).entries()));
      }
    }
    delete params.userId;
    observed.push({
      endpoint: url.includes("/notes_rate") ? "notes_rate" : "core_data",
      params,
      metrics: {
        impMedian: body?.data?.impMedian ?? null,
        readMedian: body?.data?.readMedian ?? null,
        imp: body?.data?.sumData?.imp ?? null,
        read: body?.data?.sumData?.read ?? null,
      },
    });
  } catch {
    // Diagnostic output is best effort.
  }
});

try {
  await page.goto(creator.pgyLink, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await clickExact(page, "笔记数据", { waitMs: 900 });
  await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.58)));
  await page.waitForTimeout(700);
  await clickExact(page, "合作笔记", { last: true, waitMs: 900 });

  const controlsBeforeOpen = await visibleControls(page);
  const noteTypeSelection = await selectNoteType(page, "视频");
  const controlsAfterOpen = await visibleControls(page);
  const selected90 = await selectNear90(page);
  const flowTypeSelection = await selectFlowType(page, "仅自然流量");
  const scaleClicked = await clickExact(page, "按规模", { last: true, waitMs: 1200 });
  await page.waitForTimeout(1400);

  const pageText = await page.evaluate(() => document.body.innerText || "");
  const performanceTail = pageText.slice(Math.max(pageText.lastIndexOf("数据表现"), 0), Math.max(pageText.lastIndexOf("数据表现"), 0) + 700);
  console.log(JSON.stringify({
    creator: { nickname: creator.nickname, pgyLink: creator.pgyLink },
    actions: { noteTypeSelection, selected90, flowTypeSelection, scaleClicked },
    controlsBeforeOpen,
    controlsAfterOpen,
    performanceTail,
    observed,
  }, null, 2));
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
}
