import { enrichFieldContract } from "./pgy_field_library_v1.mjs";

const GROUPS = Object.freeze({
  BASIC: "基础信息",
  COOP_90: "90天合作笔记",
  TRAFFIC: "曝光来源",
  NATURAL_90: "90天合作笔记·仅自然流量",
  DAILY_30: "30天日常笔记",
  RECENT_16: "近16篇",
  COST: "成本",
  DECISION: "决策辅助",
});

export const PGY_SCOPES = Object.freeze({
  COOP_VIDEO_90_FULL: Object.freeze({
    business: 1,
    noteType: 2,
    dateType: 2,
    advertiseSwitch: 1,
  }),
  COOP_VIDEO_90_NATURAL: Object.freeze({
    business: 1,
    noteType: 2,
    dateType: 2,
    advertiseSwitch: 0,
  }),
  COOP_MIXED_90_FULL: Object.freeze({
    business: 1,
    noteType: 3,
    dateType: 2,
    advertiseSwitch: 1,
  }),
  COOP_MIXED_90_NATURAL: Object.freeze({
    business: 1,
    noteType: 3,
    dateType: 2,
    advertiseSwitch: 0,
  }),
  DAILY_ALL_30_FULL: Object.freeze({
    business: 0,
    noteType: 3,
    dateType: 1,
    advertiseSwitch: 1,
  }),
});

export function cooperation90Scopes(noteScope = "video") {
  return noteScope === "mixed"
    ? {
        full: PGY_SCOPES.COOP_MIXED_90_FULL,
        natural: PGY_SCOPES.COOP_MIXED_90_NATURAL,
      }
    : {
        full: PGY_SCOPES.COOP_VIDEO_90_FULL,
        natural: PGY_SCOPES.COOP_VIDEO_90_NATURAL,
      };
}

function normalizedUnit(unit) {
  if (unit === "%") return "ratio";
  if (unit === "元") return "currency_cny";
  if (unit === "万") return "ten_thousand_people";
  if (unit === "人") return "people";
  return "count";
}

function noteMetricContract(id, unit) {
  const parts = id.split(".");
  if (parts[0] !== "pgy") return null;
  if (parts[1] === "recent16") {
    const metricPart = parts.slice(2).join("_");
    const metric = metricPart.replace(/^max_/, "");
    return {
      fieldId: `pgy.note.${metric}.max`,
      legacyFieldId: id,
      metric,
      statistic: "max",
      scene: "all",
      contentType: "all",
      window: "recent16",
      traffic: "original",
      view: "list",
      source: "pgy",
      unit: normalizedUnit(unit),
    };
  }
  if (!["coop", "daily"].includes(parts[1])) return null;
  const trafficIndex = parts.findIndex((part) => ["full", "natural"].includes(part));
  if (trafficIndex < 0) return null;
  const rawMetric = parts.slice(trafficIndex + 1).join("_");
  const trafficMatch = rawMetric.match(/^traffic_(.+)$/);
  const readTrafficMatch = rawMetric.match(/^read_traffic_(.+)$/);
  const fixed = {
    note_count: {
      fieldId: "pgy.note.sample.count",
      metric: "sample",
      statistic: "count",
    },
  }[rawMetric];
  const statistic = fixed?.statistic || (trafficMatch || readTrafficMatch
    ? "share"
    : rawMetric.includes("median")
      ? "median"
      : rawMetric.includes("rate")
        ? "rate"
        : "value");
  const metric = fixed?.metric || (trafficMatch
    ? `traffic_${trafficMatch[1]}`
    : readTrafficMatch
      ? `read_traffic_${readTrafficMatch[1]}`
      : rawMetric
        .replace(/^imp/, "exposure")
        .replace(/_median$/, "")
        .replace(/_rate$/, ""));
  return {
    fieldId: fixed?.fieldId || `pgy.note.${metric}.${statistic}`,
    legacyFieldId: id,
    metric,
    statistic,
    scene: parts[1] === "coop" ? "cooperation" : "daily",
    contentType: parts[2] === "video" ? "video" : parts[2] === "all" ? "all" : parts[2],
    window: parts[3],
    traffic: parts[4] === "full" ? "all" : parts[4],
    view: "scale",
    source: "pgy",
    unit: normalizedUnit(unit),
  };
}

function registryContract(id, name, unit) {
  const noteContract = noteMetricContract(id, unit);
  if (noteContract) return noteContract;
  if (!id.startsWith("pgy.creator.")) return null;
  return {
    fieldId: id,
    legacyFieldId: id,
    metric: id.slice("pgy.creator.".length),
    statistic: "value",
    scene: "creator",
    contentType: "all",
    window: "lifetime",
    traffic: "all",
    view: "profile",
    source: "pgy",
    unit: normalizedUnit(unit),
    label: name,
  };
}

function field(id, name, group, options = {}) {
  const contract = options.contract || registryContract(id, name, options.unit || "");
  return Object.freeze({
    id,
    name,
    group,
    source: "pgy",
    default: true,
    aliases: [],
    requestKeys: [],
    unit: "",
    ...options,
    contract: contract ? Object.freeze(enrichFieldContract(contract)) : null,
  });
}

export const FIELD_REGISTRY = Object.freeze([
  field("pgy.creator.name", "达人名称", GROUPS.BASIC, {
    aliases: [
      "名称", "账号", "博主名称", "账号昵称",
      "KOL名", "KOL name", "creator name", "account name",
    ],
    requestKeys: ["creator.basic"],
  }),
  field("pgy.creator.red_id", "小红书号", GROUPS.BASIC, {
    aliases: ["RED ID", "Xiaohongshu ID", "小紅書号", "小紅書ID"],
    requestKeys: ["creator.basic"],
  }),
  field("pgy.creator.xhs_profile", "小红书主页链接", GROUPS.BASIC, {
    aliases: [
      "主页链接", "小红书链接", "KOLアカウントリンク", "链接",
      "Xiaohongshu profile", "Xiaohongshu profile link", "creator profile link",
    ],
    requestKeys: ["creator.basic"],
  }),
  field("pgy.creator.pgy_profile", "蒲公英链接", GROUPS.BASIC, {
    aliases: [
      "蒲公英主页链接", "蒲公英博主链接", "蒲公英URL",
      "蒲公英リンク", "蒲公英URL（リンク）",
      "Pugongying link", "PGY link", "Dandelion link",
    ],
    requestKeys: [],
  }),
  field("pgy.creator.fans", "粉丝数", GROUPS.BASIC, {
    aliases: ["粉丝量", "粉丝", "ファン数", "followers", "follower count"],
    requestKeys: ["creator.basic"],
    unit: "人",
  }),
  field("pgy.creator.fans_w", "粉丝数（w）", GROUPS.BASIC, {
    aliases: ["粉丝数w", "粉丝数（万）", "粉丝数(万)"],
    requestKeys: ["creator.basic"],
    unit: "万",
  }),
  field("pgy.creator.video_quote", "报价", GROUPS.COST, {
    aliases: [
      "视频报价", "视频笔记一口价", "合作报价 / 视频笔记一口价",
      "費用 (元)", "費用(元)", "cost (cny)", "price (cny)", "video quote",
    ],
    requestKeys: ["creator.basic"],
    unit: "元",
  }),
  field("pgy.creator.total_engagement", "总互动数", GROUPS.BASIC, {
    aliases: [
      "总互动值", "获赞与收藏", "総エンゲージメント数",
      "total engagement", "total engagements",
    ],
    requestKeys: ["creator.basic"],
    unit: "次",
  }),
  field("pgy.creator.active_fans_rate", "活跃粉丝占比", GROUPS.BASIC, {
    aliases: ["アクティブファン比率", "active follower rate", "active fans rate"],
    requestKeys: [],
    unit: "%",
  }),
  field("pgy.creator.read_fans_rate", "阅读粉丝占比", GROUPS.BASIC, {
    aliases: ["閲覧ファン比率", "reading follower rate", "read fans rate"],
    requestKeys: [],
    unit: "%",
  }),
  field("pgy.creator.engage_fans_rate", "互动粉丝占比", GROUPS.BASIC, {
    aliases: ["エンゲージファン比率", "engaged follower rate", "engage fans rate"],
    requestKeys: [],
    unit: "%",
  }),
  field("pgy.creator.order_fans_rate", "下单粉丝占比", GROUPS.BASIC, {
    aliases: ["購入ファン比率", "ordering follower rate", "buyer fans rate"],
    requestKeys: [],
    unit: "%",
  }),
  field("pgy.creator.age_25_plus_rate", "25岁以上粉丝占比", GROUPS.BASIC, {
    aliases: [
      "25歳以上ファン比率", "25岁以上粉丝比例",
      "followers aged 25+", "25+ follower rate",
    ],
    requestKeys: [],
    unit: "%",
  }),
  field("pgy.creator.top3_regions", "粉丝地域分布前3位", GROUPS.BASIC, {
    aliases: [
      "粉丝地域分部前3位", "ファン地域分布上位3",
      "top 3 follower regions", "top 3 audience regions",
    ],
    requestKeys: [],
  }),
  field("pgy.creator.content_tags", "内容标签", GROUPS.BASIC, {
    aliases: ["内容类目", "蒲公英内容标签"],
    requestKeys: ["creator.content_tags"],
  }),
  field("pgy.creator.feature_tags", "内容特征标签", GROUPS.BASIC, {
    aliases: ["内容特征", "博主特征标签"],
    requestKeys: ["creator.feature_tags"],
  }),

  field("pgy.coop.video.90d.full.imp_median", "合作笔记曝光中位数（90天）", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 曝光中位数（90天）", "90天合作笔记曝光中位数"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "次",
  }),
  field("pgy.coop.video.90d.full.read_median", "合作笔记阅读中位数（90天）", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 阅读中位数（90天）", "90天合作笔记阅读中位数"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "次",
  }),
  field("pgy.coop.video.90d.full.like_median", "90天合作笔记中位点赞量", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 中位点赞量"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "次",
  }),
  field("pgy.coop.video.90d.full.collect_median", "90天合作笔记中位收藏量", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 中位收藏量"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "次",
  }),
  field("pgy.coop.video.90d.full.hundred_like_rate", "90天合作笔记百赞比例", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 百赞比例"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.thousand_like_rate", "90天合作笔记千赞比例", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 千赞比例"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.like_collect_median", "90天合作笔记赞藏量中位数", GROUPS.COOP_90, {
    aliases: ["90天合作笔记 / 赞藏量中位数"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "次",
    derivation: "对接口返回的逐篇笔记点赞量与收藏量之和取中位数；无逐篇值时留空",
  }),
  field("pgy.coop.video.90d.full.traffic.discover", "曝光来源-发现页", GROUPS.TRAFFIC, {
    aliases: ["曝光来源 / 发现页", "发现页"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.traffic.search", "曝光来源-搜索页", GROUPS.TRAFFIC, {
    aliases: ["曝光来源 / 搜索页", "搜索页"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.traffic.follow", "曝光来源-关注页", GROUPS.TRAFFIC, {
    aliases: ["曝光来源 / 关注页", "关注页"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.traffic.profile", "曝光来源-博主个人页", GROUPS.TRAFFIC, {
    aliases: ["曝光来源 / 博主个人页", "博主个人页"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.traffic.nearby", "曝光来源-附近页", GROUPS.TRAFFIC, {
    aliases: ["曝光来源 / 附近页", "附近页"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.full.traffic.other", "曝光来源-其他", GROUPS.TRAFFIC, {
    aliases: ["曝光来源 / 其他", "其他"],
    requestKeys: ["coop.video.90d.full.summary"],
    unit: "%",
  }),
  field("pgy.coop.video.90d.natural.imp", "预估合作笔记自然流曝光（90天）", GROUPS.NATURAL_90, {
    aliases: ["预估合作笔记自然流曝光", "90天合作笔记仅自然流量曝光"],
    requestKeys: ["coop.video.90d.natural.core"],
    unit: "次",
  }),
  field("pgy.coop.video.90d.natural.read", "预估合作笔记自然流阅读（90天）", GROUPS.NATURAL_90, {
    aliases: ["预估合作笔记自然流阅读", "90天合作笔记仅自然流量阅读"],
    requestKeys: ["coop.video.90d.natural.core"],
    unit: "次",
  }),

  field("pgy.daily.all.30d.full.imp_median", "30天日常笔记曝光中位数", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 曝光中位数（90天）", "30天日常笔记 / 曝光中位数（30天）"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "次",
  }),
  field("pgy.daily.all.30d.full.read_median", "30天日常笔记阅读中位数", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 阅读中位数（90天）", "30天日常笔记 / 阅读中位数（30天）"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "次",
  }),
  field("pgy.daily.all.30d.full.like_median", "30天日常笔记中位点赞量", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 中位点赞量"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "次",
  }),
  field("pgy.daily.all.30d.full.collect_median", "30天日常笔记中位收藏量", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 中位收藏量"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "次",
  }),
  field("pgy.daily.all.30d.full.hundred_like_rate", "30天日常笔记百赞比例", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 百赞比例"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "%",
  }),
  field("pgy.daily.all.30d.full.thousand_like_rate", "30天日常笔记千赞比例", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 千赞比例"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "%",
  }),
  field("pgy.daily.all.30d.full.like_collect_median", "30天日常笔记赞藏量中位数", GROUPS.DAILY_30, {
    aliases: ["30天日常笔记 / 赞藏量中位数"],
    requestKeys: ["daily.all.30d.full.summary"],
    unit: "次",
    derivation: "对接口返回的逐篇笔记点赞量与收藏量之和取中位数；无逐篇值时留空",
  }),
  field("pgy.recent16.max_read", "近16篇最高阅读量", GROUPS.RECENT_16, {
    aliases: ["近16篇 / 最高阅读量"],
    requestKeys: ["recent16.notes"],
    unit: "次",
  }),
  field("pgy.recent16.max_like", "近16篇最高点赞量", GROUPS.RECENT_16, {
    aliases: ["近16篇 / 最高点赞量"],
    requestKeys: ["recent16.notes"],
    unit: "次",
  }),
  field("pgy.recent16.max_collect", "近16篇最高收藏量", GROUPS.RECENT_16, {
    aliases: ["近16篇 / 最高收藏量"],
    requestKeys: ["recent16.notes"],
    unit: "次",
  }),
]);

const CATALOG_SCENES = Object.freeze([
  Object.freeze({ key: "coop", label: "合作笔记" }),
  Object.freeze({ key: "daily", label: "日常笔记" }),
]);
const CATALOG_CONTENT_TYPES = Object.freeze([
  Object.freeze({ key: "image", label: "图文" }),
  Object.freeze({ key: "video", label: "视频" }),
  Object.freeze({ key: "all", label: "图文+视频" }),
]);
const CATALOG_WINDOWS = Object.freeze([
  Object.freeze({ key: "30d", label: "30天" }),
  Object.freeze({ key: "90d", label: "90天" }),
]);
const CATALOG_FULL_METRICS = Object.freeze([
  Object.freeze({ suffix: "note_count", label: "笔记数", unit: "次" }),
  Object.freeze({ suffix: "imp_median", label: "曝光中位数", unit: "次" }),
  Object.freeze({ suffix: "read_median", label: "阅读中位数", unit: "次" }),
  Object.freeze({ suffix: "interaction_median", label: "互动中位数", unit: "次" }),
  Object.freeze({ suffix: "interaction_rate", label: "互动率", unit: "%" }),
  Object.freeze({ suffix: "like_median", label: "点赞中位数", unit: "次" }),
  Object.freeze({ suffix: "collect_median", label: "收藏中位数", unit: "次" }),
  Object.freeze({ suffix: "comment_median", label: "评论中位数", unit: "次" }),
  Object.freeze({ suffix: "share_median", label: "分享中位数", unit: "次" }),
  Object.freeze({ suffix: "video_full_view_rate", label: "视频完播率", unit: "%" }),
  Object.freeze({ suffix: "picture_3s_view_rate", label: "图文3秒阅读率", unit: "%" }),
  Object.freeze({ suffix: "hundred_like_rate", label: "百赞比例", unit: "%" }),
  Object.freeze({ suffix: "thousand_like_rate", label: "千赞比例", unit: "%" }),
  Object.freeze({ suffix: "like_collect_median", label: "赞藏量中位数", unit: "次" }),
  Object.freeze({ suffix: "traffic_discover", label: "流量来源·发现页", unit: "%" }),
  Object.freeze({ suffix: "traffic_search", label: "流量来源·搜索页", unit: "%" }),
  Object.freeze({ suffix: "traffic_follow", label: "流量来源·关注页", unit: "%" }),
  Object.freeze({ suffix: "traffic_profile", label: "流量来源·博主个人页", unit: "%" }),
  Object.freeze({ suffix: "traffic_nearby", label: "流量来源·附近页", unit: "%" }),
  Object.freeze({ suffix: "traffic_other", label: "流量来源·其他", unit: "%" }),
  Object.freeze({ suffix: "read_traffic_discover", label: "阅读来源·发现页", unit: "%" }),
  Object.freeze({ suffix: "read_traffic_search", label: "阅读来源·搜索页", unit: "%" }),
  Object.freeze({ suffix: "read_traffic_follow", label: "阅读来源·关注页", unit: "%" }),
  Object.freeze({ suffix: "read_traffic_profile", label: "阅读来源·博主个人页", unit: "%" }),
  Object.freeze({ suffix: "read_traffic_nearby", label: "阅读来源·附近页", unit: "%" }),
  Object.freeze({ suffix: "read_traffic_other", label: "阅读来源·其他", unit: "%" }),
]);
const CATALOG_NATURAL_METRICS = Object.freeze([
  Object.freeze({ suffix: "imp", label: "曝光中位数", unit: "次" }),
  Object.freeze({ suffix: "read", label: "阅读中位数", unit: "次" }),
  Object.freeze({ suffix: "interaction", label: "互动量", unit: "次" }),
  Object.freeze({ suffix: "cpm", label: "CPM", unit: "元" }),
  Object.freeze({ suffix: "cpv", label: "CPV", unit: "元" }),
  Object.freeze({ suffix: "cpuv", label: "CPUV", unit: "元" }),
  Object.freeze({ suffix: "cpe", label: "CPE", unit: "元" }),
]);
const CATALOG_METRIC_LABELS = new Map(
  [...CATALOG_FULL_METRICS, ...CATALOG_NATURAL_METRICS]
    .map((metric) => [metric.suffix, metric.label]),
);

function catalogGroup(scene, contentType, window, traffic) {
  return `${scene.label} · ${contentType.label} · ${window.label} · ${traffic === "full" ? "全流量" : "仅自然流量"}`;
}

function catalogName(scene, contentType, window, traffic, metric) {
  return `${catalogGroup(scene, contentType, window, traffic)} · ${metric.label}`;
}

const STATIC_FIELD_IDS = new Set(FIELD_REGISTRY.map((item) => item.id));
const GENERATED_CATALOG_FIELDS = [];
for (const scene of CATALOG_SCENES) {
  for (const contentType of CATALOG_CONTENT_TYPES) {
    for (const window of CATALOG_WINDOWS) {
      for (const [traffic, metrics] of [
        ["full", CATALOG_FULL_METRICS],
        ["natural", CATALOG_NATURAL_METRICS],
      ]) {
        for (const metric of metrics) {
          const id = `pgy.${scene.key}.${contentType.key}.${window.key}.${traffic}.${metric.suffix}`;
          if (STATIC_FIELD_IDS.has(id)) continue;
          GENERATED_CATALOG_FIELDS.push(field(
            id,
            catalogName(scene, contentType, window, traffic, metric),
            catalogGroup(scene, contentType, window, traffic),
            {
              aliases: [],
              requestKeys: [],
              unit: metric.unit,
              ...(metric.suffix === "like_collect_median"
                ? { derivation: "对接口返回的逐篇笔记点赞量与收藏量之和取中位数；无逐篇值时留空" }
                : {}),
            },
          ));
        }
      }
    }
  }
}

export const SELECTABLE_FIELD_REGISTRY = Object.freeze([
  ...FIELD_REGISTRY,
  ...GENERATED_CATALOG_FIELDS,
]);

export const DERIVED_FIELD_REGISTRY = Object.freeze([
  Object.freeze({
    id: "derived.cost_jpy",
    name: "费用（日元）",
    group: GROUPS.COST,
    unit: "日元",
    default: false,
    aliases: ["費用 (円)", "費用(円)", "cost (jpy)", "price (jpy)", "费用（円）"],
    source: "formula",
    dependencies: ["pgy.creator.video_quote"],
  }),
  Object.freeze({
    id: "derived.cost_per_fan",
    name: "平均触达每个粉丝费用",
    group: GROUPS.COST,
    unit: "元",
    default: false,
    aliases: [
      "ファン数あたりの費用",
      "平均触达每个粉丝费用 即费用/个粉丝",
      "cost per follower",
    ],
    source: "formula",
    dependencies: ["pgy.creator.video_quote", "pgy.creator.fans"],
  }),
  Object.freeze({
    id: "derived.order_price",
    name: "下单价",
    group: GROUPS.COST,
    unit: "元",
    default: false,
    aliases: ["下单价（后台价格*1.1，为平台服务费)", "下单价(后台价格*1.1，为平台服务费)"],
    source: "formula",
    dependencies: ["pgy.creator.video_quote"],
  }),
  Object.freeze({
    id: "derived.actual_spend",
    name: "实际花费",
    group: GROUPS.COST,
    unit: "元",
    default: false,
    aliases: ["实际花费（下单价*1.02，小红星收取2%的技术服务费）", "实际花费(下单价*1.02，小红星收取2%的技术服务费)"],
    source: "formula",
    dependencies: ["derived.order_price"],
  }),
  Object.freeze({
    id: "derived.cpc",
    name: "CPC",
    group: GROUPS.COST,
    unit: "元",
    default: false,
    aliases: ["cpc", "CPC（报价/阅读中位数）", "CPC(报价/阅读中位数)"],
    source: "formula",
    dependencies: ["pgy.creator.video_quote", "pgy.coop.video.90d.natural.read"],
    definition: "视频报价 ÷ 90天合作笔记仅自然流阅读",
  }),
]);

export const LLM_FIELD_POLICY = Object.freeze({
  candidates: Object.freeze(["达人类型", "账号数据表现", "推荐理由", "内容方向"]),
  protected: Object.freeze(["是否合作", "合作方式", "授权情况"]),
});

export const REQUEST_DEFINITIONS = Object.freeze({
  "creator.basic": Object.freeze({
    id: "creator.basic",
    method: "GET",
    path: ({ creatorId }) => `/api/solar/cooperator/user/blogger/${creatorId}`,
  }),
  "creator.content_tags": Object.freeze({
    id: "creator.content_tags",
    method: "GET",
    path: ({ creatorId }) => `/api/solar/kol/data_v2/kol_content_tags?userId=${encodeURIComponent(creatorId)}`,
  }),
  "creator.feature_tags": Object.freeze({
    id: "creator.feature_tags",
    method: "GET",
    path: ({ creatorId }) => `/api/solar/kol/data_v2/kol_feature_tags?userId=${encodeURIComponent(creatorId)}`,
  }),
  "coop.video.90d.full.summary": Object.freeze({
    id: "coop.video.90d.full.summary",
    method: "GET",
    path: ({ creatorId }) => notesRatePath(creatorId, PGY_SCOPES.COOP_VIDEO_90_FULL),
  }),
  "coop.video.90d.natural.core": Object.freeze({
    id: "coop.video.90d.natural.core",
    method: "POST",
    path: () => "/api/pgy/kol/data/core_data",
    body: ({ creatorId }) => ({ userId: creatorId, ...PGY_SCOPES.COOP_VIDEO_90_NATURAL }),
  }),
  "daily.all.30d.full.summary": Object.freeze({
    id: "daily.all.30d.full.summary",
    method: "GET",
    path: ({ creatorId }) => notesRatePath(creatorId, PGY_SCOPES.DAILY_ALL_30_FULL),
  }),
  "recent16.notes": Object.freeze({
    id: "recent16.notes",
    method: "GET",
    path: ({ creatorId }) => `/api/solar/kol/data_v2/notes_detail?advertiseSwitch=1&orderType=1&pageNumber=1&pageSize=16&userId=${encodeURIComponent(creatorId)}&noteType=4&isThirdPlatform=0`,
  }),
});

function notesRatePath(creatorId, scope) {
  const query = new URLSearchParams({ userId: creatorId, ...Object.fromEntries(
    Object.entries(scope).map(([key, value]) => [key, String(value)]),
  ) });
  return `/api/solar/kol/data_v3/notes_rate?${query.toString()}`;
}

function normalizeLabel(value) {
  return String(value || "")
    .replace(/\r?\n/g, "")
    .replace(/[／|｜]/g, "/")
    .replace(/[（）]/g, (character) => character === "（" ? "(" : ")")
    .replace(/[\s:：_\-·]/g, "")
    .replace(/[，,。.]/g, "")
    .replace(/[×✖️]/g, "*")
    .toLowerCase();
}

function labelSegments(value) {
  const raw = String(value || "");
  return [
    raw,
    ...raw.split(/\r?\n|\s*\/\s*|[｜|]/g),
  ].map((item) => item.trim()).filter(Boolean);
}

const ALL_FIELDS = [...SELECTABLE_FIELD_REGISTRY, ...DERIVED_FIELD_REGISTRY];
const FIELD_BY_ID = new Map(ALL_FIELDS.map((item) => [item.id, item]));
const FIELD_ALIASES = new Map();
for (const item of ALL_FIELDS) {
  for (const alias of [item.name, ...(item.aliases || [])]) {
    const key = normalizeLabel(alias);
    if (!FIELD_ALIASES.has(key)) FIELD_ALIASES.set(key, []);
    FIELD_ALIASES.get(key).push(item);
  }
}

export function fieldById(id) {
  return FIELD_BY_ID.get(String(id || ""));
}

export function contractByFieldId(id, overrides = {}) {
  const item = fieldById(id);
  if (!item?.contract) return null;
  return enrichFieldContract({ ...item.contract, ...overrides });
}

export function matchFieldLabel(label, parentLabel = "") {
  const candidates = [...new Set([
    parentLabel && label ? `${parentLabel} / ${label}` : "",
    ...labelSegments(label),
    ...labelSegments(parentLabel),
  ].filter(Boolean))];
  for (const candidate of candidates) {
    const matches = [...new Map(
      (FIELD_ALIASES.get(normalizeLabel(candidate)) || []).map((item) => [item.id, item]),
    ).values()];
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function requestForNoteScope(request, noteScope) {
  if (noteScope !== "mixed") return request;
  const scopes = cooperation90Scopes(noteScope);
  if (request.id === "coop.video.90d.full.summary") {
    return {
      ...request,
      path: ({ creatorId }) => notesRatePath(creatorId, scopes.full),
    };
  }
  if (request.id === "coop.video.90d.natural.core") {
    return {
      ...request,
      body: ({ creatorId }) => ({ userId: creatorId, ...scopes.natural }),
    };
  }
  return request;
}

export function compileCollectionPlan(fieldIds = [], { noteScope = "video" } = {}) {
  const selected = fieldIds
    .map((id) => fieldById(id))
    .filter((item) => item?.source === "pgy");
  const requestKeys = [...new Set(selected.flatMap((item) => item.requestKeys || []))];
  return {
    fieldIds: selected.map((item) => item.id),
    requiredFieldNames: selected.map((item) => item.name),
    requests: requestKeys
      .map((key) => REQUEST_DEFINITIONS[key])
      .filter(Boolean)
      .map((request) => requestForNoteScope(request, noteScope)),
  };
}

function catalogPresentation(item) {
  const contract = item.contract;
  if (!["cooperation", "daily"].includes(contract?.scene)) {
    const creatorNames = {
      "pgy.creator.name": "博主名称",
      "pgy.creator.xhs_profile": "小红书主页链接",
      "pgy.creator.pgy_profile": "蒲公英链接",
      "pgy.creator.fans": "粉丝数",
      "pgy.creator.fans_w": "粉丝数（万）",
      "pgy.creator.video_quote": "视频笔记一口价",
      "pgy.creator.content_tags": "内容标签",
      "pgy.creator.feature_tags": "内容特征标签",
    };
    const group = item.source === "formula"
      ? "程序计算"
      : contract?.window === "recent16"
        ? "笔记列表｜近16篇"
        : item.id === "pgy.creator.video_quote"
          ? "合作报价"
          : contract?.scene === "creator"
            ? "笔记主页"
            : item.group || GROUPS.BASIC;
    return {
      name: creatorNames[item.id] || item.name,
      group,
      semanticName: item.name,
    };
  }
  const scene = contract.scene === "cooperation" ? "合作笔记" : "日常笔记";
  const contentType = contract.contentType === "image"
    ? "图文"
    : contract.contentType === "video"
      ? "视频"
      : "图文+视频";
  const window = contract.window === "30d" ? "近30日" : "近90日";
  const traffic = contract.traffic === "natural" ? "仅自然流量" : "全流量";
  const metricSuffix = item.id.split(".").slice(5).join("_");
  const nativeMetricNames = {
    note_count: "笔记数",
    imp_median: "曝光中位数",
    read_median: "阅读中位数",
    interaction_median: "互动中位数",
    interaction_rate: "互动率",
    like_median: "中位点赞量",
    collect_median: "中位收藏量",
    comment_median: "中位评论量",
    share_median: "中位分享量",
    hundred_like_rate: "百赞比例",
    thousand_like_rate: "千赞比例",
    like_collect_median: "赞藏量中位数",
    traffic_discover: "发现页",
    traffic_search: "搜索页",
    traffic_follow: "关注页",
    traffic_profile: "博主个人页",
    traffic_nearby: "附近页",
    traffic_other: "其他",
    read_traffic_discover: "发现页",
    read_traffic_search: "搜索页",
    read_traffic_follow: "关注页",
    read_traffic_profile: "博主个人页",
    read_traffic_nearby: "附近页",
    read_traffic_other: "其他",
    imp: "曝光中位数",
    read: "阅读中位数",
    interaction: "互动量",
    cpm: "CPM",
    cpv: "CPV",
    cpuv: "CPUV",
    cpe: "CPE",
  };
  const metric = nativeMetricNames[metricSuffix]
    || CATALOG_METRIC_LABELS.get(metricSuffix)
    || item.name;
  const groupParts = ["数据表现", scene, contentType, window, traffic];
  if (metricSuffix.startsWith("traffic_")) groupParts.push("曝光来源");
  else if (metricSuffix.startsWith("read_traffic_")) groupParts.push("阅读来源");
  else if (["cpm", "cpv", "cpuv", "cpe"].includes(metricSuffix)) groupParts.push("按成本");
  else groupParts.push("按规模");
  const group = groupParts.join("｜");
  return {
    name: metric,
    group,
    semanticName: `${scene}｜${contentType}｜${window}｜${traffic}｜${metric}`,
  };
}

export function publicFieldRegistry() {
  return ALL_FIELDS.map((item) => {
    const presentation = catalogPresentation(item);
    return {
      id: item.id,
      name: presentation.name,
      group: presentation.group,
      semanticName: presentation.semanticName || item.name,
      internalName: item.name,
      source: item.source,
      default: Boolean(item.default),
      unit: item.unit || "",
      requestKeys: item.requestKeys || [],
      derivation: item.derivation || "",
      contract: item.contract,
      dependencies: item.dependencies || [],
    };
  });
}

function finite(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function ratio(value) {
  const number = finite(value);
  if (number === "") return "";
  return number > 1 ? number / 100 : number;
}

function median(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return "";
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function likeCollectMedian(data) {
  const notes = Array.isArray(data?.notes) ? data.notes : [];
  return median(notes.map((note) => {
    const like = finite(note?.likeNum);
    const collect = finite(note?.collectNum);
    return like === "" || collect === "" ? Number.NaN : like + collect;
  }));
}

function requestValues(url, postData = "") {
  const result = Object.fromEntries(new URL(url).searchParams.entries());
  if (!postData) return result;
  try {
    return { ...result, ...JSON.parse(postData) };
  } catch {
    return { ...result, ...Object.fromEntries(new URLSearchParams(postData).entries()) };
  }
}

function matchesScope(url, postData, scope) {
  const values = requestValues(url, postData);
  return Object.entries(scope).every(([key, expected]) => Number(values[key]) === Number(expected));
}

function assignIfPresent(target, name, value, transform = finite) {
  const normalized = transform(value);
  if (normalized !== "") target[name] = normalized;
}

function assignNotesRate(target, data, prefix, { traffic = false } = {}) {
  assignIfPresent(target, `${prefix}曝光中位数`, data.impMedian);
  assignIfPresent(target, `${prefix}阅读中位数`, data.readMedian);
  assignIfPresent(target, `${prefix}中位点赞量`, data.likeMedian);
  assignIfPresent(target, `${prefix}中位收藏量`, data.collectMedian);
  assignIfPresent(target, `${prefix}百赞比例`, data.hundredLikePercent, ratio);
  assignIfPresent(target, `${prefix}千赞比例`, data.thousandLikePercent, ratio);
  assignIfPresent(target, `${prefix}赞藏量中位数`, likeCollectMedian(data));
  if (!traffic) return;
  const page = data.pagePercentVo || {};
  const trafficMapping = {
    "曝光来源-发现页": page.impHomefeedPercent,
    "曝光来源-搜索页": page.impSearchPercent,
    "曝光来源-关注页": page.impFollowPercent,
    "曝光来源-博主个人页": page.impDetailPercent,
    "曝光来源-附近页": page.impNearbyPercent,
    "曝光来源-其他": page.impOtherPercent,
  };
  for (const [name, value] of Object.entries(trafficMapping)) assignIfPresent(target, name, value);
}

export function extractRegisteredFieldsFromApi(url, body, { postData = "", noteScope = "video" } = {}) {
  const fields = {};
  const cooperationScopes = cooperation90Scopes(noteScope);
  if (url.includes("/api/solar/cooperator/user/blogger/")) {
    const data = body?.data || {};
    assignIfPresent(fields, "粉丝数", data.fansCount);
    const fans = finite(data.fansCount);
    if (fans !== "") fields["粉丝数（w）"] = Number((fans / 10000).toFixed(4));
    assignIfPresent(fields, "报价", data.videoPrice);
    if (data.name) fields["达人名称"] = String(data.name);
    if (data.userId) fields["小红书主页链接"] = `https://www.xiaohongshu.com/user/profile/${data.userId}`;
    if (Array.isArray(data.contentTags)) {
      fields["内容标签"] = data.contentTags
        .flatMap((item) => [item.taxonomy1Tag, ...(item.taxonomy2Tags || [])])
        .filter(Boolean)
        .join("、");
    }
    if (Array.isArray(data.featureTags)) fields["内容特征标签"] = data.featureTags.filter(Boolean).join("、");
  }
  if (url.includes("/kol_content_tags")) {
    const names = (Array.isArray(body?.data) ? body.data : []).map((item) => item?.name).filter(Boolean);
    if (names.length) fields["内容标签"] = names.join("、");
  }
  if (url.includes("/kol_feature_tags")) {
    const values = Array.isArray(body?.data) ? body.data : [];
    const names = values.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean);
    if (names.length) fields["内容特征标签"] = names.join("、");
  }
  if (url.includes("/notes_rate") && matchesScope(url, postData, cooperationScopes.full)) {
    const data = body?.data || {};
    assignIfPresent(fields, "90天合作笔记样本数", data.noteNumber);
    assignNotesRate(fields, data, "90天合作笔记", { traffic: true });
    fields["合作笔记曝光中位数（90天）"] = fields["90天合作笔记曝光中位数"];
    fields["合作笔记阅读中位数（90天）"] = fields["90天合作笔记阅读中位数"];
    delete fields["90天合作笔记曝光中位数"];
    delete fields["90天合作笔记阅读中位数"];
  }
  if (url.includes("/core_data") && matchesScope(url, postData, cooperationScopes.natural)) {
    const sum = body?.data?.sumData || {};
    assignIfPresent(fields, "预估合作笔记自然流曝光（90天）", sum.imp);
    assignIfPresent(fields, "预估合作笔记自然流阅读（90天）", sum.read);
  }
  if (url.includes("/notes_rate") && matchesScope(url, postData, PGY_SCOPES.DAILY_ALL_30_FULL)) {
    const data = body?.data || {};
    assignIfPresent(fields, "30天日常笔记样本数", data.noteNumber);
    assignNotesRate(fields, data, "30天日常笔记");
  }
  if (url.includes("/notes_detail")) {
    const notes = (Array.isArray(body?.data?.list) ? body.data.list : []).slice(0, 16);
    assignIfPresent(fields, "近16篇最高阅读量", Math.max(...notes.map((item) => Number(item.readNum)).filter(Number.isFinite)));
    assignIfPresent(fields, "近16篇最高点赞量", Math.max(...notes.map((item) => Number(item.likeNum)).filter(Number.isFinite)));
    assignIfPresent(fields, "近16篇最高收藏量", Math.max(...notes.map((item) => Number(item.collectNum)).filter(Number.isFinite)));
  }
  return fields;
}
