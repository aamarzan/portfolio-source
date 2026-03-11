
from __future__ import annotations
import argparse
import json
from pathlib import Path
from datetime import datetime
import pandas as pd
from openpyxl import load_workbook

PREFERRED_SITE_ORDER = ["CMCH","SOMCH","SZMCH","RMCH","DMCH","PGIMER","SGRDUHS","GGSMCH"]
SITE_COUNTRY_MAP = {
    "CMCH":"Bangladesh",
    "SOMCH":"Bangladesh",
    "SZMCH":"Bangladesh",
    "RMCH":"Bangladesh",
    "DMCH":"Bangladesh",
    "PGIMER":"India",
    "SGRDUHS":"India",
    "GGSMCH":"India",
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
    ("2026-07-11", 1620.0, 474.0),
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
    ("2026-07-17", 81.0),
]

def normalize_site(code: str) -> str:
    code = (code or "").strip().upper()
    return {
        "SGRDUSH":"SGRDUHS",
        "GGSMC":"GGSMCH",
    }.get(code, code)

def load_master_dataframe(workbook_path: Path) -> pd.DataFrame:
    wb = load_workbook(workbook_path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    df = pd.DataFrame(rows, columns=headers)
    df = df[df["Patient ID"].notna()].copy()

    df["Date of Screening"] = pd.to_datetime(df["Date of Screening"], errors="coerce")
    df = df[df["Date of Screening"].notna()].copy()
    df["siteCode"] = df["Patient ID"].astype(str).str.extract(r"^([A-Za-z]+)")[0].map(normalize_site)

    for col in ["Patient Status", "Outcome (Died/ Survived)", "If excluded, reason", "True Positive?", "Comments"]:
        if col not in df.columns:
            df[col] = ""
        df[col] = df[col].fillna("").astype(str).str.strip()

    df["country"] = df["siteCode"].map(lambda x: SITE_COUNTRY_MAP.get(x, "Other"))
    df["patientStatusNorm"] = df["Patient Status"].str.strip().str.title()
    df["outcomeNorm"] = df["Outcome (Died/ Survived)"].str.strip().str.title()
    df["truePositiveNorm"] = df["True Positive?"].str.strip().str.title()
    df["isEnrolled"] = df["patientStatusNorm"].eq("Enrolled")
    df["isExcluded"] = df["patientStatusNorm"].eq("Excluded")
    df["isTruePositive"] = df["truePositiveNorm"].eq("Yes")
    df["isDiedEnrolled"] = df["isEnrolled"] & df["outcomeNorm"].eq("Died")
    return df

def site_order_from_df(df: pd.DataFrame) -> list[str]:
    present = [s for s in df["siteCode"].dropna().astype(str).unique().tolist() if s]
    ordered = [s for s in PREFERRED_SITE_ORDER if s in present]
    extras = sorted([s for s in present if s not in ordered])
    return ordered + extras

def make_payload(df: pd.DataFrame) -> dict:
    site_order = site_order_from_df(df)
    records = []
    for _, row in df.sort_values(["Date of Screening","Patient ID"]).iterrows():
        records.append({
            "patientId": str(row["Patient ID"]),
            "siteCode": str(row["siteCode"]),
            "country": str(row["country"]),
            "screeningDate": row["Date of Screening"].date().isoformat(),
            "screeningMonth": row["Date of Screening"].strftime("%b %Y"),
            "baseDeficit": None if pd.isna(row.get("Base Deficit Value")) else row.get("Base Deficit Value"),
            "patientStatus": row["patientStatusNorm"] or "Not specified",
            "outcome": row["outcomeNorm"] or "Not specified",
            "truePositive": "Yes" if row["isTruePositive"] else "No",
            "excludedReason": row["If excluded, reason"] or "Not specified",
            "comment": row["Comments"] or "",
            "isEnrolled": bool(row["isEnrolled"]),
            "isExcluded": bool(row["isExcluded"]),
            "isDiedEnrolled": bool(row["isDiedEnrolled"]),
            "isTruePositive": bool(row["isTruePositive"]),
        })

    payload = {
        "meta": {
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "sourceWorkbook": "private/master_data.xlsx",
            "pageTitle": "NIHR RIGHT4 Methanol Dashboard",
            "pageSubtitle": "Operational recruitment, screening, and true-positive monitoring synced from the master workbook.",
        },
        "config": {
            "siteOrder": site_order,
            "siteMeta": {code: {"label": code, "country": SITE_COUNTRY_MAP.get(code, "Other")} for code in site_order},
            "targetSchedule": {
                "dates": [d for d, _, _ in TARGET_SCHEDULE],
                "targetPatients": [float(t) for _, t, _ in TARGET_SCHEDULE],
                "calculatedTarget": [float(c) for _, _, c in TARGET_SCHEDULE],
            },
            "truePositiveTargetSchedule": {
                "dates": [d for d, _ in TRUE_POSITIVE_TARGET_SCHEDULE],
                "targetPositive": [float(t) for _, t in TRUE_POSITIVE_TARGET_SCHEDULE],
            },
        },
        "records": records,
    }
    return payload

def write_outputs(payload: dict, js_path: Path, json_path: Path):
    json_text = json.dumps(payload, indent=2, ensure_ascii=False)
    js_text = f"window.RIGHT4_DASHBOARD_DATA = {json_text};\n"
    js_path.write_text(js_text, encoding="utf-8")
    json_path.write_text(json_text, encoding="utf-8")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="")
    parser.add_argument("--workbook", default="private/master_data.xlsx")
    parser.add_argument("--js-out", default="right4-dashboard-data.js")
    parser.add_argument("--json-out", default="right4-dashboard-data.json")
    args = parser.parse_args()

    workbook_path = Path(args.workbook)
    df = load_master_dataframe(workbook_path)
    payload = make_payload(df)
    write_outputs(payload, Path(args.js_out), Path(args.json_out))
    print(f"Generated {len(payload['records'])} records across {len(payload['config']['siteOrder'])} sites.")

if __name__ == "__main__":
    main()
