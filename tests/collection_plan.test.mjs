import assert from "node:assert/strict";
import test from "node:test";
import {
  compileTaskCollectionPlan,
  contractProvenanceForRequest,
  extractContractValues,
} from "../src/collection_plan.mjs";
import {
  mergeRecentNotesPayloads,
  nativeRequestMatches,
} from "../src/pgy_collect_core.mjs";
import { groupFieldContracts } from "../src/field_contracts.mjs";
import { contractByFieldId } from "../src/field_registry.mjs";

test("90天合作图文加视频全流量编译为 noteType=3 advertiseSwitch=1", () => {
  const plan = compileTaskCollectionPlan({
    scopeGroups: [{
      id: "group-a",
      scene: "cooperation",
      contentType: "all",
      window: "90d",
      traffic: "all",
      view: "scale",
      contracts: [{ fieldId: "pgy.note.exposure.median" }],
    }],
  }, "creator-1");
  assert.equal(plan.requests[0].params.business, 1);
  assert.equal(plan.requests[0].params.noteType, 3);
  assert.equal(plan.requests[0].params.dateType, 2);
  assert.equal(plan.requests[0].params.advertiseSwitch, 1);
});

test("同一任务允许全流量和自然流两个合作口径", () => {
  const plan = compileTaskCollectionPlan({
    scopeGroups: [
      { id: "all", scene: "cooperation", contentType: "all", window: "90d", traffic: "all", view: "scale", contracts: [] },
      { id: "natural", scene: "cooperation", contentType: "all", window: "90d", traffic: "natural", view: "scale", contracts: [] },
    ],
  }, "creator-1");
  assert.deepEqual(plan.requests.map((item) => item.params.advertiseSwitch).sort(), [0, 1]);
  assert.equal(plan.requests.find((item) => item.params.advertiseSwitch === 0).method, "POST");
});

test("未解决口径不能被编译", () => {
  assert.throws(() => compileTaskCollectionPlan({
    scopeGroups: [{
      id: "ambiguous",
      scene: "cooperation",
      contentType: "",
      window: "90d",
      traffic: "all",
      view: "scale",
      contracts: [],
    }],
  }, "creator-1"), /不支持的内容类型/);
});

test("同一指标的不同口径按合同键分别保存", () => {
  const base = {
    fieldId: "pgy.note.exposure.median",
    metric: "exposure",
    statistic: "median",
    scene: "cooperation",
    window: "90d",
    traffic: "all",
    view: "scale",
    source: "pgy",
    unit: "count",
  };
  const imageRequest = {
    endpoint: "/api/solar/kol/data_v3/notes_rate",
    contracts: [{ ...base, contentType: "image" }],
  };
  const videoRequest = {
    endpoint: "/api/solar/kol/data_v3/notes_rate",
    contracts: [{ ...base, contentType: "video" }],
  };
  const imageValues = extractContractValues(imageRequest, { data: { impMedian: 1000 } });
  const videoValues = extractContractValues(videoRequest, { data: { impMedian: 2000 } });
  assert.equal(imageValues["pgy.note.exposure.median|cooperation|image|90d|all|scale"], 1000);
  assert.equal(videoValues["pgy.note.exposure.median|cooperation|video|90d|all|scale"], 2000);
});

test("自然流、比例和近16篇使用各自响应结构", () => {
  const naturalContract = {
    fieldId: "pgy.note.read.value",
    metric: "read",
    statistic: "value",
    scene: "cooperation",
    contentType: "all",
    window: "90d",
    traffic: "natural",
    view: "scale",
    source: "pgy",
    unit: "count",
  };
  const natural = extractContractValues({
    endpoint: "/api/pgy/kol/data/core_data",
    contracts: [naturalContract],
  }, { data: { sumData: { read: 8321 } } });
  assert.equal(natural["pgy.note.read.value|cooperation|all|90d|natural|scale"], 8321);

  const recentContract = {
    fieldId: "pgy.note.read.max",
    metric: "read",
    statistic: "max",
    scene: "all",
    contentType: "all",
    window: "recent16",
    traffic: "original",
    view: "list",
    source: "pgy",
    unit: "count",
  };
  const recent = extractContractValues({
    endpoint: "/api/solar/kol/data_v2/notes_detail",
    contracts: [recentContract],
  }, { data: { list: [{ readNum: 5 }, { readNum: 12 }] } });
  assert.equal(recent["pgy.note.read.max|all|all|recent16|original|list"], 12);
});

test("原生交互响应必须与已确认口径逐参数匹配", () => {
  const request = {
    endpoint: "/api/solar/kol/data_v3/notes_rate",
    params: {
      userId: "creator-1",
      business: 1,
      noteType: 3,
      dateType: 2,
      advertiseSwitch: 1,
    },
  };
  assert.equal(nativeRequestMatches(
    request,
    "https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?userId=creator-1&business=1&noteType=3&dateType=2&advertiseSwitch=1",
  ), true);
  assert.equal(nativeRequestMatches(
    request,
    "https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?userId=creator-1&business=1&noteType=2&dateType=2&advertiseSwitch=1",
  ), false);
});

test("近16篇按蒲公英原生的两页8条合并并去重", () => {
  const pageOne = Array.from({ length: 8 }, (_, index) => ({ noteId: `n${index + 1}`, readNum: index + 1 }));
  const pageTwo = Array.from({ length: 8 }, (_, index) => ({ noteId: `n${index + 9}`, readNum: index + 9 }));
  const payload = mergeRecentNotesPayloads([
    { pageNumber: 1, payload: { data: { list: pageOne } } },
    { pageNumber: 2, payload: { data: { list: pageTwo } } },
  ]);
  assert.equal(payload.data.list.length, 16);
  assert.equal(payload.data.list.at(-1).readNum, 16);
});

test("达人基础字段按合同库请求并从原始JSON路径提取", () => {
  const contract = contractByFieldId("pgy.creator.fans");
  const plan = compileTaskCollectionPlan({
    scopeGroups: groupFieldContracts([contract]),
  }, "creator-1");
  assert.equal(plan.requests.length, 1);
  assert.equal(
    plan.requests[0].endpoint,
    "/api/solar/cooperator/user/blogger/creator-1",
  );
  const values = extractContractValues(plan.requests[0], {
    data: { fansCount: 1566 },
  });
  assert.equal(
    values["pgy.creator.fans|creator|all|lifetime|all|profile"],
    1566,
  );
});

test("评论中位数、互动率和阅读来源使用字段合同响应路径", () => {
  const contracts = [
    contractByFieldId("pgy.daily.all.30d.full.comment_median"),
    contractByFieldId("pgy.daily.all.30d.full.interaction_rate"),
    contractByFieldId("pgy.daily.all.30d.full.read_traffic_search"),
  ];
  const request = compileTaskCollectionPlan({
    scopeGroups: groupFieldContracts(contracts),
  }, "creator-1").requests[0];
  const values = extractContractValues(request, {
    data: {
      commentMedian: 34,
      interactionRate: "46.7",
      pagePercentVo: { readSearchPercent: 0.551 },
    },
  });
  assert.equal(
    values["pgy.note.comment.median|daily|all|30d|all|scale"],
    34,
  );
  assert.equal(
    values["pgy.note.interaction.rate|daily|all|30d|all|scale"],
    0.467,
  );
  assert.equal(
    values["pgy.note.read_traffic_search.share|daily|all|30d|all|scale"],
    0.551,
  );
});

test("每个字段保存请求签名、值状态和确定性来源", () => {
  const contracts = [
    contractByFieldId("pgy.daily.all.30d.full.comment_median"),
    contractByFieldId("pgy.daily.all.30d.full.share_median"),
  ];
  const request = compileTaskCollectionPlan({
    scopeGroups: groupFieldContracts(contracts),
  }, "creator-1").requests[0];
  const values = extractContractValues(request, {
    data: { commentMedian: 0 },
  });
  const provenance = contractProvenanceForRequest(request, values, {
    ok: true,
    status: 200,
    transport: "fetch",
    capturedAt: "2026-07-31T00:00:00.000Z",
  });
  const commentKey = "pgy.note.comment.median|daily|all|30d|all|scale";
  const shareKey = "pgy.note.share.median|daily|all|30d|all|scale";
  assert.equal(provenance[commentKey].valueStatus, "ZERO");
  assert.equal(provenance[shareKey].valueStatus, "NO_SAMPLE");
  assert.equal(provenance[commentKey].requestSignature, request.signature);
  assert.equal(provenance[commentKey].requestId, "notes.full.scale");
  assert.equal(provenance[commentKey].endpoint, "/api/solar/kol/data_v3/notes_rate");
});
