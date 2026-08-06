#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { generateRecommendationReasons } from "./recommendation_service.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const inputPath = path.resolve(option("results") || "");
const outputPath = path.resolve(option("output") || option("results") || "");
if (!option("results")) {
  throw new Error("usage: node src/generate_recommendations.mjs --results <json> [--output <json>]");
}

const results = JSON.parse(await fs.readFile(inputPath, "utf8"));
const enriched = await generateRecommendationReasons(results);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  outputPath,
  count: enriched.length,
  model: enriched[0]?.recommendationModel || "",
  lengths: enriched.map((item) => ({
    rowIndex: item.rowIndex,
    length: Array.from(String(item.recommendationReason || "").replace(/\s+/g, "")).length,
  })),
}, null, 2));
