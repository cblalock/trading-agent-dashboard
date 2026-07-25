# AI Options Trading Agent — Performance Dashboard

Interactive dashboards analyzing every trade placed by an AI-driven options
trading agent (Claude + Alpaca paper trading + technical-signal scanner), including
the reasoning behind each entry/exit and how performance responded to live changes
made to the system. Two versions live in this repo:

- **`docs/`** — a hand-built web dashboard (vanilla HTML/CSS/JS, no framework),
  published via GitHub Pages. This is the primary version.
- **`agent-stats.twb`** — the original Tableau Public workbook (see the rest of
  this README for its setup/palette notes).

**Data source:** [trading-agent](../trading-agent) — a Claude-powered agent that
scans technical setups, places paper options trades, and journals every decision
with its reasoning to a SQLite database.

## Web dashboard (`docs/`)

```
trades.db (SQLite)  --export_web_data.py-->  docs/data.json  --> docs/index.html (GitHub Pages)
```

Re-run `python export_web_data.py` (conda env `trading`) to refresh `docs/data.json`
with the latest closed trades, then commit + push — GitHub Pages redeploys
automatically on push to `main`. There's no scheduled/automatic refresh; this is a
manual, on-demand update.

Sections: KPI tiles + equity curve, loss/exit breakdown, DTE-bucket performance,
a scanner-tuning case study (the `min_strength` 4→3→4 change), and a searchable
trade log with the agent's own entry/exit reasoning. Dark theme, custom SVG charts
(no charting library), built against the same colorblind-safety-validated palette
described below, just re-stepped for the dark surface.

## Why this project

Most trading dashboards visualize market data. This one visualizes an *agent's
decisions* — a full diagnose → change → monitor loop: bucket-level loss analysis
surfaced that hard-stop exits were consuming more P&L than the win side could
cover, broken down further by days-to-expiration; a scanner misconfiguration was
found (`min_strength=4` silently disabled 13 of 15 enabled indicators, since most
individual indicators can never score that high); the threshold was lowered to 3
on 2026-07-20 and the dashboard tracks whether the newly-unlocked signal types
(Bollinger, Volume Climax, EMA200 Bounce, RSI Divergence, Hammer/Shooting Star,
S/R Breakout, RSI Oversold/Overbought) actually perform.

## Pipeline

```
trades.db (SQLite)  --export_data.py-->  data/trades_export.csv  --> Tableau Public
```

Re-run `python export_data.py` (conda env `trading`) any time to refresh the CSV
with the latest closed trades. The script derives several fields Tableau doesn't
need to compute itself:

| Column | What it is |
|---|---|
| `exit_category` | Free-text `exit_reason` collapsed into 9 clean buckets (Hard Stop, Striker Stop, ATR Stop, Take Profit, EOD Close, Contra-Signal, Liquidation, Theta Risk, Preemptive Exit) |
| `dte_bucket` | 0-3 / 4-7 / 8-14 / 15+ days-to-expiration at entry |
| `hold_type` | Same Day vs. Overnight |
| `win` | `pnl > 0` (null for still-open trades) |
| `trade_number`, `cumulative_pnl`, `capital_after` | Running equity curve, ordered by exit time |
| `indicators_triggered_readable` | The scanner indicator(s) that fired, joined into one readable string |

## Color system

Palette is computed, not eyeballed — it passed a colorblind-safety validator
(OKLab ΔE ≥ 8 on adjacent pairs, ≥15 normal-vision floor) before being used here.
**`Preferences.tps`** in this folder has four ready-made Tableau custom palettes:

- **Trading Dashboard - Categorical** — 8-hue fixed-order set for identity fields
  (`exit_category`, `dte_bucket`, `ticker`). Assign colors to specific values
  manually in Tableau's *Edit Colors* dialog rather than relying on
  alphabetical auto-assignment — suggested mapping:
  - Take Profit → green `#008300`
  - Hard Stop → red `#e34948`
  - Striker Stop → orange `#eb6834`
  - ATR Stop → yellow `#eda100`
  - EOD Close → aqua `#1baf7a`
  - Contra-Signal → violet `#4a3aa7`
  - Theta Risk → magenta `#e87ba4`
  - Liquidation / Preemptive Exit → blue `#2a78d6`
- **Trading Dashboard - PnL Diverging** — red↔blue for anything centered on zero
  (avg P&L by bucket, daily P&L). Deliberately **not** red/green — red-green is
  the one pairing ~8% of men (red-green colorblindness) genuinely can't
  distinguish, which is exactly the pairing almost every finance dashboard
  defaults to.
- **Trading Dashboard - Sequential Blue** — single-hue ramp for pure magnitude
  (e.g. trade count heatmaps).
- **Trading Dashboard - Status** — reserve for win-rate KPI tiles only (good/
  warning/serious/critical), never reused as a categorical series color.

**To install:** copy `Preferences.tps` into
`Documents\My Tableau Repository\Preferences.tps` (merge if one already exists),
restart Tableau — the four palettes appear in every *Edit Colors* dropdown.

**Dark theme:** set worksheet/dashboard backgrounds to `#1a1a19` (Format →
Workbook → set background), text to `#ffffff` primary / `#c3c2b7` secondary,
gridlines `#2c2c2a`, axis/baseline `#383835`. Keep the font a clean system sans
(Tableau's default, or Segoe UI) — no serif/display fonts anywhere.

## Dashboard pages (suggested build order)

1. **Overview** — KPI tiles (Total P&L, Win Rate, Total Trades, Current Capital)
   + equity curve (`trade_number` on x, `capital_after` on y, single blue line,
   thin 2px stroke, no dual axis).
2. **Loss & Exit Breakdown** — bar chart of `exit_category` by sum(`pnl`) and by
   count, using the categorical palette's manual mapping above. This is the
   "hard stops are the biggest loss category" finding, made visual.
3. **DTE Bucket Performance** — bar or heatmap of win rate and avg `pnl` by
   `dte_bucket` (order 0-3, 4-7, 8-14, 15+, Unknown manually, not alphabetically).
   Use the diverging palette on avg `pnl` since it's centered on zero.
4. **Signal Strength / Scanner Case Study** — `signal_strength` performance over
   time with a reference line annotation at 2026-07-20 (the `min_strength` 4→3
   change) — the before/after story.
5. **Trade Log & Reasoning Explorer** — searchable/filterable table of
   `entry_reason` / `claude_reasoning` per trade. Keep this text in secondary/
   muted ink, not colored by category — text carries meaning through content
   here, not color.

## Notes

- `data/trades_export.csv` is a point-in-time snapshot — re-run `export_data.py`
  to refresh before publishing an update.
- All figures are **paper trading** (simulated $5,000 starting capital) — label
  this clearly on the published dashboard so it doesn't read as real capital.
