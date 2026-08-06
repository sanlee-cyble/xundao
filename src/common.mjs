import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function safeFilename(input) {
  return String(input)
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}._-]+/gu, "_")
    .slice(0, 120);
}

export function textIncludesAny(text, needles) {
  const haystack = String(text || "").toLowerCase();
  return needles.some((needle) => needle && haystack.includes(String(needle).toLowerCase()));
}

export function flattenJson(value, prefix = "", rows = []) {
  if (value === null || value === undefined) {
    rows.push({ path: prefix, value });
    return rows;
  }
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => flattenJson(item, `${prefix}[${index}]`, rows));
    return rows;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenJson(child, prefix ? `${prefix}.${key}` : key, rows);
    }
    return rows;
  }
  rows.push({ path: prefix, value });
  return rows;
}

export function pickInteresting(json, creators, hints) {
  const text = JSON.stringify(json);
  const matchedCreators = creators.filter((creator) => {
    const markers = [creator.nickname, creator.redId, creator.pgyLink, creator.creatorId].filter(Boolean);
    return textIncludesAny(text, markers);
  });
  const hitHints = hints.filter((hint) => textIncludesAny(text, [hint]));
  return {
    matchedCreators: matchedCreators.map((creator) => ({
      rowIndex: creator.rowIndex,
      nickname: creator.nickname,
      redId: creator.redId
    })),
    hitHints,
    score: matchedCreators.length * 10 + Math.min(hitHints.length, 10)
  };
}
