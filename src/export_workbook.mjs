#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson } from "./common.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = await readJson(path.join(ROOT, "config/pgy_config.json"));
const resultsPath = path.resolve(ROOT, CONFIG.mappedResultsJson);
const outputDir = path.resolve(ROOT, CONFIG.outputDir);
const outputPath = path.join(outputDir, "达人表现数据_采集结果.xlsx");

await fs.mkdir(outputDir, { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn("python3", [
    path.join(ROOT, "src/prototype_excel.py"),
    "export",
    "--results",
    resultsPath,
    "--output",
    outputPath,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Excel export exited with ${code}`));
  });
});

console.log(`exported -> ${outputPath}`);
