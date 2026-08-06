import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbookColumns } from "../src/semantic_resolver.mjs";

test("父级90天合作笔记与自然流列拆成不同口径组", () => {
  const columns = [
    { letter: "M", parentLabel: "90天合作笔记", displayLabel: "曝光中位数（90天）" },
    { letter: "AE", parentLabel: "", displayLabel: "预估合作笔记自然流曝光" },
    { letter: "AG", parentLabel: "30天日常笔记", displayLabel: "曝光中位数（30天）" },
  ];
  const result = resolveWorkbookColumns(columns, {
    contentTypeDefault: "all",
    naturalWindowDefault: "90d",
  });
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.scopeGroups.length, 3);
  assert.equal(result.columns.find((item) => item.letter === "M").contract.traffic, "all");
  assert.equal(result.columns.find((item) => item.letter === "AE").contract.traffic, "natural");
  assert.equal(result.columns.find((item) => item.letter === "AE").contract.window, "90d");
  assert.equal(result.columns.find((item) => item.letter === "AG").contract.window, "30d");
});

test("曝光中位数缺少业务维度时生成澄清问题", () => {
  const result = resolveWorkbookColumns([
    { letter: "M", parentLabel: "", displayLabel: "曝光中位数（90天）" },
  ]);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.unresolved[0].missingDimensions, ["scene", "contentType", "traffic"]);
});

test("计划目标和计划比不会伪装成蒲公英待采字段", () => {
  const result = resolveWorkbookColumns([
    {
      letter: "P",
      parentLabel: "エンゲージメント / 总互动",
      childLabel: "計画 / 目標",
      displayLabel: "計画 / 目標",
      pathLabel: "エンゲージメント / 总互动 / 計画 / 目標",
      mapping: { id: "pgy.note.interaction.value", name: "互动量", source: "pgy" },
    },
    {
      letter: "AZ",
      parentLabel: "エンゲージメント率 / 互动率",
      childLabel: "計画比 / %",
      displayLabel: "計画比 / %",
      pathLabel: "エンゲージメント率 / 互动率 / 計画比 / %",
    },
  ]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.columns[0].mapping, null);
  assert.equal(result.columns[0].outputPolicy.mode, "manual");
  assert.equal(result.columns[1].mapping, null);
  assert.equal(result.columns[1].outputPolicy.mode, "manual");
});

test("近16篇使用字段库确定的全部笔记和原始流量口径", () => {
  const result = resolveWorkbookColumns([
    {
      letter: "AN",
      parentLabel: "近16篇",
      displayLabel: "最高阅读量",
      mapping: { id: "pgy.recent16.max_read", name: "近16篇最高阅读量", source: "pgy", unit: "次" },
    },
  ]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.columns[0].contract.contentType, "all");
  assert.equal(result.columns[0].contract.traffic, "original");
});

test("父级30天日常笔记优先于子表头遗留的90天文案", () => {
  const result = resolveWorkbookColumns([
    {
      letter: "AG",
      parentLabel: "30天日常笔记",
      childLabel: "曝光中位数（90天）",
      displayLabel: "曝光中位数（90天）",
      mapping: {
        id: "pgy.daily.all.30d.full.imp_median",
        name: "30天日常笔记曝光中位数",
        source: "pgy",
        unit: "次",
      },
    },
  ], { contentTypeDefault: "all" });
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.columns[0].contract.window, "30d");
});
