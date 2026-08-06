#!/usr/bin/env python3
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config/pgy_config.json").read_text(encoding="utf-8"))
IAB_DIRS = [
    ROOT / "raw/iab-full-2026-07-07",
    ROOT / "raw/iab-2026-07-07T03-logged-in",
]

DETAIL_FILE_BY_RED_ID = {
    "194723003": "li_bai_kaishui_detail_text.txt",
    "yuuucute": "xiaoyu_detail_text.txt",
    "95223718596": "nishiqi_detail_text.txt",
    "181476121": "yuezhenzhen_detail_text.txt",
}

DETAIL_URL_BY_RED_ID = {
    "194723003": "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/5e818e370000000001008f91?track_id=kolSearch_a2ed98f00b434fadbf4929508fac580b&fromRoute=Advertiser_Kol&source=Advertiser_Kol",
    "yuuucute": "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/5e32383c0000000001007253?track_id=kolSearch_ace019468754425c98c9713a1bf72064&fromRoute=Advertiser_Kol&source=Advertiser_Kol",
}


def lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


def next_value(rows, label, start=0):
    for index in range(start, len(rows) - 1):
        if rows[index] == label:
            return rows[index + 1], index
    return "", -1


def value_after_last(rows, label):
    value = ""
    last = -1
    for index in range(0, len(rows) - 1):
        if rows[index] == label:
            value = rows[index + 1]
            last = index
    return value, last


def clean_money(value):
    return value.replace("¥", "").replace(",", "").strip()


def load_detail_urls():
    urls = dict(DETAIL_URL_BY_RED_ID)
    for directory in IAB_DIRS:
        source = directory / "detail_urls.json"
        if not source.exists():
            continue
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if payload.get("nishiqi"):
            urls["95223718596"] = payload["nishiqi"]
        if payload.get("yuezhenzhen"):
            urls["181476121"] = payload["yuezhenzhen"]
    return urls


def find_detail_file(red_id):
    filename = DETAIL_FILE_BY_RED_ID.get(red_id)
    if not filename:
        return None
    for directory in IAB_DIRS:
        source = directory / filename
        if source.exists() and source.stat().st_size > 0:
            return source
    return None


def creator_id_from_url(url):
    match = re.search(r"/blogger-detail/([^/?#]+)", url or "")
    return match.group(1) if match else ""


def parse_detail(text):
    rows = lines(text)
    data = {}
    data["粉丝数"], _ = next_value(rows, "粉丝数")
    data["总互动数"], _ = next_value(rows, "获赞与收藏")
    picture_price, _ = next_value(rows, "图文笔记一口价")
    video_price, _ = next_value(rows, "视频笔记一口价")
    data["图文报价"] = clean_money(picture_price)
    data["视频报价"] = clean_money(video_price)

    read_value, _ = next_value(rows, "阅读中位数")
    interact_value, _ = next_value(rows, "互动中位数")
    data["近90日阅读中位数"] = read_value
    data["近90日互动中位数"] = interact_value

    complete_value, _ = value_after_last(rows, "视频完播率")
    three_sec_value, _ = value_after_last(rows, "图文3秒阅读率")
    data["视频完播率"] = complete_value
    data["图文3秒阅读率"] = three_sec_value
    for label in ["活跃粉丝占比", "阅读粉丝占比", "互动粉丝占比", "下单粉丝占比"]:
        data[label], _ = next_value(rows, label)

    age = ""
    if "年龄分布" in rows:
        idx = rows.index("年龄分布")
        age = rows[idx + 1] if idx + 1 < len(rows) else ""
    data["25岁以上粉丝占比"] = age

    region = ""
    if "地域分布" in rows:
        idx = rows.index("地域分布")
        region = rows[idx + 1] if idx + 1 < len(rows) else ""
    data["粉丝地域分布前3位"] = region

    update_date = ""
    for row in rows:
        if row.startswith("数据更新至："):
            update_date = row.replace("数据更新至：", "").strip()
            break
    return data, update_date


def main():
    creators_path = ROOT / CONFIG["creatorsJson"]
    creators = json.loads(creators_path.read_text(encoding="utf-8"))
    detail_urls = load_detail_urls()
    results = []
    for creator in creators:
        source = find_detail_file(creator["redId"])
        if source and source.exists():
            text = source.read_text(encoding="utf-8", errors="ignore")
            fields, update_date = parse_detail(text)
            detail_url = detail_urls.get(creator["redId"], creator.get("pgyLink", ""))
            results.append(
                {
                    **creator,
                    "pgyLink": detail_url,
                    "pgyDetailUrl": detail_url,
                    "creatorId": creator.get("creatorId") or creator_id_from_url(detail_url),
                    "dataStatus": "成功",
                    "matchMethod": "Codex内置浏览器详情页",
                    "errorReason": "",
                    "evidenceFiles": [str(source.relative_to(ROOT))],
                    "dataUpdateDate": update_date,
                    "rawTextFile": str(source.relative_to(ROOT)),
                    "rawText": text,
                    "fields": {key: {"path": "visible_page_text", "value": value} for key, value in fields.items()},
                }
            )
        else:
            results.append(
                {
                    **creator,
                    "dataStatus": "未匹配",
                    "matchMethod": "Codex内置浏览器站内搜索",
                    "errorReason": "未能在蒲公英站内搜索稳定定位到该达人详情页",
                    "evidenceFiles": [],
                    "rawTextFile": "",
                    "rawText": "",
                    "fields": {},
                }
            )
    out = ROOT / CONFIG["mappedResultsJson"]
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"mapped {len(results)} creators from in-app browser text -> {out}")
    for row in results:
        print(row["nickname"], row["dataStatus"], len(row["fields"]))


if __name__ == "__main__":
    main()
