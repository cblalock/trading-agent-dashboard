"""
export_web_data.py — pulls trades.db into web/data.json for the custom web dashboard.
Re-run any time (conda env `trading`) to refresh the data before publishing.
Sibling to export_data.py (which feeds the Tableau version) — same derived
columns, different output shape (JSON tailored for the web page's charts).
"""

import json
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd

SOURCE_DB = r"C:\Users\Owner\Desktop\trading-agent\trades.db"
OUT_PATH = r"C:\Users\Owner\Desktop\trading_agent_dashboard\docs\data.json"
STARTING_CAPITAL = 5000.0
ET = ZoneInfo("America/New_York")

DTE_ORDER = ["0-3 DTE", "4-7 DTE", "8-14 DTE", "15+ DTE", "Equity", "Unknown"]
TOD_ORDER = ["Open (9:30-10ET)", "Morning (10-11ET)", "Midday (11-1ET)", "Afternoon (1-3ET)", "Close (3-4ET)", "Unknown"]
EXIT_CATEGORY_ORDER = [
    "Take Profit", "Hard Stop", "Striker Stop", "EOD Close", "Friday Close",
    "Contra-Signal (15m RSI)", "Contra-Signal (Other)", "Momentum Fade",
    "Theta Risk", "Preemptive Exit", "Liquidation", "Other", "Open",
]

# Maps the structured exit_category written by journal.py (agent.py tags it at
# close time via a required tool-call enum; main.py's mechanical closers pass
# their own code directly — see journal.MECHANICAL_EXIT_CATEGORIES /
# CLAUDE_EXIT_CATEGORIES) to the display label used on the chart. Added
# 2026-08-12 to replace the old regex-guess-from-exit_reason-text approach,
# which couldn't reliably tell a 15m RSI contra-signal from any other kind.
EXIT_CATEGORY_LABELS = {
    "hard_stop": "Hard Stop",
    "hard_take_profit": "Take Profit",
    "striker_stop": "Striker Stop",
    "striker_take_profit": "Take Profit",
    "friday_short_fuse_close": "Friday Close",
    "liquidation": "Liquidation",
    "eod_close": "EOD Close",
    "take_profit": "Take Profit",
    "contra_signal_15m_rsi": "Contra-Signal (15m RSI)",
    "contra_signal_other": "Contra-Signal (Other)",
    "momentum_fade": "Momentum Fade",
    "theta_decay": "Theta Risk",
    "near_stop_preemptive": "Preemptive Exit",
    "other": "Other",
}


def categorize_exit_legacy(reason: str) -> str:
    """Regex-guess fallback for any row that somehow has no structured
    exit_category (shouldn't happen post-2026-08-12 backfill, but kept as a
    safety net rather than dropping rows from the chart)."""
    if pd.isna(reason) or not reason:
        return "Other"
    r = reason.lower()
    if r == "hard_stop" or "hard exit" in r or ("hard stop" in r and "near" not in r and "approaching" not in r):
        return "Hard Stop"
    if r == "striker_stop" or "striker stop" in r:
        return "Striker Stop"
    if "atr stop" in r:
        return "Preemptive Exit"
    if r in ("hard_take_profit", "striker_take_profit") or r.startswith("tp") or "take profit" in r or "trim" in r or "lock" in r:
        return "Take Profit"
    if "eod" in r or "end of day" in r:
        return "EOD Close"
    if "15m" in r and "rsi" in r and ("contra" in r or "opposin" in r or "oppose" in r):
        return "Contra-Signal (15m RSI)"
    if r == "contra_signal" or "contra-signal" in r or "contra signal" in r or "contradic" in r:
        return "Contra-Signal (Other)"
    if r == "liquidation":
        return "Liquidation"
    if "theta" in r:
        return "Theta Risk"
    if "near hard stop" in r or "approaching hard stop" in r or "pre-emptive" in r:
        return "Preemptive Exit"
    if "momentum" in r:
        return "Momentum Fade"
    return "Other"


def categorize_exit(exit_category: str, reason: str) -> str:
    if pd.notna(exit_category) and exit_category in EXIT_CATEGORY_LABELS:
        return EXIT_CATEGORY_LABELS[exit_category]
    return categorize_exit_legacy(reason)


def tod_bucket(entry_time_utc) -> str:
    """entry_time_utc: naive UTC timestamp (trades.db stores entry_time in UTC, no offset)."""
    if pd.isna(entry_time_utc):
        return "Unknown"
    et = entry_time_utc.tz_localize("UTC").tz_convert(ET)
    minutes = et.hour * 60 + et.minute
    if minutes < 10 * 60:
        return "Open (9:30-10ET)"
    if minutes < 11 * 60:
        return "Morning (10-11ET)"
    if minutes < 13 * 60:
        return "Midday (11-1ET)"
    if minutes < 15 * 60:
        return "Afternoon (1-3ET)"
    return "Close (3-4ET)"


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


def join_indicators(val):
    if not val:
        return ""
    try:
        items = json.loads(val)
        return "; ".join(items)
    except Exception:
        return str(val)


def clean_records(df: pd.DataFrame) -> list:
    """Convert a DataFrame to JSON-safe records (NaT/NaN -> None)."""
    return json.loads(df.to_json(orient="records", date_format="iso"))


def main():
    conn = sqlite3.connect(SOURCE_DB)
    df = pd.read_sql_query("SELECT * FROM trades ORDER BY entry_time", conn)
    conn.close()

    df["entry_time"] = pd.to_datetime(df["entry_time"])
    df["exit_time"] = pd.to_datetime(df["exit_time"])

    df["is_closed"] = df["status"] == "closed"
    df["win"] = (df["pnl"] > 0).astype(object)
    df.loc[~df["is_closed"], "win"] = None

    df["exit_category_label"] = df.apply(
        lambda row: categorize_exit(row.get("exit_category"), row["exit_reason"]), axis=1
    )
    df.loc[~df["is_closed"], "exit_category_label"] = "Open"

    df["dte_bucket"] = df.apply(lambda row: dte_bucket(row["dte_at_entry"], row["trade_type"]), axis=1)
    df["tod_bucket"] = df["entry_time"].apply(tod_bucket)

    df["hold_type"] = None
    closed = df["is_closed"]
    same_day = df["entry_time"].dt.date == df["exit_time"].dt.date
    df.loc[closed & same_day, "hold_type"] = "Same Day"
    df.loc[closed & ~same_day, "hold_type"] = "Overnight"

    df["entry_date"] = df["entry_time"].dt.date.astype(str)
    df["indicators_triggered_readable"] = df["indicators_triggered"].apply(join_indicators)

    # --- Equity curve (closed trades only, in exit order) ---
    closed_df = df[df["is_closed"]].sort_values("exit_time").copy()
    closed_df["trade_number"] = range(1, len(closed_df) + 1)
    closed_df["cumulative_pnl"] = closed_df["pnl"].cumsum()
    closed_df["capital_after"] = STARTING_CAPITAL + closed_df["cumulative_pnl"]
    df = df.merge(
        closed_df[["id", "trade_number", "cumulative_pnl", "capital_after"]],
        on="id", how="left",
    )
    closed_df = closed_df.merge(
        df[["id", "trade_number", "cumulative_pnl", "capital_after"]].dropna(subset=["trade_number"]),
        on=["id", "trade_number", "cumulative_pnl", "capital_after"], how="left",
    )

    equity_curve = clean_records(
        closed_df[["trade_number", "exit_time", "ticker", "pnl", "cumulative_pnl", "capital_after"]]
    )

    # --- KPI tiles ---
    total_pnl = float(closed_df["pnl"].sum())
    total_trades = int(len(closed_df))
    wins = int((closed_df["pnl"] > 0).sum())
    win_rate = (wins / total_trades) if total_trades else None
    current_capital = STARTING_CAPITAL + total_pnl

    kpis = {
        "total_pnl": total_pnl,
        "win_rate": win_rate,
        "total_trades": total_trades,
        "current_capital": current_capital,
        "starting_capital": STARTING_CAPITAL,
        "wins": wins,
        "losses": total_trades - wins,
    }

    # --- Exit category breakdown ---
    exit_group = closed_df.groupby("exit_category_label")["pnl"].agg(["sum", "mean", "count"]).reset_index()
    exit_group.columns = ["exit_category", "total_pnl", "avg_pnl", "count"]
    exit_group["pct_of_exits"] = (exit_group["count"] / len(closed_df) * 100).round(1)
    exit_group["order"] = exit_group["exit_category"].apply(
        lambda c: EXIT_CATEGORY_ORDER.index(c) if c in EXIT_CATEGORY_ORDER else len(EXIT_CATEGORY_ORDER)
    )
    exit_group = exit_group.sort_values("order").drop(columns="order")
    exit_breakdown = clean_records(exit_group)

    # --- DTE bucket breakdown ---
    dte_group = closed_df.groupby("dte_bucket").agg(
        count=("pnl", "count"),
        avg_pnl=("pnl", "mean"),
        total_pnl=("pnl", "sum"),
        win_rate=("win", lambda s: float(s.mean()) if s.notna().any() else None),
    ).reset_index()
    dte_group["order"] = dte_group["dte_bucket"].apply(
        lambda c: DTE_ORDER.index(c) if c in DTE_ORDER else len(DTE_ORDER)
    )
    dte_group = dte_group.sort_values("order").drop(columns="order")
    dte_breakdown = clean_records(dte_group)

    # --- Entry time-of-day breakdown ---
    tod_group = closed_df.groupby("tod_bucket").agg(
        count=("pnl", "count"),
        avg_pnl=("pnl", "mean"),
        total_pnl=("pnl", "sum"),
        win_rate=("win", lambda s: float(s.mean()) if s.notna().any() else None),
    ).reset_index()
    tod_group["order"] = tod_group["tod_bucket"].apply(
        lambda c: TOD_ORDER.index(c) if c in TOD_ORDER else len(TOD_ORDER)
    )
    tod_group = tod_group.sort_values("order").drop(columns="order")
    tod_breakdown = clean_records(tod_group)

    # --- Scanner case study: daily aggregates around the min_strength changes ---
    daily = closed_df.groupby("entry_date").agg(
        count=("pnl", "count"),
        total_pnl=("pnl", "sum"),
        avg_pnl=("pnl", "mean"),
        win_rate=("win", lambda s: float(s.mean()) if s.notna().any() else None),
    ).reset_index()
    daily = daily.sort_values("entry_date")
    daily_performance = clean_records(daily)

    scanner_events = [
        {"date": "2026-07-20", "label": "min_strength 4\u21923 (unlock indicators)"},
        {"date": "2026-07-24", "label": "reverted \u21924 (-$750.50 Fri)"},
        {"date": "2026-08-10", "label": "15m entries blocked (proven-negative timeframe)"},
    ]

    # --- Full trade log ---
    # exit_category here is the display label (exit_category_label renamed on
    # output) — app.js keys its color map / filter dropdown off this field, not
    # the raw machine code from the DB (which is also present, unrenamed, as
    # the source column would collide, so it's dropped from this view; the raw
    # code is available in trades.db directly if ever needed).
    trade_log_cols = [
        "id", "ticker", "side", "trade_type", "option_type", "strike_price",
        "expiration_date", "entry_time", "exit_time", "entry_price", "exit_price",
        "qty", "pnl", "win", "status", "exit_category_label", "dte_at_entry", "dte_bucket",
        "hold_type", "tod_bucket", "signal_strength", "signal_timeframe",
        "indicators_triggered_readable", "entry_reason", "exit_reason", "claude_reasoning",
    ]
    trades = clean_records(
        df[trade_log_cols]
        .rename(columns={"exit_category_label": "exit_category"})
        .sort_values("entry_time", ascending=False)
    )

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kpis": kpis,
        "equity_curve": equity_curve,
        "exit_breakdown": exit_breakdown,
        "dte_breakdown": dte_breakdown,
        "tod_breakdown": tod_breakdown,
        "daily_performance": daily_performance,
        "scanner_events": scanner_events,
        "trades": trades,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {len(trades)} trades ({total_trades} closed) to {OUT_PATH}")


if __name__ == "__main__":
    main()
