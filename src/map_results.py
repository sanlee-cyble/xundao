#!/usr/bin/env python3
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config/pgy_config.json").read_text(encoding="utf-8"))

FIELD_ALIASES = {
    "粉丝数": [r"fans", r"follower", r"粉丝"],
    "总互动数": [r"interaction", r"interact", r"like.*collect", r"总互动", r"互动量"],
    "图文报价": [r"picture.*price", r"image.*price", r"note.*price", r"图文.*价", r"图文报价"],
    "视频报价": [r"video.*price", r"视频.*价", r"视频报价"],
    "近90日阅读中位数": [r"read.*median", r"view.*median", r"阅读.*中位"],
    "近90日互动中位数": [r"interact.*median", r"interaction.*median", r"互动.*中位"],
    "视频完播率": [r"complete", r"finish", r"完播"],
    "图文3秒阅读率": [r"3.*read", r"three.*read", r"3秒.*阅读"],
    "活跃粉丝占比": [r"active.*fans", r"活跃.*粉丝"],
    "阅读粉丝占比": [r"read.*fans", r"阅读.*粉丝"],
    "互动粉丝占比": [r"interact.*fans", r"互动.*粉丝"],
    "下单粉丝占比": [r"order.*fans", r"下单.*粉丝"],
    "25岁以上粉丝占比": [r"25", r"age"],
    "粉丝地域分布前3位": [r"province", r"city", r"region", r"地域"]
}


def latest_capture_dir():
    raw_root = ROOT / CONFIG["rawDir"]
    if not raw_root.exists():
        return None
    dirs = sorted([p for p in raw_root.iterdir() if p.is_dir() and p.name.startswith("capture-")])
    return dirs[-1] if dirs else None


def flatten(obj, prefix=""):
    if isinstance(obj, dict):
        for key, value in obj.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            yield from flatten(value, next_prefix)
    elif isinstance(obj, list):
        for index, value in enumerate(obj[:100]):
            yield from flatten(value, f"{prefix}[{index}]")
    else:
        yield prefix, obj


def norm(value):
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return value
    return str(value).strip()


def first_match(flat_rows, aliases):
    patterns = [re.compile(alias, re.I) for alias in aliases]
    for path, value in flat_rows:
        if value in ("", None):
            continue
        searchable = path.replace("_", "").replace("-", "")
        if any(pattern.search(searchable) for pattern in patterns):
            return {"path": path, "value": norm(value)}
    return None


def main():
    creators_path = ROOT / CONFIG["creatorsJson"]
    creators = json.loads(creators_path.read_text(encoding="utf-8")) if creators_path.exists() else []
    capture_dir = latest_capture_dir()
    results = []
    if not capture_dir:
        for creator in creators:
            results.append({**creator, "dataStatus": "未采集", "errorReason": "尚未产生 raw/capture-* 监听目录", "fields": {}})
    else:
        response_files = sorted((capture_dir / "responses").glob("*.json"))
        response_payloads = []
        for file in response_files:
            try:
                payload = json.loads(file.read_text(encoding="utf-8"))
            except Exception:
                continue
            response_payloads.append((file, payload, json.dumps(payload, ensure_ascii=False)))

        for creator in creators:
            markers = [creator.get("nickname", ""), creator.get("redId", ""), creator.get("pgyLink", ""), creator.get("creatorId", "")]
            markers = [m for m in markers if m]
            matched = [(file, payload) for file, payload, text in response_payloads if any(m in text for m in markers)]
            fields = {}
            evidence = []
            for file, payload in matched:
                body = payload.get("body", payload)
                flat_rows = list(flatten(body))
                for field, aliases in FIELD_ALIASES.items():
                    if field not in fields:
                        hit = first_match(flat_rows, aliases)
                        if hit:
                            fields[field] = hit
                evidence.append(str(file.relative_to(ROOT)))
            data_status = "已匹配原始响应" if matched else "未匹配"
            results.append(
                {
                    **creator,
                    "dataStatus": data_status,
                    "errorReason": "" if matched else "未在已捕获响应中找到该达人昵称/小红书号",
                    "evidenceFiles": evidence[:10],
                    "fields": fields
                }
            )

    out = ROOT / CONFIG["mappedResultsJson"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"mapped {len(results)} creators -> {out}")
    for row in results:
        print(f"- {row.get('nickname')} / {row.get('redId')}: {row['dataStatus']} ({len(row.get('fields', {}))} fields)")


if __name__ == "__main__":
    main()
