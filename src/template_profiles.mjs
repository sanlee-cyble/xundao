import { DERIVED_FIELD_REGISTRY, FIELD_REGISTRY, LLM_FIELD_POLICY } from "./field_registry.mjs";

export const TEMPLATE_PROFILES = {
  fuji: {
    id: "fuji",
    label: "富士模板",
    description: "保留原有达人表现采集字段，适用于富士项目执行表与候选池导出。",
    collectionTemplate: "fuji",
    fields: [
      { name: "粉丝数", group: "基础信息", default: true },
      { name: "总互动数", group: "基础信息", default: true },
      { name: "图文报价", group: "报价", default: true },
      { name: "视频报价", group: "报价", default: true },
      { name: "阅读中位数", group: "表现数据", default: true },
      { name: "互动中位数", group: "表现数据", default: true },
      { name: "视频完播率", group: "表现数据", default: true },
      { name: "图文3秒阅读率", group: "表现数据", default: false },
      { name: "预估阅读单价", group: "成本", default: false },
      { name: "预估互动单价", group: "成本", default: false },
      { name: "活跃粉丝占比", group: "粉丝画像", default: false },
      { name: "阅读粉丝占比", group: "粉丝画像", default: false },
      { name: "互动粉丝占比", group: "粉丝画像", default: false },
      { name: "下单粉丝占比", group: "粉丝画像", default: false },
      { name: "25岁以上粉丝占比", group: "粉丝画像", default: true },
      { name: "粉丝地域分布前3位", group: "粉丝画像", default: true },
    ],
  },
  medela: {
    id: "medela",
    label: "美德乐模板",
    description: "采集视频类合作笔记近 90 天全流量中位数、仅自然流曝光/阅读、视频报价，并生成成本公式与客观推荐理由。",
    collectionTemplate: "medela",
    fields: [
      { name: "小红书主页链接", group: "基础信息", default: true },
      { name: "粉丝数（w）", group: "基础信息", default: true },
      { name: "合作笔记曝光中位数（90天）", group: "合作表现", default: true },
      { name: "曝光来源-发现页", group: "曝光来源", default: true },
      { name: "曝光来源-搜索页", group: "曝光来源", default: true },
      { name: "曝光来源-关注页", group: "曝光来源", default: true },
      { name: "曝光来源-博主个人页", group: "曝光来源", default: true },
      { name: "曝光来源-附近页", group: "曝光来源", default: true },
      { name: "曝光来源-其他", group: "曝光来源", default: true },
      { name: "合作笔记阅读中位数（90天）", group: "合作表现", default: true },
      { name: "预估合作笔记自然流曝光（90天）", group: "合作表现", default: true },
      { name: "预估合作笔记自然流阅读（90天）", group: "合作表现", default: true },
      { name: "报价", group: "成本", default: true },
      { name: "下单价", group: "成本", default: true, derived: true },
      { name: "实际花费", group: "成本", default: true, derived: true },
      { name: "CPC", group: "成本", default: true, derived: true },
      { name: "推荐理由", group: "决策辅助", default: true, generated: true },
    ],
  },
  dynamic: {
    id: "dynamic",
    label: "智能 Excel",
    description: "自动解析任意 Excel 表头，按字段口径生成最小采集计划；蒲公英外字段由 DeepSeek 逐格审计，证据不足即留空。",
    collectionTemplate: "dynamic",
    fields: [
      ...FIELD_REGISTRY.map((item) => ({
        id: item.id,
        name: item.name,
        group: item.group,
        default: true,
      })),
      ...DERIVED_FIELD_REGISTRY.map((item) => ({
        id: item.id,
        name: item.name,
        group: "计算字段",
        default: true,
        derived: true,
      })),
      ...LLM_FIELD_POLICY.candidates.map((name) => ({
        name,
        group: "证据判断字段",
        default: true,
        generated: true,
      })),
    ],
  },
};

export function normalizeTemplateId(value) {
  const id = String(value || "fuji").trim().toLowerCase();
  return TEMPLATE_PROFILES[id] ? id : "fuji";
}

export function templateProfile(value) {
  return TEMPLATE_PROFILES[normalizeTemplateId(value)];
}

export function publicTemplateProfiles() {
  return Object.values(TEMPLATE_PROFILES).map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    fields: profile.fields,
  }));
}

export const MEDELA_REQUIRED_FIELDS = TEMPLATE_PROFILES.medela.fields
  .filter((field) => !field.derived && !field.generated)
  .map((field) => field.name);
