import assert from "node:assert/strict";
import test from "node:test";
import {
  PGY_FIELD_LIBRARY_V1,
  enrichFieldContract,
  fieldCapabilitiesByFieldId,
  listFieldCapabilities,
  matchPlatformFieldLabel,
  readPgyResponsePath,
  validateExecutableFieldContract,
} from "../src/pgy_field_library_v1.mjs";

test("字段合同库V1来自25组实时蒲公英证据并保留校准状态", () => {
  assert.equal(PGY_FIELD_LIBRARY_V1.schemaVersion, "1.0.0");
  assert.equal(PGY_FIELD_LIBRARY_V1.sourceEvidence.successfulScopeGroups, 25);
  assert.ok(PGY_FIELD_LIBRARY_V1.capabilities.length >= 370);
  assert.ok(
    listFieldCapabilities({ surfaceStatus: "pgy_ui_verified" }).length >= 50,
  );
  assert.ok(
    listFieldCapabilities({
      surfaceStatus: "api_observed_needs_ui_alignment",
    }).length >= 300,
  );
});

test("全流量评论、互动率和阅读来源都有蒲公英原生响应路径", () => {
  const comment = fieldCapabilitiesByFieldId("pgy.note.comment.median")[0];
  const interactionRate =
    fieldCapabilitiesByFieldId("pgy.note.interaction.rate")[0];
  const readSearch =
    fieldCapabilitiesByFieldId("pgy.note.read_traffic_search.share")[0];
  assert.equal(comment.platformLabel, "中位评论量");
  assert.equal(comment.response.jsonPath, "$.data.commentMedian");
  assert.equal(interactionRate.response.jsonPath, "$.data.interactionRate");
  assert.equal(
    readSearch.response.jsonPath,
    "$.data.pagePercentVo.readSearchPercent",
  );
});

test("原生名称只生成字段候选，不暗中补齐多值口径", () => {
  const matches = matchPlatformFieldLabel("曝光中位数", {
    domain: "notesFullTraffic",
  });
  assert.equal(matches.length, 1);
  const contract = enrichFieldContract({
    fieldId: "pgy.note.exposure.median",
    metric: "exposure",
    statistic: "median",
    scene: "cooperation",
    contentType: "",
    window: "90d",
    traffic: "all",
    view: "scale",
    source: "pgy",
    unit: "count",
  });
  const validation = validateExecutableFieldContract(contract);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missingDimensions, ["contentType"]);
});

test("已对齐字段合同包含请求、响应和空值规则", () => {
  const contract = enrichFieldContract({
    fieldId: "pgy.note.comment.median",
    metric: "comment",
    statistic: "median",
    scene: "daily",
    contentType: "all",
    window: "30d",
    traffic: "all",
    view: "scale",
    source: "pgy",
    unit: "count",
  });
  assert.equal(validateExecutableFieldContract(contract).valid, true);
  assert.equal(contract.request.requestId, "notes.full.scale");
  assert.equal(contract.response.jsonPath, "$.data.commentMedian");
  assert.match(contract.nullSemantics.zero, /保留0/);
});

test("响应路径读取器支持标量和数组字段", () => {
  const payload = {
    data: {
      commentMedian: 34,
      list: [{ readNum: 100 }, { readNum: 200 }],
    },
  };
  assert.equal(
    readPgyResponsePath(payload, "$.data.commentMedian"),
    34,
  );
  assert.deepEqual(
    readPgyResponsePath(payload, "$.data.list[].readNum"),
    [100, 200],
  );
});
