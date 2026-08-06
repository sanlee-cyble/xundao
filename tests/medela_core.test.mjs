import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFieldsFromApi,
  MEDELA_VIDEO_NATURAL_SCOPE,
  MEDELA_VIDEO_SCOPE,
} from "../src/pgy_collect_core.mjs";
import { normalizeTemplateId, templateProfile } from "../src/template_profiles.mjs";

test("美德乐 notes_rate 只读取视频类合作笔记近 90 天目标口径", () => {
  const url = "https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?business=1&noteType=2&dateType=2&advertiseSwitch=1";
  const fields = extractFieldsFromApi(url, {
    data: {
      impMedian: 58837,
      readMedian: 11879,
      pagePercentVo: {
        impHomefeedPercent: 0.688,
        impSearchPercent: 0.233,
        impFollowPercent: 0.011,
        impDetailPercent: 0.043,
        impNearbyPercent: 0,
        impOtherPercent: 0.025,
      },
    },
  }, { collectionTemplate: "medela" });
  assert.equal(fields["合作笔记曝光中位数（90天）"], 58837);
  assert.equal(fields["合作笔记阅读中位数（90天）"], 11879);
  assert.equal(fields["曝光来源-发现页"], 0.688);
  assert.equal(
    [
      fields["曝光来源-发现页"],
      fields["曝光来源-搜索页"],
      fields["曝光来源-关注页"],
      fields["曝光来源-博主个人页"],
      fields["曝光来源-附近页"],
      fields["曝光来源-其他"],
    ].reduce((sum, value) => sum + value, 0),
    1,
  );
});

test("美德乐忽略图文加视频的混合口径", () => {
  const url = "https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?business=1&noteType=3&dateType=2&advertiseSwitch=1";
  const fields = extractFieldsFromApi(url, {
    data: { impMedian: 123, readMedian: 45, pagePercentVo: { impHomefeedPercent: 1 } },
  }, { collectionTemplate: "medela" });
  assert.equal(fields["合作笔记曝光中位数（90天）"], undefined);
});

test("美德乐 L/S 忽略仅自然流量的 notes_rate", () => {
  const url = "https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate?business=1&noteType=2&dateType=2&advertiseSwitch=0";
  const fields = extractFieldsFromApi(url, {
    data: { impMedian: 35157, readMedian: 9243, pagePercentVo: { impHomefeedPercent: 1 } },
  }, { collectionTemplate: "medela" });
  assert.equal(fields["合作笔记曝光中位数（90天）"], undefined);
  assert.equal(fields["合作笔记阅读中位数（90天）"], undefined);
});

test("美德乐 core_data 只读取按规模仅自然流曝光与阅读", () => {
  const fields = extractFieldsFromApi(
    "https://pgy.xiaohongshu.com/api/pgy/kol/data/core_data",
    { data: { sumData: { imp: 133125, read: 20382 } } },
    {
      collectionTemplate: "medela",
      postData: JSON.stringify({ business: 1, noteType: 2, dateType: 2, advertiseSwitch: 0 }),
    },
  );
  assert.equal(fields["预估合作笔记自然流曝光（90天）"], 133125);
  assert.equal(fields["预估合作笔记自然流阅读（90天）"], 20382);
});

test("美德乐 T/U 忽略全流量 core_data", () => {
  const fields = extractFieldsFromApi(
    "https://pgy.xiaohongshu.com/api/pgy/kol/data/core_data",
    { data: { sumData: { imp: 67498, read: 13526 } } },
    {
      collectionTemplate: "medela",
      postData: JSON.stringify({ business: 1, noteType: 2, dateType: 2, advertiseSwitch: 1 }),
    },
  );
  assert.equal(fields["预估合作笔记自然流曝光（90天）"], undefined);
  assert.equal(fields["预估合作笔记自然流阅读（90天）"], undefined);
});

test("博主基础接口生成万粉数、视频报价和小红书主页链接", () => {
  const fields = extractFieldsFromApi(
    "https://pgy.xiaohongshu.com/api/solar/cooperator/user/blogger/creator-1",
    { data: { userId: "creator-1", fansCount: 18143, videoPrice: 2000 } },
    { collectionTemplate: "medela" },
  );
  assert.equal(fields["粉丝数（w）"], 1.8143);
  assert.equal(fields["报价"], 2000);
  assert.equal(fields["小红书主页链接"], "https://www.xiaohongshu.com/user/profile/creator-1");
});

test("模板注册表支持富士、美德乐并安全回退", () => {
  assert.equal(templateProfile("fuji").label, "富士模板");
  assert.equal(templateProfile("medela").label, "美德乐模板");
  assert.equal(normalizeTemplateId("unknown"), "fuji");
  assert.equal(templateProfile("medela").fields.length, 17);
  assert.deepEqual(MEDELA_VIDEO_SCOPE, {
    business: 1,
    noteType: 2,
    dateType: 2,
    advertiseSwitch: 1,
  });
  assert.deepEqual(MEDELA_VIDEO_NATURAL_SCOPE, {
    business: 1,
    noteType: 2,
    dateType: 2,
    advertiseSwitch: 0,
  });
});
