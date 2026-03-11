
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from datetime import datetime, date
import pandas as pd
from openpyxl import load_workbook

SITE_ORDER = ["CMCH","SOMCH","SZMCH","RMCH","DMCH","PGIMER","SGRDUHS","GGSMCH"]
SITE_META = {
    "CMCH":{"label":"CMCH","country":"Bangladesh"},
    "SOMCH":{"label":"SOMCH","country":"Bangladesh"},
    "SZMCH":{"label":"SZMCH","country":"Bangladesh"},
    "RMCH":{"label":"RMCH","country":"Bangladesh"},
    "DMCH":{"label":"DMCH","country":"Bangladesh"},
    "PGIMER":{"label":"PGIMER","country":"India"},
    "SGRDUHS":{"label":"SGRDUHS","country":"India"},
    "GGSMCH":{"label":"GGSMCH","country":"India"},
}
TARGET_SCHEDULE = [
    ("2025-06-01", 0.0, 0.0),
    ("2025-06-16", 60.0, 18.2),
    ("2025-07-01", 120.0, 36.4),
    ("2025-07-16", 180.0, 54.6),
    ("2025-07-31", 240.0, 72.8),
    ("2025-08-15", 300.0, 91.0),
    ("2025-08-30", 360.0, 109.2),
    ("2025-09-15", 420.0, 127.4),
    ("2025-09-30", 480.0, 145.6),
    ("2025-10-15", 540.0, 163.8),
    ("2025-10-31", 610.0, 182.0),
    ("2025-11-15", 670.0, 200.2),
    ("2025-12-03", 740.0, 218.4),
    ("2025-12-16", 790.0, 236.6),
    ("2025-12-30", 850.0, 254.8),
    ("2026-01-14", 910.0, 273.0),
    ("2026-01-31", 975.0, 291.2),
    ("2026-02-15", 1040.0, 309.4),
    ("2026-03-10", 1135.0, 327.6),
    ("2026-03-28", 1200.0, 345.8),
    ("2026-04-12", 1260.0, 364.0),
    ("2026-04-27", 1320.0, 382.2),
    ("2026-05-12", 1380.0, 400.4),
    ("2026-05-27", 1440.0, 418.6),
    ("2026-06-11", 1500.0, 436.8),
    ("2026-06-26", 1560.0, 455.0),
    ("2026-07-11", 1620.0, 474.0)
]
TRUE_POSITIVE_TARGET_SCHEDULE = [
    ("2025-06-01", 0.0),
    ("2025-06-16", 3.0),
    ("2025-07-01", 6.0),
    ("2025-07-16", 9.0),
    ("2025-07-31", 12.0),
    ("2025-08-15", 15.0),
    ("2025-08-30", 18.0),
    ("2025-09-15", 21.0),
    ("2025-09-30", 24.0),
    ("2025-10-15", 27.0),
    ("2025-10-31", 30.0),
    ("2025-11-15", 33.0),
    ("2025-12-03", 36.5),
    ("2025-12-16", 39.0),
    ("2025-12-30", 42.0),
    ("2026-01-14", 45.0),
    ("2026-01-30", 48.0),
    ("2026-02-17", 51.5),
    ("2026-03-10", 55.7),
    ("2026-03-17", 57.0),
    ("2026-04-02", 60.0),
    ("2026-04-17", 63.0),
    ("2026-05-02", 66.0),
    ("2026-05-17", 69.0),
    ("2026-06-02", 72.0),
    ("2026-06-17", 75.0),
    ("2026-07-02", 78.0),
    ("2026-07-17", 81.0)
]

def normalize_site(code: str) -> str:
    code = (code or "").strip().upper()
    return {"SGRDUSH":"SGRDUHS","GGSMC":"GGSMCH"}.get(code, code)

def load_master_dataframe(workbook_path: Path) -> pd.DataFrame:
    wb = load_workbook(workbook_path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    df = pd.DataFrame(rows, columns=headers)
    df = df[df["Patient ID"].notna()].copy()

    df["Date of Screening"] = pd.to_datetime(df["Date of Screening"])
    df["siteCode"] = (
        df["Patient ID"].astype(str).str.extract(r"^([A-Za-z]+)")[0].str.upper().map(normalize_site)
    )

    for col in ["Patient Status", "Outcome (Died/ Survived)", "If excluded, reason", "True Positive?", "Comments"]:
        if col in df.columns:
            df[col] = df[col].fillna("").astype(str).str.strip()

    df["isEnrolled"] = df["Patient Status"].str.lower().eq("enrolled")
    df["isExcluded"] = df["Patient Status"].str.lower().eq("excluded")
    df["isDiedEnrolled"] = df["Outcome (Died/ Survived)"].str.lower().eq("died") & df["isEnrolled"]
    df["isTruePositive"] = df["True Positive?"].str.lower().eq("yes")
    return df

def make_site_table(df: pd.DataFrame) -> list[dict]:
    rows = []
    for code in SITE_ORDER:
        sdf = df[df["siteCode"] == code]
        rows.append({
            "siteCode": code,
            "siteLabel": SITE_META[code]["label"],
            "country": SITE_META[code]["country"],
            "screened": int(len(sdf)),
            "recruited": int(sdf["isEnrolled"].sum()),
            "excluded": int(sdf["isExcluded"].sum()),
            "diedEnrolled": int(sdf["isDiedEnrolled"].sum()),
        })
    rows.append({
        "siteCode": "TOTAL",
        "siteLabel": "Total",
        "country": "",
        "screened": int(len(df)),
        "recruited": int(df["isEnrolled"].sum()),
        "excluded": int(df["isExcluded"].sum()),
        "diedEnrolled": int(df["isDiedEnrolled"].sum()),
    })
    return rows

def count_upto(df: pd.DataFrame, cutoff: str, mask_col: str) -> int:
    cutoff_ts = pd.Timestamp(cutoff)
    return int((df[mask_col] & (df["Date of Screening"].dt.normalize() <= cutoff_ts)).sum())

def sanitize(obj):
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    if isinstance(obj, tuple):
        return [sanitize(v) for v in obj]
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    if hasattr(obj, "item"):
        try:
            return obj.item()
        except Exception:
            pass
    return obj

def build_payload(df: pd.DataFrame) -> dict:
    today = pd.Timestamp(date.today())
    last14_start = today - pd.Timedelta(days=13)
    last30_start = today - pd.Timedelta(days=29)

    last14_mask = df["Date of Screening"].dt.normalize().between(last14_start.normalize(), today.normalize())
    last30_mask = df["Date of Screening"].dt.normalize().between(last30_start.normalize(), today.normalize())

    bangladesh_sites = {"CMCH", "SOMCH", "SZMCH", "RMCH", "DMCH"}
    india_sites = {"PGIMER", "SGRDUHS", "GGSMCH"}

    summary = {
        "lastUpdate": datetime.now().strftime("%d %b %Y, %I:%M %p"),
        "totalScreened": int(len(df)),
        "totalRecruited": int(df["isEnrolled"].sum()),
        "totalExcluded": int(df["isExcluded"].sum()),
        "totalDiedEnrolled": int(df["isDiedEnrolled"].sum()),
        "totalTruePositive": int(df["isTruePositive"].sum()),
        "truePositiveVsTargetPct": (df["isTruePositive"].sum() / max(TRUE_POSITIVE_TARGET_SCHEDULE[-1][1], 1)) * 100,
        "overallPositivePct": (df["isTruePositive"].sum() / max(int(df["isEnrolled"].sum()), 1)) * 100,
        "countryEnrollment": {
            "Bangladesh": int(df[df["siteCode"].isin(bangladesh_sites)]["isEnrolled"].sum()),
            "India": int(df[df["siteCode"].isin(india_sites)]["isEnrolled"].sum()),
        },
        "classification": {
            "True Positive": int(df["isTruePositive"].sum()),
            "Other Recruited": int(df["isEnrolled"].sum() - df["isTruePositive"].sum()),
        },
    }

    start_date = df["Date of Screening"].min().normalize()
    date_index = pd.date_range(start_date, today.normalize(), freq="D")
    daily_df = pd.DataFrame(index=date_index)

    for code in SITE_ORDER:
        counts = (
            df[(df["isEnrolled"]) & (df["siteCode"] == code)]
            .groupby(df["Date of Screening"].dt.normalize())
            .size()
        )
        daily_df[code] = counts.reindex(date_index, fill_value=0).cumsum()

    daily_df["TOTAL"] = daily_df.sum(axis=1)
    daily_cumulative = {
        "dates": [d.date().isoformat() for d in daily_df.index],
        "series": {code: daily_df[code].astype(int).tolist() for code in SITE_ORDER + ["TOTAL"]},
    }

    enrolled = df[df["isEnrolled"]].copy()
    enrolled["month"] = enrolled["Date of Screening"].dt.to_period("M").dt.to_timestamp()
    month_index = pd.period_range(
        start=df["Date of Screening"].min().to_period("M"),
        end=today.to_period("M"),
        freq="M",
    ).to_timestamp()
    monthly = {
        "months": [m.date().isoformat() for m in month_index],
        "labels": [m.strftime("%b %Y") for m in month_index],
        "series": {},
    }
    for code in SITE_ORDER:
        monthly["series"][code] = [
            int(((enrolled["siteCode"] == code) & (enrolled["month"] == m)).sum())
            for m in month_index
        ]
    monthly["series"]["TOTAL"] = [
        sum(monthly["series"][code][idx] for code in SITE_ORDER)
        for idx in range(len(month_index))
    ]

    target_vs_actual = {
        "dates": [d for d, _, _ in TARGET_SCHEDULE],
        "targetPatients": [t for _, t, _ in TARGET_SCHEDULE],
        "calculatedTarget": [c for _, _, c in TARGET_SCHEDULE],
        "actualPatients": [count_upto(df, d, "isEnrolled") for d, _, _ in TARGET_SCHEDULE],
    }

    positive_vs_target = {
        "dates": [d for d, _ in TRUE_POSITIVE_TARGET_SCHEDULE],
        "targetPositive": [t for _, t in TRUE_POSITIVE_TARGET_SCHEDULE],
        "actualPositive": [count_upto(df, d, "isTruePositive") for d, _ in TRUE_POSITIVE_TARGET_SCHEDULE],
    }

    exclusion_reason_counts = (
        df[df["isExcluded"]]["If excluded, reason"].replace("", "Not specified").value_counts()
    )
    exclusion_reasons = [
        {"reason": reason, "count": int(count)}
        for reason, count in exclusion_reason_counts.head(8).items()
    ]

    recent_df = df.sort_values(["Date of Screening", "Patient ID"], ascending=[False, False]).head(12)
    recent_rows = []
    for _, row in recent_df.iterrows():
        recent_rows.append({
            "patientId": row["Patient ID"],
            "siteCode": row["siteCode"],
            "screeningDate": row["Date of Screening"].date().isoformat() if pd.notna(row["Date of Screening"]) else "",
            "baseDeficit": "" if pd.isna(row["Base Deficit Value"]) else str(row["Base Deficit Value"]),
            "patientStatus": row["Patient Status"],
            "outcome": row["Outcome (Died/ Survived)"],
            "truePositive": "Yes" if row["isTruePositive"] else "No",
            "comment": row["Comments"],
        })

    payload = {
        "meta": {
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "sourceWorkbook": "private/master_data.xlsx",
            "pageTitle": "NIHR RIGHT4 Methanol Dashboard",
            "pageSubtitle": "Operational recruitment, screening, and true-positive monitoring synced from the master workbook.",
        },
        "summary": summary,
        "siteTables": {
            "totalCases": make_site_table(df),
            "last14Days": make_site_table(df[last14_mask]),
            "last30Days": make_site_table(df[last30_mask]),
        },
        "charts": {
            "dailyCumulative": daily_cumulative,
            "monthlyRecruitment": monthly,
            "targetVsActual": target_vs_actual,
            "positiveVsTarget": positive_vs_target,
            "exclusionReasons": exclusion_reasons,
        },
        "recentRecords": recent_rows,
    }
    return sanitize(payload)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    workbook_path = repo_root / "private" / "master_data.xlsx"
    index_path = repo_root / "right4-dashboard" / "index.html"
    data_js_path = repo_root / "right4-dashboard-data.js"
    data_json_path = repo_root / "right4-dashboard-data.json"

    if not workbook_path.exists():
        raise FileNotFoundError(f"Workbook not found: {workbook_path}")

    df = load_master_dataframe(workbook_path)
    payload = build_payload(df)

    data_js_path.write_text("window.RIGHT4_DASHBOARD_DATA = " + json.dumps(payload, indent=2, ensure_ascii=False) + ";\n", encoding="utf-8")
    data_json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    if index_path.exists():
        html = index_path.read_text(encoding="utf-8")
        html = re.sub(r"(right4-dashboard\.css\?v=)([^\"']+)", rf"\g<1>{args.version}", html)
        html = re.sub(r"(right4-dashboard-data\.js\?v=)([^\"']+)", rf"\g<1>{args.version}", html)
        html = re.sub(r"(right4-dashboard\.js\?v=)([^\"']+)", rf"\g<1>{args.version}", html)
        index_path.write_text(html, encoding="utf-8")

    print(f"Workbook rows: {len(df)}")
    print(f"Total screened: {payload['summary']['totalScreened']}")
    print(f"Total recruited: {payload['summary']['totalRecruited']}")
    print(f"Total true positive: {payload['summary']['totalTruePositive']}")
    print(f"Last updated: {payload['summary']['lastUpdate']}")

if __name__ == "__main__":
    main()
