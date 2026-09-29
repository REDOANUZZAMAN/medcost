const $ = (s) => document.querySelector(s);
const usd = (v) => "$" + Math.round(v).toLocaleString("en-US");
const form = $("#form");

// ---------- form helpers
$("#age").addEventListener("input", (e) => ($("#ageOut").textContent = e.target.value));

function bmiFromHW() {
  const h = parseFloat($("#height").value), w = parseFloat($("#weight").value);
  if (h > 0 && w > 0) $("#bmi").value = (w / (h / 100) ** 2).toFixed(1);
  bmiHint();
}
function bmiHint() {
  const b = parseFloat($("#bmi").value);
  const cat = !b ? "" : b < 18.5 ? "underweight" : b < 25 ? "healthy weight" : b < 30 ? "overweight" : "obese (BMI ≥ 30)";
  $("#bmiHint").textContent = b ? `BMI ${b.toFixed(1)} — ${cat}` : "";
}
$("#height").addEventListener("input", bmiFromHW);
$("#weight").addEventListener("input", bmiFromHW);
$("#bmi").addEventListener("input", bmiHint);
bmiHint();

// ---------- predict
async function estimate(e) {
  e && e.preventDefault();
  const f = new FormData(form);
  const body = {
    age: +f.get("age"), bmi: +f.get("bmi"), children: +f.get("children"),
    smoker: f.get("smoker"), sex: f.get("sex"), region: f.get("region"),
  };
  const r = await fetch("/api/predict", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    $("#warn").innerHTML = `<div class="warnbox">Please check your inputs (BMI must be 10–80).</div>`;
    return;
  }
  render(await r.json());
}
form.addEventListener("submit", estimate);
form.addEventListener("change", () => estimate());

function render(d) {
  $("#pred").textContent = usd(d.prediction);
  $("#rangeText").textContent =
    `${Math.round(d.coverage * 100)}% of similar people pay between ${usd(d.low)} and ${usd(d.high)} a year.`;
  const max = Math.max(d.high * 1.1, 1);
  $("#rangebar").hidden = false;
  $("#rbFill").style.left = (d.low / max) * 100 + "%";
  $("#rbFill").style.width = ((d.high - d.low) / max) * 100 + "%";
  $("#rbDot").style.left = (d.prediction / max) * 100 + "%";
  $("#rbLo").textContent = usd(d.low);
  $("#rbHi").textContent = usd(d.high);
  $("#warn").innerHTML = d.warnings.map((w) => `<div class="warnbox">⚠ ${w}</div>`).join("");
  $("#whatif").innerHTML = d.what_if.map((w) => {
    const cls = w.delta < 0 ? "down" : "up";
    const sign = w.delta < 0 ? "−" : "+";
    return `<li><span>${w.label}</span><span class="d ${cls}">${usd(w.prediction)}
      <small>(${sign}${usd(Math.abs(w.delta))})</small></span></li>`;
  }).join("");
  drawChart(d.curve);
}

// ---------- age curve: 2-series line chart with crosshair tooltip
function drawChart(c) {
  last = c;
  $("#chartCard").hidden = false;
  const series = [
    { name: "You", vals: c.you, color: "var(--series-1)" },
    { name: `If ${c.other_label}`, vals: c.other, color: "var(--series-2)" },
  ];
  $("#legend").innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");

  const W = Math.max(340, Math.round($("#chart").clientWidth || 960));
  const H = Math.round(Math.min(340, Math.max(240, W * 0.55)));
  const m = { t: 16, r: W < 600 ? 78 : 92, b: 34, l: W < 600 ? 48 : 64 };
  const xs = c.ages, ymax = niceMax(Math.max(...c.you, ...c.other));
  const x = (a) => m.l + ((a - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * ymax);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated charges by age">`;
  svg += `<g class="axis">`;
  for (const t of ticks) {
    svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text x="${m.l - 10}" y="${y(t) + 4}" text-anchor="end">${t >= 1000 ? "$" + t / 1000 + "k" : "$0"}</text>`;
  }
  for (const a of (W < 600 ? [18, 30, 45, 64] : [18, 25, 35, 45, 55, 64])) svg += `<text x="${x(a)}" y="${H - 10}" text-anchor="middle">${a}</text>`;
  svg += `</g>`;
  for (const s of series) {
    const d = s.vals.map((v, i) => `${i ? "L" : "M"}${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = s.vals[s.vals.length - 1];
    svg += `<text class="dl" x="${W - m.r + 8}" y="${y(last) + 4}">${s.name.replace("If ", "")}</text>`;
  }
  svg += `<line id="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-muted)" stroke-width="1" visibility="hidden"/>`;
  for (const s of series) svg += `<circle class="hv" r="5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="2" visibility="hidden"/>`;
  svg += `<rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>`;
  svg += `</svg><div class="tip" id="tip" hidden></div>`;
  $("#chart").innerHTML = svg;

  const el = $("#chart svg"), tip = $("#tip"), xh = $("#xh"), dots = [...el.querySelectorAll(".hv")];
  const move = (ev) => {
    const pt = el.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM().inverse());
    let i = 0;
    xs.forEach((a, k) => { if (Math.abs(x(a) - p.x) < Math.abs(x(xs[i]) - p.x)) i = k; });
    xh.setAttribute("x1", x(xs[i])); xh.setAttribute("x2", x(xs[i])); xh.setAttribute("visibility", "visible");
    series.forEach((s, k) => {
      dots[k].setAttribute("cx", x(xs[i])); dots[k].setAttribute("cy", y(s.vals[i]));
      dots[k].setAttribute("visibility", "visible");
    });
    tip.hidden = false;
    tip.innerHTML = `<b>Age ${xs[i]}</b>` + series.map((s) => `<div><i style="background:${s.color}"></i>${s.name}: ${usd(s.vals[i])}</div>`).join("");
    const box = $("#chart").getBoundingClientRect();
    const px = (x(xs[i]) / W) * box.width;
    tip.style.left = Math.min(px + 12, box.width - tip.offsetWidth - 4) + "px";
    tip.style.top = "10px";
  };
  const leave = () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
  $("#hit").addEventListener("pointermove", move);
  $("#hit").addEventListener("pointerleave", leave);

  $("#chartTable").innerHTML = `<table><tr><th>Age</th>${series.map((s) => `<th class="n">${s.name}</th>`).join("")}</tr>` +
    xs.map((a, i) => `<tr><td>${a}</td>${series.map((s) => `<td class="n">${usd(s.vals[i])}</td>`).join("")}</tr>`).join("") + `</table>`;
}
function niceMax(v) {
  const step = 10 ** Math.floor(Math.log10(v)) / 2;
  return Math.ceil(v / step) * step;
}

// ---------- honest-evaluation section
async function loadMetrics() {
  const m = await (await fetch("/api/metrics")).json();
  const ds = m.dataset, leak = m.leak_demo.original_protocol, h = m.holdout;
  const pct = (a, b) => Math.round((a / b) * 100) + "%";
  $("#facts").innerHTML = [
    [ds.duplicate_rows.toLocaleString(), `of the original CSV's ${ds.rows_in_original_csv.toLocaleString()} rows are exact duplicates — only ${ds.unique_rows.toLocaleString()} people are unique.`],
    [pct(leak.test_rows_also_in_train, leak.test_rows), `of the original test set was also in its training set, so its R² ${leak.r2.toFixed(2)} was partly memorisation.`],
    [usd(h.chosen.mae), `average error of MedCost on people it never saw (original model: ${usd(h.rf_original.mae)}).`],
  ].map(([n, t]) => `<div class="card fact"><div class="num">${n}</div><p>${t}</p></div>`).join("");

  $("#cmp").innerHTML = `<tr><th>How it was scored</th><th class="n">R²</th><th class="n">Avg error (MAE)</th><th class="n">RMSE</th></tr>` +
    [["Original project, as published (duplicates leak into test)", leak, "bad"],
     ["Original model, honest test (unique rows, unseen people)", h.rf_original, ""],
     ["MedCost, same honest test", h.chosen, "hl"]]
      .map(([n, s, c]) => `<tr class="${c}"><td>${n}</td><td class="n">${s.r2.toFixed(3)}</td><td class="n">${usd(s.mae)}</td><td class="n">${usd(s.rmse)}</td></tr>`).join("");
  const iv = h.interval;
  $("#cmpNote").textContent = `The 90% range contained the true charge for ${Math.round(iv.coverage * 100)}% of the ${iv.n_test} test people ` +
    `(smokers ${Math.round(iv.coverage_smokers * 100)}%, non-smokers ${Math.round(iv.coverage_non_smokers * 100)}%). ` +
    `The honest test set is 20% of unique people, held out before any model choice.`;

  const rows = Object.entries(m.cv).sort((a, b) => a[1].mae - b[1].mae);
  $("#cv").innerHTML = `<tr><th>Model</th><th class="n">Avg error (MAE)</th><th class="n">R²</th></tr>` +
    rows.map(([k, v]) => `<tr class="${k === m.chosen.name ? "hl" : ""}"><td>${v.description}${k === m.chosen.name ? " ← chosen" : ""}</td>` +
      `<td class="n">${usd(v.mae)} <small>± ${usd(v.mae_std).slice(1)}</small></td><td class="n">${v.r2.toFixed(3)}</td></tr>`).join("");
}

let last;
window.addEventListener("resize", () => { if (last) { clearTimeout(window._rz); window._rz = setTimeout(() => drawChart(last), 150); } });
loadMetrics();
estimate();
