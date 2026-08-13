"""
export_web_data.py — pulls trades.db into web/data.json for the custom web dashboard.
Re-run any time (conda env `trading`) to refresh the data before publishing.
Sibling to export_data.py (which feeds the Tableau version) — same derived
columns, different output shape (JSON tailored for the web page's charts).
"""

import glob
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd

SOURCE_DB = r"C:\Users\Owner\Desktop\trading-agent\trades.db"
LOGS_DIR = r"C:\Users\Owner\Desktop\trading-agent\logs"
OUT_PATH = r"C:\Users\Owner\Desktop\trading_agent_dashboard\docs\data.json"
STARTING_CAPITAL = 5000.0
ET = ZoneInfo("America/New_York")
DAILY_BUDGET_USD = 2.00  # mirrors agent.DAILY_BUDGET_USD — kept in sync manually, not imported
CAP_LINE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),\d+ \[\w+\].*budget cap.*reached", re.IGNORECASE)
LOG_FILENAME_RE = re.compile(r"trading_agent_(\d{4}-\d{2}-\d{2})\.log$")

DTE_ORDER = ["0-3 DTE", "4-7 DTE", "8-14 DTE", "15+ DTE", "Equity", "Unknown"]
TOD_ORDER = ["Open (9:30-10ET)", "Morning (10-11ET)", "Midday (11-1ET)", "Afternoon (1-3ET)", "Close (3-4ET)", "Unknown"]
EXIT_CATEGORY_ORDER = [
    "Take Profit", "Hard Stop", "Striker Stop", "EOD Close", "Friday Close",
    "Contra-Signal (15m RSI)", "Contra-Signal (Other)", "Momentum Fade",
    "Theta Risk", "Preemptive Exit", "Liquidation", "Other", "Open",
]

# Curated, hand-maintained — each entry is a real dated intervention pulled
# from project history. Not derived from trades.db (some of these, like the
# re-entry cooldown, don't have a clean isolated before/after metric), so this
# has to be updated by hand when something new ships. Status values: confirmed
# (verified against live data after shipping), watching (live, not enough
# data yet), needs_revisit (shipped but not clearly working), shipped (too
# structural/one-off to have a "did it work" test).
CHANGELOG = [
    {
        "date": "2026-07-09", "status": "watching",
        "title": "Re-entry cooldown / awareness fix",
        "problem": "Two same-ticker chase-and-lose incidents (QQQ 7/8, TSLA 7/9) — re-entering a name right after it stopped out, on a thesis that wasn't materially different.",
        "change": "Every cycle now surfaces recently-closed trades (last 2h) in the prompt with an explicit “do NOT re-enter without a materially different thesis” rule.",
        "result": "Advisory, not a hard block. No third recurrence observed since, but small n — still watching.",
    },
    {
        "date": "2026-07-13", "status": "confirmed",
        "title": "Friday DTE barbell",
        "problem": "QQQ ×2 + TSLA opened Friday 7/10 at ~3 DTE, gapped over the weekend, hard-stopped at Monday's open — −$955.50 combined.",
        "change": "A budget-independent safety net force-closes any position with 1–4 calendar days to expiry in the last 40 minutes of a Friday session. 0 DTE and 5+ DTE are both left alone — the danger zone is specifically the middle.",
        "result": "Confirmed 7/17: all 8 Friday entries that day were 0 DTE, zero landed in the 1–4 DTE middle zone.",
    },
    {
        "date": "2026-07-14", "status": "confirmed",
        "title": "DTE-aware hard-stop tightening",
        "problem": "Hard stops were the single largest realized-loss category to date — 12 trades, −$3,074.50 total, avg −$256/trade.",
        "change": "The mandatory stop tightens from −50% to −35% once a normal trade has ≤3 calendar days left to expiry.",
        "result": "First live firing 7/29 (TSLA put, −38% vs. −35% target), repeated 7/30 (MSFT call, −37%) — small, consistent overshoot, looks stable.",
    },
    {
        "date": "2026-07-14", "status": "needs_revisit",
        "title": "Striker mode (fast in/out scalps)",
        "problem": "Paying for a tighter Claude cycle cadence wouldn't actually buy “strike fast” — a free mechanical poller already reacts faster than any affordable LLM cadence.",
        "change": "A new trade style with mechanically-enforced quick take-profit/stop percentages, polled every 30s independent of the API budget.",
        "result": "Thresholds drifted to 30%/40% by late July (−$774 over 24 trades) before getting hard-capped at 12%/15% on 7/28. Cumulative performance still lags normal trades — the founding “speed edge” thesis hasn't shown up in the data yet.",
    },
    {
        "date": "2026-07-16", "status": "confirmed",
        "title": "Put-bias fix",
        "problem": "The agent was citing a thin put sample (n=2) as a blanket reason to skip bearish setups, even on strong strength-4/5 confirmations.",
        "change": "Updated the entry rules so a low-n stat is a mild tiebreaker, not a veto, over a genuinely strong live setup.",
        "result": "Confirmed 7/17: 8 of 9 trades that day were puts off strength 4–5 bearish confirmations, no put-veto language observed.",
    },
    {
        "date": "2026-07-24", "status": "confirmed",
        "title": "Confirmation-signal gate",
        "problem": "A −$750.50 Friday came from entries with individually clean-looking signals that were quietly contradicted by another timeframe.",
        "change": "Reverted the scanner's min_strength 3→4, and hard-coded a block — not just prompt guidance — on any entry with an opposing lower-tier signal.",
        "result": "Confirmed live 7/27: fired constantly, 10–24 candidates blocked per cycle, cited explicitly in the agent's own cycle summaries all day.",
    },
    {
        "date": "2026-07-24", "status": "confirmed",
        "title": "Concentration guard",
        "problem": "Same incident as above — several individually-clean entries turned out to be one correlated directional bet stacked three deep.",
        "change": "Hard-blocks a 3rd+ same-direction entry across the watchlist within a 1.5h window.",
        "result": "Confirmed live 7/27: blocked SPY/QQQ 3rd-bearish attempts after NVDA+TSLA and NVDA+AMZN bearish pairs were already on, no false positives on the bullish side.",
    },
    {
        "date": "2026-07-24", "status": "shipped",
        "title": "Watchlist diversification",
        "problem": "AMD (1 trade ever, unused) and IWM (−$875.10/5 trades, 20% WR, redundant with SPY/QQQ) were dead weight on the watchlist.",
        "change": "Dropped AMD and IWM, added XOM (energy) and JPM (financials).",
        "result": "Gives the new concentration guard genuinely uncorrelated names to route to instead of just a cap on one correlated bloc.",
    },
    {
        "date": "2026-07-29", "status": "watching",
        "title": "Opening-bell entry caution",
        "problem": "First-30-minutes-after-open entries averaged −$71.68 (n=32, the largest single bucket) vs. +$25.89 an hour later (n=23).",
        "change": "Soft prompt guidance to raise the bar — prefer waiting until 10am ET — for strength-4 entries specifically.",
        "result": "Not yet cleanly isolated in the data since shipping. Still watching.",
    },
    {
        "date": "2026-08-10", "status": "confirmed",
        "title": "15-minute timeframe entry block",
        "problem": "The 15-Minute (Day Trade) signal timeframe was a clear, large-sample loser: −26.13 avg/58 trades, 36% WR all-time.",
        "change": "15m signals scoring strength≥4 get demoted out of tradeable candidates into confirmation-only context before Claude ever sees them as an entry option, with a hard-block backstop.",
        "result": "Live since 8/10. Still useful as contra-signal context on open positions — which is exactly what fed the 8/12 finding below.",
    },
    {
        "date": "2026-08-12", "status": "confirmed",
        "title": "Structured exit-category tagging",
        "problem": "No reliable data existed on *why* positions closed. 8/11 and 8/12 both saw 100% of that day's exits triggered by a 15m RSI contra-signal, but the dashboard could only regex-guess a category from freeform reasoning text.",
        "change": "close_option_trade now requires an explicit exit_category tag at the moment of the decision, not guessed after the fact. Backfilled all 123 historical trades.",
        "result": "Immediately surfaced something counterintuitive: a 15m-RSI contra-signal exit is the *cheapest* way to lose (−19.60 avg) — far better than riding to a full hard stop (−224.97 avg). Whether 8/11–8/12's 100% rate is a real market regime or a fluke is still open.",
    },
    {
        "date": "2026-08-13", "status": "shipped",
        "title": "Guardrail block-tracking + budget visibility",
        "problem": "The dashboard only ever showed what got traded, never what the guardrails actually stopped, and the $1–2/day API budget — a real, active design constraint — was invisible.",
        "change": "New structured logging every time a hard rule blocks an attempted trade, plus a daily spend-vs-cap chart built from existing usage records and parsed cap-out timestamps.",
        "result": "Just shipped. Budget trend has full history back to 6/30; blocked-candidate tracking starts fresh from here — no reliable data exists before this build.",
    },
]

# One unique color per entry (not per-status) so a tick on the scanner chart
# and its changelog card visually match 1:1. Chosen with the dataviz skill's
# validate_palette.js — best achievable at n=12: lightness/chroma/contrast all
# clear, but a couple of pairs still land under the CVD/normal-vision floors
# (structurally unavoidable much past ~3 colors for an all-pairs-matching use
# case — see references/color-formula.md). The "number" field is the
# guaranteed-unambiguous fallback for exactly those pairs.
CHANGELOG_COLORS = [
    "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300",
    "#9085e9", "#e66767", "#2a9dc9", "#ad7830", "#4a80bd", "#6f9330",
]
for _i, _entry in enumerate(CHANGELOG):
    _entry["color"] = CHANGELOG_COLORS[_i % len(CHANGELOG_COLORS)]
    _entry["number"] = _i + 1

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


def find_cap_out_times() -> dict:
    """Best-effort extraction of the first 'budget cap ... reached' timestamp
    per day from the daily log files (main.py doesn't persist this anywhere
    queryable — only logs it as text). Returns {date: 'HH:MM ET'} for days
    the non-EOD cap was actually hit; days without a match either never
    exhausted the budget or the log rotated before a match landed, and are
    left out rather than guessed."""
    cap_times = {}
    for path in glob.glob(os.path.join(LOGS_DIR, "trading_agent_*.log")):
        m = LOG_FILENAME_RE.search(os.path.basename(path))
        if not m:
            continue
        day = m.group(1)
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    lm = CAP_LINE_RE.match(line)
                    if lm:
                        cap_times[day] = lm.group(2)[:5]
                        break
        except OSError:
            continue
    return cap_times


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

    # scanner_events (the old 3-item min_strength-only annotation list) was
    # replaced 2026-08-13 \u2014 the scanner chart now draws a tick per CHANGELOG
    # entry instead, color-coded by status, so every dated intervention shows
    # up consistently rather than a hand-picked subset. See CHANGELOG above.

    # --- Budget / cost trend: daily API spend + when the non-EOD cap was hit ---
    usage_conn = sqlite3.connect(SOURCE_DB)
    usage_df = pd.read_sql_query(
        "SELECT date, SUM(cost_usd) AS cost_usd, COUNT(*) AS api_calls FROM api_usage GROUP BY date ORDER BY date",
        usage_conn,
    )
    usage_conn.close()

    cap_times = find_cap_out_times()

    # --- Blocked candidates: what the guardrails actually stopped ---
    BLOCK_RULE_LABELS = {
        "blocked_timeframe": "15m timeframe block",
        "contradicting_confirmation": "Confirmation gate",
        "concentration_guard": "Concentration guard",
    }
    blocked_conn = sqlite3.connect(SOURCE_DB)
    try:
        blocked_df = pd.read_sql_query(
            "SELECT rule, COUNT(*) AS count FROM blocked_candidates GROUP BY rule ORDER BY count DESC",
            blocked_conn,
        )
    except pd.io.sql.DatabaseError:
        blocked_df = pd.DataFrame(columns=["rule", "count"])
    blocked_conn.close()
    blocked_df["rule_label"] = blocked_df["rule"].map(lambda r: BLOCK_RULE_LABELS.get(r, r))
    blocked_breakdown = clean_records(blocked_df[["rule_label", "count"]].rename(columns={"rule_label": "rule"}))

    def cap_minutes_after_open(day: str):
        t = cap_times.get(day)
        if not t:
            return None
        hh, mm = t.split(":")
        return int(hh) * 60 + int(mm) - (9 * 60 + 30)  # minutes after 9:30 ET

    usage_df["cap_time"] = usage_df["date"].map(cap_times.get)
    usage_df["cap_minutes_after_open"] = usage_df["date"].apply(cap_minutes_after_open)
    budget_trend = clean_records(usage_df)

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
        "budget_trend": budget_trend,
        "daily_budget_usd": DAILY_BUDGET_USD,
        "blocked_breakdown": blocked_breakdown,
        "changelog": CHANGELOG,
        "trades": trades,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {len(trades)} trades ({total_trades} closed) to {OUT_PATH}")


if __name__ == "__main__":
    main()
