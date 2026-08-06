#!/usr/bin/env python3
import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config/pgy_config.json").read_text(encoding="utf-8"))


def clean(value):
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def find_column(header_rows, *keywords):
    for col in range(header_rows.shape[1]):
        labels = [clean(header_rows.iat[row, col]) for row in range(header_rows.shape[0])]
        joined = " ".join(labels)
        if all(keyword in joined for keyword in keywords):
            return col
    return None


def main():
    input_path = Path(CONFIG["inputExcel"])
    if not input_path.exists():
        raise FileNotFoundError(input_path)

    raw = pd.read_excel(input_path, sheet_name=CONFIG["sourceSheet"], header=None, dtype=str)
    header_rows = raw.iloc[:2]
    nickname_col = find_column(header_rows, "账号昵称")
    red_id_col = find_column(header_rows, "小红书号")
    link_col = find_column(header_rows, "蒲公英链接")

    if nickname_col is None or red_id_col is None:
        raise RuntimeError("无法在前两行表头中定位账号昵称/小红书号列")

    creators = []
    for idx in range(2, len(raw)):
        nickname = clean(raw.iat[idx, nickname_col])
        red_id = clean(raw.iat[idx, red_id_col])
        pgy_link = clean(raw.iat[idx, link_col]) if link_col is not None else ""
        if not nickname and not red_id and not pgy_link:
            continue
        creators.append(
            {
                "rowIndex": idx + 1,
                "nickname": nickname,
                "redId": red_id,
                "pgyLink": pgy_link,
                "creatorId": "",
                "status": "pending",
                "matchMethod": "",
                "notes": ""
            }
        )

    output = ROOT / CONFIG["creatorsJson"]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(creators, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"extracted {len(creators)} creators -> {output}")
    for item in creators:
        print(f"- row {item['rowIndex']}: {item['nickname']} / {item['redId']}")


if __name__ == "__main__":
    main()
