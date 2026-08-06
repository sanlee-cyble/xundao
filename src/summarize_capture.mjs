#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./common.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = await readJson(path.join(ROOT, "config/pgy_config.json"));

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function latestCaptureDir() {
  const rawRoot = path.join(ROOT, CONFIG.rawDir);
  if (!await exists(rawRoot)) return null;
  const entries = await fs.readdir(rawRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("capture-"))
    .map((entry) => entry.name)
    .sort();
  if (!dirs.length) return null;
  return path.join(rawRoot, dirs[dirs.length - 1]);
}

function endpointKey(record) {
  const parsed = new URL(record.url);
  return `${record.method || "GET"} ${parsed.origin}${parsed.pathname}`;
}

async function main() {
  const captureDir = await latestCaptureDir();
  if (!captureDir) {
    console.log("no capture dir found");
    return;
  }
  const logPath = path.join(captureDir, "network.jsonl");
  if (!await exists(logPath)) {
    console.log(`no network log found in ${path.relative(ROOT, captureDir)}`);
    return;
  }
  const lines = (await fs.readFile(logPath, "utf8")).trim().split(/\n+/).filter(Boolean);
  const endpointMap = new Map();
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.type !== "response") continue;
    const key = endpointKey(record);
    const existing = endpointMap.get(key) || {
      key,
      method: record.method,
      url: record.url,
      count: 0,
      statuses: {},
      score: 0,
      hitHints: new Set(),
      matchedCreators: new Map(),
      samples: []
    };
    existing.count += 1;
    existing.statuses[record.status] = (existing.statuses[record.status] || 0) + 1;
    existing.score += record.score || 0;
    for (const hint of record.hitHints || []) existing.hitHints.add(hint);
    for (const creator of record.matchedCreators || []) {
      existing.matchedCreators.set(`${creator.rowIndex}:${creator.redId}`, creator);
    }
    if (record.rawPath && existing.samples.length < 5) existing.samples.push(record.rawPath);
    endpointMap.set(key, existing);
  }
  const endpoints = [...endpointMap.values()]
    .map((item) => ({
      ...item,
      hitHints: [...item.hitHints],
      matchedCreators: [...item.matchedCreators.values()]
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count);
  const out = path.join(captureDir, "endpoint_candidates.json");
  await writeJson(out, {
    captureDir: path.relative(ROOT, captureDir),
    generatedAt: new Date().toISOString(),
    endpoints
  });
  console.log(`summarized ${endpoints.length} endpoints -> ${path.relative(ROOT, out)}`);
  for (const endpoint of endpoints.slice(0, 12)) {
    console.log(`${endpoint.score.toString().padStart(3)} ${endpoint.count.toString().padStart(3)} ${endpoint.key}`);
  }
}

await main();
