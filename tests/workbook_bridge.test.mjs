import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  attachLinksToWorkbook,
  exportDynamicWorkbook,
  extractDynamicTask,
  fillDynamicWorkbook,
} from "../src/dynamic_workbook.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureBuilder = path.join(projectRoot, "tests/fixtures/create_portable_workbooks.py");
const workbookBridge = path.join(projectRoot, "src/workbook_bridge.py");
const medelaCli = path.join(projectRoot, "src/medela_workbook.mjs");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("OpenPyXL 生产桥可解析并回填动态 Excel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-workbook-test-"));
  try {
    run("python3", [fixtureBuilder, root]);
    const inputPath = path.join(root, "dynamic.xlsx");
    const outputPath = path.join(root, "dynamic-output.xlsx");
    const previewPath = path.join(root, "dynamic-preview.svg");
    const validationPath = path.join(root, "dynamic-validation.json");
    const task = await extractDynamicTask(inputPath);
    assert.equal(task.creators.length, 1);
    const creator = task.creators[0];
    const validation = await fillDynamicWorkbook({
      inputPath,
      outputPath,
      previewPath,
      validationPath,
      results: [{
        ...creator,
        fields: {
          "粉丝数（w）": 9.5,
          "报价": 1000,
          "预估合作笔记自然流阅读（90天）": 4000,
        },
        contractValues: {},
        llmFieldDecisions: {},
      }],
    });
    assert.equal(validation.errorInspection.length, 0);
    assert.equal(validation.formulaInspection.length, 3);
    const inspected = JSON.parse(run("python3", [
      workbookBridge,
      "inspect",
      "--input",
      outputPath,
    ]));
    assert.deepEqual(inspected.values[1].slice(2, 5), [9.5, 1000, 4000]);
    assert.deepEqual(inspected.values[1].slice(5, 8), [
      '=IF(D2="","",ROUND(D2*1.1,2))',
      '=IF(F2="","",ROUND(F2*1.02,2))',
      '=IF(E2>0,D2/E2,"")',
    ]);
    assert.match(await fs.readFile(previewPath, "utf8"), /^<svg/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("美德乐兼容模板在无私有 Node 依赖时仍可回填", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-medela-test-"));
  try {
    run("python3", [fixtureBuilder, root]);
    const inputPath = path.join(root, "medela.xlsx");
    const creatorsPath = path.join(root, "creators.json");
    const resultsPath = path.join(root, "results.json");
    const outputPath = path.join(root, "medela-output.xlsx");
    const previewPath = path.join(root, "medela-preview.svg");
    const validationPath = path.join(root, "medela-validation.json");
    run(process.execPath, [
      medelaCli,
      "extract",
      "--input",
      inputPath,
      "--creators",
      creatorsPath,
    ]);
    const [creator] = JSON.parse(await fs.readFile(creatorsPath, "utf8"));
    await fs.writeFile(resultsPath, JSON.stringify([{
      ...creator,
      recommendationReason: "本测试只验证便携回填链路，不用于实际投放判断。",
      fields: {
        "小红书主页链接": "https://www.xiaohongshu.com/user/profile/creator-fixture",
        "粉丝数（w）": 9.5,
        "合作笔记曝光中位数（90天）": 5000,
        "合作笔记阅读中位数（90天）": 4000,
        "预估合作笔记自然流曝光（90天）": 3000,
        "预估合作笔记自然流阅读（90天）": 2000,
        "报价": 1000,
      },
    }]));
    run(process.execPath, [
      medelaCli,
      "fill",
      "--input",
      inputPath,
      "--results",
      resultsPath,
      "--output",
      outputPath,
      "--preview",
      previewPath,
      "--validation",
      validationPath,
    ]);
    const inspected = JSON.parse(run("python3", [
      workbookBridge,
      "inspect",
      "--input",
      outputPath,
    ]));
    assert.equal(inspected.values[2][9], "https://www.xiaohongshu.com/user/profile/creator-fixture");
    assert.equal(inspected.values[2][10], 9.5);
    assert.equal(inspected.values[2][22], '=IF(V3="","",ROUND(V3*1.1,2))');
    assert.equal(inspected.values[2][23], '=IF(W3="","",ROUND(W3*1.02,2))');
    assert.equal(inspected.values[2][24], '=IF(U3>0,V3/U3,"")');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("无 Excel 的动态字段任务可导出通用工作簿和公式", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-dynamic-export-test-"));
  try {
    const outputPath = path.join(root, "link-task.xlsx");
    const previewPath = path.join(root, "link-task.svg");
    const validationPath = path.join(root, "link-task-validation.json");
    const creator = {
      rowIndex: 2,
      nickname: "测试达人",
      pgyLink: "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-link",
    };
    const definitions = [
      ["pgy.creator.video_quote", "报价", "pgy", "元"],
      ["pgy.coop.video.90d.natural.read", "预估合作笔记自然流阅读（90天）", "pgy", "次"],
      ["derived.order_price", "下单价", "formula", "元"],
      ["derived.actual_spend", "实际花费", "formula", "元"],
      ["derived.cpc", "CPC", "formula", "元"],
    ];
    const task = {
      creators: [creator],
      columns: definitions.map(([id, name, source, unit], index) => ({
        index,
        letter: String.fromCharCode(65 + index),
        displayLabel: name,
        topLabel: source === "formula"
          ? "程序计算"
          : id === "pgy.creator.video_quote"
            ? "合作报价"
            : "数据表现｜合作笔记｜视频｜近90日｜仅自然流量｜按规模",
        mapping: {
          id,
          name,
          label: id === "pgy.creator.video_quote"
            ? "视频笔记一口价"
            : id === "pgy.coop.video.90d.natural.read"
              ? "阅读中位数"
              : name,
          source,
          unit,
        },
        contract: null,
      })),
    };
    const validation = await exportDynamicWorkbook({
      task,
      outputPath,
      previewPath,
      validationPath,
      results: [{
        ...creator,
        dataStatus: "成功",
        fields: {
          "报价": 1000,
          "预估合作笔记自然流阅读（90天）": 4000,
        },
      }],
    });
    assert.equal(validation.errorInspection.length, 0);
    assert.equal(validation.formulaInspection.length, 3);
    const inspected = JSON.parse(run("python3", [
      workbookBridge,
      "inspect",
      "--input",
      outputPath,
    ]));
    assert.deepEqual(inspected.values[1].slice(2), [
      "视频笔记一口价",
      "阅读中位数",
      "下单价",
      "实际花费",
      "CPC",
    ]);
    assert.deepEqual(inspected.values[2].slice(2), [
      1000,
      4000,
      '=IF(C3="","",ROUND(C3*1.1,2))',
      '=IF(E3="","",ROUND(E3*1.02,2))',
      '=IF(D3>0,C3/D3,"")',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("字段型 Excel 可与对话中另行粘贴的达人链接合并", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-template-links-test-"));
  try {
    run("python3", [fixtureBuilder, root]);
    const inputPath = path.join(root, "template-only.xlsx");
    const links = [
      "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-a",
      "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-b",
    ];
    const attached = await attachLinksToWorkbook(inputPath, links);
    assert.equal(attached.count, 2);
    const task = await extractDynamicTask(inputPath);
    assert.equal(task.creators.length, 2);
    assert.deepEqual(task.creators.map((creator) => creator.pgyLink), links);
    assert.equal(task.headerDepth, 2);
    const inspected = JSON.parse(run("python3", [
      workbookBridge,
      "inspect",
      "--input",
      inputPath,
    ]));
    assert.equal(inspected.values[1].at(-1), "蒲公英链接");
    assert.deepEqual(inspected.values.slice(2).map((row) => row.at(-1)), links);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("固化模板字段可追加到仅含达人链接的 Excel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-template-columns-test-"));
  try {
    run("python3", [fixtureBuilder, root]);
    const inputPath = path.join(root, "links-only.xlsx");
    const outputPath = path.join(root, "links-only-output.xlsx");
    const previewPath = path.join(root, "links-only-output.svg");
    const validationPath = path.join(root, "links-only-validation.json");
    const task = await extractDynamicTask(inputPath);
    task.columns.push({
      index: 1,
      letter: "B",
      key: "pgy.creator.fans:粉丝数",
      displayLabel: "粉丝数",
      childLabel: "粉丝数",
      mapping: {
        id: "pgy.creator.fans",
        name: "粉丝数",
        source: "pgy",
        unit: "人",
      },
      contract: null,
      appendedByTemplate: true,
    });
    const validation = await fillDynamicWorkbook({
      inputPath,
      task,
      outputPath,
      previewPath,
      validationPath,
      results: [{
        ...task.creators[0],
        fields: { "粉丝数": 12345 },
        contractValues: {},
        llmFieldDecisions: {},
      }],
    });
    assert.deepEqual(validation.appendedColumns, [{
      column: "B",
      fieldId: "pgy.creator.fans",
      name: "粉丝数",
    }]);
    const inspected = JSON.parse(run("python3", [
      workbookBridge,
      "inspect",
      "--input",
      outputPath,
    ]));
    assert.deepEqual(inspected.values[0], ["蒲公英链接", "粉丝数"]);
    assert.equal(inspected.values[1][1], 12345);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
