"use strict";

// ----------------------------------------------------------------------------- data
const BUNDLE = window.POP_BUNDLE;
const GEO = window.POP_GEO;
const $ = (id) => document.getElementById(id);
const ROOT = document.querySelector(".viz-root");
const css = (name) => getComputedStyle(ROOT).getPropertyValue(name).trim();

const SRC = Object.fromEntries(BUNDLE.sources.map((s) => [s.id, s]));
const LEVELS = Object.fromEntries(BUNDLE.levels.map((l) => [l.level, l]));
const TOP_LEVEL = BUNDLE.levels[0].level;
const BY_P = {}; // pcode -> {level, i, u}
BUNDLE.levels.forEach((l) => l.units.forEach((u, i) => { BY_P[u.p] = { level: l.level, i, u }; }));
const SEQ = BUNDLE.grid.density.colors;   // sequential blue, light -> dark
const DIV = BUNDLE.grid.diff.colors;      // orange (B higher / decline) - gray - blue (A higher / growth)

const S = {
  a: BUNDLE.sources[0].id,
  b: BUNDLE.sources[1] ? BUNDLE.sources[1].id : "",
  period: BUNDLE.sources[0].periods.length - 1,
  base: 0,
  level: 2,
  metric: "pop",
  grid: false,
  sel: null,           // pcode, or null for national
  sortKey: "a", sortDir: -1, search: "",
};

/** Weights over a source's periods that estimate it at time t. Mirrors pipeline.match_periods. */
function matchPeriods(periods, t) {
  const ts = periods.map((p) => p.t);
  for (let k = 0; k < ts.length; k++) if (Math.abs(ts[k] - t) < 1e-9) return [[k, 1]];
  for (let k = 0; k < ts.length - 1; k++) {
    if (ts[k] < t && t < ts[k + 1]) {
      const w = (t - ts[k]) / (ts[k + 1] - ts[k]);
      return [[k, 1 - w], [k + 1, w]];
    }
  }
  let best = 0;
  ts.forEach((tk, k) => { if (Math.abs(tk - t) < Math.abs(ts[best] - t)) best = k; });
  return Math.abs(ts[best] - t) <= BUNDLE.nearest_tolerance_years + 1e-9 ? [[best, 1]] : null;
}

function weighted(srcId, level, weights) {
  const rows = BUNDLE.values[srcId][level];
  const out = new Float64Array(rows[weights[0][0]].length);
  for (const [k, w] of weights) rows[k].forEach((v, i) => { out[i] += w * v; });
  return out;
}

function describeMatch(srcId, weights) {
  const ps = SRC[srcId].periods;
  if (!weights) return "no estimate near this date";
  if (weights.length === 1) {
    return weights[0][1] === 1 && Math.abs(ps[weights[0][0]].t - curT()) < 1e-9
      ? `${ps[weights[0][0]].id}` : `nearest estimate (${ps[weights[0][0]].id})`;
  }
  return `interpolated: ${weights.map(([k, w]) => `${ps[k].id} ${Math.round(w * 100)}%`).join(" + ")}`;
}

const curT = () => SRC[S.a].periods[S.period].t;

/** Everything the views need for the current filter state at one admin level. */
function context(level) {
  const pa = SRC[S.a].periods;
  const A = Float64Array.from(BUNDLE.values[S.a][level][S.period]);
  const wB = S.b ? matchPeriods(SRC[S.b].periods, curT()) : null;
  const B = wB ? weighted(S.b, level, wB) : null;
  const dt = curT() - pa[S.base].t;
  const base = BUNDLE.values[S.a][level][S.base];
  const growth = dt > 0 ? Array.from(A, (v, i) => (base[i] > 0 ? (Math.pow(v / base[i], 1 / dt) - 1) * 100 : NaN)) : null;
  const units = LEVELS[level].units;
  return { level, units, A, B, wB, growth, dt };
}

// ----------------------------------------------------------------------------- formatting
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtInt = (v) => (Number.isFinite(v) ? nf0.format(v) : "–");
function fmtPop(v) {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e8 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return nf0.format(v);
}
const fmtPct = (v, d = 1) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%` : "–");
const fmtSigned = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtPop(Math.abs(v))}` : "–");
const fmtDens = (v) => (Number.isFinite(v) ? (v >= 100 ? nf0.format(v) : v.toFixed(1)) : "–");
const pctDiff = (a, b) => (b > 0 ? ((a - b) / b) * 100 : NaN);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tToDate = (t) => { const y = Math.floor(t); return new Date(Date.UTC(y, 0, 1) + (t - y) * 365.2425 * 864e5); };
const label = (id) => SRC[id].label;

function round2(v) {
  if (v === 0) return 0;
  const m = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 1);
  return Math.round(v / m) * m;
}

// ----------------------------------------------------------------------------- metrics
const METRICS = {
  pop: { label: () => `${label(S.a)} population`, kind: "seq", needsB: false },
  density: { label: () => `${label(S.a)} density (people/km²)`, kind: "seq", needsB: false },
  growth: { label: () => `${label(S.a)} annual growth since ${SRC[S.a].periods[S.base].id}`, kind: "div", needsB: false },
  popB: { label: () => `${label(S.b)} population (matched date)`, kind: "seq", needsB: true },
  pct: { label: () => `Difference: ${label(S.a)} vs ${label(S.b)} (%)`, kind: "div", needsB: true },
  diff: { label: () => `Difference: ${label(S.a)} − ${label(S.b)} (people)`, kind: "div", needsB: true },
};

function metricValues(ctx) {
  const { A, B, units, growth } = ctx;
  switch (S.metric) {
    case "pop": return Array.from(A);
    case "density": return Array.from(A, (v, i) => v / units[i].area);
    case "growth": return growth || Array.from(A, () => NaN);
    case "popB": return Array.from(B);
    case "pct": return Array.from(A, (v, i) => pctDiff(v, B[i]));
    case "diff": return Array.from(A, (v, i) => v - B[i]);
  }
}

function quantileBreaks(vals, n) {
  const s = vals.filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!s.length) return [1];
  const out = [];
  for (let k = 1; k < n; k++) out.push(round2(s[Math.floor((k / n) * (s.length - 1))]));
  return [...new Set(out)];
}

/** Class breaks + colours for the current metric. */
function scale(ctx, vals) {
  const m = METRICS[S.metric];
  let breaks, fmt;
  if (S.metric === "pop" || S.metric === "popB") {
    breaks = quantileBreaks(Array.from(ctx.A), 7); fmt = fmtPop;   // B shares A's breaks
  } else if (S.metric === "density") {
    breaks = quantileBreaks(vals, 7); fmt = fmtDens;
  } else if (S.metric === "pct") {
    breaks = [-30, -15, -5, 5, 15, 30]; fmt = (v) => `${v > 0 ? "+" : ""}${v}%`;
  } else if (S.metric === "growth") {
    breaks = [-2, -1, 0, 1, 2, 3]; fmt = (v) => `${v > 0 ? "+" : ""}${v}%`;
  } else {
    const s = vals.filter(Number.isFinite).map(Math.abs).sort((x, y) => x - y);
    const q = (p) => round2(s[Math.floor(p * (s.length - 1))] || 1);
    const [q1, q2, q3] = [q(0.4), q(0.75), q(0.95)];
    breaks = [-q3, -q2, -q1, q1, q2, q3]; fmt = fmtSigned;
  }
  const colors = m.kind === "seq" ? SEQ.slice(SEQ.length - breaks.length - 1) : DIV;
  const colorOf = (v) => {
    if (!Number.isFinite(v)) return null;
    let k = 0;
    while (k < breaks.length && v >= breaks[k]) k++;
    return colors[k];
  };
  return { breaks, colors, colorOf, fmt, kind: m.kind };
}

// ----------------------------------------------------------------------------- controls
function option(value, text, selected) {
  const o = document.createElement("option");
  o.value = value; o.textContent = text; o.selected = !!selected;
  return o;
}

function fillControls() {
  const fa = $("f-a"); fa.replaceChildren(...BUNDLE.sources.map((s) => option(s.id, s.label, s.id === S.a)));
  const fb = $("f-b");
  fb.replaceChildren(option("", "None", !S.b), ...BUNDLE.sources.filter((s) => s.id !== S.a).map((s) => option(s.id, s.label, s.id === S.b)));
  const ps = SRC[S.a].periods;
  $("f-period").replaceChildren(...ps.map((p, k) => option(k, p.id, k === S.period)));
  $("f-base").replaceChildren(...ps.map((p, k) => option(k, p.id, k === S.base)));
  $("f-level").replaceChildren(...BUNDLE.levels.map((l) => option(l.level, `${l.name} (${l.units.length})`, l.level === S.level)));
  const metrics = Object.entries(METRICS).filter(([, m]) => !m.needsB || S.b);
  if (!metrics.some(([k]) => k === S.metric)) S.metric = "pop";
  $("f-metric").replaceChildren(...metrics.map(([k]) => option(k, METRICS[k].label(), k === S.metric)));
  $("f-base-wrap").hidden = S.metric !== "growth";
  $("f-prev").disabled = S.period === 0;
  $("f-next").disabled = S.period === ps.length - 1;
}

function bindControls() {
  $("f-a").onchange = (e) => {
    S.a = e.target.value;
    if (S.b === S.a) S.b = BUNDLE.sources.find((s) => s.id !== S.a)?.id || "";
    // keep roughly the same date when switching the primary source
    const ps = SRC[S.a].periods; const t = curTSafe();
    S.period = ps.reduce((best, p, k) => (Math.abs(p.t - t) < Math.abs(ps[best].t - t) ? k : best), 0);
    S.base = 0; render();
  };
  $("f-b").onchange = (e) => { S.b = e.target.value; render(); };
  $("f-period").onchange = (e) => { S.period = +e.target.value; if (S.base > S.period) S.base = 0; render(); };
  $("f-prev").onclick = () => { if (S.period > 0) { S.period--; render(); } };
  $("f-next").onclick = () => { if (S.period < SRC[S.a].periods.length - 1) { S.period++; render(); } };
  $("f-base").onchange = (e) => { S.base = +e.target.value; render(); };
  $("f-level").onchange = (e) => { S.level = +e.target.value; render({ refit: false }); };
  $("f-metric").onchange = (e) => { S.metric = e.target.value; render(); };
  $("f-grid").onchange = (e) => { S.grid = e.target.checked; render(); };
  $("unit-reset").onclick = () => { S.sel = null; render(); };
  $("t-search").oninput = (e) => { S.search = e.target.value.trim().toLowerCase(); renderTable(context(S.level)); };
  $("t-csv").onclick = downloadCsv;
  $("theme-toggle").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    setBasemap(); render();
  };
}
let lastT = null;
const curTSafe = () => (lastT ?? curT());

// ----------------------------------------------------------------------------- map
const isDark = () => css("color-scheme") === "dark";
const map = L.map("map", { zoomSnap: 0.25, attributionControl: true }).setView([9, 40.5], 6);
const canvas = L.canvas({ padding: 0.3 });
let basemap = null;
function setBasemap() {
  if (basemap) basemap.remove();
  const style = isDark() ? "Dark_Gray_Base" : "Light_Gray_Base";
  basemap = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}/MapServer/tile/{z}/{y}/{x}`, {
    attribution: "Basemap &copy; Esri", maxZoom: 16,
  }).addTo(map);
  basemap.bringToBack();
}
setBasemap();
map.createPane("outline"); map.getPane("outline").style.zIndex = 450; map.getPane("outline").style.pointerEvents = "none";
map.createPane("grid"); map.getPane("grid").style.zIndex = 350;

const layers = {};          // level -> L.GeoJSON
const featureByIdx = {};    // level -> [layer]
let outline = null, gridOverlay = null, legend = null;
let VIEW = null;            // {ctx, vals, sc} for the current map level

function ensureLayer(level) {
  if (layers[level]) return layers[level];
  featureByIdx[level] = [];
  layers[level] = L.geoJSON(GEO[level], {
    renderer: canvas,
    style: () => ({ weight: 0.5 }),
    onEachFeature: (f, lyr) => {
      featureByIdx[level][f.properties.i] = lyr;
      lyr.bindTooltip(() => tipHtml(level, f.properties.i), { sticky: true, className: "unit-tip", direction: "top", offset: [0, -8] });
      lyr.on("click", () => { S.sel = f.properties.p; render(); });
      lyr.on("mouseover", () => lyr.setStyle({ weight: 2, color: css("--emph") }));
      lyr.on("mouseout", () => styleLayer(level));
    },
  });
  return layers[level];
}

function styleLayer(level) {
  if (!layers[level] || !VIEW) return;
  const line = css("--map-line"), emph = css("--emph");
  layers[level].setStyle((f) => {
    const i = f.properties.i;
    const c = VIEW.sc.colorOf(VIEW.vals[i]);
    const sel = f.properties.p === S.sel;
    return {
      fillColor: c || "transparent",
      fillOpacity: S.grid ? 0 : c ? 0.88 : 0,
      color: sel ? emph : line,
      weight: sel ? 2.5 : level === 3 ? 0.25 : 0.6,
    };
  });
  const s = S.sel && BY_P[S.sel];
  if (s && s.level === level) featureByIdx[level][s.i]?.bringToFront();
}

function tipHtml(level, i) {
  const { ctx, vals } = VIEW;
  const u = LEVELS[level].units[i];
  const rows = [[`${label(S.a)}`, fmtInt(ctx.A[i])]];
  if (ctx.B) rows.push([`${label(S.b)}`, fmtInt(ctx.B[i])], ["Difference", fmtPct(pctDiff(ctx.A[i], ctx.B[i]))]);
  if (S.metric === "density") rows.push(["People/km²", fmtDens(vals[i])]);
  if (S.metric === "growth") rows.push(["Growth / yr", fmtPct(vals[i], 2)]);
  return `<b>${esc(u.n)}</b> <span class="muted">${esc(u.p)}</span><br>` +
    rows.map(([k, v]) => `${esc(k)}: <span class="tv">${v}</span>`).join("<br>");
}

function renderMap(ctx, opts) {
  const vals = metricValues(ctx);
  const sc = scale(ctx, vals);
  VIEW = { ctx, vals, sc };
  for (const lv of Object.keys(layers)) if (+lv !== S.level) map.removeLayer(layers[lv]);
  const lyr = ensureLayer(S.level);
  if (!map.hasLayer(lyr)) lyr.addTo(map);
  styleLayer(S.level);

  // Region outlines for orientation when looking at finer levels.
  if (S.level !== TOP_LEVEL) {
    if (!outline) outline = L.geoJSON(GEO[TOP_LEVEL], { pane: "outline", interactive: false, renderer: L.canvas({ pane: "outline" }) });
    outline.setStyle({ color: css("--emph"), weight: 1.2, opacity: 0.55, fill: false });
    if (!map.hasLayer(outline)) outline.addTo(map);
  } else if (outline && map.hasLayer(outline)) map.removeLayer(outline);

  renderGridOverlay(ctx);
  renderLegend(sc);
  if (opts.zoomToSel && S.sel && BY_P[S.sel].level === S.level) {
    const f = featureByIdx[S.level][BY_P[S.sel].i];
    if (f) map.fitBounds(f.getBounds(), { maxZoom: 9, padding: [40, 40] });
  }
}

/** Which pre-rendered 1 km PNG fits the current view, plus its legend. */
function gridChoice(ctx) {
  const nearest = (srcId) => {
    const ps = SRC[srcId].periods;
    return ps.reduce((b, p) => (Math.abs(p.t - curT()) < Math.abs(b.t - curT()) ? p : b), ps[0]);
  };
  if ((S.metric === "pct" || S.metric === "diff") && S.b) {
    const comp = BUNDLE.comparisons.find((c) => c.a === S.a && c.b === S.b);
    if (comp && comp.pairs.length) {
      const tOf = (id) => SRC[S.b].periods.find((p) => p.id === id).t;
      const pair = comp.pairs.reduce((b, p) => (Math.abs(tOf(p.b_period) - curT()) < Math.abs(tOf(b.b_period) - curT()) ? p : b));
      return {
        url: `data/grid/diff_${S.a}__${S.b}_${pair.b_period}.png`, kind: "diff",
        note: `1 km grid: ${label(S.a)} − ${label(S.b)} ${pair.b_period} (${label(S.a)} ${pair.a_weights.map(([id, w]) => (pair.a_weights.length > 1 ? `${id} ${Math.round(w * 100)}%` : id)).join(" + ")}).`,
      };
    }
  }
  const src = S.metric === "popB" && S.b ? S.b : S.a;
  const p = src === S.a ? SRC[S.a].periods[S.period] : nearest(src);
  return { url: `data/grid/${src}_${p.id}.png`, kind: "density", note: `1 km grid: ${label(src)} ${p.id} population density.` };
}

function renderGridOverlay(ctx) {
  if (gridOverlay) { map.removeLayer(gridOverlay); gridOverlay = null; }
  VIEW.grid = null;
  if (!S.grid) return;
  const g = gridChoice(ctx);
  gridOverlay = L.imageOverlay(g.url, BUNDLE.grid.bounds, { pane: "grid", opacity: 0.92, className: "grid-img" }).addTo(map);
  VIEW.grid = g;
}

function legendRows(breaks, colors, fmt, kind) {
  const rows = [];
  for (let k = 0; k < colors.length; k++) {
    let t;
    if (k === 0) t = `< ${fmt(breaks[0])}`;
    else if (k === breaks.length) t = `≥ ${fmt(breaks[k - 1])}`;
    else t = `${fmt(breaks[k - 1])} to ${fmt(breaks[k])}`;
    rows.push(`<div class="r"><span class="swatch" style="background:${colors[k]}"></span>${t}</div>`);
  }
  return (kind === "div" ? rows.reverse() : rows.reverse()).join("");
}

function renderLegend(sc) {
  if (legend) legend.remove();
  legend = L.control({ position: "bottomright" });
  legend.onAdd = () => {
    const d = L.DomUtil.create("div", "legend");
    let html;
    if (VIEW.grid) {
      const g = BUNDLE.grid[VIEW.grid.kind];
      const title = VIEW.grid.kind === "diff" ? `${esc(label(S.a))} − ${esc(label(S.b))}<br>(people/km²)` : "People per km² (1 km grid)";
      html = `<div class="t">${title}</div>` + legendRows(g.breaks, g.colors, (v) => (VIEW.grid.kind === "diff" ? `${v > 0 ? "+" : ""}${nf0.format(v)}` : nf0.format(v)), "seq");
      if (VIEW.grid.kind === "diff") html += `<div class="r muted">blue = ${esc(label(S.a))} higher</div>`;
    } else {
      html = `<div class="t">${esc(METRICS[S.metric].label())}</div>` + legendRows(sc.breaks, sc.colors, sc.fmt, sc.kind);
      if (S.metric === "pct" || S.metric === "diff") html += `<div class="r muted">blue = ${esc(label(S.a))} higher</div>`;
    }
    d.innerHTML = html;
    return d;
  };
  legend.addTo(map);
}

// ----------------------------------------------------------------------------- tiles & side panel
function nationalSeries(srcId) {
  return BUNDLE.values[srcId][TOP_LEVEL].map((row) => row.reduce((s, v) => s + v, 0));
}

function renderTiles() {
  const ps = SRC[S.a].periods;
  const natA = nationalSeries(S.a);
  const a = natA[S.period];
  const tiles = [];
  const unassigned = BUNDLE.national[S.a].unassigned[S.period];
  tiles.push({ k: `${label(S.a)} · ${ps[S.period].id}`, sw: css("--series-1"), v: fmtPop(a), s: `${fmtInt(a)} within admin boundaries; ${fmtPop(unassigned)} outside` });
  if (S.b) {
    const w = matchPeriods(SRC[S.b].periods, curT());
    if (w) {
      const natB = nationalSeries(S.b);
      const b = w.reduce((s, [k, wt]) => s + wt * natB[k], 0);
      tiles.push({ k: `${label(S.b)} · matched`, sw: css("--series-2"), v: fmtPop(b), s: describeMatch(S.b, w) });
      tiles.push({ k: "Difference", v: fmtPct(pctDiff(a, b)), s: `${fmtSigned(a - b)} people (${label(S.a)} − ${label(S.b)})` });
    } else {
      tiles.push({ k: label(S.b), v: "–", s: "no estimate near this date" });
    }
  }
  const dt = ps[S.period].t - ps[0].t;
  if (dt > 0) tiles.push({ k: `${label(S.a)} growth`, v: fmtPct((Math.pow(a / natA[0], 1 / dt) - 1) * 100, 2) + "/yr", s: `annualised, ${ps[0].id} → ${ps[S.period].id}` });
  tiles.push({ k: "Populated cells", v: fmtPop(BUNDLE.national[S.a].settled_cells[S.period]), s: `${label(S.a)} native-resolution cells with people` });
  $("tiles").innerHTML = tiles.map((t) => `<div class="tile"><div class="k">${t.sw ? `<span class="swatch" style="background:${t.sw}"></span>` : ""}${esc(t.k)}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`).join("");
}

/** Time series for a unit (or national) for one source: [{t, v}]. */
function unitSeries(srcId, sel) {
  if (!sel) return SRC[srcId].periods.map((p, k) => ({ t: p.t, id: p.id, v: nationalSeries(srcId)[k] }));
  const { level, i } = BY_P[sel];
  return SRC[srcId].periods.map((p, k) => ({ t: p.t, id: p.id, v: BUNDLE.values[srcId][level][k][i] }));
}

function renderSide() {
  const sel = S.sel && BY_P[S.sel] ? BY_P[S.sel] : null;
  $("unit-reset").hidden = !sel;
  let A, B, area, w = S.b ? matchPeriods(SRC[S.b].periods, curT()) : null, growth = NaN;
  const dt = curT() - SRC[S.a].periods[S.base].t;
  if (sel) {
    const ctx = context(sel.level);
    A = ctx.A[sel.i]; B = ctx.B ? ctx.B[sel.i] : NaN; area = sel.u.area; growth = ctx.growth ? ctx.growth[sel.i] : NaN;
    $("unit-level").textContent = `${LEVELS[sel.level].name} · ${sel.u.p}`;
    $("unit-name").textContent = sel.u.n;
    const path = []; let up = sel.u.up;
    while (up && BY_P[up]) { path.push(BY_P[up].u.n); up = BY_P[up].u.up; }
    $("unit-path").textContent = path.join(" › ");
  } else {
    A = nationalSeries(S.a)[S.period];
    B = w ? w.reduce((s, [k, wt]) => s + wt * nationalSeries(S.b)[k], 0) : NaN;
    area = LEVELS[TOP_LEVEL].units.reduce((s, u) => s + u.area, 0);
    const base = nationalSeries(S.a)[S.base];
    growth = dt > 0 ? (Math.pow(A / base, 1 / dt) - 1) * 100 : NaN;
    $("unit-level").textContent = "National";
    $("unit-name").textContent = "Ethiopia";
    $("unit-path").textContent = "Click a unit on the map or in a table to drill in";
  }
  const nat = nationalSeries(S.a)[S.period];
  const rows = [
    [`${label(S.a)} (${SRC[S.a].periods[S.period].id})`, fmtInt(A), css("--series-1")],
  ];
  if (S.b) {
    rows.push([`${label(S.b)} (matched)`, fmtInt(B), css("--series-2")]);
    rows.push(["Difference", `${fmtSigned(A - B)} (${fmtPct(pctDiff(A, B))})`]);
  }
  rows.push(["Area", `${fmtInt(area)} km²`], ["Density", `${fmtDens(A / area)} /km²`]);
  if (sel) rows.push(["Share of national", `${((A / nat) * 100).toFixed(2)}%`]);
  if (dt > 0) rows.push([`Growth since ${SRC[S.a].periods[S.base].id}`, `${fmtPct(growth, 2)}/yr`]);
  $("unit-stats").innerHTML = rows.map(([k, v, c]) => `<dt>${c ? `<span class="swatch" style="background:${c}"></span>` : ""}${esc(k)}</dt><dd>${v}</dd>`).join("");
  renderTimeSeries();
}

// ----------------------------------------------------------------------------- charts
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const PLOTLY_CFG = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toggleSpikelines"] };
function axis(extra = {}) {
  return { gridcolor: css("--grid"), linecolor: css("--axis"), zeroline: false, tickfont: { color: css("--text-muted"), size: 11 },
    title: { font: { color: css("--text-secondary"), size: 12 } }, automargin: true, ...extra };
}
function baseLayout(extra = {}) {
  return {
    paper_bgcolor: css("--surface-1"), plot_bgcolor: css("--surface-1"),
    font: { family: FONT, size: 12, color: css("--text-secondary") },
    margin: { l: 10, r: 10, t: 30, b: 10 },
    hoverlabel: { bgcolor: css("--surface-1"), bordercolor: css("--axis"), font: { family: FONT, color: css("--text-primary") } },
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { color: css("--text-primary") } },
    ...extra,
  };
}

function renderTimeSeries() {
  const ser = [[S.a, "--series-1"]];
  if (S.b) ser.push([S.b, "--series-2"]);
  const traces = ser.map(([id, c]) => {
    const s = unitSeries(id, S.sel);
    return {
      x: s.map((d) => tToDate(d.t)), y: s.map((d) => d.v), customdata: s.map((d) => d.id),
      name: label(id), mode: "lines+markers", type: "scatter",
      line: { color: css(c), width: 2 }, marker: { color: css(c), size: 8, line: { color: css("--surface-1"), width: 2 } },
      hovertemplate: "%{customdata}: %{y:,.0f}<extra>" + esc(label(id)) + "</extra>",
    };
  });
  const tx = tToDate(curT());
  Plotly.react("ts", traces, baseLayout({
    xaxis: axis({ type: "date", hoverformat: "%b %Y" }),
    yaxis: axis({ tickformat: "~s", rangemode: "normal" }),
    hovermode: "x unified",
    showlegend: traces.length > 1,
    shapes: [{ type: "line", xref: "x", yref: "paper", x0: tx, x1: tx, y0: 0, y1: 1, line: { color: css("--axis"), width: 1 } }],
  }), PLOTLY_CFG);
  $("ts-note").textContent = S.b
    ? `${label(S.a)}: ${SRC[S.a].cadence}ly estimates; ${label(S.b)}: ${SRC[S.b].cadence}ly estimates plotted at their reference date. Vertical rule = selected period.`
    : "Vertical rule = selected period.";
}

function renderScatter(ctx) {
  const el = $("scatter");
  $("scatter-title").textContent = `${LEVELS[ctx.level].name}-level agreement`;
  if (!ctx.B) {
    Plotly.purge(el); el.innerHTML = `<p class="subtle">Choose a source under “Compare with” to compare unit totals.</p>`;
    $("scatter-sub").textContent = ""; $("scatter-stats").innerHTML = ""; return;
  }
  if (!el.classList.contains("js-plotly-plot")) el.innerHTML = "";
  const idx = ctx.units.map((_, i) => i).filter((i) => ctx.A[i] > 0 && ctx.B[i] > 0);
  const selI = S.sel && BY_P[S.sel]?.level === ctx.level ? BY_P[S.sel].i : -1;
  const lo = Math.min(...idx.map((i) => Math.min(ctx.A[i], ctx.B[i]))), hi = Math.max(...idx.map((i) => Math.max(ctx.A[i], ctx.B[i])));
  const text = idx.map((i) => `${ctx.units[i].n} (${ctx.units[i].p})<br>${label(S.a)}: ${fmtInt(ctx.A[i])}<br>${label(S.b)}: ${fmtInt(ctx.B[i])}<br>Difference: ${fmtPct(pctDiff(ctx.A[i], ctx.B[i]))}`);
  const traces = [
    { x: [lo, hi], y: [lo, hi], mode: "lines", line: { color: css("--axis"), width: 1 }, hoverinfo: "skip", showlegend: false },
    { x: idx.map((i) => ctx.B[i]), y: idx.map((i) => ctx.A[i]), text, customdata: idx.map((i) => ctx.units[i].p),
      mode: "markers", type: "scatter", showlegend: false, hovertemplate: "%{text}<extra></extra>",
      marker: { color: css("--series-1"), size: ctx.level === 3 ? 7 : 10, opacity: 0.75, line: { color: css("--surface-1"), width: 1 } } },
  ];
  if (selI >= 0) traces.push({ x: [ctx.B[selI]], y: [ctx.A[selI]], mode: "markers", hoverinfo: "skip", showlegend: false,
    marker: { color: css("--emph"), size: 13, line: { color: css("--surface-1"), width: 2 } } });
  Plotly.react(el, traces, baseLayout({
    xaxis: axis({ type: "log", dtick: 1, tickformat: "~s", title: { text: `${label(S.b)} (matched)`, font: { color: css("--text-secondary") } } }),
    yaxis: axis({ type: "log", dtick: 1, tickformat: "~s", title: { text: `${label(S.a)} ${SRC[S.a].periods[S.period].id}`, font: { color: css("--text-secondary") } } }),
    hovermode: "closest", hoverdistance: 20, margin: { l: 10, r: 10, t: 10, b: 10 },
  }), PLOTLY_CFG);
  el.removeAllListeners?.("plotly_click");
  el.on("plotly_click", (ev) => { const p = ev.points[0]?.customdata; if (p) { S.sel = p; render({ zoomToSel: true }); } });

  $("scatter-sub").textContent = `Each dot is one ${LEVELS[ctx.level].name.toLowerCase()}; the line is perfect agreement. ${label(S.b)} ${describeMatch(S.b, ctx.wB)}.`;
  const la = idx.map((i) => Math.log10(ctx.A[i])), lb = idx.map((i) => Math.log10(ctx.B[i]));
  const pd = idx.map((i) => Math.abs(pctDiff(ctx.A[i], ctx.B[i]))).sort((x, y) => x - y);
  const sumA = idx.reduce((s, i) => s + ctx.A[i], 0), sumAbs = idx.reduce((s, i) => s + Math.abs(ctx.A[i] - ctx.B[i]), 0);
  const stats = [
    ["Units compared", fmtInt(idx.length)],
    ["Correlation (log scale)", pearson(la, lb).toFixed(3)],
    ["Median absolute difference", `${pd[Math.floor(pd.length / 2)].toFixed(1)}%`],
    ["Units within ±10%", `${((pd.filter((v) => v <= 10).length / pd.length) * 100).toFixed(0)}%`],
    ["Population-weighted abs. difference", `${((sumAbs / sumA) * 100).toFixed(1)}%`],
  ];
  $("scatter-stats").innerHTML = stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

function pearson(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { const dx = x[k] - mx, dy = y[k] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
}

// ----------------------------------------------------------------------------- tables
function renderGridStats() {
  const t = $("grid-stats");
  if (!S.b) { t.innerHTML = `<tbody><tr><td class="muted">Choose a comparison source.</td></tr></tbody>`; return; }
  let comp = BUNDLE.comparisons.find((c) => c.a === S.a && c.b === S.b), flip = false;
  if (!comp) { comp = BUNDLE.comparisons.find((c) => c.a === S.b && c.b === S.a); flip = true; }
  if (!comp) { t.innerHTML = `<tbody><tr><td class="muted">No grid comparison configured for this pair (add it to config.json → comparisons).</td></tr></tbody>`; return; }
  const [la, lb] = flip ? [label(S.b), label(S.a)] : [label(S.a), label(S.b)];
  const pctf = (v) => `${(v * 100).toFixed(1)}%`;
  t.innerHTML = `<thead><tr><th>${esc(lb)}</th><th>${esc(la)} matched</th><th class="num">${esc(la)} total</th><th class="num">${esc(lb)} total</th>
    <th class="num" title="Pearson correlation of log10(1 + people) across 1 km cells">r (log)</th><th class="num">Allocation disagreement</th>
    <th class="num" title="Share of ${esc(la)} people in cells where ${esc(lb)} has nobody">${esc(la)} where ${esc(lb)} = 0</th>
    <th class="num" title="Share of ${esc(lb)} people in cells where ${esc(la)} has nobody">${esc(lb)} where ${esc(la)} = 0</th></tr></thead><tbody>` +
    comp.pairs.map((p) => `<tr><td>${p.b_period}</td><td class="muted">${p.a_weights.map(([id, w]) => (p.a_weights.length > 1 ? `${id} ${Math.round(w * 100)}%` : id)).join(" + ")}</td>
      <td class="num">${fmtPop(p.total_a)}</td><td class="num">${fmtPop(p.total_b)}</td><td class="num">${p.r_log.toFixed(3)}</td>
      <td class="num">${pctf(p.allocation_disagreement)}</td><td class="num">${pctf(p.share_a_outside_b)}</td><td class="num">${pctf(p.share_b_outside_a)}</td></tr>`).join("") + "</tbody>";
  t.querySelectorAll("tbody tr").forEach((tr) => { tr.style.cursor = "default"; });
}

function renderTopDiff(ctx) {
  const t = $("top-diff");
  if (!ctx.B) { t.innerHTML = `<tbody><tr><td class="muted">Choose a comparison source.</td></tr></tbody>`; return; }
  const idx = ctx.units.map((_, i) => i).sort((x, y) => Math.abs(ctx.A[y] - ctx.B[y]) - Math.abs(ctx.A[x] - ctx.B[x])).slice(0, 10);
  t.innerHTML = `<thead><tr><th>${esc(LEVELS[ctx.level].name)}</th><th class="num">${esc(label(S.a))}</th><th class="num">${esc(label(S.b))}</th><th class="num">Difference</th><th class="num">%</th></tr></thead><tbody>` +
    idx.map((i) => `<tr data-p="${esc(ctx.units[i].p)}" class="${ctx.units[i].p === S.sel ? "sel" : ""}"><td>${esc(ctx.units[i].n)}</td><td class="num">${fmtPop(ctx.A[i])}</td><td class="num">${fmtPop(ctx.B[i])}</td>
      <td class="num">${fmtSigned(ctx.A[i] - ctx.B[i])}</td><td class="num">${fmtPct(pctDiff(ctx.A[i], ctx.B[i]))}</td></tr>`).join("") + "</tbody>";
  bindRowClicks(t);
}

function tableColumns(ctx) {
  const parents = BUNDLE.levels.filter((l) => l.level < ctx.level);
  const cols = [
    { key: "n", label: LEVELS[ctx.level].name, get: (i) => ctx.units[i].n },
    ...parents.slice().reverse().map((l) => ({ key: `up${l.level}`, label: l.name, get: (i) => ancestor(ctx.units[i], l.level)?.n || "" })),
    { key: "p", label: "P-code", get: (i) => ctx.units[i].p },
    { key: "area", label: "Area km²", num: true, get: (i) => ctx.units[i].area, fmt: fmtInt },
    { key: "a", label: `${label(S.a)} ${SRC[S.a].periods[S.period].id}`, num: true, get: (i) => ctx.A[i], fmt: fmtInt },
  ];
  if (ctx.B) {
    cols.push({ key: "b", label: `${label(S.b)} (matched)`, num: true, get: (i) => ctx.B[i], fmt: fmtInt });
    cols.push({ key: "d", label: "Difference", num: true, get: (i) => ctx.A[i] - ctx.B[i], fmt: (v) => fmtSigned(v) });
    cols.push({ key: "pct", label: "Difference %", num: true, get: (i) => pctDiff(ctx.A[i], ctx.B[i]), fmt: (v) => fmtPct(v) });
  }
  cols.push({ key: "dens", label: "Density /km²", num: true, get: (i) => ctx.A[i] / ctx.units[i].area, fmt: fmtDens });
  if (ctx.growth) cols.push({ key: "g", label: `Growth/yr since ${SRC[S.a].periods[S.base].id}`, num: true, get: (i) => ctx.growth[i], fmt: (v) => fmtPct(v, 2) });
  return cols;
}

function ancestor(u, level) {
  let p = u.up;
  while (p && BY_P[p]) { if (BY_P[p].level === level) return BY_P[p].u; p = BY_P[p].u.up; }
  return null;
}

function tableRows(ctx, cols) {
  let idx = ctx.units.map((_, i) => i);
  if (S.search) idx = idx.filter((i) => cols.some((c) => !c.num && String(c.get(i)).toLowerCase().includes(S.search)));
  const col = cols.find((c) => c.key === S.sortKey) || cols.find((c) => c.key === "a");
  idx.sort((x, y) => {
    const vx = col.get(x), vy = col.get(y);
    if (col.num) return ((Number.isFinite(vx) ? vx : -Infinity) - (Number.isFinite(vy) ? vy : -Infinity)) * S.sortDir;
    return String(vx).localeCompare(String(vy)) * S.sortDir;
  });
  return idx;
}

function renderTable(ctx) {
  const cols = tableColumns(ctx);
  const idx = tableRows(ctx, cols);
  $("table-title").textContent = `All ${LEVELS[ctx.level].name.toLowerCase()}s (${idx.length})`;
  const t = $("units-table");
  t.innerHTML = `<thead><tr>${cols.map((c) => `<th data-k="${c.key}" class="${c.num ? "num" : ""}" ${c.key === S.sortKey ? `aria-sort="${S.sortDir > 0 ? "ascending" : "descending"}"` : ""}>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>` +
    idx.map((i) => `<tr data-p="${esc(ctx.units[i].p)}" class="${ctx.units[i].p === S.sel ? "sel" : ""}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.fmt ? c.fmt(c.get(i)) : esc(c.get(i))}</td>`).join("")}</tr>`).join("") + "</tbody>";
  t.querySelectorAll("th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      if (S.sortKey === k) S.sortDir *= -1; else { S.sortKey = k; S.sortDir = cols.find((c) => c.key === k).num ? -1 : 1; }
      renderTable(ctx);
    };
  });
  bindRowClicks(t);
}

function bindRowClicks(t) {
  t.querySelectorAll("tbody tr[data-p]").forEach((tr) => { tr.onclick = () => { S.sel = tr.dataset.p; render({ zoomToSel: true }); }; });
}

function downloadCsv() {
  const ctx = context(S.level);
  const cols = tableColumns(ctx);
  const idx = tableRows(ctx, cols);
  const q = (v) => (typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "") : `"${String(v).replace(/"/g, '""')}"`);
  const lines = [cols.map((c) => q(c.label)).join(","), ...idx.map((i) => cols.map((c) => q(c.get(i))).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ethiopia_${LEVELS[S.level].name.toLowerCase()}_${S.a}_${SRC[S.a].periods[S.period].id}${S.b ? `_vs_${S.b}` : ""}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ----------------------------------------------------------------------------- notes
function renderNotes() {
  const srcs = BUNDLE.sources.map((s) => `<li><b>${esc(s.label)}</b> — ${esc(s.description)} ${s.periods.length} periods (${s.periods[0].id} – ${s.periods[s.periods.length - 1].id}).</li>`).join("");
  $("notes").innerHTML = `<ul>${srcs}
    <li><b>Boundaries:</b> ${esc(BUNDLE.boundaries)}. Each populated raster cell is assigned to the woreda containing its centre (via a 3″ ≈ 90 m label grid); zones and regions are sums of woredas. People in cells outside all woredas are reported as “outside” in the headline tile and excluded from unit totals.</li>
    <li><b>Common grid:</b> every source is also binned to the same 30″ (≈ 1 km) EPSG:4326 grid by cell centre. Pixel statistics and the 1 km layers use that grid.</li>
    <li><b>Matching dates:</b> quarterly estimates are placed at mid-quarter, annual estimates at mid-year (1 July). The comparison source is linearly interpolated to the selected date when bracketed, otherwise the nearest estimate within ${BUNDLE.nearest_tolerance_years} years is used.</li>
    <li><b>Adding a source:</b> add an entry to <code>config.json</code> (and optionally a comparison pair), then run <code>python build.py</code>. Rasters must contain people per cell; any CRS and resolution work.</li>
    <li>Map classes for population and density are quantiles of the primary source at the selected level, so colours are comparable across sources within a view but not across levels. Unit-level CSVs for every source and period are in <code>outputs/admin_population_long.csv</code>.</li>
  </ul>`;
}

// ----------------------------------------------------------------------------- render
function render(opts = {}) {
  fillControls();
  $("subtitle").textContent = `${BUNDLE.sources.map((s) => s.label).join(" · ")} · ${BUNDLE.boundaries}`;
  const ctx = context(S.level);
  renderMap(ctx, opts);
  renderTiles();
  renderSide();
  renderScatter(ctx);
  renderGridStats();
  renderTopDiff(ctx);
  renderTable(ctx);
  const g = VIEW.grid;
  $("map-note").textContent = `${METRICS[S.metric].label()} · ${SRC[S.a].periods[S.period].id}` +
    (S.b ? ` · ${label(S.b)} ${describeMatch(S.b, ctx.wB)}` : "") + (g ? ` · ${g.note}` : "");
  lastT = curT();
}

bindControls();
renderNotes();
render();
const HOME = [[3.4, 33], [14.9, 48]];
const fitHome = () => { map.invalidateSize(); map.fitBounds(HOME); };
requestAnimationFrame(fitHome);
window.addEventListener("load", fitHome);
