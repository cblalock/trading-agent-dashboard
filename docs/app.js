/* ===================================================================
   Trading Agent Dashboard — chart rendering (vanilla JS, no deps)
   Data source: data.json (produced by ../export_web_data.py)
   =================================================================== */

const NS = "http://www.w3.org/2000/svg";

// Category color mapping — hex values mirror the CSS custom properties in
// style.css (SVG fill can't resolve var() reliably in every renderer, so
// these are duplicated intentionally; keep them in sync with :root).
const PALETTE = {
  blue: "#3987e5",
  orange: "#d95926",
  aqua: "#199e70",
  yellow: "#c98500",
  magenta: "#d55181",
  green: "#008300",
  violet: "#9085e9",
  red: "#e66767",
  muted: "#898781",
};

const EXIT_CATEGORY_COLOR = {
  "Take Profit": PALETTE.green,
  "Hard Stop": PALETTE.red,
  "Striker Stop": PALETTE.orange,
  "EOD Close": PALETTE.aqua,
  "Friday Close": PALETTE.blue,
  "Contra-Signal (15m RSI)": PALETTE.violet,
  "Contra-Signal (Other)": PALETTE.magenta,
  "Momentum Fade": PALETTE.yellow,
  "Theta Risk": PALETTE.magenta,
  "Liquidation": PALETTE.muted,
  "Preemptive Exit": PALETTE.blue,
  "Other": PALETTE.muted,
  "Open": PALETTE.muted,
};

// ---------- formatting ----------

const fmtCurrency0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtCurrency2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPercent1 = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
// Bare "YYYY-MM-DD" strings parse as UTC midnight in JS, which shifts a day
// backward in any timezone west of UTC once toLocaleDateString renders it
// locally. Full timestamps (with "T") don't have this problem. Parse
// bare dates from local components to sidestep the UTC round-trip.
function parseDateLocal(iso) {
  const bareDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (bareDateMatch) {
    const [, y, m, d] = bareDateMatch;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  return new Date(iso);
}
const fmtDate = (iso) => iso ? parseDateLocal(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const fmtDateShort = (iso) => iso ? parseDateLocal(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

function signClass(n) {
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  if (attrs) {
    for (const k in attrs) el.setAttribute(k, attrs[k]);
  }
  return el;
}

// Matches .category-label in style.css (12px, --font-sans) so bucket-label
// columns size themselves to whatever text they actually contain, rather
// than a fixed guess that only happens to fit short labels like "0-3 DTE".
const _measureCanvas = document.createElement("canvas").getContext("2d");
_measureCanvas.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
function measureTextWidth(text) {
  return _measureCanvas.measureText(text).width;
}

function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

// ---------- tooltip ----------

const tooltipEl = document.getElementById("tooltip");

function showTooltip(x, y, rowsHtml) {
  tooltipEl.innerHTML = "";
  rowsHtml.forEach(({ key, label, value, valueClass }) => {
    const row = document.createElement("div");
    if (key) {
      const swatch = document.createElement("span");
      swatch.className = "tt-key";
      swatch.style.background = key;
      row.appendChild(swatch);
    }
    const labelSpan = document.createElement("span");
    labelSpan.textContent = (value === "" || value == null) ? label : label + ": ";
    row.appendChild(labelSpan);
    if (value !== "" && value != null) {
      const valueSpan = document.createElement("span");
      valueSpan.className = "tt-value" + (valueClass ? " " + valueClass : "");
      valueSpan.textContent = value;
      row.appendChild(valueSpan);
    }
    tooltipEl.appendChild(row);
  });
  tooltipEl.style.left = x + "px";
  tooltipEl.style.top = y + "px";
  tooltipEl.classList.add("visible");
}

function hideTooltip() {
  tooltipEl.classList.remove("visible");
}

function tooltipPos(evt, container) {
  const rect = container.getBoundingClientRect();
  return { x: rect.left + window.scrollX + (evt.clientX - rect.left), y: rect.top + window.scrollY + (evt.clientY - rect.top) - 12 };
}

// ---------- table toggle wiring ----------

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".table-toggle");
  if (!btn) return;
  const target = document.getElementById(btn.dataset.target);
  const visible = target.classList.toggle("visible");
  btn.textContent = visible ? "Hide table" : "View as table";
});

// ---------- KPI tiles ----------

function renderKPIs(kpis) {
  const grid = document.getElementById("kpi-grid");
  grid.innerHTML = "";

  const tiles = [
    {
      label: "Total P&L",
      value: fmtCurrency0.format(kpis.total_pnl),
      cls: signClass(kpis.total_pnl),
      sub: `${kpis.wins} wins / ${kpis.losses} losses`,
    },
    {
      label: "Win rate",
      value: kpis.win_rate != null ? fmtPercent1.format(kpis.win_rate) : "—",
      cls: "",
      sub: `across ${kpis.total_trades} closed trades`,
    },
    {
      label: "Total trades",
      value: String(kpis.total_trades),
      cls: "",
      sub: "all closed, paper account",
    },
    {
      label: "Current capital",
      value: fmtCurrency0.format(kpis.current_capital),
      cls: signClass(kpis.current_capital - kpis.starting_capital),
      sub: `started at ${fmtCurrency0.format(kpis.starting_capital)}`,
    },
  ];

  tiles.forEach((t) => {
    const tile = document.createElement("div");
    tile.className = "kpi-tile";
    const label = document.createElement("div");
    label.className = "kpi-label";
    label.textContent = t.label;
    const value = document.createElement("div");
    value.className = "kpi-value " + t.cls;
    value.textContent = t.value;
    const sub = document.createElement("div");
    sub.className = "kpi-sub";
    sub.textContent = t.sub;
    tile.append(label, value, sub);
    grid.appendChild(tile);
  });
}

// ---------- Equity curve ----------

function renderEquityCurve(equityCurve, startingCapital) {
  const viewport = document.getElementById("equity-viewport");
  viewport.innerHTML = "";
  if (!equityCurve.length) {
    viewport.innerHTML = '<p class="empty-state">No closed trades yet.</p>';
    return;
  }

  const W = 1000, H = 320;
  const pad = { top: 16, right: 24, bottom: 32, left: 64 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const points = [{ trade_number: 0, capital_after: startingCapital, exit_time: null, ticker: null, pnl: null }, ...equityCurve];

  const xMax = points[points.length - 1].trade_number;
  const yValues = points.map((p) => p.capital_after);
  const yTicks = niceTicks(Math.min(...yValues), Math.max(...yValues), 5);
  const yMin = yTicks[0], yMax = yTicks[yTicks.length - 1];

  const x = (t) => pad.left + (t / xMax) * innerW;
  const y = (v) => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Equity curve" });

  // gridlines + y labels
  yTicks.forEach((v) => {
    svg.appendChild(svgEl("line", { class: "gridline", x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v) }));
    const lbl = svgEl("text", { class: "axis-label", x: pad.left - 10, y: y(v) + 4, "text-anchor": "end" });
    lbl.textContent = fmtCurrency0.format(v);
    svg.appendChild(lbl);
  });

  // starting-capital reference line
  const startY = y(startingCapital);
  const refLine = svgEl("line", { x1: pad.left, x2: W - pad.right, y1: startY, y2: startY, stroke: "#383835", "stroke-width": 1, "stroke-dasharray": "3 3" });
  svg.appendChild(refLine);

  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: pad.left, x2: pad.left, y1: pad.top, y2: H - pad.bottom }));
  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: pad.left, x2: W - pad.right, y1: H - pad.bottom, y2: H - pad.bottom }));

  // area fill
  let areaD = `M ${x(points[0].trade_number)} ${y(points[0].capital_after)}`;
  points.forEach((p) => { areaD += ` L ${x(p.trade_number)} ${y(p.capital_after)}`; });
  areaD += ` L ${x(points[points.length - 1].trade_number)} ${H - pad.bottom} L ${x(0)} ${H - pad.bottom} Z`;
  svg.appendChild(svgEl("path", { class: "mark-area", d: areaD, fill: PALETTE.blue }));

  // line
  let lineD = `M ${x(points[0].trade_number)} ${y(points[0].capital_after)}`;
  points.forEach((p) => { lineD += ` L ${x(p.trade_number)} ${y(p.capital_after)}`; });
  svg.appendChild(svgEl("path", { class: "mark-line", d: lineD, stroke: PALETTE.blue }));

  // end dot + label
  const last = points[points.length - 1];
  svg.appendChild(svgEl("circle", { class: "mark-dot end-marker", cx: x(last.trade_number), cy: y(last.capital_after), r: 4, fill: PALETTE.blue }));
  const labelAbove = y(last.capital_after) > pad.top + 18;
  const endLabel = svgEl("text", {
    class: "direct-label", x: x(last.trade_number) - 8,
    y: labelAbove ? y(last.capital_after) - 12 : y(last.capital_after) + 18,
    "text-anchor": "end",
  });
  endLabel.textContent = fmtCurrency0.format(last.capital_after);
  svg.appendChild(endLabel);

  // x axis labels (first / last trade number)
  const xLabelStart = svgEl("text", { class: "axis-label", x: pad.left, y: H - 6 });
  xLabelStart.textContent = "Trade 1";
  svg.appendChild(xLabelStart);
  const xLabelEnd = svgEl("text", { class: "axis-label", x: W - pad.right, y: H - 6, "text-anchor": "end" });
  xLabelEnd.textContent = `Trade ${xMax}`;
  svg.appendChild(xLabelEnd);

  // crosshair
  const crosshair = svgEl("line", { class: "crosshair-line", y1: pad.top, y2: H - pad.bottom, x1: 0, x2: 0 });
  svg.appendChild(crosshair);
  const crosshairDot = svgEl("circle", { class: "mark-dot", r: 4, fill: PALETTE.blue, style: "opacity:0" });
  svg.appendChild(crosshairDot);

  // hit layer
  const hit = svgEl("rect", { class: "hit-layer", x: pad.left, y: pad.top, width: innerW, height: innerH });
  svg.appendChild(hit);

  hit.addEventListener("pointermove", (evt) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mx = (evt.clientX - rect.left) * scaleX;
    const t = Math.round(((mx - pad.left) / innerW) * xMax);
    const clamped = Math.max(0, Math.min(xMax, t));
    const pt = points.reduce((a, b) => Math.abs(b.trade_number - clamped) < Math.abs(a.trade_number - clamped) ? b : a);
    crosshair.setAttribute("x1", x(pt.trade_number));
    crosshair.setAttribute("x2", x(pt.trade_number));
    crosshair.style.opacity = 1;
    crosshairDot.setAttribute("cx", x(pt.trade_number));
    crosshairDot.setAttribute("cy", y(pt.capital_after));
    crosshairDot.style.opacity = 1;

    const rows = [
      { label: "Trade #", value: String(pt.trade_number) },
      { label: "Capital after", value: fmtCurrency2.format(pt.capital_after) },
    ];
    if (pt.ticker) rows.push({ label: "Ticker", value: pt.ticker });
    if (pt.pnl != null) rows.push({ label: "P&L", value: fmtCurrency2.format(pt.pnl), valueClass: signClass(pt.pnl) });
    if (pt.exit_time) rows.push({ label: "Exit", value: fmtDate(pt.exit_time) });

    const pos = tooltipPos(evt, viewport);
    showTooltip(pos.x, pos.y, rows);
  });
  hit.addEventListener("pointerleave", () => {
    crosshair.style.opacity = 0;
    crosshairDot.style.opacity = 0;
    hideTooltip();
  });

  viewport.appendChild(svg);
}

// ---------- Exit breakdown (diverging horizontal bars) ----------

function renderExitBreakdown(rows) {
  const viewport = document.getElementById("exit-viewport");
  viewport.innerHTML = "";
  if (!rows.length) {
    viewport.innerHTML = '<p class="empty-state">No closed trades yet.</p>';
    return;
  }

  const W = 1000;
  const rowH = 34;
  // left padding sized to the longest "Category (NN.N%)" label actually in
  // this data, not a fixed guess — a fixed 130px fit "Contra-Signal" but
  // overflowed the chart once it split into "Contra-Signal (15m RSI) (12.2%)".
  const longestLabel = Math.max(...rows.map((r) => measureTextWidth(`${r.exit_category} (${r.pct_of_exits}%)`)));
  const pad = { top: 10, right: 90, bottom: 10, left: Math.max(130, longestLabel + 24) };
  const innerW = W - pad.left - pad.right;
  const H = pad.top + pad.bottom + rows.length * rowH;

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.total_pnl)), 1);
  const xZero = pad.left + innerW / 2;
  const scale = (innerW / 2) / maxAbs;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "P&L by exit category" });

  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: xZero, x2: xZero, y1: pad.top, y2: H - pad.bottom }));

  rows.forEach((r, i) => {
    const cy = pad.top + i * rowH + rowH / 2;
    const barH = 18;
    const color = EXIT_CATEGORY_COLOR[r.exit_category] || PALETTE.muted;
    const val = r.total_pnl;
    const barW = Math.abs(val) * scale;
    const barX = val >= 0 ? xZero : xZero - barW;

    const bar = svgEl("rect", {
      class: "mark-bar", x: barX, y: cy - barH / 2, width: Math.max(barW, 1), height: barH,
      rx: 4, fill: color,
    });
    svg.appendChild(bar);

    const catLabel = svgEl("text", { class: "category-label", x: pad.left - 12, y: cy + 4, "text-anchor": "end" });
    catLabel.textContent = `${r.exit_category} (${r.pct_of_exits}%)`;
    svg.appendChild(catLabel);

    const valLabel = svgEl("text", {
      class: "direct-label", y: cy + 4,
      x: val >= 0 ? barX + barW + 8 : barX - 8,
      "text-anchor": val >= 0 ? "start" : "end",
    });
    valLabel.textContent = fmtCurrency0.format(val);
    svg.appendChild(valLabel);

    const hitRow = svgEl("rect", { x: pad.left, y: cy - rowH / 2, width: innerW, height: rowH, fill: "transparent", style: "cursor:pointer" });
    hitRow.addEventListener("pointermove", (evt) => {
      bar.classList.add("hovered");
      const pos = tooltipPos(evt, viewport);
      showTooltip(pos.x, pos.y, [
        { key: color, label: r.exit_category, value: "" , valueClass: "" },
        { label: "Share of exits", value: `${r.pct_of_exits}%` },
        { label: "Total P&L", value: fmtCurrency2.format(r.total_pnl), valueClass: signClass(r.total_pnl) },
        { label: "Avg P&L", value: fmtCurrency2.format(r.avg_pnl), valueClass: signClass(r.avg_pnl) },
        { label: "Trades", value: String(r.count) },
      ]);
    });
    hitRow.addEventListener("pointerleave", () => { bar.classList.remove("hovered"); hideTooltip(); });
    svg.appendChild(hitRow);
  });

  viewport.appendChild(svg);
  renderSimpleTable("exit-table-wrap", ["Exit category", "Share of exits", "Total P&L", "Avg P&L", "Trades"],
    rows.map((r) => [r.exit_category, `${r.pct_of_exits}%`, fmtCurrency2.format(r.total_pnl), fmtCurrency2.format(r.avg_pnl), r.count]));
}

// ---------- DTE bucket performance (two small multiples) ----------

function renderDteBreakdown(rows) {
  const viewport = document.getElementById("dte-viewport");
  viewport.innerHTML = "";
  if (!rows.length) {
    viewport.innerHTML = '<p class="empty-state">No closed trades yet.</p>';
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "dte-grid";

  wrap.appendChild(buildBucketSubchart(rows, "dte_bucket", "win_rate", "Win rate", (v) => fmtPercent1.format(v), true, 1));
  wrap.appendChild(buildBucketSubchart(rows, "dte_bucket", "avg_pnl", "Avg P&L", (v) => fmtCurrency0.format(v), false));

  viewport.appendChild(wrap);
  renderSimpleTable("dte-table-wrap", ["DTE bucket", "Trades", "Win rate", "Avg P&L", "Total P&L"],
    rows.map((r) => [r.dte_bucket, r.count, r.win_rate != null ? fmtPercent1.format(r.win_rate) : "—", fmtCurrency2.format(r.avg_pnl), fmtCurrency2.format(r.total_pnl)]));
}

// ---------- Entry time-of-day performance (two small multiples) ----------

function renderTodBreakdown(rows) {
  const viewport = document.getElementById("tod-viewport");
  viewport.innerHTML = "";
  if (!rows.length) {
    viewport.innerHTML = '<p class="empty-state">No closed trades yet.</p>';
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "dte-grid";

  wrap.appendChild(buildBucketSubchart(rows, "tod_bucket", "win_rate", "Win rate", (v) => fmtPercent1.format(v), true, 1));
  wrap.appendChild(buildBucketSubchart(rows, "tod_bucket", "avg_pnl", "Avg P&L", (v) => fmtCurrency0.format(v), false));

  viewport.appendChild(wrap);
  renderSimpleTable("tod-table-wrap", ["Entry window", "Trades", "Win rate", "Avg P&L", "Total P&L"],
    rows.map((r) => [r.tod_bucket, r.count, r.win_rate != null ? fmtPercent1.format(r.win_rate) : "—", fmtCurrency2.format(r.avg_pnl), fmtCurrency2.format(r.total_pnl)]));
}

function buildBucketSubchart(rows, labelField, field, title, formatter, isSequential, fixedMax) {
  const container = document.createElement("div");
  const heading = document.createElement("div");
  heading.className = "chart-caption";
  heading.style.marginBottom = "8px";
  heading.textContent = title;
  container.appendChild(heading);

  const W = 480;
  const rowH = 40;
  const longestLabel = Math.max(...rows.map((r) => measureTextWidth(String(r[labelField]))));
  const pad = { top: 6, right: 70, bottom: 6, left: Math.max(90, longestLabel + 24) };
  const innerW = W - pad.left - pad.right;
  const H = pad.top + pad.bottom + rows.length * rowH;

  const values = rows.map((r) => r[field]).filter((v) => v != null);
  const maxAbs = fixedMax != null ? fixedMax : Math.max(...values.map(Math.abs), 1);
  const zeroBased = isSequential;
  const xZero = zeroBased ? pad.left : pad.left + innerW / 2;
  // Reserve room so the largest-magnitude bar's value label never reaches the
  // row-label zone at pad.left (was colliding with the category label whenever
  // a diverging chart's max value was large enough to fill the full half-width).
  const valueLabelBuffer = 46;
  const scale = zeroBased ? innerW / maxAbs : (innerW / 2 - valueLabelBuffer) / maxAbs;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": title + " by " + labelField });
  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: xZero, x2: xZero, y1: pad.top, y2: H - pad.bottom }));

  rows.forEach((r, i) => {
    const cy = pad.top + i * rowH + rowH / 2;
    const barH = 18;
    const val = r[field];
    const label = svgEl("text", { class: "category-label", x: pad.left - 12, y: cy + 4, "text-anchor": "end" });
    label.textContent = r[labelField];
    svg.appendChild(label);

    if (val == null) {
      const naLabel = svgEl("text", { class: "axis-label", x: pad.left + 6, y: cy + 4 });
      naLabel.textContent = "n/a";
      svg.appendChild(naLabel);
      return;
    }

    const color = isSequential ? PALETTE.blue : (val >= 0 ? PALETTE.blue : PALETTE.red);
    let barX, barW;
    if (zeroBased) {
      barW = val * scale;
      barX = pad.left;
    } else {
      barW = Math.abs(val) * scale;
      barX = val >= 0 ? xZero : xZero - barW;
    }

    const bar = svgEl("rect", { class: "mark-bar", x: barX, y: cy - barH / 2, width: Math.max(barW, 1), height: barH, rx: 4, fill: color });
    svg.appendChild(bar);

    const valLabel = svgEl("text", {
      class: "direct-label", y: cy + 4,
      x: zeroBased ? barX + barW + 8 : (val >= 0 ? barX + barW + 8 : barX - 8),
      "text-anchor": zeroBased ? "start" : (val >= 0 ? "start" : "end"),
    });
    valLabel.textContent = formatter(val);
    svg.appendChild(valLabel);

    const hitRow = svgEl("rect", { x: pad.left - 90, y: cy - rowH / 2, width: innerW + 90, height: rowH, fill: "transparent", style: "cursor:pointer" });
    hitRow.addEventListener("pointermove", (evt) => {
      bar.classList.add("hovered");
      const pos = tooltipPos(evt, container);
      showTooltip(pos.x, pos.y, [
        { label: r[labelField], value: formatter(val) },
        { label: "Trades", value: String(r.count) },
      ]);
    });
    hitRow.addEventListener("pointerleave", () => { bar.classList.remove("hovered"); hideTooltip(); });
    svg.appendChild(hitRow);
  });

  container.style.position = "relative";
  container.appendChild(svg);
  return container;
}

// ---------- Scanner case study ----------

function renderScannerCaseStudy(daily, events) {
  const viewport = document.getElementById("scanner-viewport");
  viewport.innerHTML = "";
  if (!daily.length) {
    viewport.innerHTML = '<p class="empty-state">No closed trades yet.</p>';
    return;
  }

  const W = 1000, H = 300;
  const pad = { top: 20, right: 24, bottom: 40, left: 64 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const values = daily.map((d) => d.total_pnl);
  const yTicks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 5);
  const yMin = yTicks[0], yMax = yTicks[yTicks.length - 1];
  const y = (v) => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const y0 = y(0);

  const bandW = innerW / daily.length;
  const barW = Math.min(28, bandW * 0.6);
  const xCenter = (i) => pad.left + bandW * i + bandW / 2;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily P&L with scanner change annotations" });

  yTicks.forEach((v) => {
    svg.appendChild(svgEl("line", { class: "gridline", x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v) }));
    const lbl = svgEl("text", { class: "axis-label", x: pad.left - 10, y: y(v) + 4, "text-anchor": "end" });
    lbl.textContent = fmtCurrency0.format(v);
    svg.appendChild(lbl);
  });

  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: pad.left, x2: W - pad.right, y1: y0, y2: y0 }));

  daily.forEach((d, i) => {
    const val = d.total_pnl;
    const color = val >= 0 ? PALETTE.blue : PALETTE.red;
    const barY = val >= 0 ? y(val) : y0;
    const barH = Math.max(Math.abs(y(val) - y0), 1);
    const bar = svgEl("rect", { class: "mark-bar", x: xCenter(i) - barW / 2, y: barY, width: barW, height: barH, rx: 3, fill: color });
    svg.appendChild(bar);

    const hitCol = svgEl("rect", { x: pad.left + bandW * i, y: pad.top, width: bandW, height: innerH, fill: "transparent", style: "cursor:pointer" });
    hitCol.addEventListener("pointermove", (evt) => {
      bar.classList.add("hovered");
      const pos = tooltipPos(evt, viewport);
      showTooltip(pos.x, pos.y, [
        { label: fmtDate(d.entry_date), value: fmtCurrency2.format(d.total_pnl), valueClass: signClass(d.total_pnl) },
        { label: "Trades", value: String(d.count) },
        { label: "Win rate", value: d.win_rate != null ? fmtPercent1.format(d.win_rate) : "—" },
      ]);
    });
    hitCol.addEventListener("pointerleave", () => { bar.classList.remove("hovered"); hideTooltip(); });
    svg.appendChild(hitCol);

    // sparse x labels to avoid collisions
    if (i === 0 || i === daily.length - 1 || i % Math.ceil(daily.length / 8) === 0) {
      const lbl = svgEl("text", { class: "axis-label", x: xCenter(i), y: H - pad.bottom + 16, "text-anchor": "middle" });
      lbl.textContent = fmtDateShort(d.entry_date);
      svg.appendChild(lbl);
    }
  });

  // annotation lines (staggered vertically so adjacent dates don't collide)
  events.forEach((ev, i) => {
    const idx = daily.findIndex((d) => d.entry_date >= ev.date);
    const xPos = idx === -1 ? pad.left + innerW : pad.left + bandW * idx;
    svg.appendChild(svgEl("line", { class: "annotation-line", x1: xPos, x2: xPos, y1: pad.top, y2: H - pad.bottom }));
    const flip = xPos > pad.left + innerW * 0.6;
    const lbl = svgEl("text", {
      class: "annotation-label",
      x: flip ? xPos - 6 : xPos + 6,
      y: pad.top + 10 + i * 13,
      "text-anchor": flip ? "end" : "start",
    });
    lbl.textContent = ev.label;
    svg.appendChild(lbl);
  });

  viewport.appendChild(svg);
  renderSimpleTable("scanner-table-wrap", ["Date", "Trades", "Total P&L", "Avg P&L", "Win rate"],
    daily.map((d) => [fmtDate(d.entry_date), d.count, fmtCurrency2.format(d.total_pnl), fmtCurrency2.format(d.avg_pnl), d.win_rate != null ? fmtPercent1.format(d.win_rate) : "—"]));
}

// ---------- Budget trend (daily API spend vs. the cap) ----------

function renderBudgetTrend(rows, dailyBudget) {
  const viewport = document.getElementById("budget-viewport");
  viewport.innerHTML = "";
  if (!rows.length) {
    viewport.innerHTML = '<p class="empty-state">No usage data yet.</p>';
    return;
  }

  const NON_EOD_CAP = dailyBudget - 0.15;

  const W = 1000, H = 300;
  const pad = { top: 20, right: 24, bottom: 40, left: 64 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const yMax = Math.max(dailyBudget, ...rows.map((d) => d.cost_usd)) * 1.08;
  const y = (v) => pad.top + innerH - (v / yMax) * innerH;
  const y0 = pad.top + innerH;

  const bandW = innerW / rows.length;
  const barW = Math.min(28, bandW * 0.6);
  const xCenter = (i) => pad.left + bandW * i + bandW / 2;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily API spend vs. budget cap" });

  [0, NON_EOD_CAP, dailyBudget].forEach((v) => {
    svg.appendChild(svgEl("line", { class: "gridline", x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v) }));
    const lbl = svgEl("text", { class: "axis-label", x: pad.left - 10, y: y(v) + 4, "text-anchor": "end" });
    lbl.textContent = fmtCurrency2.format(v);
    svg.appendChild(lbl);
  });
  const capLine = svgEl("line", { x1: pad.left, x2: W - pad.right, y1: y(NON_EOD_CAP), y2: y(NON_EOD_CAP), stroke: PALETTE.red, "stroke-width": 1, "stroke-dasharray": "4 3" });
  svg.appendChild(capLine);

  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: pad.left, x2: W - pad.right, y1: y0, y2: y0 }));

  rows.forEach((d, i) => {
    const hitCap = d.cost_usd >= NON_EOD_CAP - 0.01;
    const color = hitCap ? PALETTE.red : PALETTE.blue;
    const barH = Math.max(y0 - y(d.cost_usd), 1);
    const bar = svgEl("rect", { class: "mark-bar", x: xCenter(i) - barW / 2, y: y(d.cost_usd), width: barW, height: barH, rx: 3, fill: color });
    svg.appendChild(bar);

    if (d.cap_time) {
      svg.appendChild(svgEl("circle", { cx: xCenter(i), cy: y(d.cost_usd) - 8, r: 3, fill: PALETTE.yellow }));
    }

    const hitCol = svgEl("rect", { x: pad.left + bandW * i, y: pad.top, width: bandW, height: innerH, fill: "transparent", style: "cursor:pointer" });
    hitCol.addEventListener("pointermove", (evt) => {
      bar.classList.add("hovered");
      const pos = tooltipPos(evt, viewport);
      showTooltip(pos.x, pos.y, [
        { label: fmtDate(d.date), value: fmtCurrency2.format(d.cost_usd) },
        { label: "API calls", value: String(d.api_calls) },
        { label: "Capped out at", value: d.cap_time ? `${d.cap_time} ET` : "never hit the wall" },
      ]);
    });
    hitCol.addEventListener("pointerleave", () => { bar.classList.remove("hovered"); hideTooltip(); });
    svg.appendChild(hitCol);

    if (i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 8) === 0) {
      const lbl = svgEl("text", { class: "axis-label", x: xCenter(i), y: H - pad.bottom + 16, "text-anchor": "middle" });
      lbl.textContent = fmtDateShort(d.date);
      svg.appendChild(lbl);
    }
  });

  viewport.appendChild(svg);
  renderSimpleTable("budget-table-wrap", ["Date", "Spent", "API calls", "Capped out at"],
    rows.map((d) => [fmtDate(d.date), fmtCurrency2.format(d.cost_usd), d.api_calls, d.cap_time ? `${d.cap_time} ET` : "—"]));
}

// ---------- Blocked candidates (guardrails at work) ----------

function renderBlockedCandidates(rows) {
  const viewport = document.getElementById("blocked-viewport");
  const caption = document.getElementById("blocked-caption");
  viewport.innerHTML = "";
  if (!rows.length) {
    viewport.innerHTML = '<p class="empty-state">No blocked attempts logged yet — tracking started 2026-08-13.</p>';
    return;
  }
  if (caption) caption.textContent = "Count of place_option_trade attempts a hard rule actually stopped, by rule.";

  const W = 1000;
  const rowH = 40;
  const longestLabel = Math.max(...rows.map((r) => measureTextWidth(r.rule)));
  const pad = { top: 10, right: 70, bottom: 10, left: Math.max(140, longestLabel + 24) };
  const innerW = W - pad.left - pad.right;
  const H = pad.top + pad.bottom + rows.length * rowH;
  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Blocked candidates by rule" });
  svg.appendChild(svgEl("line", { class: "axis-baseline", x1: pad.left, x2: pad.left, y1: pad.top, y2: H - pad.bottom }));

  rows.forEach((r, i) => {
    const cy = pad.top + i * rowH + rowH / 2;
    const barH = 20;
    const barW = (r.count / maxCount) * innerW;
    const bar = svgEl("rect", { class: "mark-bar", x: pad.left, y: cy - barH / 2, width: Math.max(barW, 1), height: barH, rx: 4, fill: PALETTE.violet });
    svg.appendChild(bar);

    const label = svgEl("text", { class: "category-label", x: pad.left - 12, y: cy + 4, "text-anchor": "end" });
    label.textContent = r.rule;
    svg.appendChild(label);

    const valLabel = svgEl("text", { class: "direct-label", x: pad.left + barW + 8, y: cy + 4 });
    valLabel.textContent = String(r.count);
    svg.appendChild(valLabel);

    const hitRow = svgEl("rect", { x: pad.left, y: cy - rowH / 2, width: innerW, height: rowH, fill: "transparent", style: "cursor:pointer" });
    hitRow.addEventListener("pointermove", (evt) => {
      bar.classList.add("hovered");
      const pos = tooltipPos(evt, viewport);
      showTooltip(pos.x, pos.y, [
        { key: PALETTE.violet, label: r.rule, value: "" },
        { label: "Blocked attempts", value: String(r.count) },
      ]);
    });
    hitRow.addEventListener("pointerleave", () => { bar.classList.remove("hovered"); hideTooltip(); });
    svg.appendChild(hitRow);
  });

  viewport.appendChild(svg);
  renderSimpleTable("blocked-table-wrap", ["Rule", "Blocked attempts"], rows.map((r) => [r.rule, r.count]));
}

// ---------- System changelog ----------

const STATUS_LABEL = {
  confirmed: "Confirmed",
  watching: "Watching",
  needs_revisit: "Needs revisit",
  shipped: "Shipped",
};

function renderChangelog(entries) {
  const viewport = document.getElementById("changelog-viewport");
  viewport.innerHTML = "";
  if (!entries.length) {
    viewport.innerHTML = '<p class="empty-state">Nothing logged yet.</p>';
    return;
  }

  const list = document.createElement("div");
  list.className = "changelog-list";

  // newest first
  [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((e) => {
    const entry = document.createElement("div");
    entry.className = `changelog-entry status-${e.status}`;

    const head = document.createElement("div");
    head.className = "changelog-head";
    const date = document.createElement("span");
    date.className = "changelog-date";
    date.textContent = e.date;
    const title = document.createElement("span");
    title.className = "changelog-title";
    title.textContent = e.title;
    const status = document.createElement("span");
    status.className = "changelog-status";
    status.textContent = STATUS_LABEL[e.status] || e.status;
    head.append(date, title, status);
    entry.appendChild(head);

    [["Problem", e.problem], ["Change", e.change], ["Result", e.result]].forEach(([label, text]) => {
      const row = document.createElement("p");
      row.className = "changelog-row";
      const strong = document.createElement("strong");
      strong.textContent = label;
      row.appendChild(strong);
      row.appendChild(document.createTextNode(text));
      entry.appendChild(row);
    });

    list.appendChild(entry);
  });

  viewport.appendChild(list);
}

// ---------- generic table renderer (used for the "view as table" fallback) ----------

function renderSimpleTable(containerId, headers, rows) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

// ---------- Trade log & reasoning explorer ----------

let ALL_TRADES = [];

function renderTradeLog(trades) {
  ALL_TRADES = trades;

  const categories = [...new Set(trades.map((t) => t.exit_category))].sort();
  const categorySelect = document.getElementById("trade-category-filter");
  categories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    categorySelect.appendChild(opt);
  });

  document.getElementById("trade-search").addEventListener("input", drawTradeTable);
  categorySelect.addEventListener("change", drawTradeTable);
  document.getElementById("trade-sort").addEventListener("change", drawTradeTable);

  drawTradeTable();
}

function drawTradeTable() {
  const search = document.getElementById("trade-search").value.trim().toLowerCase();
  const category = document.getElementById("trade-category-filter").value;
  const sort = document.getElementById("trade-sort").value;

  let rows = ALL_TRADES.filter((t) => {
    if (category && t.exit_category !== category) return false;
    if (!search) return true;
    const haystack = [t.ticker, t.entry_reason, t.exit_reason, t.claude_reasoning, t.indicators_triggered_readable]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(search);
  });

  rows = rows.slice().sort((a, b) => {
    switch (sort) {
      case "entry_time_asc": return new Date(a.entry_time) - new Date(b.entry_time);
      case "pnl_desc": return (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity);
      case "pnl_asc": return (a.pnl ?? Infinity) - (b.pnl ?? Infinity);
      default: return new Date(b.entry_time) - new Date(a.entry_time);
    }
  });

  document.getElementById("trade-filter-count").textContent = `${rows.length} of ${ALL_TRADES.length} trades`;

  const wrap = document.getElementById("tradelog-table-wrap");
  wrap.innerHTML = "";

  if (!rows.length) {
    wrap.innerHTML = '<p class="empty-state">No trades match this filter.</p>';
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  ["Entry", "Ticker", "Type", "Exit category", "DTE", "Signal", "P&L"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach((t) => {
    const tr = document.createElement("tr");
    tr.className = "trade-row";

    const tdEntry = document.createElement("td");
    tdEntry.textContent = fmtDate(t.entry_time);
    tr.appendChild(tdEntry);

    const tdTicker = document.createElement("td");
    tdTicker.textContent = t.ticker;
    tr.appendChild(tdTicker);

    const tdType = document.createElement("td");
    tdType.textContent = t.option_type ? `${t.option_type} $${t.strike_price ?? ""}` : t.trade_type;
    tr.appendChild(tdType);

    const tdCat = document.createElement("td");
    const dot = document.createElement("span");
    dot.className = "category-dot";
    dot.style.background = EXIT_CATEGORY_COLOR[t.exit_category] || PALETTE.muted;
    tdCat.appendChild(dot);
    tdCat.appendChild(document.createTextNode(t.exit_category || "—"));
    tr.appendChild(tdCat);

    const tdDte = document.createElement("td");
    tdDte.textContent = t.dte_at_entry != null ? String(t.dte_at_entry) : "—";
    tr.appendChild(tdDte);

    const tdSignal = document.createElement("td");
    tdSignal.textContent = t.signal_strength != null ? `Str ${t.signal_strength}` : "—";
    tr.appendChild(tdSignal);

    const tdPnl = document.createElement("td");
    tdPnl.className = "pnl-cell " + signClass(t.pnl);
    tdPnl.textContent = t.pnl != null ? fmtCurrency2.format(t.pnl) : "—";
    tr.appendChild(tdPnl);

    const reasoningRow = document.createElement("tr");
    reasoningRow.className = "reasoning-row hidden";
    const reasoningCell = document.createElement("td");
    reasoningCell.colSpan = 7;

    [
      ["Entry reasoning", t.entry_reason],
      ["Exit reasoning", t.exit_reason],
      ["Claude's reasoning", t.claude_reasoning],
      ["Indicators triggered", t.indicators_triggered_readable],
    ].forEach(([label, text]) => {
      if (!text) return;
      const block = document.createElement("div");
      block.className = "reasoning-block";
      const lbl = document.createElement("span");
      lbl.className = "label";
      lbl.textContent = label + ":";
      block.appendChild(lbl);
      block.appendChild(document.createTextNode(text));
      reasoningCell.appendChild(block);
    });

    reasoningRow.appendChild(reasoningCell);

    tr.addEventListener("click", () => reasoningRow.classList.toggle("hidden"));

    tbody.appendChild(tr);
    tbody.appendChild(reasoningRow);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
}

// ---------- init ----------

fetch(`data.json?v=${Date.now()}`)
  .then((r) => r.json())
  .then((data) => {
    document.getElementById("last-updated").textContent = fmtDate(data.generated_at);
    renderKPIs(data.kpis);
    renderEquityCurve(data.equity_curve, data.kpis.starting_capital);
    renderExitBreakdown(data.exit_breakdown);
    renderDteBreakdown(data.dte_breakdown);
    renderTodBreakdown(data.tod_breakdown);
    renderBudgetTrend(data.budget_trend, data.daily_budget_usd);
    renderBlockedCandidates(data.blocked_breakdown || []);
    renderScannerCaseStudy(data.daily_performance, data.scanner_events);
    renderChangelog(data.changelog || []);
    renderTradeLog(data.trades);
  })
  .catch((err) => {
    document.getElementById("app").innerHTML = `<p class="empty-state">Failed to load data.json: ${err.message}</p>`;
  });
