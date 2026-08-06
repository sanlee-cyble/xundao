import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeWorkbookValues,
  discoverRuntimePgyColumns,
  valueForPgyColumn,
} from "../src/dynamic_workbook.mjs";
import {
  PGY_SCOPES,
  compileCollectionPlan,
  extractRegisteredFieldsFromApi,
  matchFieldLabel,
  publicFieldRegistry,
} from "../src/field_registry.mjs";
import { resolveWorkbookColumns } from "../src/semantic_resolver.mjs";
import { resolveColumnsWithFieldLibrary } from "../src/field_resolution_service.mjs";
import { createTaskContract } from "../src/task_contract.mjs";

test("动态表头用父级分组区分 90 天合作笔记与 30 天日常笔记", () => {
  const values = [
    ["名称", "蒲公英链接", "90天合作笔记", null, "30天日常笔记", null, "报价", "cpc"],
    [null, null, "曝光中位数（90天）", "阅读中位数（90天）", "曝光中位数（90天）", "阅读中位数（90天）", null, null],
    ["测试达人", "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-1", null, null, null, null, null, null],
  ];
  const task = analyzeWorkbookValues(values, "测试");
  assert.equal(task.creators.length, 1);
  assert.equal(task.columns[2].mapping.id, "pgy.coop.video.90d.full.imp_median");
  assert.equal(task.columns[4].mapping.id, "pgy.daily.all.30d.full.imp_median");
  assert.equal(task.columns[7].mapping.id, "derived.cpc");
  assert.deepEqual(
    task.collectionPlan.requests.map((request) => request.id),
    [
      "creator.basic",
      "coop.video.90d.full.summary",
      "daily.all.30d.full.summary",
    ],
  );
});

test("服务端二次解析保留已识别合同且不把公式列重新解释为蒲公英字段", async () => {
  const values = [
    ["名称", "蒲公英链接", "90天合作笔记", null, "30天日常笔记", null, "报价", "cpc"],
    [null, null, "曝光中位数（90天）", "阅读中位数（90天）", "曝光中位数（90天）", "阅读中位数（90天）", null, null],
    ["测试达人", "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-1", null, null, null, null, null, null],
  ];
  const first = analyzeWorkbookValues(values, "测试");
  const resolution = resolveWorkbookColumns(first.columns);
  const assisted = await resolveColumnsWithFieldLibrary(resolution.columns, { apiKey: "" });
  const contract = createTaskContract({
    columns: assisted.columns,
    creators: first.creators,
  });
  assert.equal(contract.unresolvedCount, first.taskContract.unresolvedCount);
  assert.equal(assisted.columns[2].contract.scene, "cooperation");
  assert.equal(assisted.columns[4].contract.scene, "daily");
  assert.equal(assisted.columns[7].mapping.id, "derived.cpc");
});

test("字段注册表识别换行公式列并把 CPC 锁定到仅自然流阅读", () => {
  assert.equal(
    matchFieldLabel("下单价\n（后台价格*1.1，为平台服务费)").id,
    "derived.order_price",
  );
  const cpc = matchFieldLabel("cpc");
  assert.equal(cpc.id, "derived.cpc");
  assert.deepEqual(cpc.dependencies, [
    "pgy.creator.video_quote",
    "pgy.coop.video.90d.natural.read",
  ]);
});

test("注册表按三个明确口径提取合作全流量、合作自然流和日常 30 天", () => {
  const coopUrl = `https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?${new URLSearchParams({
    userId: "creator-1",
    ...PGY_SCOPES.COOP_VIDEO_90_FULL,
  })}`;
  const coop = extractRegisteredFieldsFromApi(coopUrl, {
    data: {
      impMedian: 50000,
      readMedian: 10000,
      likeMedian: 200,
      collectMedian: 100,
      hundredLikePercent: "75.0",
      thousandLikePercent: "12.5",
      notes: [
        { likeNum: 100, collectNum: 50 },
        { likeNum: 300, collectNum: 150 },
      ],
      pagePercentVo: {
        impHomefeedPercent: 0.7,
        impSearchPercent: 0.3,
      },
    },
  });
  assert.equal(coop["合作笔记曝光中位数（90天）"], 50000);
  assert.equal(coop["90天合作笔记百赞比例"], 0.75);
  assert.equal(coop["90天合作笔记赞藏量中位数"], 300);
  assert.equal(coop["曝光来源-搜索页"], 0.3);

  const natural = extractRegisteredFieldsFromApi(
    "https://pgy.xiaohongshu.com/api/pgy/kol/data/core_data",
    { data: { sumData: { imp: 42000, read: 8300 } } },
    { postData: JSON.stringify({ userId: "creator-1", ...PGY_SCOPES.COOP_VIDEO_90_NATURAL }) },
  );
  assert.equal(natural["预估合作笔记自然流曝光（90天）"], 42000);
  assert.equal(natural["预估合作笔记自然流阅读（90天）"], 8300);

  const dailyUrl = `https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?${new URLSearchParams({
    userId: "creator-1",
    ...PGY_SCOPES.DAILY_ALL_30_FULL,
  })}`;
  const daily = extractRegisteredFieldsFromApi(dailyUrl, {
    data: { impMedian: 5000, readMedian: 2000, likeMedian: 80, collectMedian: 30 },
  });
  assert.equal(daily["30天日常笔记曝光中位数"], 5000);
  assert.equal(daily["30天日常笔记阅读中位数"], 2000);
});

test("采集计划按字段去重请求", () => {
  const plan = compileCollectionPlan([
    "pgy.coop.video.90d.full.imp_median",
    "pgy.coop.video.90d.full.read_median",
    "pgy.coop.video.90d.full.traffic.search",
  ]);
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].id, "coop.video.90d.full.summary");
});

test("图文+视频口径仅替换合作笔记的 noteType，仍锁定近90日和流量范围", () => {
  const coopUrl = `https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?${new URLSearchParams({
    userId: "creator-1",
    ...PGY_SCOPES.COOP_MIXED_90_FULL,
  })}`;
  const fields = extractRegisteredFieldsFromApi(coopUrl, {
    data: { noteNumber: 3, impMedian: 74000, readMedian: 12000 },
  }, { noteScope: "mixed" });
  assert.equal(fields["90天合作笔记样本数"], 3);
  assert.equal(fields["合作笔记曝光中位数（90天）"], 74000);
  assert.equal(fields["合作笔记阅读中位数（90天）"], 12000);

  const plan = compileCollectionPlan([
    "pgy.coop.video.90d.full.imp_median",
    "pgy.coop.video.90d.natural.read",
  ], { noteScope: "mixed" });
  const fullPath = plan.requests.find((request) => request.id === "coop.video.90d.full.summary").path({ creatorId: "creator-1" });
  const naturalBody = plan.requests.find((request) => request.id === "coop.video.90d.natural.core").body({ creatorId: "creator-1" });
  assert.match(fullPath, /noteType=3/);
  assert.match(fullPath, /dateType=2/);
  assert.match(fullPath, /advertiseSwitch=1/);
  assert.deepEqual(naturalBody, { userId: "creator-1", ...PGY_SCOPES.COOP_MIXED_90_NATURAL });
});

test("动态任务保留列级合同以区分同一指标的不同内容类型", () => {
  const values = [
    ["名称", "蒲公英链接", "视频合作笔记90天全流量", "图文合作笔记90天全流量"],
    [null, null, "曝光中位数（90天）", "曝光中位数（90天）"],
    ["测试达人", "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-1", null, null],
  ];
  const task = analyzeWorkbookValues(values, "测试");
  assert.equal(task.columns[2].contract.contentType, "video");
  assert.equal(task.columns[3].contract.contentType, "image");
  assert.equal(task.scopeGroups.filter((group) => group.scene === "cooperation").length, 2);
  const result = {
    contractValues: {
      "pgy.note.exposure.median|cooperation|video|90d|all|scale": 2000,
      "pgy.note.exposure.median|cooperation|image|90d|all|scale": 1000,
    },
    fields: {},
  };
  assert.equal(valueForPgyColumn(task.columns[2], result), 2000);
  assert.equal(valueForPgyColumn(task.columns[3], result), 1000);
});

test("字段库以蒲公英原生字段名呈现，并用分组保留完整取数口径", () => {
  const fields = publicFieldRegistry();
  const imageExposure = fields.find((item) => item.id === "pgy.coop.image.30d.full.imp_median");
  assert.equal(imageExposure.name, "曝光中位数");
  assert.equal(imageExposure.group, "数据表现｜合作笔记｜图文｜近30日｜全流量｜按规模");
  const mixedNaturalRead = fields.find((item) => item.id === "pgy.coop.all.90d.natural.read");
  assert.equal(mixedNaturalRead.name, "阅读中位数");
  assert.equal(mixedNaturalRead.group, "数据表现｜合作笔记｜图文+视频｜近90日｜仅自然流量｜按规模");
  const trafficSearch = fields.find((item) => item.id === "pgy.daily.video.90d.full.traffic_search");
  assert.equal(trafficSearch.name, "搜索页");
  assert.match(trafficSearch.group, /曝光来源$/);
  const target = fields.find((item) => item.id === "pgy.daily.image.30d.natural.imp");
  assert.equal(target.contract.scene, "daily");
  assert.equal(target.contract.contentType, "image");
  assert.equal(target.contract.window, "30d");
  assert.equal(target.contract.traffic, "natural");
});

test("日文和英文表头可归一为蒲公英字段合同且忽略汇率元数据行", () => {
  const blank = () => Array(31).fill(null);
  const row1 = blank();
  const row2 = blank();
  const row3 = blank();
  const row4 = blank();
  const row5 = blank();
  row2[1] = "レート";
  row2[2] = 23.52;
  row3[7] = "KOL名";
  row3[8] = "小紅書ID";
  row3[9] = "蒲公英リンク";
  row3[10] = "ファン数";
  row3[21] = "Daily posts · all content types · last 90 days · all traffic · median views";
  row3[22] = "通常投稿・全投稿形式・過去90日・全トラフィック・エンゲージメント中央値";
  row3[23] = "Daily video · last 90 days · all traffic · completion rate";
  row3[24] = "通常投稿・画像・過去90日・全トラフィック・3秒閲覧率";
  row5[7] = "测试达人";
  row5[8] = "red-001";
  row5[9] = "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/creator-jp";
  const task = analyzeWorkbookValues(
    [blank(), row2, row3, row4, row5],
    "富士テスト",
  );
  assert.equal(task.headerStartRow, 3);
  assert.equal(task.calculationContext.exchangeRate, 23.52);
  assert.equal(task.creators[0].nickname, "测试达人");
  assert.equal(task.columns[8].mapping.id, "pgy.creator.red_id");
  assert.equal(task.columns[9].mapping.id, "pgy.creator.pgy_profile");
  assert.equal(task.columns[10].mapping.id, "pgy.creator.fans");
  assert.equal(task.columns[21].contract.metric, "read");
  assert.equal(task.columns[21].contract.scene, "daily");
  assert.equal(task.columns[21].contract.window, "90d");
  assert.equal(task.columns[21].contract.traffic, "all");
  assert.equal(task.columns[22].contract.metric, "interaction");
  assert.equal(task.columns[23].contract.contentType, "video");
  assert.equal(task.columns[23].contract.metric, "video_full_view");
  assert.equal(task.columns[24].contract.contentType, "image");
  assert.equal(task.columns[24].contract.metric, "picture_3s_view");
  assert.equal(task.unresolvedCount, 0);
});

test("字段库未登记但蒲公英已返回的字段只在当前任务内按精确名称发现", () => {
  const task = {
    columns: [{
      key: "C:粉丝互动偏好",
      displayLabel: "粉丝互动偏好",
      pathLabel: "粉丝互动偏好",
      mapping: null,
    }],
    unmatchedColumns: [{
      key: "C:粉丝互动偏好",
      displayLabel: "粉丝互动偏好",
    }],
  };
  const discovered = discoverRuntimePgyColumns(task, [{
    fields: {
      粉丝互动偏好: "评论型",
      近90日阅读中位数: 1000,
    },
  }]);
  assert.equal(discovered.columns[0].mapping.source, "pgy");
  assert.equal(discovered.columns[0].mapping.name, "粉丝互动偏好");
  assert.equal(discovered.columns[0].mapping.discoveredAtRuntime, true);
  assert.equal(discovered.unmatchedColumns.length, 0);
  assert.equal(task.columns[0].mapping, null);
});
