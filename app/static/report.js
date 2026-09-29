const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const usd = (v) => "$" + Math.round(v).toLocaleString("en-US");
const kfmt = (v) => (v === 0 ? "$0" : "$" + (v / 1000).toLocaleString("en-US") + "k");
const FMT = {
  int: (v) => Math.round(v).toLocaleString("en-US"),
  usd, r2: (v) => v.toFixed(3), pct: (v) => Math.round(v * 100) + "%",
};
const get = (o, path) => path.split(".").reduce((a, k) => a?.[k], o);
const SMOKER = [
  { key: "no", name: "Non-smoker", color: "var(--series-1)" },
  { key: "yes", name: "Smoker", color: "var(--series-2)" },
];
const tip = $("#tip");
const charts = [];

// ---------- shared tooltip
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > innerWidth - 4) x = ev.clientX - w - pad;
  if (y + h > innerHeight - 4) y = ev.clientY - h - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
const hideTip = () => (tip.hidden = true);

// Clean axis: a step of 1/2/2.5/5 x 10^k giving about n intervals, and a max on that step.
function niceScale(v, n = 4) {
  const raw = v / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
  const max = Math.ceil(v / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}
function box(el, ratio = 0.52, min = 240, max = 380) {
  const W = Math.max(320, Math.round(el.clientWidth || 860));
  return { W, H: Math.round(Math.min(max, Math.max(min, W * ratio))), narrow: W < 600 };
}
function svgPoint(svg, ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// ---------- scatter: points {x, y, g}, grouped by SMOKER
function scatter(el, pts, o) {
  const { W, H, narrow } = box(el);
  const m = { t: 12, r: 16, b: 44, l: narrow ? 52 : 62 };
  const xmin = o.xmin, xmax = o.xmax;
  const { max: ymax, ticks: yt } = niceScale(o.ymax ?? Math.max(...pts.map((p) => p.y)));
  const x = (v) => m.l + ((v - xmin) / (xmax - xmin)) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const r = narrow ? 3 : 4;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label}"><g class="axis">`;
  for (const t of yt) {
    s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${kfmt(t)}</text>`;
  }
  for (const t of o.xticks) s += `<text x="${x(t)}" y="${H - m.b + 18}" text-anchor="middle">${o.xfmt ? o.xfmt(t) : t}</text>`;
  s += `<text class="atitle" x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">${o.xLabel}</text></g>`;
  for (const ref of o.refs || []) {
    if (ref.type === "v") s += `<line class="ref" x1="${x(ref.at)}" x2="${x(ref.at)}" y1="${m.t}" y2="${H - m.b}"/>` +
      `<text class="reflbl" x="${x(ref.at) + 6}" y="${m.t + 12}">${ref.label}</text>`;
    if (ref.type === "diag") { const e = Math.min(xmax, ymax);
      s += `<line class="ref" x1="${x(0)}" y1="${y(0)}" x2="${x(e)}" y2="${y(e)}"/>` +
        `<text class="reflbl" x="${x(e * 0.96) - 10}" y="${y(e * 0.96)}" text-anchor="end">${ref.label}</text>`; }
  }
  for (const g of SMOKER) for (const p of pts.filter((p) => p.g === g.key))
    s += `<circle cx="${x(p.x).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${r}" fill="${g.color}" fill-opacity=".72" stroke="var(--surface-1)" stroke-width="1"/>`;
  s += `<circle id="hl" r="${r + 3}" fill="none" stroke="var(--text-primary)" stroke-width="2" visibility="hidden"/>`;
  s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
  el.innerHTML = s;
  const svg = $("svg", el), hl = $("#hl", el);
  $(".hit", el).addEventListener("pointermove", (ev) => {
    const q = svgPoint(svg, ev);
    let best, bd = Infinity;
    for (const p of pts) { const d = (x(p.x) - q.x) ** 2 + (y(p.y) - q.y) ** 2; if (d < bd) { bd = d; best = p; } }
    if (bd > 30 ** 2) { hl.setAttribute("visibility", "hidden"); return hideTip(); }
    hl.setAttribute("cx", x(best.x)); hl.setAttribute("cy", y(best.y)); hl.setAttribute("visibility", "visible");
    showTip(ev, o.tip(best));
  });
  $(".hit", el).addEventListener("pointerleave", () => { hl.setAttribute("visibility", "hidden"); hideTip(); });
}

// ---------- horizontal bars / dot-and-whisker: rows {label, v, sd?, hl?, tip}
function hbars(el, rows, o) {
  const { W, narrow } = box(el);
  const labelW = Math.min(narrow ? 132 : 280, W * 0.46);
  const band = narrow ? 30 : 32, m = { t: 6, r: 64, b: 30, l: labelW + 12 };
  const H = m.t + m.b + band * rows.length;
  const { max: vmax, ticks: vt } = niceScale(Math.max(...rows.map((r) => r.v + (r.sd || 0))), narrow ? 2 : 4);
  const x = (v) => m.l + (v / vmax) * (W - m.l - m.r);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label}"><g class="axis">`;
  for (const t of vt) {
    s += `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${H - m.b}"/>`;
    s += `<text x="${x(t)}" y="${H - m.b + 18}" text-anchor="middle">${o.fmtTick(t)}</text>`;
  }
  s += `</g>`;
  rows.forEach((r, i) => {
    const cy = m.t + band * i + band / 2;
    const fill = r.hl ? "var(--series-1)" : "var(--muted-mark)";
    const lbl = narrow && r.short ? r.short : r.label;
    s += `<text class="blbl${r.hl ? " strong" : ""}" x="${m.l - 10}" y="${cy + 4}" text-anchor="end">${lbl}</text>`;
    if (o.whisker) {
      s += `<line x1="${x(Math.max(0, r.v - r.sd))}" x2="${x(r.v + r.sd)}" y1="${cy}" y2="${cy}" stroke="${fill}" stroke-width="2" stroke-linecap="round"/>`;
      s += `<circle cx="${x(r.v)}" cy="${cy}" r="5" fill="${fill}" stroke="var(--surface-1)" stroke-width="2"/>`;
      s += `<text class="vlbl" x="${x(r.v + r.sd) + 8}" y="${cy + 4}">${o.fmt(r.v)}</text>`;
    } else {
      const h = Math.min(20, band - 10), x0 = x(0), x1 = Math.max(x0 + 4, x(r.v)), rr = 4;
      s += `<path d="M${x0},${cy - h / 2}H${x1 - rr}Q${x1},${cy - h / 2} ${x1},${cy - h / 2 + rr}V${cy + h / 2 - rr}Q${x1},${cy + h / 2} ${x1 - rr},${cy + h / 2}H${x0}Z" fill="${fill}"/>`;
      s += `<text class="vlbl" x="${x1 + 8}" y="${cy + 4}">${o.fmt(r.v)}</text>`;
    }
    s += `<rect class="hitrow" data-i="${i}" x="0" y="${cy - band / 2}" width="${W}" height="${band}" fill="transparent"/>`;
  });
  s += `</svg>`;
  el.innerHTML = s;
  $$(".hitrow", el).forEach((h) => {
    h.addEventListener("pointermove", (ev) => showTip(ev, rows[+h.dataset.i].tip));
    h.addEventListener("pointerleave", hideTip);
  });
}

function table(el, head, rows, hlRow = -1) {
  el.innerHTML = `<tr>${head.map((h, i) => `<th${i ? ' class="n"' : ""}>${h}</th>`).join("")}</tr>` +
    rows.map((r, k) => `<tr${k === hlRow ? ' class="hl"' : ""}>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("");
}

// Short model names for Figure 4 (full descriptions stay in the tooltip).
const CV_NAMES = {
  linear_original: "Original linear", rf_original: "Original Random Forest",
  linear_engineered: "Linear + interactions", rf_engineered: "Random Forest, tuned",
  gbr_engineered: "Gradient boosting", gbr_engineered_huber: "Gradient boosting, Huber",
  gbr_log_target: "Gradient boosting, log target",
};
function cvLabel(k, narrow) {
  const fair = k.endsWith("_no_sex_region"), base = k.replace("_no_sex_region", "");
  let name = CV_NAMES[base] || base;
  if (narrow) name = name.replace("Linear + interactions", "Linear + int.").replace("Gradient boosting", "GB").replace("Random Forest", "RF").replace("Original", "Orig.");
  return name + (fair ? (narrow ? " −s/r" : " − sex/region") : "");
}

// ---------- build
async function main() {
  const [M, R] = await Promise.all([fetch("/api/metrics").then((r) => r.json()), fetch("/api/report").then((r) => r.json())]);

  // inline numbers
  $$("[data-m]").forEach((e) => { const v = get(M, e.dataset.m); e.textContent = (e.hasAttribute("data-sign") && v >= 0 ? "+" : "") + FMT[e.dataset.f](v); });
  $$("[data-r]").forEach((e) => (e.textContent = FMT[e.dataset.f](get(R, e.dataset.r))));
  const L = M.leak_demo.original_protocol;
  $$("[data-leak-pct]").forEach((e) => (e.textContent = FMT.pct(L.test_rows_also_in_train / L.test_rows)));
  $$("[data-fair-cost]").forEach((e) => (e.textContent = usd(M.cv[M.chosen.name].mae - M.cv[M.chosen.base].mae)));
  $$("[data-imp]").forEach((e) => (e.textContent = FMT.pct(M.feature_importance[e.dataset.imp])));
  $$("[data-legend=smoker]").forEach((e) => (e.innerHTML = SMOKER.map((g) => `<span><i class="dot" style="background:${g.color}"></i>${g.name}</span>`).join("")));

  const G = R.groups;
  table($("#groupTable"), ["Group", "People", "Mean charges", "Median charges"], [
    ["Non-smokers", G.non_smoker.n, usd(G.non_smoker.mean), usd(G.non_smoker.median)],
    ["Smokers, BMI < 30", G.smoker_bmi_lt_30.n, usd(G.smoker_bmi_lt_30.mean), usd(G.smoker_bmi_lt_30.median)],
    ["Smokers, BMI ≥ 30", G.smoker_bmi_ge_30.n, usd(G.smoker_bmi_ge_30.mean), usd(G.smoker_bmi_ge_30.median)],
  ]);
  const H = M.holdout;
  table($("#holdoutTable"), ["Model / protocol", "R²", "MAE", "RMSE"], [
    ["Original RF, published protocol (leaky)", L.r2.toFixed(3), usd(L.mae), usd(L.rmse)],
    ["Original RF, honest test", H.rf_original.r2.toFixed(3), usd(H.rf_original.mae), usd(H.rf_original.rmse)],
    ["MedCost, honest test", H.chosen.r2.toFixed(3), usd(H.chosen.mae), usd(H.chosen.rmse)],
  ], 2);
  const cnt = (s) => R.holdout.filter((h) => s == null || h.smoker === s).length;
  const iv = H.interval;
  table($("#coverageTable"), ["Group", "Test people", "Inside 90% range"], [
    ["Smokers", cnt("yes"), FMT.pct(iv.coverage_smokers)],
    ["Non-smokers", cnt("no"), FMT.pct(iv.coverage_non_smokers)],
    ["All", cnt(), FMT.pct(iv.coverage)],
  ], 2);

  const pts = R.points;
  const pointTip = (p) => `<b>${p.src.smoker === "yes" ? "Smoker" : "Non-smoker"}</b><div>Age ${p.src.age} · BMI ${p.src.bmi}</div><div>Charges ${usd(p.src.charges)}</div>`;
  const draw = () => {
    scatter($("#figAge"), pts.map((p) => ({ x: p.age, y: p.charges, g: p.smoker, src: p })),
      { label: "Charges by age", xmin: 16, xmax: 66, xticks: [20, 30, 40, 50, 60], xLabel: "Age", tip: pointTip });
    scatter($("#figBmi"), pts.map((p) => ({ x: p.bmi, y: p.charges, g: p.smoker, src: p })),
      { label: "Charges by BMI", xmin: 14, xmax: 56, xticks: [15, 20, 25, 30, 35, 40, 45, 50, 55], xLabel: "BMI",
        refs: [{ type: "v", at: 30, label: "BMI 30" }], tip: pointTip });
    hbars($("#figLeak"), [
      { label: "Original RF, published (leaky)", short: "Original, leaky", v: L.mae, tip: `<b>Original RF, leaky protocol</b><div>MAE ${usd(L.mae)} · R² ${L.r2.toFixed(3)}</div>` },
      { label: "Original RF, honest test", short: "Original, honest", v: H.rf_original.mae, tip: `<b>Original RF, honest test</b><div>MAE ${usd(H.rf_original.mae)} · R² ${H.rf_original.r2.toFixed(3)}</div>` },
      { label: "MedCost, honest test", short: "MedCost, honest", v: H.chosen.mae, hl: true, tip: `<b>MedCost, honest test</b><div>MAE ${usd(H.chosen.mae)} · R² ${H.chosen.r2.toFixed(3)}</div>` },
    ], { label: "MAE by evaluation protocol", fmt: usd, fmtTick: kfmt });
    const cv = Object.entries(M.cv).filter(([k]) => k !== "mean_baseline").sort((a, b) => a[1].mae - b[1].mae);
    hbars($("#figCv"), cv.map(([k, v]) => ({
      label: cvLabel(k, false), short: cvLabel(k, true),
      v: v.mae, sd: v.mae_std, hl: k === M.chosen.name,
      tip: `<b>${v.description}</b><div>MAE ${usd(v.mae)} ± ${usd(v.mae_std).slice(1)}</div><div>R² ${v.r2.toFixed(3)} · RMSE ${usd(v.rmse)}</div>`,
    })), { label: "Cross-validated MAE by model", whisker: true, fmt: usd, fmtTick: kfmt });
    scatter($("#figPva"), R.holdout.map((h) => ({ x: h.actual, y: h.pred, g: h.smoker, src: h })),
      { label: "Predicted vs actual", xmin: 0, xmax: 60000, ymax: 60000, xticks: [0, 20000, 40000, 60000], xfmt: kfmt,
        xLabel: "Actual charges", refs: [{ type: "diag", label: "perfect prediction" }],
        tip: (p) => `<b>${p.src.smoker === "yes" ? "Smoker" : "Non-smoker"}</b><div>Actual ${usd(p.src.actual)}</div><div>Predicted ${usd(p.src.pred)}</div><div>90% range ${usd(p.src.lo)}–${usd(p.src.hi)}</div>` });
    hbars($("#figImp"), Object.entries(M.feature_importance).map(([k, v]) => ({
      label: k.replace(/_/g, " × ").replace("age × sq", "age²"), v, hl: k === "smoker_bmi",
      tip: `<b>${k}</b><div>${(v * 100).toFixed(1)}% of loss reduction</div>`,
    })), { label: "Feature importance", fmt: (v) => (v * 100).toFixed(1) + "%", fmtTick: (v) => Math.round(v * 100) + "%" });
  };
  draw();
  let rz;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(draw, 150); });
  document.body.dataset.ready = "1";
}
main();
