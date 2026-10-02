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
  if (Math.abs(p) < 0.02) return '<span class="delta flat" title="Roughly flat">0%</span>';
  return p > 0
    ? `<span class="delta up" title="Up vs. the previous period">▲ ${fmtPct(p)}</span>`
    : `<span class="delta down" title="Down vs. the previous period">▼ ${fmtPct(p)}</span>`;
}
const score100 = (s) => (s == null ? null : Math.round(s * 100));
function meterHtml(s) {
  const v = score100(s);
  if (v == null) return '<span class="faint">–</span>';
  return `<div class="meter" title="Score ${v} / 100"><div class="meter-track"><div class="meter-fill" style="width:${v}%"></div></div><span>${v}</span></div>`;
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
  if (prev == null) return '<span class="move new" title="New in the list since the last refresh">NEW</span>';
  const d = prev - rank;
  if (d > 0) return `<span class="move up" title="Up ${d} since the last refresh">▲${d}</span>`;
  if (d < 0) return `<span class="move down" title="Down ${-d} since the last refresh">▼${-d}</span>`;
  return '<span class="move same" title="Same position as last time">•</span>';
}

const PIN_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4z" fill="currentColor"/></svg>`;
const PIN_OUTLINE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
function pinBtn(term, pinned) {
  return `<button class="icon-btn pin-toggle ${pinned ? "on" : ""}" data-term="${esc(term)}" data-pinned="${pinned ? 1 : 0}"
    title="${pinned ? "Unpin (stop forcing into the list)" : "Pin (always keep in the ranked list)"}"
    aria-label="${pinned ? "Unpin" : "Pin"} ${esc(term)}">${pinned ? PIN_SVG : PIN_OUTLINE_SVG}</button>`;
}

// ---------------------------------------------------------------------------
// tooltip
// ---------------------------------------------------------------------------
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
      <div class="hit" title="${esc(r.name)}: ${r.value}">
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
  explore: { q: "", filter: "all", sort: "score", dir: -1 } };

let pollTimer;
const schedulePoll = (ms) => { clearTimeout(pollTimer); pollTimer = setTimeout(pollStatus, ms); };
async function pollStatus() {
  clearTimeout(pollTimer);
  let st;
  try { st = await api("/api/status"); } catch (e) { schedulePoll(10000); return; }
  state.status = st;
  renderTopbar();
  const running = st.run.running;
  if (state.wasRunning && !running) {
    const last = st.last_attempted;
    if (last && last.status === "failed") toast("Refresh failed. See History for details.", true);
    else if (last && last.status === "cancelled") toast("Refresh cancelled.");
    else toast(last && last.status === "partial" ? "Refresh finished with some gaps. Rankings updated." : "Refresh finished. Rankings updated.");
    if (!(state.view === "settings" && state.settingsDirty)) render();
  } else if (state.wasRunning === false && running && state.view === "rankings" && !st.last_completed) {
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
  btn.title = run.running ? "" : `Fetch fresh data from Google Trends (takes about ${fmtDuration(st.estimate.seconds)})`;

  const updated = st.last_completed ? `Updated ${relTime(st.last_completed.started_at)}` : "No data yet";
  let auto, autoTitle = "";
  if (run.running) auto = "Updating now";
  else if (!st.schedule.enabled) { auto = "Automatic updates off"; autoTitle = "Turn them on in Settings"; }
  else {
    const nr = new Date(st.next_run);
    const ms = nr - Date.now();
    auto = ms < 120000 ? "Automatic update starting shortly" : `Automatically updates in ${fmtUntil(ms)}`;
    autoTitle = `Next automatic update: ${nr.toLocaleString(undefined, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Then every ${st.schedule.weekday}.`;
  }
  $("#freshness").innerHTML = `<span>${esc(updated)}</span><span class="auto" title="${esc(autoTitle)}">${CLOCK_SVG}${esc(auto)}</span>`;

  const banner = $("#progress");
  banner.hidden = !run.running;
  if (!run.running) return;
  const est = run.estimate || st.estimate;
  const order = ["discover", "interest", "regions"];
  const idx = order.indexOf(run.phase);
  let done = 0, total = est.discover + est.interest + est.regions;
  if (idx >= 0) {
    done = order.slice(0, idx).reduce((a, p) => a + est[p], 0);
    const phaseTotal = run.total || est[run.phase];
    done += (run.done / Math.max(phaseTotal, 1)) * est[run.phase];
  }
  const pct = Math.min(99, Math.round((done / total) * 100));
  $("#progress-fill").style.width = pct + "%";
  $(".progress-bar").setAttribute("aria-valuenow", pct);
  $("#progress-title").textContent = run.cancelling ? "Cancelling after the current request…"
    : idx >= 0 ? `Step ${idx + 1} of 3 · ${run.phase_label}` : "Starting refresh…";
  $("#progress-detail").textContent = run.detail ? `${run.done + 1} of ${run.total}: ${run.detail}` : "";
  const perReq = est.seconds / est.requests;
  const left = (total - done) * perReq;
  $("#progress-eta").textContent = `${pct}% · about ${fmtDuration(left)} left · started ${relTime(run.started_at)}. It's slow on purpose so Google doesn't block it. It runs on the server, so you can close this tab.`;
  $("#cancel-btn").disabled = !!run.cancelling;
}

async function startRun() {
  try {
    await api("/api/runs", { method: "POST" });
    toast("Refresh started. Rankings update automatically when it's done.");
    state.wasRunning = true;
    pollStatus();
  } catch (e) { toast(e.message, true); }
}

$("#run-btn").addEventListener("click", startRun);
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
  return { view: view || "rankings", run: params.get("run") ? +params.get("run") : null };
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
  const { view, run } = parseHash();
  state.view = view;
  state.runId = run;
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  const fn = { rankings: renderRankings, explore: renderExplore, pinned: renderPinned, history: renderHistory, settings: renderSettings }[view] || renderRankings;
  fn().catch((e) => ($("#view").innerHTML = `<div class="callout err">Couldn't load this page: ${esc(e.message)}</div>`));
}
const runQS = () => (state.runId ? `?run=${state.runId}` : "");

function snapshotBanner(run) {
  if (!state.runId || !run) return "";
  return `<div class="callout warn snapshot-banner row">Viewing an older snapshot from <b>${fmtDateTime(run.started_at)}</b>.
    <span class="spacer"></span><a href="#${state.view}">Back to latest</a></div>`;
}

function emptyState() {
  const st = state.status;
  if (st && st.run.running) {
    return `<div class="card empty"><h2>Your first refresh is running</h2>
      <p class="muted">Rankings will appear here automatically when it finishes (progress is shown above).</p></div>`;
  }
  return `<div class="card empty"><h2>No data yet</h2>
    <p class="muted">Run a first refresh to discover keywords and rank them. It takes about ${fmtDuration(st?.estimate.seconds)}.<br>
    After that it refreshes itself every week.</p>
    <button class="btn primary" onclick="startRun()">Run first refresh</button></div>`;
}

// ---------------------------------------------------------------------------
// view: rankings
// ---------------------------------------------------------------------------
async function renderRankings() {
  const data = await api("/api/ranking" + runQS());
  const v = $("#view");
  if (!data.run) { v.innerHTML = emptyState(); return; }
  const items = data.items;
  const anchor = data.run.anchor;
  const hasPrev = data.prev_run_id != null;
  const scored = items.filter((i) => i.score != null);
  const riser = scored.reduce((a, b) => (a == null || b.momentum > a.momentum ? b : a), null);
  const biggest = scored.reduce((a, b) => (a == null || b.volume > a.volume ? b : a), null);
  const newcomers = hasPrev ? items.filter((i) => i.prev_rank == null) : [];
  const where = data.run.geo ? `in ${data.run.geo}` : "worldwide";

  v.innerHTML = `
    ${snapshotBanner(data.run)}
    <div class="page-head">
      <div><h1>Top ${items.length} keywords</h1>
      <p class="muted">Google search interest ${esc(where)}, ranked by popularity and momentum. Click a keyword for details.</p></div>
    </div>
    <div class="tiles" style="margin-bottom:16px">
      <div class="card tile"><div class="label">Fastest riser</div>
        <div class="value">${riser ? esc(riser.term) : "–"}</div>
        <div class="sub">${riser ? `${momHtml(riser.momentum)} over the last few weeks` : ""}</div></div>
      <div class="card tile"><div class="label">Most searched</div>
        <div class="value">${biggest ? esc(biggest.term) : "–"}</div>
        <div class="sub">${biggest ? `${fmtVol(biggest.volume)} as popular as “${esc(anchor)}”` : ""}</div></div>
      <div class="card tile"><div class="label">New in the list</div>
        <div class="value">${hasPrev ? newcomers.length : "–"}</div>
        <div class="sub">${hasPrev ? (newcomers.length ? esc(newcomers.slice(0, 3).map((n) => n.term).join(", ")) + (newcomers.length > 3 ? "…" : "") : "Same keywords as last time") : "First snapshot. Changes show up next week."}</div></div>
      <div class="card tile"><div class="label">Snapshot</div>
        <div class="value">${fmtDate(data.run.started_at)}</div>
        <div class="sub">${statusHtml(data.run.status)}${data.run.status === "partial" ? ' · <a href="#history">some data missing</a>' : ""}</div></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr>
          <th>#</th><th title="Change in position since the previous refresh"></th>
          <th>Keyword</th>
          <th class="hide-sm" title="Search interest over the selected time range">Trend</th>
          <th class="right" title="Average search interest compared to “${esc(anchor)}” (1× = same popularity)">Popularity ⓘ</th>
          <th class="right" title="Last 4 weeks compared to the 12 weeks before">Momentum ⓘ</th>
          <th title="Combined score, 0–100">Score ⓘ</th>
          <th class="hide-sm">Top ${data.run.geo ? "regions" : "countries"}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${items.map((r) => `
            <tr class="clickable" tabindex="0" data-term="${esc(r.term)}">
              <td class="rank num">${r.rank}</td>
              <td>${moveHtml(r.rank, r.prev_rank, hasPrev)}</td>
              <td class="kw-cell"><div class="kw">${esc(r.term)}</div>
                <div class="row" style="gap:4px;margin-top:2px">
                  ${r.pinned ? `<span class="badge pin">Pinned</span>` : ""}
                  ${r.source && r.source !== "pin" ? `<span class="badge" title="${esc(SOURCE_HELP[r.source])}">${esc(SOURCE_LABEL[r.source])}</span>` : ""}
                </div></td>
              <td class="hide-sm">${sparkline(r.series)}</td>
              <td class="right num">${fmtVol(r.volume)}</td>
              <td class="right num">${momHtml(r.momentum)}</td>
              <td>${meterHtml(r.score)}</td>
              <td class="hide-sm regions-mini">${r.top_regions.map((x) => esc(x.name)).join(", ") || (r.regions_fetched
                ? '<span class="faint" title="Not enough searches for a reliable breakdown">too few searches</span>'
                : '<span class="faint" title="Moved up after you ignored a keyword. Countries are looked up on the next refresh.">next refresh</span>')}</td>
              <td class="right">${pinBtn(r.term, r.pinned_now)}</td>
            </tr>`).join("")}
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
        <p><b>Where keywords come from:</b> your seed keywords, plus searches Google reports as rising or popular alongside them.
        See every keyword checked in <a href="#explore">All keywords</a>.</p>
      </div>
    </details>`;

  $$("tbody tr.clickable", v).forEach((tr) => {
    tr.addEventListener("click", () => openKeyword(tr.dataset.term));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openKeyword(tr.dataset.term); });
  });
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
  try { k = await api(`/api/keyword?term=${encodeURIComponent(term)}${state.runId ? "&run=" + state.runId : ""}`); }
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
          ${k.rank ? `<span class="badge">#${k.rank} in the list</span>` : `<span class="badge">Not in the top list</span>`}
          ${c.source ? `<span class="badge" title="${esc(SOURCE_HELP[c.source])}">${esc(SOURCE_LABEL[c.source])}</span>` : ""}
          ${pinned ? `<span class="badge pin">Pinned</span>` : ""}
          ${k.ignored ? `<span class="badge" title="Matches a word in your ignore list (Settings)">Ignored</span>` : ""}
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
    <div class="facts">
      <div class="fact"><div class="label">Popularity</div><div class="value">${fmtVol(c.volume)}</div></div>
      <div class="fact"><div class="label">Momentum</div><div class="value">${momHtml(c.momentum)}</div></div>
      <div class="fact"><div class="label">Score</div><div class="value">${score100(c.score) ?? "–"}${c.score != null ? '<span class="faint small"> / 100</span>' : ""}</div></div>
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
      <h2>Where people search for it</h2>
      ${!k.regions_fetched ? '<p class="muted">This keyword moved into the list after you ignored another one. Its countries are looked up on the next refresh.</p>' : hbars(regionsShown, `100 = the ${k.region_kind} where this keyword takes the biggest share of searches. Showing the top ${regionsShown.length} of ${k.regions.length}.${k.small_hidden ? " Small countries are hidden (Settings → Advanced)." : ""}`)}
    </div>` : ""}

    <div class="section">
      <h2>How it was found</h2>
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
  const data = await api("/api/candidates" + runQS());
  const v = $("#view");
  if (!data.run) { v.innerHTML = emptyState(); return; }
  const ex = state.explore;
  const filters = { all: "All", rising: "Rising", top: "Popular related", seed: "Seeds", pin: "Pinned", ranked: "In top list", ignored: "Ignored", problem: "Problems" };
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
        counts[k] || k === "all" ? `<button data-f="${k}" class="${ex.filter === k ? "on" : ""}">${l} <span class="faint">${counts[k]}</span></button>` : "").join("")}</div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr>
        ${[["term", "Keyword"], ["source", "Found via"], ["volume", "Popularity", "right"], ["momentum", "Momentum", "right"], ["score", "Score"], ["rank", "Rank", "right"]]
          .map(([k, l, cls]) => `<th class="sortable ${cls || ""}" data-sort="${k}">${l}${ex.sort === k ? (ex.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}
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
          ${r.error ? `<span class="badge" style="margin-left:6px" title="${esc(r.error)}">⚠ no data</span>` : ""}
          ${r.ignored ? `<span class="badge" style="margin-left:6px" title="Matches a word in your ignore list (Settings)">Ignored</span>` : ""}</td>
        <td><span class="badge" title="${esc(SOURCE_HELP[r.source])}">${esc(SOURCE_LABEL[r.source] || r.source)}</span></td>
        <td class="right num">${fmtVol(r.volume)}</td>
        <td class="right num">${momHtml(r.momentum)}</td>
        <td>${meterHtml(r.score)}</td>
        <td class="right num">${r.rank ? "#" + r.rank : '<span class="faint">–</span>'}</td>
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
  const pins = await api("/api/pins");
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <div><h1>Pinned keywords</h1>
      <p class="muted">Pinned keywords always appear in the ranked list, whatever their score. Handy for your own products, brands, or anything you want to watch.</p></div>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">${addKeywordForm("add-form", "Pin keyword")}
      <p class="help" style="margin-top:8px">Tip: you can also pin straight from the Rankings or All keywords lists using the pin icon.</p></div>
    ${pins.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Keyword</th><th>Note</th><th class="right">Current rank</th><th>Pinned</th><th></th></tr></thead>
      <tbody>${pins.map((p) => `<tr>
        <td class="kw-cell"><a href="javascript:void 0" class="kw open-kw" data-term="${esc(p.term)}">${esc(p.term)}</a></td>
        <td><input type="text" class="pin-note" data-term="${esc(p.term)}" value="${esc(p.note || "")}" placeholder="Add a note…" style="width:100%;min-width:160px"></td>
        <td class="right num">${p.rank ? "#" + p.rank : '<span class="faint" title="Will be measured on the next refresh">pending</span>'}</td>
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
      <thead><tr><th>Started</th><th>Status</th><th class="right">Took</th><th class="right">Keywords checked</th><th class="right">Google requests</th><th>Settings used</th><th></th></tr></thead>
      <tbody>${runs.map((r) => {
        const took = r.finished_at ? (new Date(r.finished_at) - new Date(r.started_at)) / 1000 : null;
        const viewable = r.ranked > 0;
        return `<tr>
          <td>${fmtDateTime(r.started_at)}<div class="faint small">${relTime(r.started_at)}</div></td>
          <td>${statusHtml(r.status)}
            ${r.error ? `<details><summary class="small muted" style="font-weight:500">Details</summary><pre class="err">${esc(r.error)}</pre></details>` : ""}</td>
          <td class="right num">${r.status === "running" ? "…" : fmtDuration(took)}</td>
          <td class="right num">${r.candidates}</td>
          <td class="right num">${r.requests_made ?? "–"}</td>
          <td class="muted small">vs “${esc(r.anchor)}” · ${r.geo ? esc(r.geo) : "worldwide"}</td>
          <td class="right">${viewable ? `<a class="btn small" href="#rankings?run=${r.id}">View rankings</a>` : ""}</td>
        </tr>`; }).join("")}</tbody></table></div>
      <p class="help" style="margin-top:10px"><b>Partial</b> means Google refused or skipped some requests; the rankings still use everything that came back.
      If it happens often, raise the delays under Settings → Advanced.</p>`
      : emptyState()}`;
}

// ---------------------------------------------------------------------------
// view: settings
// ---------------------------------------------------------------------------
const GEOS = [["", "Worldwide"], ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"],
  ["NZ", "New Zealand"], ["ZA", "South Africa"], ["DE", "Germany"], ["other", "Other country code…"]];

async function renderSettings() {
  const data = await api("/api/settings");
  const cfg = structuredClone(data.config);
  const v = $("#view");
  const momShare = Math.round((cfg.ranking.momentum_weight / (cfg.ranking.volume_weight + cfg.ranking.momentum_weight)) * 100);
  const knownGeo = GEOS.some(([c]) => c === cfg.trends.geo);

  v.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1>
      <p class="muted">Ignored words apply as soon as you save; other changes apply from the next refresh. Nothing here deletes past data.</p></div></div>
    <form id="settings" class="settings" autocomplete="off">
      <section class="card card-pad">
        <h2>What to track</h2>
        <div class="field" style="margin-top:14px">
          <label>Seed keywords</label>
          <span class="help">Starting points. Each refresh, Google's related and rising searches for these are discovered automatically. Type a keyword and press Enter.</span>
          <div class="chips" data-key="seeds"></div>
        </div>
        <div class="field">
          <label>Ignore keywords containing</label>
          <span class="help">Discovered keywords that contain any of these words are hidden from the lists as soon as you save, and skipped in future refreshes (e.g. “meaning”, “near me”, a brand you don't care about). Seeds and pinned keywords are never hidden.</span>
          <div class="chips" data-key="blocklist"></div>
        </div>
        <div class="grid-2" style="margin-top:18px">
          <div class="field">
            <label for="anchor">Comparison keyword</label>
            <input type="text" id="anchor" value="${esc(cfg.trends.anchor)}">
            <span class="help">Every keyword's popularity is measured against this one. Pick something mid-sized in your niche. Changing it makes new snapshots not directly comparable with old ones.</span>
          </div>
          <div class="field">
            <label for="geo">Region</label>
            <select id="geo">${GEOS.map(([c, n]) => `<option value="${c}" ${(knownGeo ? c === cfg.trends.geo : c === "other") ? "selected" : ""}>${n}</option>`).join("")}</select>
            <input type="text" id="geo-other" maxlength="2" placeholder="2-letter code, e.g. MX" value="${knownGeo ? "" : esc(cfg.trends.geo)}" ${knownGeo ? "hidden" : ""}>
            <span class="help">Worldwide shows a per-country breakdown; a single country shows its provinces/states instead.</span>
          </div>
          <div class="field">
            <label for="timeframe">Time range</label>
            <select id="timeframe">${Object.entries(data.timeframes).map(([k, n]) => `<option value="${k}" ${k === cfg.trends.timeframe ? "selected" : ""}>${n}</option>`).join("")}</select>
          </div>
        </div>
      </section>

      <section class="card card-pad">
        <h2>Ranking</h2>
        <div class="field" style="margin-top:14px">
          <label for="balance">What matters more?</label>
          <div class="slider-row"><span class="muted small">Popularity</span>
            <input type="range" id="balance" min="0" max="100" step="5" value="${momShare}">
            <span class="muted small">Momentum</span></div>
          <span class="help" id="balance-text"></span>
        </div>
        <div class="field">
          <label for="top_n">Keywords in the ranked list</label>
          <input type="number" id="top_n" min="5" max="50" value="${cfg.ranking.top_n}" style="width:100px">
          <span class="help">Country breakdowns are fetched for this many keywords, so bigger lists take longer.</span>
        </div>
      </section>

      <section class="card card-pad">
        <h2>Automatic refresh</h2>
        <div class="field" style="margin-top:14px">
          <label class="toggle"><input type="checkbox" id="sched-on" ${cfg.schedule.enabled ? "checked" : ""}> Refresh automatically every week</label>
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
        <div class="grid-2" style="margin-top:14px">
          ${numField("rising_per_seed", "Rising searches per seed", cfg.discovery.rising_per_seed, 0, 25)}
          ${numField("top_per_seed", "Popular searches per seed", cfg.discovery.top_per_seed, 0, 25)}
          ${numField("max_candidates", "Max keywords checked per refresh", cfg.discovery.max_candidates, 10, 200)}
          ${numField("recent_weeks", "Momentum: recent weeks", cfg.ranking.recent_weeks, 1, 26)}
          ${numField("baseline_weeks", "Momentum: compared against previous weeks", cfg.ranking.baseline_weeks, 1, 52)}
          ${numField("min_delay_s", "Min. seconds between requests", cfg.rate_limit.min_delay_s, 2, 120)}
          ${numField("max_delay_s", "Max. seconds between requests", cfg.rate_limit.max_delay_s, 2, 180)}
          ${numField("max_retries", "Retries when Google says “too many requests”", cfg.rate_limit.max_retries, 0, 10)}
        </div>
        <label class="toggle" style="margin-top:14px"><input type="checkbox" id="hide_small" ${cfg.regions.hide_small_countries ? "checked" : ""}> Hide small countries and territories (under ~1 million people)</label>
        <p class="help">Google ranks countries by share of searches, so places like St. Helena can top the list from a handful of searches. Applies to past snapshots too.</p>
        <p class="help" style="margin-top:10px">Google blocks clients that ask too fast. Longer delays make refreshes slower but more reliable.</p>
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

  const updateBalance = () => {
    const m = +$("#balance").value;
    const txt = m === 0 ? "Pure popularity: the most-searched keywords win."
      : m === 100 ? "Pure momentum: the fastest-growing keywords win, however small."
      : `${100 - m}% popularity, ${m}% momentum.${m > 60 ? " Favours fast-growing keywords." : m < 40 ? " Favours big, established keywords." : " A balance of big and growing keywords."}`;
    $("#balance-text").textContent = txt;
  };
  updateBalance();
  $("#balance").addEventListener("input", updateBalance);
  $("#geo").addEventListener("change", () => { $("#geo-other").hidden = $("#geo").value !== "other"; });
  const syncSched = () => $$("#sched-when select").forEach((s) => (s.disabled = !$("#sched-on").checked));
  syncSched();
  $("#sched-on").addEventListener("change", syncSched);
  $("#settings").addEventListener("input", markDirty);
  $("#settings").addEventListener("change", markDirty);

  function collect() {
    const n = (id) => +$("#" + id).value;
    const geo = $("#geo").value === "other" ? $("#geo-other").value.trim().toUpperCase() : $("#geo").value;
    const m = n("balance") / 100;
    return {
      trends: { ...cfg.trends, anchor: $("#anchor").value, geo, timeframe: $("#timeframe").value },
      discovery: { seeds: chipState.seeds, blocklist: chipState.blocklist, rising_per_seed: n("rising_per_seed"),
        top_per_seed: n("top_per_seed"), max_candidates: n("max_candidates") },
      ranking: { ...cfg.ranking, top_n: n("top_n"), volume_weight: +(1 - m).toFixed(2), momentum_weight: +m.toFixed(2),
        recent_weeks: n("recent_weeks"), baseline_weeks: n("baseline_weeks") },
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
      $("#estimate").innerHTML = r.error ? `<span style="color:var(--critical)">⚠ ${esc(r.error)}</span>`
        : `Each refresh: about ${r.estimate.requests} Google requests, ~${fmtDuration(r.estimate.seconds)}`;
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
      toast("Settings saved. Ignored words apply right away; everything else from the next refresh.");
      pollStatus();
    } catch (err) { toast(err.message, true); }
  });
}

function numField(id, label, value, min, max) {
  return `<div class="field" style="margin:0"><label for="${id}" class="small">${label}</label>
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
