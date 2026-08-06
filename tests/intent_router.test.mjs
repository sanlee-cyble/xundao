import assert from "node:assert/strict";
import test from "node:test";
import { routeIntent } from "../src/intent_router.mjs";

test("上传 Excel 优先识别为采集", () => {
  assert.equal(routeIntent({ hasExcel: true, text: "帮我处理" }).intent, "collect");
});

test("明确寻找表达识别为 finder", () => {
  assert.equal(routeIntent({ hasExcel: false, text: "寻找50位母婴达人" }).intent, "finder");
});

test("先找再采集识别为两阶段", () => {
  assert.deepEqual(
    routeIntent({ hasExcel: false, text: "先找20位母婴达人，再采集90天合作笔记" }).stages,
    ["finder", "collect"],
  );
});

test("蒲公英链接优先识别为采集", () => {
  assert.equal(
    routeIntent({ text: "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/123" }).intent,
    "collect",
  );
});
