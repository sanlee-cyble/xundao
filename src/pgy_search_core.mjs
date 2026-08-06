import fs from "node:fs/promises";
import path from "node:path";
import { nowStamp, safeFilename, writeJson } from "./common.mjs";
import { ROOT } from "./pgy_collect_core.mjs";

export const PGY_CATEGORIES = [
  { name: "全部", children: [] },
  { name: "美妆", children: ["整体妆容", "唇妆", "眼妆", "美甲", "底妆", "美妆合集", "香水", "美妆其他"] },
  { name: "护肤", children: ["面部保养", "面部清洁", "护肤合集", "护肤其他"] },
  { name: "个人护理", children: ["头发产品", "身体护理", "口腔护理", "护理其他"] },
  { name: "母婴", children: ["母婴日常", "早教", "婴童用品", "婴童洗护", "婴童食品", "婴童时尚", "孕期穿搭", "孕产经验", "产后恢复", "育儿经验", "宝宝才艺", "宝宝写真", "母婴其他"] },
  { name: "时尚", children: ["穿搭", "配饰", "发型", "箱包", "鞋靴", "时尚其他"] },
  { name: "美食", children: ["美食教程", "美食探店", "美食展示", "美食测评", "吃播", "美食其他"] },
  { name: "家居家装", children: ["装修", "家居用品", "花艺园艺", "家居装饰", "家具", "家电", "室内设计", "居家经验", "家居家装其他"] },
  { name: "影视综资讯", children: ["动漫", "娱乐资讯", "影视", "民生资讯", "综艺", "影视综其他"] },
  { name: "运动健身", children: ["减脂塑形", "滑雪", "滑板", "水上活动", "运动其他", "足球", "篮球", "跑步", "游泳"] },
  { name: "宠物", children: ["猫", "狗", "动物其他"] },
  { name: "文化艺术", children: ["社科", "文化", "艺术", "文化艺术其他"] },
  { name: "兴趣爱好", children: ["绘画", "手工", "阅读", "文具手账", "舞蹈", "兴趣爱好其他", "玩具周边"] },
  { name: "生活记录", children: ["接地气生活", "日常片段", "中外生活", "品质生活", "校园生活"] },
  { name: "教育", children: ["大学教育", "k12教育", "家庭教育", "学习日常", "留学教育", "教育其他", "语言教育"] },
  { name: "职场", children: ["职场干货", "职场行业", "职业考试", "职场其他"] },
  { name: "情感", children: ["情感知识", "情感日常", "情感其他"] },
  { name: "摄影", children: ["人文风光摄影", "摄影技巧", "胶片摄影", "人像摄影", "摄影其他"] },
  { name: "游戏", children: ["手机游戏", "主机游戏", "游戏其他", "线下游戏"] },
  { name: "科技数码", children: ["移动数码", "玩机攻略", "数码科技其他"] },
  { name: "出行旅游", children: ["城市出行", "户外", "旅行"] },
  { name: "音乐", children: [] },
  { name: "搞笑", children: [] },
  { name: "健康养生", children: [] },
  { name: "汽车", children: ["用车攻略", "汽车评测", "汽车其他"] },
  { name: "婚嫁", children: ["婚礼造型", "婚礼记录", "婚礼经验", "婚礼用品"] },
  { name: "商业财经", children: [] },
  { name: "素材", children: [] },
  { name: "其他", children: [] },
];

const SEARCH_PATH = "/solar/pre-trade/note/kol";
const SEARCH_API = "/api/solar/cooperator/blogger/v2";

function normalizedText(value) {
  return String(value || "").trim();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFanRange(label) {
  const value = normalizedText(label);
  if (value.includes("路人")) return { min: 0, max: 300 };
  if (value.includes("素人")) return { min: 300, max: 5000 };
  if (value.includes("初级")) return { min: 5000, max: 50000 };
  if (value.includes("腰部")) return { min: 50000, max: 500000 };
  if (value.includes("头部")) return { min: 500000, max: Number.POSITIVE_INFINITY };
  if (value === "1-5万") return { min: 10000, max: 50000 };
  if (value === "5-10万") return { min: 50000, max: 100000 };
  if (value === "10-50万") return { min: 100000, max: 500000 };
  if (value === "50万+") return { min: 500000, max: Number.POSITIVE_INFINITY };
  if (value === "1-10万") return { min: 10000, max: 100000 };
  return { min: 0, max: Number.POSITIVE_INFINITY };
}

function parsePriceRange(label) {
  const value = normalizedText(label);
  if (!value || value === "不限") return { min: 0, max: Number.POSITIVE_INFINITY };
  if (value.includes("0-500")) return { min: 0, max: 500 };
  if (value.includes("500-5,000") || value.includes("500-5000")) return { min: 500, max: 5000 };
  if (value.includes("5,000-15,000") || value.includes("5000-15000")) return { min: 5000, max: 15000 };
  if (value.includes("15,000-100,000") || value.includes("15000-100000")) return { min: 15000, max: 100000 };
  if (value.includes("100,000+") || value.includes("100000+")) return { min: 100000, max: Number.POSITIVE_INFINITY };
  return { min: 0, max: Number.POSITIVE_INFINITY };
}

function genderValue(label) {
  const value = normalizedText(label);
  if (value === "男性") return 1;
  if (value === "女性") return 2;
  return null;
}

function fanGenderValue(label) {
  const value = normalizedText(label);
  if (value.includes("男性")) return 1;
  if (value.includes("女性")) return 2;
  return 0;
}

function noteTypeValue(label) {
  const value = normalizedText(label);
  if (value === "图文") return 1;
  if (value === "视频") return 2;
  return 0;
}

function parseMatchMin(label) {
  const match = String(label || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function safeCategory(value) {
  const text = normalizedText(value);
  return text && text !== "全部" && text !== "不限" ? text : "";
}

function searchUrl(keyword) {
  const params = new URLSearchParams({
    searchInfo: "true",
    searchType: "1",
    searchWord: keyword,
    contentTab: "1",
  });
  return `${SEARCH_PATH}?${params.toString()}`;
}

function buildSearchBody(filters, pageNum, pageSize, trackId = "") {
  const firstIndustry = safeCategory(filters.category);
  const secondIndustry = safeCategory(filters.subcategory);
  return {
    searchType: 1,
    keyword: normalizedText(filters.keyword) || "网球",
    column: columnForSort(filters.sort),
    sort: sortDirection(filters.sort),
    pageNum,
    pageSize,
    trackId,
    marketTarget: null,
    audienceGroup: [],
    personalTags: [],
    gender: genderValue(filters.bloggerGender),
    location: null,
    signed: -1,
    featureTags: [],
    fansAge: 0,
    fansGender: fanGenderValue(filters.fanGender),
    fansLocation: null,
    fansMaritalStatus: -1,
    fansConsumptionLevel: -1,
    fansChildAgeInfo: [],
    fansDevicePrice: [],
    fansDeviceBrand: [],
    accumCommonImpMedinNum30d: [],
    readMidNor30: [],
    interMidNor30: [],
    thousandLikePercent30: [],
    noteType: noteTypeValue(filters.cooperationType),
    progressOrderCnt: [],
    tradeType: "不限",
    tradeReportBrandIdSet: [],
    excludedTradeReportBrandId: false,
    estimateCpuv30d: [],
    inStar: 0,
    firstIndustry,
    secondIndustry,
    newHighQuality: 0,
    filterIntention: false,
    flagList: [
      { flagType: "HAS_BRAND_COOP_BUYER_AUTH", flagValue: "0" },
      { flagType: "IS_HIGH_QUALITY", flagValue: "0" },
    ],
    activityCodes: [],
    excludeLowActive: false,
    fansNumUp: 0,
    excludedTradeReportBrand: false,
    excludedTradeInviteReportBrand: false,
    filterList: [],
    contentSceneLabel: [],
  };
}

function columnForSort(sort) {
  if (sort === "粉丝数从高到低") return "fans";
  if (sort === "报价从低到高") return "price";
  if (sort === "阅读中位数优先") return "readMidNor30";
  if (sort === "互动中位数优先") return "interMidNor30";
  return "comprehensiverank";
}

function sortDirection(sort) {
  return sort === "报价从低到高" ? "asc" : "desc";
}

function tagText(item) {
  return [
    ...(item.featureTags || []),
    ...(item.contentTags || []).flatMap((tag) => [tag.taxonomy1Tag, ...(tag.taxonomy2Tags || [])]),
    ...(item.noteList || []).flatMap((note) => [note.contentTag, ...(note.featureTags || []), ...(note.industryTags || [])]),
  ]
    .filter(Boolean)
    .join(" ");
}

function categoryMatches(item, filters) {
  const category = safeCategory(filters.category);
  const subcategory = safeCategory(filters.subcategory);
  if (!category && !subcategory) return true;
  const tags = tagText(item);
  if (!tags) return true;
  if (category && !tags.includes(category)) return false;
  if (subcategory && !tags.includes(subcategory)) return false;
  return true;
}

function matchCount(item) {
  const explicit = Number(item.matchNoteNumber || 0);
  if (explicit > 0) return explicit;
  return (item.noteList || []).filter((note) => (note.featureTags || []).length > 0).length;
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function countNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, "");
    const match = text.match(/([\d.]+)\s*([万wW]?)/);
    if (!match) return 0;
    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.round(numeric * (match[2] ? 10000 : 1));
  }
  if (value && typeof value === "object") {
    const preferredKeys = [
      "likeCollectCount",
      "likeCollectNum",
      "likeAndCollectCount",
      "likeAndCollectNum",
      "count",
      "num",
      "value",
      "text",
      "display",
    ];
    for (const key of preferredKeys) {
      const numeric = countNumber(value[key]);
      if (numeric) return numeric;
    }
    for (const nested of Object.values(value)) {
      const numeric = countNumber(nested);
      if (numeric) return numeric;
    }
  }
  return 0;
}

function compactLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function nextValue(rows, label) {
  for (let index = 0; index < rows.length - 1; index += 1) {
    if (rows[index] === label) return rows[index + 1];
    if (rows[index].startsWith(label)) return rows[index].replace(label, "").trim();
  }
  return "";
}

function parseLikeCollectFromText(text) {
  const rows = compactLines(text);
  const adjacentValue = countNumber(nextValue(rows, "获赞与收藏"));
  if (adjacentValue) return adjacentValue;
  const inlineMatch = String(text || "").match(/获赞与收藏\s*[:：]?\s*([\d.,]+)\s*([万wW]?)/);
  if (inlineMatch) return countNumber(`${inlineMatch[1]}${inlineMatch[2] || ""}`);
  return 0;
}

function extractLikeCollectFromPayload(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const numeric = extractLikeCollectFromPayload(item);
      if (numeric) return numeric;
    }
    return 0;
  }

  const entries = Object.entries(value);
  const label = String(value.label || value.name || value.title || value.text || value.desc || "");
  if (label.includes("获赞与收藏")) {
    for (const key of ["value", "count", "num", "number", "total", "display", "content"]) {
      const numeric = countNumber(value[key]);
      if (numeric) return numeric;
    }
  }

  for (const [key, nested] of entries) {
    if (/like.*collect|collect.*like|likeAndCollect|likedAndCollect|likeCollect|totalLikeCollect/i.test(key)) {
      const numeric = countNumber(nested);
      if (numeric) return numeric;
    }
  }

  for (const [, nested] of entries) {
    const numeric = extractLikeCollectFromPayload(nested);
    if (numeric) return numeric;
  }
  return 0;
}

function detailUserId(candidate) {
  const direct = candidate.creatorId || candidate.userId || "";
  if (direct) return String(direct);
  const match = String(candidate.detailUrl || candidate.pgyLink || "").match(/\/blogger-detail\/([^/?#]+)/);
  return match ? match[1] : "";
}

function applyBloggerSnapshot(candidate, payload) {
  const data = payload?.data || payload || {};
  const totalInteraction = countNumber(data.likeCollectCountInfo) || extractLikeCollectFromPayload(data);
  if (!totalInteraction) return false;
  candidate.totalInteraction = totalInteraction;
  candidate.totalInteractionStatus = "success";
  if (!candidate.fans && data.fansNum) candidate.fans = Number(data.fansNum || 0);
  if (!candidate.fansNum && data.fansNum) candidate.fansNum = Number(data.fansNum || 0);
  if (!candidate.picturePrice && data.picturePrice) candidate.picturePrice = Number(data.picturePrice || 0);
  if (!candidate.videoPrice && data.videoPrice) candidate.videoPrice = Number(data.videoPrice || 0);
  if (!candidate.lowerPrice && data.lowerPrice) candidate.lowerPrice = Number(data.lowerPrice || 0);
  if (!candidate.readMedian) candidate.readMedian = firstNumber(data.clickMidNum, data.pictureClickMidNum, data.videoClickMidNum, data.readMedian);
  if (!candidate.interactionMedian) candidate.interactionMedian = firstNumber(data.interMidNum, data.pictureInterMidNum, data.videoInterMidNum, data.interactionMedian);
  return true;
}

async function enrichLikeCollectFromBloggerApi(context, candidate, config = {}) {
  const userId = detailUserId(candidate);
  if (!userId) return false;
  const baseUrl = config.baseUrl || "https://pgy.xiaohongshu.com";
  const timeout = Number(config.finderDetailApiTimeoutMs || 8000);
  try {
    const response = await context.request.get(`${baseUrl}/api/solar/cooperator/user/blogger/${encodeURIComponent(userId)}`, { timeout });
    if (!response.ok()) return false;
    const payload = await response.json();
    return applyBloggerSnapshot(candidate, payload);
  } catch (error) {
    candidate.totalInteractionError = error.message;
    return false;
  }
}

async function mapConcurrent(items, limit, handler) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

export async function enrichLikeCollectCount(context, candidates, config = {}) {
  const targets = candidates.filter((candidate) => !candidate.totalInteraction && (candidate.detailUrl || candidate.pgyLink));
  if (!targets.length) return;
  const concurrency = Number(config.finderDetailConcurrency || 4);
  const detailTimeoutMs = Number(config.finderDetailTimeoutMs || 12000);
  const labelWaitMs = Number(config.finderDetailLabelWaitMs || 7000);
  await mapConcurrent(targets, concurrency, async (candidate) => {
    const fromBloggerApi = await enrichLikeCollectFromBloggerApi(context, candidate, config);
    if (fromBloggerApi) return;

    const page = await context.newPage();
    let apiTotalInteraction = 0;
    try {
      const userId = detailUserId(candidate);
      const detailApiPath = userId ? `/api/solar/cooperator/user/blogger/${userId}` : "";
      page.on("response", async (response) => {
        if (apiTotalInteraction) return;
        if (detailApiPath && !response.url().includes(detailApiPath)) return;
        const contentType = response.headers()["content-type"] || "";
        if (!contentType.includes("json") && !response.url().includes("/api/")) return;
        try {
          const payload = await response.json();
          if (applyBloggerSnapshot(candidate, payload)) {
            apiTotalInteraction = candidate.totalInteraction;
          }
        } catch {
          // Ignore non-JSON or already-consumed responses.
        }
      });
      await page.goto(candidate.detailUrl || candidate.pgyLink, { waitUntil: "domcontentloaded", timeout: detailTimeoutMs });
      await page.waitForFunction(() => document.body.innerText.includes("获赞与收藏"), null, { timeout: labelWaitMs }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(Number(config.finderDetailWaitMs || 500));
      const rawText = await page.evaluate(() => document.body.innerText || "");
      const totalInteraction = apiTotalInteraction || parseLikeCollectFromText(rawText);
      candidate.totalInteraction = totalInteraction;
      candidate.totalInteractionStatus = totalInteraction ? "success" : "missing";
    } catch (error) {
      candidate.totalInteraction = 0;
      candidate.totalInteractionStatus = "failed";
      candidate.totalInteractionError = error.message;
    } finally {
      await page.close().catch(() => {});
    }
  });
}

function qualitySignal(item, candidate) {
  const signals = [];
  if (candidate.matchNoteNumber >= 10) signals.push("内容高度相关");
  else if (candidate.matchNoteNumber >= 2) signals.push("内容相关");
  if (candidate.lowerPrice && candidate.readMedian) {
    const cpv = candidate.lowerPrice / candidate.readMedian;
    if (cpv <= 0.5) signals.push("阅读成本低");
    else if (cpv >= 2) signals.push("阅读成本偏高");
  }
  if (Number(item.businessNoteCount || 0) > 50) signals.push("商业合作多");
  return signals.slice(0, 2).join(" · ") || "待人工判断";
}

function recommendationReason(candidate, filters) {
  const reasons = [];
  if (candidate.matchNoteNumber > 0) reasons.push(`命中${filters.keyword || "关键词"}笔记 ${candidate.matchNoteNumber} 篇`);
  if (candidate.categoryText) reasons.push(`类目 ${candidate.categoryText.split("；")[0]}`);
  if (candidate.readMedian) reasons.push(`阅读中位数 ${candidate.readMedian.toLocaleString("zh-CN")}`);
  if (candidate.interactionMedian) reasons.push(`互动中位数 ${candidate.interactionMedian.toLocaleString("zh-CN")}`);
  if (candidate.estimatedCpv) reasons.push(`预估阅读成本 ¥${candidate.estimatedCpv}`);
  if (candidate.lowerPrice) reasons.push(`报价 ¥${candidate.lowerPrice.toLocaleString("zh-CN")} 起`);
  return reasons.slice(0, 4).join("；") || "内容相关，待采集表现数据确认";
}

function normalizeCandidate(item, trackId, filters) {
  const creatorId = item.userId || "";
  const pgyLink = creatorId ? `${filters.baseUrl || "https://pgy.xiaohongshu.com"}/solar/pre-trade/blogger-detail/${creatorId}` : "";
  const fans = Number(item.fansNum || item.fansCount || 0);
  const lowerPrice = Number(item.lowerPrice || item.picturePrice || item.videoPrice || 0);
  const readMedian = firstNumber(item.clickMidNum, item.pictureClickMidNum, item.videoClickMidNum, item.readMidNor30, item.readMedian);
  const interactionMedian = firstNumber(item.interMidNum, item.pictureInterMidNum, item.videoInterMidNum, item.interMidNor30, item.interactionMedian);
  const totalInteraction = countNumber(item.likeCollectCountInfo)
    || countNumber(item.likeCollectCount)
    || countNumber(item.likeCollectNum)
    || countNumber(item.likeAndCollectCount)
    || countNumber(item.likeAndCollectNum)
    || countNumber(item.totalLikeCollectCount);
  const estimatedCpv = readMedian && lowerPrice ? Number((lowerPrice / readMedian).toFixed(2)) : 0;
  const estimatedCpe = interactionMedian && lowerPrice ? Number((lowerPrice / interactionMedian).toFixed(2)) : 0;
  const tags = (item.contentTags || [])
    .map((tag) => [tag.taxonomy1Tag, ...(tag.taxonomy2Tags || [])].filter(Boolean).join("/"))
    .filter(Boolean);
  const candidate = {
    creatorId,
    userId: creatorId,
    nickname: item.name || item.nickName || "",
    name: item.name || item.nickName || "",
    redId: item.redId || "",
    pgyLink,
    detailUrl: pgyLink,
    fans,
    fansNum: fans,
    matchNoteNumber: matchCount(item),
    evidence: matchCount(item) ? `近期${filters.keyword || ""}笔记 ${matchCount(item)} 篇` : "关键词命中",
    lowerPrice,
    picturePrice: Number(item.picturePrice || 0),
    videoPrice: Number(item.videoPrice || 0),
    priceLabel: lowerPrice ? `¥${lowerPrice.toLocaleString("zh-CN")} 起` : "-",
    totalInteraction,
    readMedian,
    interactionMedian,
    estimatedCpv,
    estimatedCpe,
    videoFinishRate: Number(item.videoFinishRate || 0),
    gender: item.gender ?? "",
    status: "可采集",
    contentTags: item.contentTags || [],
    categoryText: tags.join("；"),
    primaryCategory: tags[0] || "",
    featureTags: item.featureTags || [],
    noteList: item.noteList || [],
    businessNoteCount: item.businessNoteCount ?? "",
    location: item.location || "",
    trackId,
  };
  candidate.qualitySignal = qualitySignal(item, candidate);
  candidate.discoveryPath = filters.discoveryPath || "精准内容命中";
  candidate.searchKeyword = filters.keyword || "";
  candidate.recommendationReason = recommendationReason(candidate, filters);
  return candidate;
}

function candidatePasses(candidate, filters) {
  const { min, max } = parseFanRange(filters.fanRange);
  if (candidate.fans < min || candidate.fans > max) return false;
  if (candidate.matchNoteNumber < parseMatchMin(filters.match)) return false;
  const cooperationType = normalizedText(filters.cooperationType);
  if (cooperationType === "图文" && !candidate.picturePrice) return false;
  if (cooperationType === "视频" && !candidate.videoPrice) return false;
  const price = cooperationType === "视频" ? candidate.videoPrice : cooperationType === "图文" ? candidate.picturePrice : candidate.lowerPrice;
  const { min: priceMin, max: priceMax } = parsePriceRange(filters.priceRange);
  if (price && (price < priceMin || price > priceMax)) return false;
  if (!price && Number.isFinite(priceMax) && priceMax !== Number.POSITIVE_INFINITY) return false;
  const bloggerGender = genderValue(filters.bloggerGender);
  if (bloggerGender && candidate.gender && Number(candidate.gender) !== bloggerGender) return false;
  return true;
}

function parseKeywordList(filters, keyword) {
  const fromKeyword = String(keyword || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const baseKeyword = fromKeyword[0] || keyword;
  const extras = String(filters.expandedKeywords || "")
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set([baseKeyword, ...fromKeyword.slice(1), ...extras])).slice(0, 6);
}

function buildSearchPasses(filters, keyword) {
  const selectedStrategies = Array.isArray(filters.strategies) && filters.strategies.length
    ? filters.strategies
    : String(filters.strategy || "综合推荐").split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
  const strategies = selectedStrategies.includes("综合推荐") ? ["综合推荐"] : selectedStrategies;
  const keywords = parseKeywordList(filters, keyword);
  const base = { ...filters };
  const passes = [];
  for (const strategy of strategies) {
    for (const key of keywords) {
      const common = { ...base, keyword: key, strategy };
      if (strategy === "精准内容") {
        passes.push({ ...common, discoveryPath: "精准内容命中" });
        continue;
      }
      if (strategy === "类目铺底") {
        passes.push({ ...common, keyword: key, match: "不限", discoveryPath: "类目铺底" });
        continue;
      }
      if (strategy === "性价比优先") {
        passes.push({ ...common, match: "不限", sort: "报价从低到高", discoveryPath: "性价比优先" });
        passes.push({ ...common, match: "不限", sort: "阅读中位数优先", discoveryPath: "低阅读成本补量" });
        continue;
      }
      if (strategy === "表现优先") {
        passes.push({ ...common, match: "不限", sort: "阅读中位数优先", discoveryPath: "阅读表现优先" });
        passes.push({ ...common, match: "不限", sort: "互动中位数优先", discoveryPath: "互动表现补量" });
        continue;
      }
      passes.push({ ...common, discoveryPath: "精准内容命中" });
      passes.push({ ...common, subcategory: "不限", discoveryPath: "放宽细分类目" });
      passes.push({ ...common, match: "不限", discoveryPath: "内容相关补量" });
      passes.push({ ...common, match: "不限", sort: "阅读中位数优先", discoveryPath: "表现优先补量" });
      passes.push({ ...common, match: "不限", sort: "报价从低到高", discoveryPath: "性价比补量" });
    }
  }
  if (passes.length < 2 && safeCategory(filters.category)) {
    passes.push({ ...base, keyword, category: "全部", subcategory: "不限", match: "不限", discoveryPath: "跨类目关键词补量" });
  }
  return passes;
}

export function creatorFromCandidate(candidate, index = 0) {
  const creatorId = candidate.creatorId || candidate.userId || "";
  return {
    rowIndex: index + 2,
    nickname: candidate.nickname || candidate.name || "",
    redId: candidate.redId || "",
    pgyLink: candidate.pgyLink || candidate.detailUrl || `https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/${creatorId}`,
    creatorId,
  };
}

export async function searchCreators({ context, runDir, config = {}, filters = {} }) {
  const keyword = normalizedText(filters.keyword) || "网球";
  const pageSize = Math.min(parsePositiveInt(filters.pageSize, 20), 50);
  const maxPages = Math.min(parsePositiveInt(filters.maxPages, 5), 20);
  const limit = Math.min(parsePositiveInt(filters.limit, 50), 200);
  const batchIndex = Math.max(Number.parseInt(String(filters.batchIndex ?? "0"), 10) || 0, 0);
  const startPage = Math.max(Number.parseInt(String(filters.startPage || ""), 10) || (batchIndex * maxPages + 1), 1);
  const mergedFilters = { ...filters, keyword, baseUrl: config.baseUrl || "https://pgy.xiaohongshu.com" };
  const passes = buildSearchPasses(mergedFilters, keyword);
  const rawDir = path.join(runDir, "finder");
  await fs.mkdir(rawDir, { recursive: true });

  const page = await context.newPage();
  const rawResponses = [];
  const seen = new Set();
  const candidates = [];
  let total = 0;
  try {
    for (const pass of passes) {
      if (candidates.length >= limit) break;
      let trackId = "";
      await page.goto(`${mergedFilters.baseUrl}${searchUrl(pass.keyword || keyword)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(800);
      for (let pageNum = startPage; pageNum < startPage + maxPages && candidates.length < limit; pageNum += 1) {
        const body = buildSearchBody(pass, pageNum, pageSize, trackId);
        const result = await page.evaluate(
          async ({ apiPath, requestBody }) => {
            const response = await fetch(apiPath, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(requestBody),
            });
            const text = await response.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = { raw: text.slice(0, 1000) };
            }
            return { ok: response.ok, status: response.status, json };
          },
          { apiPath: SEARCH_API, requestBody: body },
        );
        rawResponses.push({ pass: pass.discoveryPath, keyword: pass.keyword, pageNum, request: body, response: result });
        if (!result.ok || result.json?.code !== 0) {
          throw new Error(result.json?.msg || `平台检索失败：HTTP ${result.status}`);
        }
        const data = result.json.data || {};
        const kols = Array.isArray(data) ? data : (data.kols || data.list || data.records || []);
        total = Math.max(Number(data.total || data.count || 0), total, kols.length);
        trackId = data.trackId || trackId;
        for (const item of kols) {
          const id = item.userId || item.redId || item.name;
          if (!id || seen.has(id)) continue;
          if (!categoryMatches(item, pass)) continue;
          const candidate = normalizeCandidate(item, trackId, pass);
          if (!candidatePasses(candidate, pass)) continue;
          seen.add(id);
          candidates.push(candidate);
          if (candidates.length >= limit) break;
        }
        if (!kols.length) break;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  const rawPath = path.join(rawDir, `${nowStamp()}_${safeFilename(keyword)}_raw.json`);
  const candidatesPath = path.join(rawDir, `${nowStamp()}_${safeFilename(keyword)}_candidates.json`);
  await writeJson(rawPath, rawResponses);
  await writeJson(candidatesPath, candidates);
  return {
    keyword,
    total,
    returned: candidates.length,
    batchIndex,
    nextBatchIndex: batchIndex + 1,
    pageRange: { start: startPage, end: startPage + maxPages - 1 },
    strategy: normalizedText(filters.strategy) || "综合推荐",
    passCount: passes.length,
    trackId: "",
    candidates,
    methodSummary: {
      how: "先按笔记关键词和内容类目做相关性初筛；结果不足时自动放宽细分类目、命中笔记和排序方式补量；再用阅读/互动/报价做精筛。",
      selectedBy: ["内容相关性", "粉丝量级", "阅读与互动表现", "报价和预估成本", "类目与人群匹配"],
      paths: Array.from(new Set(candidates.map((item) => item.discoveryPath))).filter(Boolean),
    },
    evidenceFiles: [
      path.relative(ROOT, rawPath),
      path.relative(ROOT, candidatesPath),
    ],
  };
}
