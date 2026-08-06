import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveEvidenceInput = path.join(
  projectRoot,
  "outputs",
  "019f8e39-6e0c-7310-8d13-6b9b08cc170e",
  "蒲公英达人_5649fae4_全量可请求数据.json",
);
const schemaSnapshotPath = path.join(
  projectRoot,
  "config",
  "pgy-field-schema-snapshot.v1.json",
);
const defaultInput = fs.existsSync(schemaSnapshotPath)
  ? schemaSnapshotPath
  : liveEvidenceInput;
const defaultOutput = path.join(projectRoot, "config", "pgy-field-contracts.v1.json");
const inputPath = path.resolve(process.argv[2] || defaultInput);
const outputPath = path.resolve(process.argv[3] || defaultOutput);

const DOMAIN_REQUESTS = Object.freeze({
  creatorProfile: {
    requestId: "creator.profile",
    method: "GET",
    endpointTemplate: "/api/solar/cooperator/user/blogger/{creatorId}",
  },
  contentTags: {
    requestId: "creator.content_tags",
    method: "GET",
    endpointTemplate: "/api/solar/kol/data_v2/kol_content_tags",
    queryTemplate: { userId: "{creatorId}" },
  },
  featureTags: {
    requestId: "creator.feature_tags",
    method: "GET",
    endpointTemplate: "/api/solar/kol/data_v2/kol_feature_tags",
    queryTemplate: { userId: "{creatorId}" },
  },
  fansProfile: {
    requestId: "creator.fans_profile",
    method: "GET",
    endpointTemplate: "/api/solar/kol/data/{creatorId}/fans_profile",
  },
  fansSummary: {
    requestId: "creator.fans_summary",
    method: "GET",
    endpointTemplate: "/api/solar/kol/data_v3/fans_summary",
    queryTemplate: { userId: "{creatorId}" },
  },
  dataSummary: {
    requestId: "creator.data_summary",
    method: "GET",
    endpointTemplate: "/api/pgy/kol/data/data_summary",
    queryTemplate: { userId: "{creatorId}", business: "{sceneCode}" },
  },
  notesFullTraffic: {
    requestId: "notes.full.scale",
    method: "GET",
    endpointTemplate: "/api/solar/kol/data_v3/notes_rate",
    queryTemplate: {
      userId: "{creatorId}",
      business: "{sceneCode}",
      noteType: "{contentTypeCode}",
      dateType: "{windowCode}",
      advertiseSwitch: 1,
    },
  },
  notesNaturalTraffic: {
    requestId: "notes.natural.scale",
    method: "POST",
    endpointTemplate: "/api/pgy/kol/data/core_data",
    bodyTemplate: {
      userId: "{creatorId}",
      business: "{sceneCode}",
      noteType: "{contentTypeCode}",
      dateType: "{windowCode}",
      advertiseSwitch: 0,
    },
  },
  recentNotes: {
    requestId: "notes.recent.list",
    method: "GET",
    endpointTemplate: "/api/solar/kol/data_v2/notes_detail",
    queryTemplate: {
      advertiseSwitch: 1,
      orderType: 1,
      pageNumber: "{pageNumber}",
      pageSize: 8,
      userId: "{creatorId}",
      noteType: 4,
      isThirdPlatform: 0,
    },
  },
});

const DOMAIN_DIMENSIONS = Object.freeze({
  creatorProfile: {
    scene: ["creator"],
    contentType: ["all"],
    window: ["lifetime"],
    traffic: ["all"],
    view: ["profile"],
  },
  contentTags: {
    scene: ["creator"],
    contentType: ["all"],
    window: ["lifetime"],
    traffic: ["all"],
    view: ["profile"],
  },
  featureTags: {
    scene: ["creator"],
    contentType: ["all"],
    window: ["lifetime"],
    traffic: ["all"],
    view: ["profile"],
  },
  fansProfile: {
    scene: ["creator"],
    contentType: ["all"],
    window: ["current"],
    traffic: ["all"],
    view: ["fans_profile"],
  },
  fansSummary: {
    scene: ["creator"],
    contentType: ["all"],
    window: ["30d"],
    traffic: ["all"],
    view: ["fans_summary"],
  },
  dataSummary: {
    scene: ["daily", "cooperation"],
    contentType: ["all"],
    window: ["current"],
    traffic: ["all"],
    view: ["overview"],
  },
  notesFullTraffic: {
    scene: ["daily", "cooperation"],
    contentType: ["image", "video", "all"],
    window: ["30d", "90d"],
    traffic: ["all"],
    view: ["scale"],
  },
  notesNaturalTraffic: {
    scene: ["daily", "cooperation"],
    contentType: ["image", "video", "all"],
    window: ["30d", "90d"],
    traffic: ["natural"],
    view: ["scale", "daily_series"],
  },
  recentNotes: {
    scene: ["all"],
    contentType: ["all"],
    window: ["recent16"],
    traffic: ["original"],
    view: ["list"],
  },
});

const NOTE_FULL_FIELDS = Object.freeze({
  noteNumber: ["pgy.note.sample.count", "sample", "count", "笔记数", "count"],
  videoNoteNumber: ["pgy.note.video_sample.count", "video_sample", "count", "视频笔记数", "count"],
  impMedian: ["pgy.note.exposure.median", "exposure", "median", "曝光中位数", "count"],
  impMedianBeyondRate: ["pgy.note.exposure.beyond_rate", "exposure", "beyond_rate", "曝光中位数超过同量级达人比例", "ratio"],
  readMedian: ["pgy.note.read.median", "read", "median", "阅读中位数", "count"],
  readMedianBeyondRate: ["pgy.note.read.beyond_rate", "read", "beyond_rate", "阅读中位数超过同量级达人比例", "ratio"],
  interactionMedian: ["pgy.note.interaction.median", "interaction", "median", "互动中位数", "count"],
  interactionRate: ["pgy.note.interaction.rate", "interaction", "rate", "互动率", "ratio"],
  interactionBeyondRate: ["pgy.note.interaction.beyond_rate", "interaction", "beyond_rate", "互动超过同量级达人比例", "ratio"],
  likeMedian: ["pgy.note.like.median", "like", "median", "中位点赞量", "count"],
  collectMedian: ["pgy.note.collect.median", "collect", "median", "中位收藏量", "count"],
  commentMedian: ["pgy.note.comment.median", "comment", "median", "中位评论量", "count"],
  shareMedian: ["pgy.note.share.median", "share", "median", "中位分享量", "count"],
  videoFullViewRate: ["pgy.note.video_full_view.rate", "video_full_view", "rate", "视频完播率", "ratio"],
  videoFullViewBeyondRate: ["pgy.note.video_full_view.beyond_rate", "video_full_view", "beyond_rate", "视频完播率超过同量级达人比例", "ratio"],
  picture3sViewRate: ["pgy.note.picture_3s_view.rate", "picture_3s_view", "rate", "图文3秒阅读率", "ratio"],
  hundredLikePercent: ["pgy.note.hundred_like.rate", "hundred_like", "rate", "百赞笔记比例", "ratio"],
  thousandLikePercent: ["pgy.note.thousand_like.rate", "thousand_like", "rate", "千赞笔记比例", "ratio"],
  "pagePercentVo.impHomefeedPercent": ["pgy.note.traffic_discover.share", "traffic_discover", "share", "发现页", "ratio"],
  "pagePercentVo.impSearchPercent": ["pgy.note.traffic_search.share", "traffic_search", "share", "搜索页", "ratio"],
  "pagePercentVo.impFollowPercent": ["pgy.note.traffic_follow.share", "traffic_follow", "share", "关注页", "ratio"],
  "pagePercentVo.impDetailPercent": ["pgy.note.traffic_profile.share", "traffic_profile", "share", "博主个人页", "ratio"],
  "pagePercentVo.impNearbyPercent": ["pgy.note.traffic_nearby.share", "traffic_nearby", "share", "附近页", "ratio"],
  "pagePercentVo.impOtherPercent": ["pgy.note.traffic_other.share", "traffic_other", "share", "其他", "ratio"],
  "pagePercentVo.readHomefeedPercent": ["pgy.note.read_traffic_discover.share", "read_traffic_discover", "share", "阅读来源·发现页", "ratio"],
  "pagePercentVo.readSearchPercent": ["pgy.note.read_traffic_search.share", "read_traffic_search", "share", "阅读来源·搜索页", "ratio"],
  "pagePercentVo.readFollowPercent": ["pgy.note.read_traffic_follow.share", "read_traffic_follow", "share", "阅读来源·关注页", "ratio"],
  "pagePercentVo.readDetailPercent": ["pgy.note.read_traffic_profile.share", "read_traffic_profile", "share", "阅读来源·博主个人页", "ratio"],
  "pagePercentVo.readNearbyPercent": ["pgy.note.read_traffic_nearby.share", "read_traffic_nearby", "share", "阅读来源·附近页", "ratio"],
  "pagePercentVo.readOtherPercent": ["pgy.note.read_traffic_other.share", "read_traffic_other", "share", "阅读来源·其他", "ratio"],
});

const NATURAL_FIELDS = Object.freeze({
  "sumData.imp": ["pgy.note.exposure.value", "exposure", "value", "曝光中位数", "count"],
  "sumData.read": ["pgy.note.read.value", "read", "value", "阅读中位数", "count"],
  "sumData.engage": ["pgy.note.interaction.value", "interaction", "value", "互动量", "count"],
  "sumData.cpm": ["pgy.note.cpm.value", "cpm", "value", "CPM", "currency_cny"],
  "sumData.cpv": ["pgy.note.cpv.value", "cpv", "value", "CPV", "currency_cny"],
  "sumData.cpuv": ["pgy.note.cpuv.value", "cpuv", "value", "CPUV", "currency_cny"],
  "sumData.cpe": ["pgy.note.cpe.value", "cpe", "value", "CPE", "currency_cny"],
  "sumData.thirdUserNum": ["pgy.note.third_user.count", "third_user", "count", "第三方用户数", "count"],
  "sumData.dateKey": ["pgy.note.data_date.value", "data_date", "value", "数据日期", "date"],
  "dailyData": ["pgy.note.natural_daily.series", "natural_daily", "series", "仅自然流量逐日数据", "json_array"],
});

const PROFILE_FIELDS = Object.freeze({
  name: ["pgy.creator.name", "博主名称"],
  redId: ["pgy.creator.red_id", "小红书号"],
  userId: ["pgy.creator.user_id", "达人ID"],
  headPhoto: ["pgy.creator.head_photo", "头像"],
  gender: ["pgy.creator.gender", "性别"],
  location: ["pgy.creator.location", "所在地"],
  fansNum: ["pgy.creator.fans", "粉丝数"],
  fansCount: ["pgy.creator.fans", "粉丝数"],
  picturePrice: ["pgy.creator.picture_quote", "图文笔记一口价"],
  videoPrice: ["pgy.creator.video_quote", "视频笔记一口价"],
  contentTags: ["pgy.creator.content_tags", "内容标签"],
  featureTags: ["pgy.creator.feature_tags", "内容特征标签"],
  videoFinishRate: ["pgy.creator.video_finish_rate", "视频完播率"],
  totalNoteCount: ["pgy.creator.note_count", "笔记数"],
  businessNoteCount: ["pgy.creator.business_note_count", "合作笔记数"],
});

const FANS_SUMMARY_FIELDS = Object.freeze({
  activeFansRate: ["pgy.creator.active_fans_rate", "活跃粉丝占比", "ratio"],
  readFansRate: ["pgy.creator.read_fans_rate", "阅读粉丝占比", "ratio"],
  engageFansRate: ["pgy.creator.engage_fans_rate", "互动粉丝占比", "ratio"],
  payFansUserRate30d: ["pgy.creator.order_fans_rate", "下单粉丝占比", "ratio"],
  fansGrowthRate: ["pgy.creator.fans_growth_rate", "粉丝增长率", "ratio"],
  fansIncreaseNum: ["pgy.creator.fans_increase_30d", "近30日涨粉数", "count"],
  fansNum: ["pgy.creator.fans", "粉丝数", "count"],
});

const DOMAIN_LABELS = Object.freeze({
  creatorProfile: "达人档案与合作报价",
  contentTags: "内容标签",
  featureTags: "内容特征标签",
  fansProfile: "粉丝画像",
  fansSummary: "粉丝表现摘要",
  dataSummary: "数据概览",
  notesFullTraffic: "笔记数据·全流量",
  notesNaturalTraffic: "笔记数据·仅自然流量",
  recentNotes: "近期笔记明细",
});

function slug(value) {
  return String(value)
    .replace(/\[\]/g, "_items")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function cleanDescription(entry) {
  const description = String(entry.description || "").trim();
  if (!description || /数据域的蒲公英原始字段/.test(description)) {
    return `蒲公英原始字段 ${entry.path}`;
  }
  return description;
}

function relativeResponsePath(domain, fieldPath) {
  if (domain !== "recentNotes") return fieldPath === "$" ? "$.data" : `$.data.${fieldPath}`;
  if (fieldPath === "$") return "$.data";
  if (fieldPath === "platformTotal") return "$.data.total";
  if (fieldPath.startsWith("notes[]")) return `$.data.list[]${fieldPath.slice("notes[]".length)}`;
  return null;
}

function noteMetadata(domain, fieldPath) {
  if (domain === "notesFullTraffic" && NOTE_FULL_FIELDS[fieldPath]) {
    const [fieldId, metric, statistic, platformLabel, unit] =
      NOTE_FULL_FIELDS[fieldPath];
    return { fieldId, metric, statistic, platformLabel, unit, uiVerified: true };
  }
  if (domain === "notesNaturalTraffic" && NATURAL_FIELDS[fieldPath]) {
    const [fieldId, metric, statistic, platformLabel, unit] =
      NATURAL_FIELDS[fieldPath];
    return { fieldId, metric, statistic, platformLabel, unit, uiVerified: true };
  }
  return null;
}

function profileMetadata(domain, fieldPath) {
  const definition = domain === "creatorProfile"
    ? PROFILE_FIELDS[fieldPath]
    : domain === "fansSummary"
      ? FANS_SUMMARY_FIELDS[fieldPath]
      : null;
  if (!definition) return null;
  const [fieldId, platformLabel, unit] = definition;
  return {
    fieldId,
    metric: slug(fieldPath),
    statistic: "value",
    platformLabel,
    unit,
    uiVerified: true,
  };
}

function uiPathTemplate(domain, platformLabel) {
  if (domain === "notesFullTraffic") {
    return [
      "笔记主页",
      "笔记数据",
      "{sceneLabel}",
      "{contentTypeLabel}",
      "{windowLabel}",
      "全流量",
      "按规模",
      platformLabel,
    ];
  }
  if (domain === "notesNaturalTraffic") {
    return [
      "笔记主页",
      "笔记数据",
      "{sceneLabel}",
      "{contentTypeLabel}",
      "{windowLabel}",
      "仅自然流量",
      "{viewLabel}",
      platformLabel,
    ];
  }
  if (domain === "fansProfile" || domain === "fansSummary") {
    return ["笔记主页", "粉丝分析", DOMAIN_LABELS[domain], platformLabel];
  }
  if (domain === "recentNotes") {
    return ["笔记主页", "笔记数据", "笔记明细", platformLabel];
  }
  return ["笔记主页", DOMAIN_LABELS[domain], platformLabel];
}

function outputKind(entry) {
  if (entry.dataTypes.includes("array") || entry.path.includes("[]")) return "list";
  if (entry.dataTypes.includes("object")) return "object";
  return "scalar";
}

function buildCapability(domain, entry, source) {
  const responsePath = relativeResponsePath(domain, entry.path);
  if (!responsePath) return null;
  const curated = noteMetadata(domain, entry.path) || profileMetadata(domain, entry.path);
  const platformLabel =
    curated?.platformLabel ||
    (entry.description && !/数据域的蒲公英原始字段/.test(entry.description)
      ? entry.description
      : entry.field || entry.path);
  const fieldId =
    curated?.fieldId || `pgy.raw.${domain}.${slug(entry.path || "data")}`;
  const unit =
    curated?.unit ||
    (entry.unit === "percentage_or_ratio_native"
      ? "ratio_native"
      : entry.unit || "platform_native");
  const request = DOMAIN_REQUESTS[domain];
  const supportedDimensions = DOMAIN_DIMENSIONS[domain];
  const isContainer = entry.dataTypes.includes("object") || entry.dataTypes.includes("array");
  return {
    capabilityId: `pgy.v1.${domain}.${slug(entry.path || "data")}`,
    fieldId,
    domain,
    domainLabel: DOMAIN_LABELS[domain],
    platformLabel,
    aliases: [],
    metric: curated?.metric || slug(entry.path || "data"),
    statistic: curated?.statistic || "value",
    supportedDimensions,
    request,
    response: {
      jsonPath: responsePath,
      dataTypes: entry.dataTypes,
      outputKind: outputKind(entry),
    },
    unit,
    nullSemantics: {
      zero: "平台明确返回0，保留0，不得改写为空白",
      null: "平台明确返回null，记录NO_SAMPLE或UNSUPPORTED，不得补0",
      absent: "响应中缺少字段，记录COLLECTION_FAILED或CAPABILITY_CHANGED",
    },
    uiPathTemplate: uiPathTemplate(domain, platformLabel),
    surfaceStatus: curated?.uiVerified
      ? "pgy_ui_verified"
      : "api_observed_needs_ui_alignment",
    executionStatus: isContainer
      ? "collectable_structured"
      : "collectable_scalar",
    evidence: {
      capturedAt: source.metadata.capturedAt,
      platformDataUpdateDate: source.metadata.platformDataUpdateDate,
      sourceEndpoint: request.endpointTemplate,
      sourceJsonPath: responsePath,
    },
    description: cleanDescription(entry),
  };
}

function uniqueBy(items, key) {
  const values = new Map();
  for (const item of items) values.set(item[key], item);
  return [...values.values()];
}

if (!fs.existsSync(inputPath)) {
  throw new Error(`找不到全量蒲公英 JSON：${inputPath}`);
}

const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (inputPath !== schemaSnapshotPath) {
  const snapshot = {
    schemaVersion: "1.0.0",
    metadata: {
      generatedAt: source.metadata.generatedAt,
      capturedAt: source.metadata.capturedAt,
      platformDataUpdateDate: source.metadata.platformDataUpdateDate,
      sourceArtifact: path.relative(projectRoot, inputPath),
    },
    coverage: {
      successfulScopeGroups: source.coverage.successfulScopeGroups,
      uniqueSuccessfulRequests: source.coverage.uniqueSuccessfulRequests,
    },
    fieldCatalog: {
      scopeDimensions: source.fieldCatalog.scopeDimensions,
      schemas: Object.fromEntries(
        Object.entries(source.fieldCatalog.schemas).map(([domain, entries]) => [
          domain,
          entries.map(({ sampleValue, observedCount, ...entry }) => entry),
        ]),
      ),
    },
  };
  fs.writeFileSync(
    schemaSnapshotPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
}
const capabilities = [];
for (const [domain, entries] of Object.entries(source.fieldCatalog?.schemas || {})) {
  if (!DOMAIN_REQUESTS[domain]) continue;
  for (const entry of entries) {
    if (entry.path === "$") continue;
    const capability = buildCapability(domain, entry, source);
    if (capability) capabilities.push(capability);
  }
  if (domain === "contentTags" || domain === "featureTags") {
    const rootEntry = entries.find((entry) => entry.path === "$");
    if (rootEntry) {
      capabilities.push(
        buildCapability(
          domain,
          { ...rootEntry, path: "data", field: "data" },
          source,
        ),
      );
    }
  }
}

const registry = {
  schemaVersion: "1.0.0",
  registryId: "xiaohongshu-pgy-blogger-detail-v1",
  platform: "小红书蒲公英",
  surface: "达人笔记主页",
  generatedAt: source.metadata.generatedAt || source.metadata.capturedAt,
  sourceEvidence: {
    capturedAt: source.metadata.capturedAt,
    platformDataUpdateDate: source.metadata.platformDataUpdateDate,
    sourceArtifact:
      source.metadata.sourceArtifact || path.relative(projectRoot, inputPath),
    successfulScopeGroups: source.coverage.successfulScopeGroups,
    uniqueSuccessfulRequests: source.coverage.uniqueSuccessfulRequests,
  },
  dimensions: source.fieldCatalog.scopeDimensions,
  codeMaps: {
    scene: { daily: 0, cooperation: 1 },
    contentType: { image: 1, video: 2, all: 3 },
    window: { "30d": 1, "90d": 2 },
    traffic: { natural: 0, all: 1 },
  },
  policies: {
    executableAccuracy:
      "只有完整合同且surfaceStatus为pgy_ui_verified或经人工复核的字段才能自动写入Excel",
    observedField:
      "api_observed_needs_ui_alignment字段已证明接口存在，但在与蒲公英前端名称和路径校准前不得宣称为可直接交付字段",
    missingValue:
      "严格区分0、null、字段缺席、权限不足和请求失败",
  },
  capabilities: uniqueBy(capabilities, "capabilityId").sort((a, b) =>
    a.capabilityId.localeCompare(b.capabilityId),
  ),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const verified = registry.capabilities.filter(
  (item) => item.surfaceStatus === "pgy_ui_verified",
).length;
console.log(
  JSON.stringify(
    {
      outputPath,
      capabilities: registry.capabilities.length,
      uiVerified: verified,
      observedNeedsAlignment: registry.capabilities.length - verified,
      sourceScopes: registry.sourceEvidence.successfulScopeGroups,
    },
    null,
    2,
  ),
);
