#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKBOOK_BRIDGE = fileURLToPath(new URL("./workbook_bridge.py", import.meta.url));

function argsFrom(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`缺少参数 --${name}`);
  return path.resolve(value);
}

function runWorkbookBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [WORKBOOK_BRIDGE, ...args], {
      cwd: path.dirname(WORKBOOK_BRIDGE),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `workbook bridge exited with ${code}`));
    });
  });
}

async function commandExtract(options) {
  return await runWorkbookBridge([
    "medela-extract",
    "--input",
    required(options, "input"),
    "--creators",
    required(options, "creators"),
  ]);
}

async function commandFill(options) {
  const outputPath = required(options, "output");
  return await runWorkbookBridge([
    "medela-fill",
    "--input",
    required(options, "input"),
    "--results",
    required(options, "results"),
    "--output",
    outputPath,
    "--preview",
    options.preview
      ? path.resolve(options.preview)
      : outputPath.replace(/\.xlsx$/i, ".preview.svg"),
    "--validation",
    options.validation
      ? path.resolve(options.validation)
      : outputPath.replace(/\.xlsx$/i, ".validation.json"),
  ]);
}

const { command, options } = argsFrom(process.argv.slice(2));
let output = "";
if (command === "extract") output = await commandExtract(options);
else if (command === "fill") output = await commandFill(options);
else throw new Error("usage: node src/medela_workbook.mjs <extract|fill> --input <xlsx> [--creators <json>] [--results <json> --output <xlsx>]");
if (output) console.log(output);
