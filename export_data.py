"""
export_data.py — pulls trades.db into a clean, tidy CSV for Tableau.
Re-run any time to refresh the export with the latest trades.
"""

import sqlite3
import pandas as pd

SOURCE_DB = r"C:\Users\Owner\Desktop\trading-agent\trades.db"
OUT_PATH = r"C:\Users\Owner\Desktop\trading_agent_dashboard\data\trades_export.csv"
STARTING_CAPITAL = 5000.0


def categorize_exit(reason: str) -> str:
    if pd.isna(reason) or not reason:
        return "open"
    r = reason.lower()
    if r == "hard_stop" or "hard exit" in r or ("hard stop" in r and "near" not in r and "approaching" not in r):
        return "Hard Stop"
    if r == "striker_stop" or "striker stop" in r:
        return "Striker Stop"
    if "atr stop" in r:
        return "ATR Stop"
    if r in ("hard_take_profit", "striker_take_profit") or "tp1" in r or "take profit" in r or "trim" in r or "lock" in r:
        return "Take Profit"
    if "eod" in r or "end of day" in r:
        return "EOD Close"
    if r == "contra_signal" or "contra-signal" in r or "contra signal" in r:
        return "Contra-Signal"
    if r == "liquidation":
        return "Liquidation"
    if "theta" in r:
        return "Theta Risk"
    if "near hard stop" in r or "approaching hard stop" in r or "pre-emptive" in r:
        return "Preemptive Exit"
    return "Other"


def dte_bucket(dte, trade_type=None) -> str:
    if pd.isna(dte):
        return "Equity" if trade_type == "equity" else "Unknown"
    dte = float(dte)
    if dte <= 3:
        return "0-3 DTE"
    if dte <= 7:
        return "4-7 DTE"
    if dte <= 14:
        return "8-14 DTE"
    return "15+ DTE"


def main():
    conn = sqlite3.connect(SOURCE_DB)
    df = pd.read_sql_query("SELECT * FROM trades ORDER BY entry_time", conn)
    conn.close()

    df["entry_time"] = pd.to_datetime(df["entry_time"])
    df["exit_time"] = pd.to_datetime(df["exit_time"])

    df["is_closed"] = df["status"] == "closed"
    df["win"] = (df["pnl"] > 0).astype(object)
    df.loc[~df["is_closed"], "win"] = pd.NA

    df["exit_category"] = df["exit_reason"].apply(categorize_exit)
    df.loc[~df["is_closed"], "exit_category"] = "Open"

    df["dte_bucket"] = df.apply(lambda row: dte_bucket(row["dte_at_entry"], row["trade_type"]), axis=1)

    df["hold_type"] = pd.NA
    closed = df["is_closed"]
    same_day = df["entry_time"].dt.date == df["exit_time"].dt.date
    df.loc[closed & same_day, "hold_type"] = "Same Day"
    df.loc[closed & ~same_day, "hold_type"] = "Overnight"

    df["entry_date"] = df["entry_time"].dt.date
    df["exit_date"] = df["exit_time"].dt.date
    df["entry_hour"] = df["entry_time"].dt.hour
    df["entry_day_of_week"] = df["entry_time"].dt.day_name()

    df["hold_minutes"] = (df["exit_time"] - df["entry_time"]).dt.total_seconds() / 60

    # Running P&L / equity curve, computed over closed trades only, in exit order
    closed_df = df[df["is_closed"]].sort_values("exit_time").copy()
    closed_df["trade_number"] = range(1, len(closed_df) + 1)
    closed_df["cumulative_pnl"] = closed_df["pnl"].cumsum()
    closed_df["capital_after"] = STARTING_CAPITAL + closed_df["cumulative_pnl"]
    df = df.merge(
        closed_df[["id", "trade_number", "cumulative_pnl", "capital_after"]],
        on="id", how="left",
    )

    # Parse indicators_triggered JSON list into a readable comma-joined string
    def join_indicators(val):
        if not val:
            return ""
        try:
            import json
            items = json.loads(val)
            return "; ".join(items)
        except Exception:
            return str(val)

    df["indicators_triggered_readable"] = df["indicators_triggered"].apply(join_indicators)

    df.to_csv(OUT_PATH, index=False)
    print(f"Wrote {len(df)} rows ({df['is_closed'].sum()} closed) to {OUT_PATH}")
    print(f"Columns: {list(df.columns)}")


if __name__ == "__main__":
    main()
