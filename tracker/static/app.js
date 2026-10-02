"use strict";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const init = { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/** A toast with an Undo button; stays up a little longer. */
function undoToast(msg, onUndo) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `${esc(msg)} <button type="button" class="toast-undo">Undo</button>`;
  $("button", t).addEventListener("click", () => { t.remove(); onUndo(); });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 8000);
}

function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3500);
}

// --- formatting ----------------------------------------------------------------
const fmtVol = (v) => {
  if (v == null) return "–";
  if (v >= 10) return Math.round(v) + "×";
  if (v >= 1) return v.toFixed(1) + "×";
  if (v >= 0.01) return v.toFixed(2) + "×";
  return v > 0 ? "<0.01×" : "0×";
};
const momPct = (m) => Math.exp(m) - 1;
function fmtPct(p) {
  const n = Math.round(p * 100);
  return (n > 0 ? "+" : "") + n.toLocaleString() + "%";
}
function momHtml(m) {
  if (m == null) return '<span class="delta flat">–</span>';
  const p = momPct(m);
  if (Math.abs(p) < 0.02) return '<span class="delta flat" data-tip="Roughly flat">0%</span>';
  return p > 0
    ? `<span class="delta up" data-tip="Up vs. the previous period">▲ ${fmtPct(p)}</span>`
    : `<span class="delta down" data-tip="Down vs. the previous period">▼ ${fmtPct(p)}</span>`;
}
const score100 = (s) => (s == null ? null : Math.round(s * 100));
function meterHtml(s) {
  const v = score100(s);
  if (v == null) return '<span class="faint">–</span>';
  return `<div class="meter" data-tip="Score ${v} / 100"><div class="meter-track"><div class="meter-fill" style="width:${v}%"></div></div><span>${v}</span></div>`;
}
function relTime(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
function fmtUntil(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (hours < 24) return plural(hours, "hour");
  const d = Math.floor(hours / 24), h = hours % 24;
  return h ? `${plural(d, "day")}, ${plural(h, "hour")}` : plural(d, "day");
}
const CLOCK_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
function fmtDuration(sec) {
  if (sec == null) return "–";
  if (sec < 90) return `${Math.max(1, Math.round(sec))} sec`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}
const SOURCE_LABEL = { pin: "Pinned", seed: "Seed", rising: "Rising search", top: "Popular related", anchor: "Comparison" };
const SOURCE_HELP = {
  pin: "You pinned this keyword",
  seed: "One of your seed keywords",
  rising: "Google listed it as a fast-rising search related to a seed",
  top: "Google listed it as a popular search related to a seed",
  anchor: "The comparison keyword every other keyword is measured against",
};
const STATUS_LABEL = { ok: "Complete", partial: "Partial", failed: "Failed", running: "Running", cancelled: "Cancelled" };
const statusHtml = (s) => `<span class="status ${esc(s)}"><span class="dot"></span>${esc(STATUS_LABEL[s] || s)}</span>`;

function moveHtml(rank, prev, hasPrevRun) {
  if (!hasPrevRun) return '<span class="move same">–</span>';
  if (prev == null) return '<span class="move new" data-tip="New in the list since the last refresh">NEW</span>';
  const d = prev - rank;
  if (d > 0) return `<span class="move up" data-tip="Up ${d} since the last refresh">▲${d}</span>`;
  if (d < 0) return `<span class="move down" data-tip="Down ${-d} since the last refresh">▼${-d}</span>`;
  return '<span class="move same" data-tip="Same position as last time">•</span>';
}

const PIN_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4z" fill="currentColor"/></svg>`;
const PIN_OUTLINE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
function pinBtn(term, pinned) {
  return `<button class="icon-btn pin-toggle ${pinned ? "on" : ""}" data-term="${esc(term)}" data-pinned="${pinned ? 1 : 0}"
    data-tip="${pinned ? "Unpin (stop forcing into the list)" : "Pin (always keep in the ranked list)"}"
    aria-label="${pinned ? "Unpin" : "Pin"} ${esc(term)}">${pinned ? PIN_SVG : PIN_OUTLINE_SVG}</button>`;
}

// ---------------------------------------------------------------------------
// tooltips: any element with data-tip shows it on hover, keyboard focus, or tap
// ---------------------------------------------------------------------------
const INFO_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r="1" fill="currentColor"/></svg>`;
/** A small ⓘ button that explains something on hover or tap. */
const info = (text) => `<button type="button" class="info" data-tip="${esc(text)}" aria-label="${esc(text)}">${INFO_SVG}</button>`;

let tipOwner = null;
function showTipFor(el) {
  tipOwner = el;
  const r = el.getBoundingClientRect();
  tip.show(esc(el.dataset.tip), r.left + r.width / 2 - 14, r.bottom - 6);
}
function hideTip() { tipOwner = null; tip.hide(); }
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el && el !== tipOwner && el.dataset.tip) showTipFor(el);
});
document.addEventListener("mouseout", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el && el === tipOwner && !el.contains(e.relatedTarget)) hideTip();
});
document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el && el.dataset.tip) showTipFor(el); });
document.addEventListener("focusout", (e) => { if (e.target.closest("[data-tip]") === tipOwner) hideTip(); });
document.addEventListener("click", (e) => {
  const b = e.target.closest("button.info");
  if (b) {  // tap support, and keep the click from opening the row underneath
    e.preventDefault(); e.stopPropagation();
    tipOwner === b ? hideTip() : showTipFor(b);
  } else if (tipOwner && tipOwner.matches("button.info")) hideTip();
}, true);
window.addEventListener("scroll", () => tipOwner && hideTip(), { passive: true });

const tip = {
  show(html, x, y) {
    const el = $("#tooltip");
    el.innerHTML = html;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    el.style.left = Math.max(8, left) + "px";
    el.style.top = Math.max(8, top) + "px";
  },
  hide() { $("#tooltip").hidden = true; },
};

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------
function sparkline(values, w = 120, h = 28) {
  if (!values || values.length < 2) return '<span class="faint small">no data</span>';
  const max = Math.max(...values, 1e-9);
  const pad = 4;
  const x = (i) => pad + (i * (w - 2 * pad)) / (values.length - 1);
  const y = (v) => h - pad - (v / max) * (h - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${x(0)},${h - pad} L${pts.join(" L")} L${x(values.length - 1)},${h - pad} Z`;
  const lx = x(values.length - 1), ly = y(values[values.length - 1]);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${area}" style="fill:var(--accent);opacity:.10"/>
    <polyline points="${pts.join(" ")}" style="fill:none;stroke:var(--accent);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round"/>
    <circle cx="${lx}" cy="${ly}" r="3" style="fill:var(--accent);stroke:var(--surface);stroke-width:1.5"/>
  </svg>`;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const tickLabel = (v) => (v === 0 ? "0" : v >= 10 ? Math.round(v) + "×" : (+v.toPrecision(2)) + "×");

// series: [{name, values, color}]
function lineChart(el, dates, series, height = 240) {
  const W = Math.max(el.clientWidth, 300), H = height, m = { l: 46, r: 14, t: 10, b: 26 };
  const n = dates.length;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const step = niceStep(Math.max(...all, 1e-6) / 4);
  const max = Math.ceil(Math.max(...all, 1e-6) / step) * step;
  const x = (i) => m.l + (n === 1 ? 0 : (i * (W - m.l - m.r)) / (n - 1));
  const y = (v) => H - m.b - (v / max) * (H - m.t - m.b);

  let g = "";
  for (let v = 0; v <= max + 1e-9; v += step) {
    g += `<line class="${v === 0 ? "baseline" : "gridline"}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${tickLabel(v)}</text>`;
  }
  // month labels, thinned so they never collide
  const months = [];
  dates.forEach((d, i) => {
    const dt = new Date(d + "T00:00:00");
    const key = dt.getFullYear() * 12 + dt.getMonth();
    if (!months.length || months[months.length - 1].key !== key) months.push({ key, i, dt });
  });
  const every = Math.ceil(months.length / Math.max(2, Math.floor((W - m.l) / 70)));
  months.forEach((mo, k) => {
    if (k % every) return;
    const multiYear = dates.length > 60;
    const label = mo.dt.toLocaleDateString(undefined, multiYear ? { year: "numeric" } : { month: "short" });
    g += `<text class="tick" x="${x(mo.i)}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>`;
  });

  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    if (si === 0) g += `<path d="M${x(0)},${y(0)} L${pts.replaceAll(" ", " L")} L${x(n - 1)},${y(0)} Z" style="fill:${s.color};opacity:.10"/>`;
    g += `<polyline class="line" points="${pts}" style="stroke:${s.color}"/>`;
  });
  g += `<line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
  series.forEach((s) => (g += `<circle class="hover-dot" r="4.5" style="fill:${s.color};stroke:var(--surface);stroke-width:2" visibility="hidden"/>`));
  g += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Line chart of search interest over time">${g}</svg>`;

  const svg = $("svg", el), cross = $(".crosshair", el), dots = $$(".hover-dot", el);
  const hit = $(".hit", el);
  hit.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    series.forEach((s, si) => {
      dots[si].setAttribute("cx", x(i)); dots[si].setAttribute("cy", y(s.values[i] ?? 0)); dots[si].setAttribute("visibility", "visible");
    });
    const rows = series.map((s) => `<div class="t-row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><b class="num">${fmtVol(s.values[i])}</b></div>`).join("");
    tip.show(`<div class="faint small">Week of ${fmtDate(dates[i] + "T00:00:00")}</div>${rows}`, ev.clientX, ev.clientY);
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tip.hide();
  });
}

function hbars(rows, label) {
  if (!rows.length) return '<p class="muted">Not enough searches for a reliable breakdown.</p>';
  return `<div class="hbars">${rows.map((r) => `
      <div class="hit" data-tip="${esc(r.name)}: ${r.value}">
        <div class="name">${esc(r.name)}</div>
        <div class="bar"><div style="width:${r.value}%"></div></div>
        <div class="val">${r.value}</div>
      </div>`).join("")}</div>
    <p class="help" style="margin-top:8px">${label}</p>`;
}

// ---------------------------------------------------------------------------
// app state, status polling, progress banner
// ---------------------------------------------------------------------------
const state = { status: null, view: "rankings", runId: null, wasRunning: null, settingsDirty: false,
  market: null, ideaSeed: null, expanded: new Set(),
  explore: { q: "", filter: "all", sort: "score", dir: -1 } };

// --- markets ----------------------------------------------------------------
const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
const marketName = (code) => (!code || code === "WW" ? "Worldwide" : (regionNames && regionNames.of(code)) || code);
const COUNTRY_CODES = `AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ
  CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE
  GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW
  KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG
  NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN
  SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`
  .split(/\s+/).filter(Boolean);
const trackedMarkets = () => (state.status ? state.status.markets.map((m) => m.code) : ["WW"]);
function setMarket(code) {
  state.market = code;
  try { localStorage.setItem("kwt-market", code); } catch { /* storage unavailable */ }
}
function ensureMarket() {
  const tracked = trackedMarkets();
  if (!tracked.includes(state.market)) {
    let saved = null;
    try { saved = localStorage.getItem("kwt-market"); } catch { /* storage unavailable */ }
    setMarket(tracked.includes(saved) ? saved : tracked[0]);
  }
}
/** Query string for data requests: the selected market, plus a snapshot id when viewing an old one. */
function qs(extra = {}) {
  const p = new URLSearchParams({ m: state.market || "WW", ...extra });
  if (state.runId) p.set("run", state.runId);
  return "?" + p.toString();
}

let pollTimer;
const schedulePoll = (ms) => { clearTimeout(pollTimer); pollTimer = setTimeout(pollStatus, ms); };
async function pollStatus() {
  clearTimeout(pollTimer);
  let st;
  try { st = await api("/api/status"); } catch (e) { schedulePoll(10000); return; }
  state.status = st;
  ensureMarket();
  renderTopbar();
  const running = st.run.running;
  if (state.wasRunning && !running) {
    const last = st.last_attempted;
    if (last && last.status === "failed") toast("Refresh failed. See History for details.", true);
    else if (last && last.status === "cancelled") toast("Refresh cancelled.");
    else toast(last && last.status === "partial" ? "Refresh finished with some gaps. Rankings updated." : "Refresh finished. Rankings updated.");
    if (!(state.view === "settings" && state.settingsDirty)) render();
  } else if (state.wasRunning === false && running && !st.last_completed) {
    render();
  }
  state.wasRunning = running;
  schedulePoll(running ? 2500 : 20000);
}

function renderTopbar() {
  const st = state.status;
  const run = st.run;
  const btn = $("#run-btn");
  btn.disabled = run.running;
  btn.textContent = run.running ? "Refreshing…" : "Refresh now";
  btn.dataset.tip = run.running ? "" : `Fetch fresh data from Google now for every market you track. Takes about ${fmtDuration(st.estimate.seconds)}.`;
  $("#quit-btn").hidden = !st.desktop;

  // market picker: only when more than one market is tracked
  const sel = $("#market");
  const codes = trackedMarkets();
  sel.hidden = codes.length < 2;
  const opts = codes.map((c) => `<option value="${c}" ${c === state.market ? "selected" : ""}>${esc(marketName(c))}</option>`).join("");
  if (sel.innerHTML !== opts) sel.innerHTML = opts;

  const mine = st.markets.find((m) => m.code === state.market);
  const lastDone = (mine && mine.last_completed) || null;
  const updated = lastDone ? `Updated ${relTime(lastDone.started_at)}` : "No data yet";
  let auto, autoTitle = "";
  if (run.running) auto = "Updating now";
  else if (!st.schedule.enabled) { auto = "Automatic updates off"; autoTitle = "Turn them on in Settings"; }
  else {
    const nr = new Date(st.next_run);
    const ms = nr - Date.now();
    auto = ms < 120000 ? "Automatic update starting shortly" : `Automatically updates in ${fmtUntil(ms)}`;
    autoTitle = `Next automatic update: ${nr.toLocaleString(undefined, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Then every ${st.schedule.weekday}.`;
  }
  $("#freshness").innerHTML = `<span>${esc(updated)}</span><span class="auto" data-tip="${esc(autoTitle)}">${CLOCK_SVG}${esc(auto)}</span>`;

  const banner = $("#progress");
  banner.hidden = !run.running;
  if (!run.running) return;
  // progress weighted by how long each phase takes, across every market
  const est = run.estimate || st.estimate;
  const order = ["discover", "interest", "regions", "ideas"].filter((p) => est.phases[p].seconds > 0);
  const perMarket = order.reduce((a, p) => a + est.phases[p].seconds, 0);
  const idx = order.indexOf(run.phase);
  let done = run.market_index * perMarket;
  if (idx >= 0) {
    done += order.slice(0, idx).reduce((a, p) => a + est.phases[p].seconds, 0);
    done += (run.done / Math.max(run.total || 1, 1)) * est.phases[run.phase].seconds;
  }
  const total = perMarket * Math.max(run.market_count, 1);
  const pct = Math.min(99, Math.round((done / total) * 100));
  $("#progress-fill").style.width = pct + "%";
  $(".progress-bar").setAttribute("aria-valuenow", pct);
  const where = run.market_count > 1 ? `${marketName(market_code_js(run.market))} (${run.market_index + 1} of ${run.market_count}) · ` : "";
  $("#progress-title").textContent = run.cancelling ? "Cancelling after the current request…"
    : idx >= 0 ? `${where}Step ${idx + 1} of ${order.length} · ${run.phase_label}` : "Starting refresh…";
  $("#progress-detail").textContent = run.detail ? `${run.done + 1} of ${run.total}: ${run.detail}` : "";
  const left = Math.max(total - done, 0);
  $("#progress-eta").textContent = `${pct}% · about ${fmtDuration(left)} left · started ${relTime(run.started_at)}. It's slow on purpose so Google doesn't block it. It runs on the server, so you can close this tab.`;
  $("#cancel-btn").disabled = !!run.cancelling;
}

const market_code_js = (geo) => geo || "WW";

async function startRun() {
  try {
    await api("/api/runs", { method: "POST" });
    toast("Refresh started. Rankings update automatically when it's done.");
    state.wasRunning = true;
    pollStatus();
  } catch (e) { toast(e.message, true); }
}

$("#run-btn").addEventListener("click", startRun);
$("#quit-btn").addEventListener("click", async () => {
  const running = state.status && state.status.run.running;
  const msg = running
    ? "A refresh is running and will stop. Quit Keyword Tracker anyway?"
    : "Quit Keyword Tracker? Weekly updates only happen while it's running. Open the app again any time.";
  if (!confirm(msg)) return;
  try { await api("/api/quit", { method: "POST" }); } catch (e) { toast(e.message, true); return; }
  clearTimeout(pollTimer);
  document.body.innerHTML = `<div class="container"><div class="card empty"><h2>Keyword Tracker has stopped</h2>
    <p class="muted">You can close this tab. Open the app again whenever you want to use it.</p></div></div>`;
});
$("#cancel-btn").addEventListener("click", async () => {
  await api("/api/runs/cancel", { method: "POST" });
  toast("Cancelling after the current request finishes.");
});

// ---------------------------------------------------------------------------
// pins (shared by every view)
// ---------------------------------------------------------------------------
async function setPinned(term, pinned) {
  try {
    if (pinned) {
      const r = await api("/api/pins", { method: "POST", body: { term } });
      toast(r.added ? `Pinned “${r.term}”. It will always appear in the list from the next refresh.` : `“${r.term}” was already pinned.`);
    } else {
      await api("/api/pins", { method: "DELETE", body: { term } });
      toast(`Unpinned “${term}”. It now has to earn its spot.`);
    }
  } catch (e) { toast(e.message, true); return; }
  if (!$("#drawer").classList.contains("open")) render();
  else { render(); openKeyword(term, false); }
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest(".pin-toggle");
  if (!b) return;
  ev.stopPropagation();
  setPinned(b.dataset.term, b.dataset.pinned !== "1");
}, true);

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
function parseHash() {
  const [view, qs] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(qs || "");
  return { view: view || "rankings", run: params.get("run") ? +params.get("run") : null, market: params.get("m") };
}

let lastHash = location.hash;
window.addEventListener("hashchange", () => {
  if (state.view === "settings" && state.settingsDirty && !confirm("You have unsaved settings. Leave without saving?")) {
    history.replaceState(null, "", lastHash);
    return;
  }
  state.settingsDirty = false;
  lastHash = location.hash;
  render();
});

function render() {
  const { view, run, market } = parseHash();
  state.view = view;
  state.runId = run;
  if (market) setMarket(market.toUpperCase());
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  if (state.status) renderTopbar();
  const fn = { rankings: renderRankings, ideas: renderIdeas, explore: renderExplore, pinned: renderPinned,
    history: renderHistory, settings: renderSettings }[view] || renderRankings;
  fn().catch((e) => ($("#view").innerHTML = `<div class="callout err">Couldn't load this page: ${esc(e.message)}</div>`));
}
$("#market").addEventListener("change", (e) => {
  setMarket(e.target.value);
  location.hash = state.view;  // drops any old-snapshot ?run=
  render();
});

function snapshotBanner(run) {
  if (!state.runId || !run) return "";
  return `<div class="callout warn snapshot-banner row">Viewing an older snapshot (${esc(marketName(run.market))}) from <b>${fmtDateTime(run.started_at)}</b>.
    <span class="spacer"></span><a href="#${state.view}">Back to latest</a></div>`;
}

function emptyState() {
  const st = state.status;
  if (st && st.run.running) {
    return `<div class="card empty"><h2>Your first refresh is running</h2>
      <p class="muted">Rankings will appear here automatically when it finishes (progress is shown above).</p></div>`;
  }
  const m = trackedMarkets().length > 1 ? ` for ${esc(marketName(state.market))}` : "";
  return `<div class="card empty"><h2>No data yet${m}</h2>
    <p class="muted">Run a refresh to discover keywords and rank them. It takes about ${fmtDuration(st?.estimate.seconds)}.<br>
    After that it refreshes itself every week.</p>
    <button class="btn primary" onclick="startRun()">Run first refresh</button></div>`;
}

// ---------------------------------------------------------------------------
// view: rankings
// ---------------------------------------------------------------------------
async function renderRankings() {
  const data = await api("/api/ranking" + qs());
  const v = $("#view");
  if (!data.run) { v.innerHTML = emptyState(); return; }
  const items = data.items;
  const anchor = data.run.anchor;
  const hasPrev = data.prev_run_id != null;
  const scored = items.filter((i) => i.score != null);
  const top = scored.reduce((a, b) => (a == null || b.momentum > a.momentum ? b : a), null);
  const riser = top && momPct(top.momentum) >= 0.02 ? top : null;  // only if something is actually growing
  const biggest = scored.reduce((a, b) => (a == null || b.volume > a.volume ? b : a), null);
  const newcomers = hasPrev ? items.filter((i) => i.prev_rank == null) : [];
  const where = marketName(data.run.market);
  const folded = items.reduce((a, i) => a + i.similar.length, 0);
  const regionWord = data.run.geo ? "provinces/states" : "countries";

  const similarRows = (r) => r.similar.map((s) => `
    <tr class="clickable similar-row" tabindex="0" data-term="${esc(s.term)}">
      <td></td><td></td>
      <td class="kw-cell"><span class="similar-mark" aria-hidden="true">↳</span><span class="kw">${esc(s.term)}</span></td>
      <td class="hide-sm"></td>
      <td class="right num">${fmtVol(s.volume)}</td>
      <td class="right num">${momHtml(s.momentum)}</td>
      <td>${meterHtml(s.score)}</td>
      <td class="hide-sm"></td><td></td>
    </tr>`).join("");

  v.innerHTML = `
    ${snapshotBanner(data.run)}
    <div class="page-head">
      <div><h1>Top ${items.length} keywords · ${esc(where)}</h1>
      <p class="muted">Google search interest${data.run.geo ? " in " + esc(where) : " worldwide"}, ranked by popularity and momentum. Click a keyword for details.</p></div>
    </div>
    <div class="tiles" style="margin-bottom:16px">
      <div class="card tile"><div class="label">Fastest riser ${info("The listed keyword whose interest grew the most: last 4 weeks compared with the 12 weeks before.")}</div>
        <div class="value">${riser ? esc(riser.term) : "Nothing growing"}</div>
        <div class="sub">${riser ? `${momHtml(riser.momentum)} over the last few weeks` : "No keyword in the list is up on the previous weeks right now"}</div></div>
      <div class="card tile"><div class="label">Most searched ${info(`The listed keyword with the highest search interest, measured against “${anchor}”.`)}</div>
        <div class="value">${biggest ? esc(biggest.term) : "–"}</div>
        <div class="sub">${biggest ? `${fmtVol(biggest.volume)} as popular as “${esc(anchor)}”` : ""}</div></div>
      <div class="card tile"><div class="label">New in the list ${info("Keywords in the list now that weren't in it after the previous refresh.")}</div>
        <div class="value">${hasPrev ? newcomers.length : "–"}</div>
        <div class="sub">${hasPrev ? (newcomers.length ? esc(newcomers.slice(0, 3).map((n) => n.term).join(", ")) + (newcomers.length > 3 ? "…" : "") : "Same keywords as last time") : "First snapshot. Changes show up next week."}</div></div>
      <div class="card tile"><div class="label">Snapshot ${info("When this data was fetched from Google. Partial means some requests failed; the rest of the data is still used.")}</div>
        <div class="value">${fmtDate(data.run.started_at)}</div>
        <div class="sub">${statusHtml(data.run.status)}${data.run.status === "partial" ? ' · <a href="#history">some data missing</a>' : ""}</div></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr>
          <th>#</th>
          <th>${info("Change in position since the previous refresh. NEW means it wasn't in the list last time.")}</th>
          <th>Keyword</th>
          <th class="hide-sm">Trend ${info("Search interest over the time range in Settings (usually the past 12 months). The dot is the latest week.")}</th>
          <th class="right">Popularity ${info(`How often it's searched compared with “${anchor}”. 2× = twice as often, 0.5× = half as often. Google doesn't publish real search counts.`)}</th>
          <th class="right">Momentum ${info("Average interest in the last 4 weeks compared with the 12 weeks before. Green and up = growing.")}</th>
          <th>Score ${info("0–100. Blends popularity and momentum (balance set in Settings). The list is sorted by this.")}</th>
          <th class="hide-sm">Top ${regionWord} ${info(`Where this keyword makes up the biggest share of searches. Click the keyword for the full list.`)}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${items.map((r) => `
            <tr class="clickable" tabindex="0" data-term="${esc(r.term)}">
              <td class="rank num">${r.rank}</td>
              <td>${moveHtml(r.rank, r.prev_rank, hasPrev)}</td>
              <td class="kw-cell"><div class="kw">${esc(r.term)}</div>
                <div class="row" style="gap:4px;margin-top:2px">
                  ${r.pinned ? `<span class="badge pin" data-tip="You pinned this, so it always appears in the list">Pinned</span>` : ""}
                  ${r.source && r.source !== "pin" ? `<span class="badge" data-tip="${esc(SOURCE_HELP[r.source])}">${esc(SOURCE_LABEL[r.source])}</span>` : ""}
                  ${r.similar.length ? `<button type="button" class="badge similar-toggle" data-term="${esc(r.term)}" aria-expanded="${state.expanded.has(r.term)}"
                    data-tip="Variants of the same search (extra words like years, engine codes or “review”), folded into one row to save space. Click to show them.">
                    ${state.expanded.has(r.term) ? "▾" : "▸"} ${r.similar.length} similar</button>` : ""}
                </div></td>
              <td class="hide-sm">${sparkline(r.series)}</td>
              <td class="right num">${fmtVol(r.volume)}</td>
              <td class="right num">${momHtml(r.momentum)}</td>
              <td>${meterHtml(r.score)}</td>
              <td class="hide-sm regions-mini">${r.top_regions.map((x) => esc(x.name)).join(", ") || (r.regions_fetched
                ? '<span class="faint" data-tip="Not enough searches for a reliable breakdown">too few searches</span>'
                : `<span class="faint" data-tip="This keyword joined the list after the last refresh (because of a settings change). Its ${regionWord} are looked up on the next refresh.">next refresh</span>`)}</td>
              <td class="right">${pinBtn(r.term, r.pinned_now)}</td>
            </tr>
            ${state.expanded.has(r.term) ? similarRows(r) : ""}`).join("")}
        </tbody>
      </table>
    </div>
    <details class="card card-pad" style="margin-top:16px">
      <summary>How is this ranked?</summary>
      <div class="stack muted" style="margin-top:10px">
        <p><b>Popularity:</b> Google Trends doesn't publish real search counts, only relative interest. So every keyword is measured
        side-by-side with “${esc(anchor)}”: <b>2×</b> means searched twice as often, <b>0.5×</b> half as often.</p>
        <p><b>Momentum:</b> average interest in the last 4 weeks vs. the 12 weeks before. <b>+50%</b> means interest is growing.</p>
        <p><b>Score:</b> each keyword is ranked against the others on both measures, then the two are blended
        (the balance is in <a href="#settings">Settings</a>). The top ${items.length} make the list, plus anything you've <b>pinned</b>.</p>
        <p><b>Similar keywords:</b> variants of the same search, like “1.9 alh tdi” and “alh”, share one row so the list
        shows more different things${folded ? ` (${folded} folded in this list)` : ""}. Part names like “alh turbo” keep their own row.
        You can turn this off in <a href="#settings">Settings</a>.</p>
        <p><b>Where keywords come from:</b> your seed keywords, plus searches Google reports as rising or popular alongside them.
        See every keyword checked in <a href="#explore">All keywords</a>, and the specific phrases people type in <a href="#ideas">Part ideas</a>.</p>
      </div>
    </details>`;

  $$("tbody tr.clickable", v).forEach((tr) => {
    tr.addEventListener("click", () => openKeyword(tr.dataset.term));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === tr) openKeyword(tr.dataset.term); });
  });
  $$(".similar-toggle", v).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const t = b.dataset.term;
    state.expanded.has(t) ? state.expanded.delete(t) : state.expanded.add(t);
    renderRankings();
  }));
}

// ---------------------------------------------------------------------------
// keyword detail drawer
// ---------------------------------------------------------------------------
let drawerTerm = null;
async function openKeyword(term, animate = true) {
  drawerTerm = term;
  const d = $("#drawer"), body = $("#drawer-body");
  if (animate) body.innerHTML = '<p class="muted">Loading…</p>';
  d.classList.add("open"); d.setAttribute("aria-hidden", "false");
  $("#drawer-backdrop").hidden = false;
  d.focus();
  let k;
  try { k = await api("/api/keyword" + qs({ term })); }
  catch (e) { body.innerHTML = `<div class="callout err">${esc(e.message)}</div>`; return; }
  if (drawerTerm !== term) return;

  const c = k.candidate || {};
  const anchor = k.run.anchor;
  const pinned = !!k.pin;
  const tf = k.run.timeframe === "today 5-y" ? "the past 5 years" : "the past 12 months";
  const trendsUrl = `https://trends.google.com/trends/explore?q=${encodeURIComponent(term)}&date=${encodeURIComponent(k.run.timeframe)}${k.run.geo ? "&geo=" + k.run.geo : ""}`;
  const regionsShown = k.regions.slice(0, 15);
  const hist = k.history.filter((h) => h.score != null || h.rank != null).slice(0, 12);

  let summary = "";
  if (c.volume != null) {
    summary = term === anchor ? `This is the comparison keyword. Every other keyword is measured against it.`
      : `Searched about <b>${fmtVol(c.volume)}</b> as often as “${esc(anchor)}” over ${tf}.`;
    const p = momPct(c.momentum);
    summary += Math.abs(p) < 0.02 ? " Interest has been steady lately."
      : ` Interest in the last 4 weeks is <b>${fmtPct(p).replace("+", "")} ${p > 0 ? "higher" : "lower"}</b> than the 12 weeks before.`;
  } else if (c.error) {
    summary = `No data this time: ${esc(c.error)}`;
  } else {
    summary = "This keyword wasn't part of this snapshot. If you just pinned it, it will be measured on the next refresh.";
  }

  body.innerHTML = `
    <div class="drawer-head">
      <div style="flex:1">
        <h1>${esc(term)}</h1>
        <div class="row" style="gap:6px;margin-top:6px">
          ${k.rank ? `<span class="badge">#${k.rank} in the list${k.grouped_under ? " (grouped)" : ""}</span>` : `<span class="badge">Not in the top list</span>`}
          ${trackedMarkets().length > 1 ? `<span class="badge">${esc(marketName(k.run.market))}</span>` : ""}
          ${c.source ? `<span class="badge" data-tip="${esc(SOURCE_HELP[c.source])}">${esc(SOURCE_LABEL[c.source])}</span>` : ""}
          ${pinned ? `<span class="badge pin">Pinned</span>` : ""}
          ${k.ignored ? `<span class="badge" data-tip="Matches a word in your ignore list (Settings)">Ignored</span>` : ""}
        </div>
      </div>
      <button class="icon-btn" id="drawer-close" aria-label="Close" style="font-size:20px">✕</button>
    </div>
    <div class="row">
      <button class="btn ${pinned ? "" : "primary"} pin-toggle" data-term="${esc(term)}" data-pinned="${pinned ? 1 : 0}">
        ${pinned ? PIN_SVG + " Unpin" : PIN_OUTLINE_SVG + " Pin to list"}</button>
      <a class="btn ghost" href="${trendsUrl}" target="_blank" rel="noopener">Open in Google Trends ↗</a>
    </div>
    ${pinned ? `<div class="field" style="margin-top:12px"><label class="help" for="pin-note">Note (only you see this)</label>
      <input type="text" id="pin-note" value="${esc(k.pin.note || "")}" placeholder="e.g. core product, competitor brand…"></div>` : ""}

    <p class="muted" style="margin-top:16px">${summary}</p>
    ${k.grouped_under ? `<p class="callout" style="margin-top:12px">Shown in the list as a variant of
      <a href="javascript:void 0" class="open-kw" data-term="${esc(k.grouped_under)}">“${esc(k.grouped_under)}”</a>.</p>` : ""}
    <div class="facts">
      <div class="fact"><div class="label">Popularity ${info(`How often it's searched compared with “${anchor}”. 1× = the same.`)}</div><div class="value">${fmtVol(c.volume)}</div></div>
      <div class="fact"><div class="label">Momentum ${info("Last 4 weeks compared with the 12 weeks before.")}</div><div class="value">${momHtml(c.momentum)}</div></div>
      <div class="fact"><div class="label">Score ${info("0–100 blend of popularity and momentum, relative to the other keywords checked.")}</div><div class="value">${score100(c.score) ?? "–"}${c.score != null ? '<span class="faint small"> / 100</span>' : ""}</div></div>
    </div>

    ${k.values.length ? `<div class="section">
      <h2>Search interest over ${tf}</h2>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>${esc(term)}</span>
        ${k.anchor_values.length ? `<span><i style="background:var(--muted)"></i>${esc(anchor)} (comparison)</span>` : ""}
      </div>
      <div class="chart" id="kw-chart"></div>
    </div>` : ""}

    ${k.rank || k.regions.length ? `<div class="section">
      <h2>Where people search for it ${info(`Ranked by share of searches, not total searches: 100 is where this keyword is most popular relative to everything else people search there.`)}</h2>
      ${!k.regions_fetched ? '<p class="muted">This keyword moved into the list after you ignored another one. Its countries are looked up on the next refresh.</p>' : hbars(regionsShown, `100 = the ${k.region_kind} where this keyword takes the biggest share of searches. Showing the top ${regionsShown.length} of ${k.regions.length}.${k.small_hidden ? " Small countries are hidden (Settings → Advanced)." : ""}`)}
    </div>` : ""}

    ${k.similar.length ? `<div class="section">
      <h2>Similar keywords ${info("Variants of this search folded into this row of the list. Click one to see its own chart.")}</h2>
      <div class="row" style="gap:6px">${k.similar.map((s) => `<button type="button" class="badge similar-toggle open-kw" data-term="${esc(s.term)}">${esc(s.term)} · ${fmtVol(s.volume)}</button>`).join("")}</div>
    </div>` : ""}

    <div class="section">
      <h2>How it was found ${info("Seeds are your starting keywords. Rising and popular searches are ones Google listed as related to a seed.")}</h2>
      ${c.source === "pin" && !k.discovered_from.length ? `<p class="muted">You pinned it.</p>` : ""}
      ${c.source === "seed" ? `<p class="muted">It's one of your seed keywords.</p>` : ""}
      ${c.source === "anchor" ? `<p class="muted">It's the comparison keyword.</p>` : ""}
      ${k.discovered_from.length ? `<ul class="muted" style="margin:0;padding-left:18px">${k.discovered_from.map((f) => `<li>${f.kind === "rising"
          ? `Rising search related to “${esc(f.seed)}” (${f.value >= 5000 ? "breakout" : "+" + f.value.toLocaleString() + "%"})`
          : `Popular search related to “${esc(f.seed)}”`}</li>`).join("")}</ul>` : ""}
    </div>

    ${hist.length > 1 ? `<div class="section"><h2>Past refreshes</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th class="right">Rank</th><th class="right">Popularity</th><th class="right">Momentum</th><th class="right">Score</th></tr></thead>
      <tbody>${hist.map((h) => `<tr><td>${fmtDate(h.started_at)}</td><td class="right num">${h.rank ? "#" + h.rank : '<span class="faint">–</span>'}</td>
        <td class="right num">${fmtVol(h.volume)}</td><td class="right num">${momHtml(h.momentum)}</td><td class="right num">${score100(h.score) ?? "–"}</td></tr>`).join("")}</tbody></table></div>
    </div>` : ""}`;

  $("#drawer-close").addEventListener("click", closeDrawer);
  $$(".open-kw", body).forEach((a) => a.addEventListener("click", () => openKeyword(a.dataset.term)));
  const note = $("#pin-note");
  if (note) note.addEventListener("change", async () => {
    await api("/api/pins", { method: "PATCH", body: { term, note: note.value } });
    toast("Note saved.");
  });
  if (k.values.length) {
    const series = [{ name: term, values: k.values, color: "var(--accent)" }];
    if (k.anchor_values.length) series.push({ name: anchor + " (comparison)", values: k.anchor_values, color: "var(--muted)" });
    requestAnimationFrame(() => lineChart($("#kw-chart"), k.dates, series));
  }
}

function closeDrawer() {
  drawerTerm = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawer-backdrop").hidden = true;
  tip.hide();
}
$("#drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ---------------------------------------------------------------------------
// view: part ideas (Google autocomplete, grouped by part)
// ---------------------------------------------------------------------------
const ideasUi = { q: "", newOnly: false, open: new Set() };
const GOOGLE_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

async function renderIdeas() {
  const v = $("#view");
  const data = await api("/api/ideas" + qs(state.ideaSeed ? { seed: state.ideaSeed } : {}));
  const where = marketName(state.market);
  const head = `<div class="page-head"><div>
      <h1>Part ideas${trackedMarkets().length > 1 ? " · " + esc(where) : ""}</h1>
      <p class="muted">The specific things people type into Google for each seed, grouped by part. Good for spotting products to make.</p></div></div>`;
  if (!data.run) {
    v.innerHTML = head + `<div class="card empty">${data.enabled
      ? `<h2>No part ideas yet</h2><p class="muted">They're collected at the end of each refresh. Run one with <b>Refresh now</b>, or wait for the next automatic update.</p>`
      : `<h2>Part ideas are turned off</h2><p class="muted">Turn them on in <a href="#settings">Settings</a>, then refresh.</p>`}</div>`;
    return;
  }
  state.ideaSeed = data.seed;
  const q = ideasUi.q.toLowerCase();
  const keep = (p) => (!q || p.term.includes(q)) && (!ideasUi.newOnly || p.new);
  const groups = data.groups.map((g) => ({ ...g, shown: g.phrases.filter(keep) })).filter((g) => g.shown.length);
  const singles = data.singles.filter(keep);
  const newCount = data.groups.reduce((a, g) => a + g.phrases.filter((p) => p.new).length, 0) + data.singles.filter((p) => p.new).length;

  const phraseRow = (p) => `<li>
      <span class="phrase">${esc(p.term)}</span>
      ${p.new ? '<span class="badge new" data-tip="Not suggested by Google for this seed last time">NEW</span>' : ""}
      <span class="spacer"></span>
      <a class="icon-btn" href="https://www.google.com/search?q=${encodeURIComponent(p.term)}" target="_blank" rel="noopener"
        data-tip="Search Google for this (opens a new tab)" aria-label="Search Google for ${esc(p.term)}">${GOOGLE_SVG}</a>
      ${pinBtn(p.term, p.pinned)}
    </li>`;
  const card = (g) => {
    const open = ideasUi.open.has(g.key) || q || ideasUi.newOnly;
    const list = open ? g.shown : g.shown.slice(0, 6);
    const more = g.shown.length - list.length;
    return `<div class="card idea-card">
      <div class="idea-head"><h3>${esc(g.label)}</h3>
        <span class="badge" data-tip="How many different searches Google suggested for this part">${g.shown.length} searches</span>
        <button type="button" class="btn ghost small idea-hide" data-word="${esc(g.label)}"
          data-tip="Not relevant? Adds “${esc(g.label)}” to your ignore list, which hides it here and in the rankings. You can undo it.">Hide</button></div>
      <ul class="phrases">${list.map(phraseRow).join("")}</ul>
      ${more > 0 ? `<button type="button" class="btn ghost small idea-more" data-key="${esc(g.key)}">Show ${more} more</button>` : ""}
    </div>`;
  };

  v.innerHTML = `${head}
    <div class="toolbar">
      <span class="muted small">Seed ${info("Your seed keywords from Settings. Pick one to see what people search alongside it.")}</span>
      <div class="seg" role="group" aria-label="Seed">${data.seeds.map((sd) =>
        `<button data-seed="${esc(sd)}" class="${sd === data.seed ? "on" : ""}">${esc(sd)}</button>`).join("")}</div>
    </div>
    <div class="toolbar">
      <input type="search" id="idea-q" placeholder="Filter, e.g. injector" value="${esc(ideasUi.q)}" style="width:220px">
      ${data.has_previous ? `<label class="toggle small"><input type="checkbox" id="idea-new" ${ideasUi.newOnly ? "checked" : ""}> New since last refresh only (${newCount})</label>` : ""}
      <span class="spacer"></span>
      <span class="muted small">${data.total} searches in ${data.groups.length} groups${data.hidden ? ` · ${data.hidden} hidden by your ignore list` : ""}
        ${info("No search counts here: these phrases are too specific for Google Trends to measure. Google lists the most common ones first, so bigger groups mean more ways people look for that part.")}</span>
    </div>
    ${groups.length || singles.length ? `<div class="idea-grid">${groups.map(card).join("")}</div>` : `<div class="card empty"><p class="muted">Nothing matches.</p></div>`}
    ${singles.length ? `<div class="card card-pad" style="margin-top:16px">
      <h2>Other searches ${info("Phrases that didn't share a part name with any other phrase.")}</h2>
      <ul class="phrases cols">${singles.map(phraseRow).join("")}</ul></div>` : ""}
    <details class="card card-pad" style="margin-top:16px">
      <summary>How part ideas work</summary>
      <div class="stack muted" style="margin-top:10px">
        <p>At the end of each refresh, the tracker types each seed into Google's search box followed by every letter
        (“${esc(data.seed)} a”, “${esc(data.seed)} b”, …) and saves what Google suggests. That's what people actually search for.</p>
        <p>Phrases are grouped by the first word that names a thing, so “alh injectors”, “alh injector nozzles” and
        “alh tdi injector seals” all land under <b>injector</b>.</p>
        <p>To track a phrase's popularity over time, <b>pin</b> it. Very specific phrases are often too rare for Google Trends
        to measure, in which case it shows “no data”.</p>
        <p>Off-topic results (like “alh dental clinic”)? Add a word to the ignore list in <a href="#settings">Settings</a>.</p>
      </div>
    </details>`;

  $$(".seg button[data-seed]", v).forEach((b) => b.addEventListener("click", () => { state.ideaSeed = b.dataset.seed; ideasUi.open.clear(); renderIdeas(); }));
  $("#idea-q").addEventListener("input", (e) => {
    ideasUi.q = e.target.value;
    clearTimeout(renderIdeas.t);
    renderIdeas.t = setTimeout(() => renderIdeas().then(() => { const i = $("#idea-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 200);
  });
  const nw = $("#idea-new");
  if (nw) nw.addEventListener("change", () => { ideasUi.newOnly = nw.checked; renderIdeas(); });
  $$(".idea-more", v).forEach((b) => b.addEventListener("click", () => { ideasUi.open.add(b.dataset.key); renderIdeas(); }));
  $$(".idea-hide", v).forEach((b) => b.addEventListener("click", async () => {
    const word = b.dataset.word;
    try { await api("/api/ignore", { method: "POST", body: { word } }); } catch (e) { toast(e.message, true); return; }
    hideTip();
    undoToast(`Hid “${word}”. It's in your ignore list in Settings.`, async () => {
      await api("/api/ignore/undo", { method: "POST", body: { word } });
      renderIdeas();
    });
    renderIdeas();
  }));
}

// ---------------------------------------------------------------------------
// view: all keywords (whole candidate pool)
// ---------------------------------------------------------------------------
function addKeywordForm(id, label) {
  return `<form class="row" id="${id}">
    <input type="text" name="term" placeholder="Add any keyword…" aria-label="Keyword to pin" style="width:220px" required maxlength="100">
    <input type="text" name="note" placeholder="Note (optional)" aria-label="Note" style="width:180px">
    <button class="btn primary">${label}</button></form>`;
}
function wireAddForm(form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const term = form.term.value.trim(), note = form.note.value.trim();
    if (!term) return;
    try {
      const r = await api("/api/pins", { method: "POST", body: { term, note } });
      toast(r.added ? `Pinned “${r.term}”. It'll be measured and listed from the next refresh.` : `“${r.term}” was already pinned.`);
      render();
    } catch (err) { toast(err.message, true); }
  });
}

async function renderExplore() {
  const data = await api("/api/candidates" + qs());
  const v = $("#view");
  if (!data.run) { v.innerHTML = emptyState(); return; }
  const ex = state.explore;
  const filters = { all: "All", rising: "Rising", top: "Popular related", seed: "Seeds", pin: "Pinned", ranked: "In top list", ignored: "Ignored", problem: "Problems" };
  const FILTER_HELP = {
    all: "Every keyword checked in this refresh",
    rising: "Searches Google says are growing fast alongside one of your seeds",
    top: "Searches Google says are commonly made alongside one of your seeds",
    seed: "Your own starting keywords from Settings",
    pin: "Keywords you pinned",
    ranked: "Keywords shown on the Rankings page, including ones folded in as similar",
    ignored: "Hidden because they contain a word from your ignore list",
    problem: "Google returned no usable data for these",
  };
  const COL_HELP = {
    source: "How the keyword got here: one of your seeds, a pin, or a search Google listed as related to a seed.",
    volume: `How often it's searched compared with “${data.run.anchor}”. 1× = the same.`,
    momentum: "Last 4 weeks compared with the 12 weeks before.",
    score: "0–100 blend of popularity and momentum. The Rankings page is sorted by this.",
    rank: "Its position on the Rankings page. “in #3” means it's folded into row 3 as a similar keyword.",
  };
  const counts = {};
  for (const f of Object.keys(filters)) counts[f] = data.items.filter((i) => matchFilter(i, f)).length;

  v.innerHTML = `
    ${snapshotBanner(data.run)}
    <div class="page-head">
      <div><h1>All keywords checked</h1>
      <p class="muted">Every keyword measured in the ${fmtDate(data.run.started_at)} refresh, not just the top list. Pin anything you want to always keep.</p></div>
      <span class="spacer"></span>${addKeywordForm("add-form", "Pin keyword")}
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search keywords…" value="${esc(ex.q)}" style="width:240px">
      <div class="seg" role="group" aria-label="Filter">${Object.entries(filters).map(([k, l]) =>
        counts[k] || k === "all" ? `<button data-f="${k}" class="${ex.filter === k ? "on" : ""}" data-tip="${esc(FILTER_HELP[k])}">${l} <span class="faint">${counts[k]}</span></button>` : "").join("")}</div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr>
        ${[["term", "Keyword"], ["source", "Found via"], ["volume", "Popularity", "right"], ["momentum", "Momentum", "right"], ["score", "Score"], ["rank", "Rank", "right"]]
          .map(([k, l, cls]) => `<th class="sortable ${cls || ""}" data-sort="${k}">${l}${ex.sort === k ? (ex.dir > 0 ? " ↑" : " ↓") : ""}${COL_HELP[k] ? " " + info(COL_HELP[k]) : ""}</th>`).join("")}
        <th></th></tr></thead>
      <tbody id="ex-body"></tbody>
    </table></div>`;

  const draw = () => {
    const q = ex.q.toLowerCase();
    let rows = data.items.filter((i) => matchFilter(i, ex.filter) && (!q || i.term.includes(q)));
    rows.sort((a, b) => {
      let x = a[ex.sort], y = b[ex.sort];
      if (x == null && y == null) return a.term.localeCompare(b.term);
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * ex.dir;
    });
    $("#ex-body").innerHTML = rows.length ? rows.map((r) => `
      <tr class="clickable" tabindex="0" data-term="${esc(r.term)}">
        <td class="kw-cell"><span class="kw">${esc(r.term)}</span>
          ${r.error ? `<span class="badge" style="margin-left:6px" data-tip="${esc(r.error)}">⚠ no data</span>` : ""}
          ${r.ignored ? `<span class="badge" style="margin-left:6px" data-tip="Matches a word in your ignore list (Settings)">Ignored</span>` : ""}</td>
        <td><span class="badge" data-tip="${esc(SOURCE_HELP[r.source])}">${esc(SOURCE_LABEL[r.source] || r.source)}</span></td>
        <td class="right num">${fmtVol(r.volume)}</td>
        <td class="right num">${momHtml(r.momentum)}</td>
        <td>${meterHtml(r.score)}</td>
        <td class="right num">${!r.rank ? '<span class="faint">–</span>' : r.grouped_under
          ? `<span class="faint" data-tip="Folded into row ${r.rank} (“${esc(r.grouped_under)}”) as a similar keyword">in #${r.rank}</span>` : "#" + r.rank}</td>
        <td class="right">${pinBtn(r.term, r.pinned_now)}</td>
      </tr>`).join("") : `<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">No keywords match.</td></tr>`;
    $$("#ex-body tr.clickable").forEach((tr) => {
      tr.addEventListener("click", () => openKeyword(tr.dataset.term));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openKeyword(tr.dataset.term); });
    });
  };
  draw();
  $("#q").addEventListener("input", (e) => { ex.q = e.target.value; draw(); });
  $$(".seg button", v).forEach((b) => b.addEventListener("click", () => { ex.filter = b.dataset.f; renderExplore(); }));
  $$("th.sortable", v).forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    ex.dir = ex.sort === k ? -ex.dir : (k === "term" || k === "source" || k === "rank" ? 1 : -1);
    ex.sort = k;
    renderExplore();
  }));
  wireAddForm($("#add-form"));
}
function matchFilter(i, f) {
  if (f === "all") return true;
  if (f === "ranked") return i.rank != null;
  if (f === "problem") return !!i.error;
  if (f === "ignored") return !!i.ignored;
  if (f === "pin") return i.pinned_now || i.source === "pin";
  return i.source === f;
}

// ---------------------------------------------------------------------------
// view: pinned
// ---------------------------------------------------------------------------
async function renderPinned() {
  const pins = await api("/api/pins" + qs());
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <div><h1>Pinned keywords</h1>
      <p class="muted">Pinned keywords always appear in the ranked list, whatever their score. Handy for your own products, brands, or anything you want to watch.</p></div>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">${addKeywordForm("add-form", "Pin keyword")}
      <p class="help" style="margin-top:8px">Tip: you can also pin straight from the Rankings or All keywords lists using the pin icon.</p></div>
    ${pins.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Keyword</th><th>Note ${info("Only you see this. Handy for remembering why you pinned something.")}</th>
        <th class="right">Current rank ${info("Its position on the Rankings page for the selected market. “pending” means it hasn't been measured yet; that happens on the next refresh.")}</th><th>Pinned</th><th></th></tr></thead>
      <tbody>${pins.map((p) => `<tr>
        <td class="kw-cell"><a href="javascript:void 0" class="kw open-kw" data-term="${esc(p.term)}">${esc(p.term)}</a></td>
        <td><input type="text" class="pin-note" data-term="${esc(p.term)}" value="${esc(p.note || "")}" placeholder="Add a note…" style="width:100%;min-width:160px"></td>
        <td class="right num">${p.rank ? "#" + p.rank : '<span class="faint" data-tip="Will be measured on the next refresh">pending</span>'}</td>
        <td class="muted">${fmtDate(p.pinned_at)}</td>
        <td class="right"><button class="btn small ghost danger pin-toggle" data-term="${esc(p.term)}" data-pinned="1">Unpin</button></td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty"><h2>Nothing pinned yet</h2><p class="muted">Add a keyword above, or click the pin icon next to any keyword in the rankings.</p></div>`}`;
  wireAddForm($("#add-form"));
  $$(".pin-note", v).forEach((inp) => inp.addEventListener("change", async () => {
    await api("/api/pins", { method: "PATCH", body: { term: inp.dataset.term, note: inp.value } });
    toast("Note saved.");
  }));
  $$(".open-kw", v).forEach((a) => a.addEventListener("click", () => openKeyword(a.dataset.term)));
}

// ---------------------------------------------------------------------------
// view: history
// ---------------------------------------------------------------------------
async function renderHistory() {
  const runs = await api("/api/runs");
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div><h1>Refresh history</h1>
      <p class="muted">Every snapshot is kept. Open an older one to see how the rankings looked back then.</p></div></div>
    ${runs.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Started</th><th>Market</th><th>Status ${info("Complete: everything worked. Partial: Google refused some requests, but the rest is used. Failed or Cancelled: nothing usable.")}</th>
        <th class="right">Took</th><th class="right">Keywords checked</th>
        <th class="right">Google requests ${info("How many times the tracker asked Google for data. Google limits how many it allows, which is why refreshes are slow.")}</th>
        <th>Compared against ${info("The comparison keyword used for popularity in that snapshot.")}</th><th></th></tr></thead>
      <tbody>${runs.map((r) => {
        const took = r.finished_at ? (new Date(r.finished_at) - new Date(r.started_at)) / 1000 : null;
        const viewable = r.ranked > 0;
        return `<tr>
          <td>${fmtDateTime(r.started_at)}<div class="faint small">${relTime(r.started_at)}</div></td>
          <td>${esc(marketName(r.market))}</td>
          <td>${statusHtml(r.status)}
            ${r.error ? `<details><summary class="small muted" style="font-weight:500">Details</summary><pre class="err">${esc(r.error)}</pre></details>` : ""}</td>
          <td class="right num">${r.status === "running" ? "…" : fmtDuration(took)}</td>
          <td class="right num">${r.candidates}</td>
          <td class="right num">${r.requests_made ?? "–"}</td>
          <td class="muted small">“${esc(r.anchor)}”</td>
          <td class="right">${viewable ? `<a class="btn small" href="#rankings?m=${r.market}&run=${r.id}">View rankings</a>` : ""}</td>
        </tr>`; }).join("")}</tbody></table></div>
      <p class="help" style="margin-top:10px"><b>Partial</b> means Google refused or skipped some requests; the rankings still use everything that came back.
      If it happens often, raise the delays under Settings → Advanced.</p>`
      : emptyState()}`;
}

// ---------------------------------------------------------------------------
// view: settings
// ---------------------------------------------------------------------------
async function renderSettings() {
  const data = await api("/api/settings");
  const cfg = structuredClone(data.config);
  const v = $("#view");
  const momShare = Math.round((cfg.ranking.momentum_weight / (cfg.ranking.volume_weight + cfg.ranking.momentum_weight)) * 100);
  const markets = cfg.trends.geos.map((g) => g || "WW");

  v.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1>
      <p class="muted">Ignored words, list size and grouping apply as soon as you save. Everything else applies from the next refresh. Nothing here deletes past data.</p></div></div>
    <form id="settings" class="settings" autocomplete="off">
      <section class="card card-pad">
        <h2>What to track</h2>
        <div class="field" style="margin-top:14px">
          <label>Seed keywords ${info("Your starting points. Each refresh asks Google which searches are related to these and rising, and adds them automatically. Seeds also drive the Part ideas page.")}</label>
          <span class="help">Type a keyword and press Enter. Click × to remove one.</span>
          <div class="chips" data-key="seeds"></div>
        </div>
        <div class="field">
          <label>Ignore keywords containing ${info("Any discovered keyword or part idea containing one of these words is hidden right away and skipped in future refreshes. Your seeds and pinned keywords are never hidden.")}</label>
          <span class="help">For off-topic results, e.g. “rc”, “meaning”, “near me”.</span>
          <div class="chips" data-key="blocklist"></div>
        </div>
        <div class="grid-2" style="margin-top:18px">
          <div class="field">
            <label for="anchor">Comparison keyword ${info("Google never gives real search counts, so every keyword's popularity is measured against this one (1× = as popular as this). Pick something mid-sized in your niche. Changing it means new snapshots aren't directly comparable with old ones.")}</label>
            <input type="text" id="anchor" value="${esc(cfg.trends.anchor)}">
          </div>
          <div class="field">
            <label for="timeframe">Time range ${info("How far back the trend charts and popularity look. Past 12 months gives weekly detail and is best for spotting recent growth.")}</label>
            <select id="timeframe">${Object.entries(data.timeframes).map(([k, n]) => `<option value="${k}" ${k === cfg.trends.timeframe ? "selected" : ""}>${n}</option>`).join("")}</select>
          </div>
        </div>
      </section>

      <section class="card card-pad">
        <h2>Markets ${info(`Where the searches come from. Each market gets its own rankings, part ideas and breakdowns; switch between them with the picker at the top of the page. Each one is a separate refresh, so more markets take longer. Up to ${data.max_markets}.`)}</h2>
        <p class="help" style="margin-top:6px">Worldwide breaks results down by country. A single country breaks them down by province or state.</p>
        <div class="row" id="markets" style="margin-top:12px"></div>
        <div class="row" style="margin-top:10px">
          <select id="add-market" aria-label="Add a market"></select>
          <button type="button" class="btn" id="add-market-btn">Add market</button>
        </div>
      </section>

      <section class="card card-pad">
        <h2>Ranking</h2>
        <div class="field" style="margin-top:14px">
          <label for="balance">What matters more? ${info("Popularity favours keywords lots of people search. Momentum favours keywords that are growing, even if they're small. Growth is often the better hint for new products.")}</label>
          <div class="slider-row"><span class="muted small">Popularity</span>
            <input type="range" id="balance" min="0" max="100" step="5" value="${momShare}">
            <span class="muted small">Momentum</span></div>
          <span class="help" id="balance-text"></span>
        </div>
        <div class="field">
          <label for="top_n">Keywords in the ranked list ${info("How many rows the Rankings page shows. Country breakdowns are fetched for each of these, so a longer list adds about 15 seconds per extra keyword to each refresh.")}</label>
          <input type="number" id="top_n" min="5" max="50" value="${cfg.ranking.top_n}" style="width:100px">
        </div>
        <div class="field">
          <label class="toggle"><input type="checkbox" id="group_similar" ${cfg.ranking.group_similar ? "checked" : ""}>
            Group similar keywords ${info("Folds variants of the same search into one row, like “1.9 alh” and “1.9 alh tdi” under “alh”, so the list shows more different things. Part names like “alh turbo” always keep their own row.")}</label>
        </div>
      </section>

      <section class="card card-pad">
        <h2>Part ideas</h2>
        <div class="field" style="margin-top:14px">
          <label class="toggle"><input type="checkbox" id="part_ideas" ${cfg.discovery.part_ideas ? "checked" : ""}>
            Collect part ideas from Google autocomplete ${info("At the end of each refresh, types each seed plus every letter into Google's search box (“alh a”, “alh b”…) and saves the suggestions. That's how the Part ideas page finds specific searches like “alh injector seals”. Adds about 1 minute per seed per market.")}</label>
        </div>
      </section>

      <section class="card card-pad">
        <h2>Automatic refresh</h2>
        <div class="field" style="margin-top:14px">
          <label class="toggle"><input type="checkbox" id="sched-on" ${cfg.schedule.enabled ? "checked" : ""}> Refresh automatically every week
            ${info("Google Trends adds one new week of data at a time, so refreshing more often than weekly adds almost nothing new.")}</label>
        </div>
        <div class="row" id="sched-when" style="margin-top:10px">
          <span class="muted">Every</span>
          <select id="weekday">${data.weekdays.map((d, i) => `<option value="${i}" ${i === cfg.schedule.weekday ? "selected" : ""}>${d}</option>`).join("")}</select>
          <span class="muted">at</span>
          <select id="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === cfg.schedule.hour ? "selected" : ""}>${fmtHour(h)}</option>`).join("")}</select>
        </div>
        <p class="help" style="margin-top:8px">If the computer is off at that time, the refresh runs as soon as it's back on.</p>
      </section>

      <details class="card card-pad">
        <summary>Advanced</summary>
        <p class="help" style="margin-top:10px">The defaults work well. Change these only if refreshes keep showing “Partial” in History, or you want to fine-tune discovery.</p>
        <div class="grid-2" style="margin-top:14px">
          ${numField("rising_per_seed", "Rising searches per seed", cfg.discovery.rising_per_seed, 0, 25, "How many fast-growing related searches to take from each seed.")}
          ${numField("top_per_seed", "Popular searches per seed", cfg.discovery.top_per_seed, 0, 25, "How many common related searches to take from each seed.")}
          ${numField("max_candidates", "Max keywords checked per refresh", cfg.discovery.max_candidates, 10, 200, "Total keywords measured each refresh, across all seeds. Every 4 extra adds one request (about 15 seconds).")}
          ${numField("recent_weeks", "Momentum: recent weeks", cfg.ranking.recent_weeks, 1, 26, "Momentum compares the average of this many latest weeks…")}
          ${numField("baseline_weeks", "Momentum: compared against previous weeks", cfg.ranking.baseline_weeks, 1, 52, "…with the average of this many weeks before them.")}
          ${numField("min_delay_s", "Min. seconds between requests", cfg.rate_limit.min_delay_s, 2, 120, "Google blocks clients that ask too fast. Raise this if refreshes often end up Partial.")}
          ${numField("max_delay_s", "Max. seconds between requests", cfg.rate_limit.max_delay_s, 2, 180, "Each pause is a random time between the min and max, which looks less robotic to Google.")}
          ${numField("max_retries", "Retries when Google says “too many requests”", cfg.rate_limit.max_retries, 0, 10, "Each retry waits twice as long as the last (1 min, 2 min, 4 min…).")}
        </div>
        <label class="toggle" style="margin-top:14px"><input type="checkbox" id="hide_small" ${cfg.regions.hide_small_countries ? "checked" : ""}>
          Hide small countries and territories ${info("Google ranks countries by share of searches, so places with under ~1 million people (like St. Helena) can top the list from a handful of searches. Applies to past snapshots too.")}</label>
      </details>

      <div class="savebar">
        <span id="estimate" class="muted small"></span><span class="spacer"></span>
        <span id="dirty" class="small faint"></span>
        <button type="button" class="btn ghost" id="reset">Discard changes</button>
        <button class="btn primary" id="save">Save settings</button>
      </div>
    </form>`;

  const chipState = { seeds: [...cfg.discovery.seeds], blocklist: [...cfg.discovery.blocklist] };
  const markDirty = () => { state.settingsDirty = true; $("#dirty").textContent = "Unsaved changes"; updateEstimate(); };
  $$(".chips", v).forEach((box) => setupChips(box, chipState[box.dataset.key], markDirty));

  // markets: removable chips + a picker of everything not yet added
  const drawMarkets = () => {
    $("#markets").innerHTML = markets.map((c, i) => `<span class="chip">${esc(marketName(c))}
      ${markets.length > 1 ? `<button type="button" data-i="${i}" aria-label="Remove ${esc(marketName(c))}">×</button>` : ""}</span>`).join("");
    $$("#markets button").forEach((b) => b.addEventListener("click", () => { markets.splice(+b.dataset.i, 1); drawMarkets(); markDirty(); }));
    const common = ["WW", "US", "CA", "GB", "AU", "NZ"].filter((c) => !markets.includes(c));
    const rest = COUNTRY_CODES.filter((c) => !markets.includes(c) && !common.includes(c))
      .sort((a, b) => marketName(a).localeCompare(marketName(b)));
    const opt = (c) => `<option value="${c}">${esc(marketName(c))}</option>`;
    $("#add-market").innerHTML = `<option value="" selected disabled>Choose a country…</option>`
      + (common.length ? `<optgroup label="Common">${common.map(opt).join("")}</optgroup>` : "")
      + `<optgroup label="All countries">${rest.map(opt).join("")}</optgroup>`;
    const full = markets.length >= data.max_markets;
    $("#add-market").disabled = full;
    $("#add-market-btn").disabled = true;  // until a country is chosen
    $("#add-market-btn").dataset.tip = full ? `That's the maximum of ${data.max_markets}.` : "";
  };
  drawMarkets();
  $("#add-market").addEventListener("change", () => { $("#add-market-btn").disabled = !$("#add-market").value; });
  $("#add-market-btn").addEventListener("click", () => {
    const c = $("#add-market").value;
    if (c && !markets.includes(c) && markets.length < data.max_markets) { markets.push(c); drawMarkets(); markDirty(); }
  });

  const updateBalance = () => {
    const m = +$("#balance").value;
    const txt = m === 0 ? "Pure popularity: the most-searched keywords win."
      : m === 100 ? "Pure momentum: the fastest-growing keywords win, however small."
      : `${100 - m}% popularity, ${m}% momentum.${m > 60 ? " Favours fast-growing keywords." : m < 40 ? " Favours big, established keywords." : " A balance of big and growing keywords."}`;
    $("#balance-text").textContent = txt;
  };
  updateBalance();
  $("#balance").addEventListener("input", updateBalance);
  const syncSched = () => $$("#sched-when select").forEach((s) => (s.disabled = !$("#sched-on").checked));
  syncSched();
  $("#sched-on").addEventListener("change", syncSched);
  $("#settings").addEventListener("input", (e) => { if (e.target.id !== "add-market") markDirty(); });
  $("#settings").addEventListener("change", (e) => { if (e.target.id !== "add-market") markDirty(); });

  function collect() {
    const n = (id) => +$("#" + id).value;
    const m = n("balance") / 100;
    return {
      trends: { ...cfg.trends, anchor: $("#anchor").value, geos: markets.map((c) => (c === "WW" ? "" : c)), timeframe: $("#timeframe").value },
      discovery: { seeds: chipState.seeds, blocklist: chipState.blocklist, rising_per_seed: n("rising_per_seed"),
        top_per_seed: n("top_per_seed"), max_candidates: n("max_candidates"), part_ideas: $("#part_ideas").checked },
      ranking: { ...cfg.ranking, top_n: n("top_n"), volume_weight: +(1 - m).toFixed(2), momentum_weight: +m.toFixed(2),
        recent_weeks: n("recent_weeks"), baseline_weeks: n("baseline_weeks"), group_similar: $("#group_similar").checked },
      regions: { hide_small_countries: $("#hide_small").checked },
      rate_limit: { ...cfg.rate_limit, min_delay_s: n("min_delay_s"), max_delay_s: n("max_delay_s"), max_retries: n("max_retries") },
      schedule: { enabled: $("#sched-on").checked, weekday: n("weekday"), hour: n("hour") },
    };
  }

  let estTimer;
  function updateEstimate() {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      const r = await api("/api/settings/estimate", { method: "POST", body: collect() });
      const per = r.estimate && r.estimate.markets > 1 ? ` (${r.estimate.markets} markets)` : "";
      $("#estimate").innerHTML = r.error ? `<span style="color:var(--critical)">⚠ ${esc(r.error)}</span>`
        : `Each refresh${per}: about ${fmtDuration(r.estimate.seconds)} ${info(`About ${r.estimate.requests} requests to Google, spaced out so Google doesn't block them. It runs in the background.`)}`;
    }, 250);
  }
  updateEstimate();

  $("#reset").addEventListener("click", () => { state.settingsDirty = false; renderSettings(); });
  $("#settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings", { method: "PUT", body: collect() });
      state.settingsDirty = false;
      $("#dirty").textContent = "";
      toast("Settings saved.");
      await pollStatus();
    } catch (err) { toast(err.message, true); }
  });
}

function numField(id, label, value, min, max, help = "") {
  return `<div class="field" style="margin:0"><label for="${id}" class="small">${label}${help ? " " + info(help) : ""}</label>
    <input type="number" id="${id}" value="${value}" min="${min}" max="${max}" style="width:110px"></div>`;
}

function setupChips(box, list, onChange) {
  const draw = () => {
    box.innerHTML = list.map((t, i) => `<span class="chip">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join("")
      + `<input type="text" placeholder="${list.length ? "Add another…" : "Type a keyword and press Enter"}" aria-label="Add keyword">`;
    const inp = $("input", box);
    inp.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === ",") && inp.value.trim()) {
        e.preventDefault();
        inp.value.split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)
          .forEach((t) => { if (!list.includes(t)) list.push(t); });
        draw(); onChange(); $("input", box).focus();
      } else if (e.key === "Enter") e.preventDefault();
      else if (e.key === "Backspace" && !inp.value && list.length) { list.pop(); draw(); onChange(); $("input", box).focus(); }
    });
    inp.addEventListener("blur", () => {
      if (inp.value.trim()) { inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); }
    });
    $$("button", box).forEach((b) => b.addEventListener("click", () => { list.splice(+b.dataset.i, 1); draw(); onChange(); }));
  };
  box.addEventListener("click", (e) => { if (e.target === box) $("input", box).focus(); });
  draw();
}

// keep "updated X ago" and the countdown current between polls
setInterval(() => { if (state.status) renderTopbar(); }, 30000);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
window.addEventListener("beforeunload", (e) => { if (state.settingsDirty) e.preventDefault(); });
(async () => {
  await pollStatus();
  render();
})();
