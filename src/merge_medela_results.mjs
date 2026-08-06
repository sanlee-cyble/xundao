#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const directory = path.resolve(option("dir") || "");
const outputPath = path.resolve(option("output") || "");
if (!option("dir") || !option("output")) {
  throw new Error("usage: node src/merge_medela_results.mjs --dir <part-results-dir> --output <results.json>");
}

const entries = await fs.readdir(directory);
const resultFiles = entries.filter((name) => /^part-\d+\.json$/.test(name)).sort((left, right) => {
  const leftNumber = Number(left.match(/\d+/)?.[0]);
  const rightNumber = Number(right.match(/\d+/)?.[0]);
  return leftNumber - rightNumber;
});
const parts = await Promise.all(resultFiles.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))));
const results = parts.flat().sort((left, right) => Number(left.rowIndex) - Number(right.rowIndex));
const duplicateRows = results.filter((item, index) => index > 0 && Number(item.rowIndex) === Number(results[index - 1].rowIndex));
if (duplicateRows.length) throw new Error(`合并结果存在重复行：${duplicateRows.map((item) => item.rowIndex).join("、")}`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, count: results.length, outputPath, rows: results.map((item) => item.rowIndex) }));
