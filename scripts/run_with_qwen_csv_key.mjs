#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        value += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function findKey(csvText) {
  const rows = csvText.split(/\r?\n/).filter((line) => line.trim()).map(parseCsvLine);
  if (!rows.length) return "";
  const normalizeLabel = (item) => String(item || "")
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const validKey = (item) => {
    const value = String(item || "").trim();
    return /^sk-[^\s,"]{12,}$/.test(value) ? value : "";
  };
  const propertyRow = rows.find((row) => (
    ["apikey", "key", "密钥"].includes(normalizeLabel(row[0]))
    && validKey(row[1])
  ));
  if (propertyRow) return validKey(propertyRow[1]);
  const headers = rows[0].map(normalizeLabel);
  const keyIndex = headers.findIndex((item) => ["apikey", "key", "密钥"].includes(item));
  if (keyIndex >= 0 && validKey(rows[1]?.[keyIndex])) return validKey(rows[1][keyIndex]);
  return rows.flat().map(validKey).find(Boolean) || "";
}

const [keyFile = process.env.QWEN_API_KEY_FILE, command, ...args] = process.argv.slice(2);
if (!keyFile || !command) {
  throw new Error("用法：node scripts/run_with_qwen_csv_key.mjs <key.csv> <command> [...args]");
}
const apiKey = findKey(await fs.readFile(keyFile, "utf8"));
if (!apiKey) throw new Error("CSV 中未找到可用的 Qwen API Key");

const child = spawn(command, args, {
  stdio: "inherit",
  env: { ...process.env, QWEN_API_KEY: apiKey },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
