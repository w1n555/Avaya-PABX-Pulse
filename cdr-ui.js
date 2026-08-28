/**
 * CDR tab — real daily files via /CM/api/cdr/*
 * Search / Daily / Weekly / Monthly with progress popup (file-by-file %).
 */

import { apiUrl, fetchJson, escapeHtml } from "./http.js?v=20260827d";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateInputValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toMonthInputValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function ymdFromInput(s) {
  return (s || "").replace(/-/g, "");
}

function parseLocalDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad2(r)}`;
}

async function apiGet(path) {
  return fetchJson(apiUrl(path));
}

const CDR = {
  lastSearch: [],
  busy: false,
  statusTimer: null,
};

/* ---------- progress modal (shared with Trunk tab) ---------- */
export function showProgress(title, sub) {
  const m = document.getElementById("progress-modal");
  if (!m) return;
  m.hidden = false;
  document.getElementById("progress-modal-title").textContent = title || "Working…";
  document.getElementById("progress-modal-sub").textContent = sub || "Please wait…";
  document.getElementById("progress-modal-detail").textContent = "";
  document.getElementById("progress-bar-fill").style.width = "0%";
  document.getElementById("progress-pct").textContent = "0%";
  document.getElementById("progress-modal-spinner").className = "modal-spinner";
  document.getElementById("btn-progress-close").hidden = true;
}

export function setProgress(pct, detail) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = document.getElementById("progress-bar-fill");
  const label = document.getElementById("progress-pct");
  if (fill) fill.style.width = p + "%";
  if (label) label.textContent = p + "%";
  if (detail != null) {
    const el = document.getElementById("progress-modal-detail");
    if (el) el.textContent = detail;
  }
}

export function hideProgress(delayMs = 0) {
  const m = document.getElementById("progress-modal");
  if (!m) return;
  const go = () => {
    m.hidden = true;
  };
  if (delayMs > 0) setTimeout(go, delayMs);
  else go();
}

export function finishProgress(ok, message) {
  const spin = document.getElementById("progress-modal-spinner");
  const sub = document.getElementById("progress-modal-sub");
  if (spin) spin.className = ok ? "modal-spinner done" : "modal-spinner fail";
  if (sub) sub.textContent = message || (ok ? "Done" : "Failed");
  if (!ok) {
    const btn = document.getElementById("btn-progress-close");
    if (btn) btn.hidden = false;
  } else hideProgress(500);
}

function renderHourChart(el, counts) {
  if (!el) return;
  const max = Math.max(1, ...counts);
  el.innerHTML = counts
    .map((c, hour) => {
      const pct = Math.round((c / max) * 100);
      const peak = c === max && c > 0;
      return `<div class="hour-bar-wrap" title="${hour}:00 — ${c} calls">
        <div class="hour-bar ${peak ? "peak" : ""}" style="height:${Math.max(2, pct)}%"></div>
        <span class="hour-n">${c || ""}</span>
      </div>`;
    })
    .join("");
}

function renderKpis(el, items) {
  if (!el) return;
  el.innerHTML = items
    .map(
      (it) => `<div class="cdr-kpi">
      <div class="cdr-kpi-v">${escapeHtml(String(it.value))}</div>
      <div class="cdr-kpi-k">${escapeHtml(it.label)}</div>
    </div>`
    )
    .join("");
}

function emptyHourly() {
  return Array(24).fill(0);
}

function addHourly(a, b) {
  for (let i = 0; i < 24; i++) a[i] += b[i] || 0;
  return a;
}

function peakOf(counts) {
  let max = -1;
  let hour = 0;
  for (let i = 0; i < 24; i++) {
    if (counts[i] > max) {
      max = counts[i];
      hour = i;
    }
  }
  return { hour, count: Math.max(0, max) };
}

/** TAC groups for chart filters */
const TAC_SSP = ["1401", "1402", "1403"];
const TAC_BPS = ["1411", "1412", "1413"];
/** Pull enough matches for concurrent math (API caps Matches list by maxMatches). */
const CHART_MAX_MATCHES = 250000;
/** CDR Search table / export cap (per day fetch + on-screen rows). */
const SEARCH_MAX_SHOW = 5000;

/** Read IN/OUT/SSP/BPS toggles for one card: scope = daily | weekly | monthly */
function getChartFilters(scope) {
  const root = document.querySelector(`.cdr-toggle-row[data-flt-scope="${scope}"]`);
  const on = (name) => !!root?.querySelector(`.cdr-toggle[data-flt="${name}"]`)?.classList.contains("is-on");
  return {
    in: on("in"),
    out: on("out"),
    ssp: on("ssp"),
    bps: on("bps"),
  };
}

function chartFilterLabel(f) {
  const bits = [];
  if (f.in) bits.push("IN");
  if (f.out) bits.push("OUT");
  if (f.ssp) bits.push("SSP");
  if (f.bps) bits.push("BPS");
  return bits.length ? bits.join("+") : "ALL";
}

function tacFields(r) {
  return [r.codeUsed, r.inTrk, r.outCrt, r.codeDial, r.inCrt]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function tacHits(r, tacs) {
  const fields = tacFields(r);
  return tacs.some((t) =>
    fields.some((f) => f === t || f.endsWith(t) || f.includes(t))
  );
}

/** IN / OUT / SSP / BPS — none ON = match all. */
function recordMatchesChartFilter(r, f) {
  const dirOn = f.in || f.out;
  if (dirOn) {
    const d = String(r.dir || "").toLowerCase();
    const isIn = d === "in";
    const isOut = d === "out";
    if (f.in && f.out) {
      if (!isIn && !isOut) return false;
    } else if (f.in && !isIn) return false;
    else if (f.out && !isOut) return false;
  }
  const tacOn = f.ssp || f.bps;
  if (tacOn) {
    const tacs = [];
    if (f.ssp) tacs.push(...TAC_SSP);
    if (f.bps) tacs.push(...TAC_BPS);
    if (!tacHits(r, tacs)) return false;
  }
  return true;
}

/**
 * CDR time is usually disconnect (end). start = end − duration.
 * date MMDDYY, time HHMM.
 */
function parseCdrEndMs(r) {
  const d = String(r.date || "").trim();
  const t = String(r.time || "").trim();
  if (d.length >= 6 && t.length >= 4) {
    const mm = Number(d.slice(0, 2));
    const dd = Number(d.slice(2, 4));
    const yy = Number(d.slice(4, 6));
    const hh = Number(t.slice(0, 2));
    const mi = Number(t.slice(2, 4));
    if (
      mm >= 1 &&
      mm <= 12 &&
      dd >= 1 &&
      dd <= 31 &&
      hh >= 0 &&
      hh <= 23 &&
      mi >= 0 &&
      mi <= 59
    ) {
      return new Date(2000 + yy, mm - 1, dd, hh, mi, 0).getTime();
    }
  }
  // fallback: recvLocal
  if (r.recvLocal) {
    const dt = new Date(r.recvLocal);
    if (!Number.isNaN(dt.getTime())) return dt.getTime();
  }
  return null;
}

function fmtConcurrentAt(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * Sweep-line max concurrent. Returns { max, atMs }.
 * durationSec<=0 ignored (no channel occupancy).
 */
function computeConcurrentPeak(records) {
  const events = [];
  for (const r of records) {
    const end = parseCdrEndMs(r);
    if (end == null) continue;
    const dur = Math.max(0, Math.round(Number(r.durationSec) || 0));
    if (dur <= 0) continue;
    const start = end - dur * 1000;
    events.push({ t: start, d: 1 });
    events.push({ t: end, d: -1 });
  }
  if (!events.length) return { max: 0, atMs: null };
  // Same timestamp: free (-1) before seize (+1)
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let max = 0;
  let atMs = null;
  for (const e of events) {
    cur += e.d;
    if (cur > max) {
      max = cur;
      atMs = e.t;
    }
  }
  return { max, atMs };
}

function hourlyFromRecords(records) {
  const hourly = emptyHourly();
  for (const r of records) {
    let h = Number(r.hour);
    if (!(h >= 0 && h <= 23)) {
      const end = parseCdrEndMs(r);
      if (end == null) continue;
      h = new Date(end).getHours();
    }
    if (h >= 0 && h <= 23) hourly[h]++;
  }
  return hourly;
}

function filterRecords(matches, chartFilter) {
  const list = Array.isArray(matches) ? matches : [];
  return list.filter((r) => recordMatchesChartFilter(r, chartFilter));
}

function bindChartToggles() {
  document.querySelectorAll(".cdr-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("is-on");
      btn.setAttribute("aria-pressed", btn.classList.contains("is-on") ? "true" : "false");
    });
  });
}

function kpisForChart({ total, peak, concurrent, filterLabel, extra = [] }) {
  const concVal =
    concurrent && concurrent.max > 0
      ? `${concurrent.max} ch · ${fmtConcurrentAt(concurrent.atMs)}`
      : concurrent && concurrent.max === 0
        ? "0"
        : "—";
  return [
    { label: "Calls", value: total },
    { label: "Peak hour", value: `${peak.hour}:00 (${peak.count})` },
    { label: "Concurrent", value: concVal },
    { label: "Filter", value: filterLabel },
    ...extra,
  ];
}

function getFilterFromForm() {
  return {
    calling: document.getElementById("cdr-calling")?.value || "",
    called: document.getElementById("cdr-called")?.value || "",
    trunk: document.getElementById("cdr-trunk")?.value || "",
    dir: document.getElementById("cdr-dir")?.value || "",
    minDur: "0",
  };
}

/** Avaya CM condition code → short English (common set; non-59-char formats). */
function condLabel(code) {
  const c = String(code || "").trim().toUpperCase();
  const map = {
    "0": "Intra-switch",
    "1": "Attendant",
    "3": "Conference",
    "4": "Long call",
    "6": "ISDN/data",
    "7": "Outgoing",
    "8": "In→Attn",
    "9": "Incoming",
    A: "Outgoing",
    B: "Adjunct out",
    C: "Conference",
    E: "Feature",
    F: "Forwarded",
    G: "AAR/ARS",
    H: "Headset",
    I: "Incomplete",
    J: "DID/attendant",
    K: "Lookahead",
    L: "Conference",
    M: "MWI",
    N: "Network",
    P: "Personal CO",
    R: "Ringdown",
    S: "Serial",
    T: "Redirected",
    U: "Unattended",
  };
  if (!c) return "—";
  const name = map[c];
  return name ? `${c} · ${name}` : c;
}

/**
 * NOC-friendly party / TAC view.
 * TAC1 = code-used (often out TAC / access code)
 * TAC2 = in-trk (incoming trunk TAC) — empty on pure outbound when CM leaves it blank
 */
function partyView(r) {
  const dir = (r.dir || "").toLowerCase();
  const calling = (r.callingNum || r.clgNum || "").trim();
  const dialed = (r.dialedNum || "").trim();
  const clg = (r.clgNum || "").trim();
  const tac1 = (r.codeUsed || r.codeDial || "").trim();
  const tac2 = (r.inTrk || "").trim();

  if (dir === "in" || r.cond === "9") {
    return {
      from: calling || clg || "—",
      to: dialed || "—",
      tac1: tac1 || "—",
      tac2: tac2 || "—",
    };
  }
  if (dir === "out" || r.cond === "7" || r.cond === "A") {
    return {
      from: clg || calling || "—",
      to: dialed || "—",
      tac1: tac1 || "—",
      tac2: tac2 || "—",
    };
  }
  return {
    from: calling || clg || "—",
    to: dialed || "—",
    tac1: tac1 || "—",
    tac2: tac2 || "—",
  };
}

function qs(params) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v != null) u.set(k, v);
  });
  return u.toString();
}

/** Enumerate yyyyMMdd keys for a calendar range (inclusive). */
function eachDayKey(fromYmd, toYmd) {
  const out = [];
  let d = parseLocalDate(
    `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)}`
  );
  const end = parseLocalDate(`${toYmd.slice(0, 4)}-${toYmd.slice(4, 6)}-${toYmd.slice(6, 8)}`);
  if (!d || !end) return out;
  while (d <= end) {
    out.push(
      `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    );
    d = addDays(d, 1);
  }
  return out;
}

async function scanDay(ymd, filter, maxMatches = 500) {
  const dateIso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const q = qs({
    date: dateIso,
    calling: filter.calling,
    called: filter.called,
    trunk: filter.trunk,
    dir: filter.dir,
    minDur: filter.minDur,
    maxMatches,
  });
  return apiGet("cdr/scan-day?" + q);
}

/**
 * Scan many days with progress callback.
 * @param {string[]} dayKeys yyyyMMdd
 * @param {(pct:number, detail:string, dayResult:object)=>void} onProgress
 */
async function scanDays(dayKeys, filter, onProgress, maxMatchesPerDay = 500) {
  const results = [];
  const n = Math.max(1, dayKeys.length);
  for (let i = 0; i < dayKeys.length; i++) {
    const ymd = dayKeys[i];
    const r = await scanDay(ymd, filter, maxMatchesPerDay);
    results.push(r);
    const pct = ((i + 1) / n) * 100;
    const detail = `Scanning ${ymd}.txt  (${i + 1}/${dayKeys.length})` +
      (r.fileExists ? ` · ${r.totalInFile || 0} rows` : " · file missing");
    onProgress(pct, detail, r);
  }
  return results;
}

async function runSearch() {
  if (CDR.busy) return;
  CDR.busy = true;
  const from = document.getElementById("cdr-from")?.value;
  const to = document.getElementById("cdr-to")?.value;
  if (!from || !to) {
    alert("Please set From and To dates.");
    CDR.busy = false;
    return;
  }
  const filter = getFilterFromForm();
  const fromKey = ymdFromInput(from);
  const toKey = ymdFromInput(to);

  showProgress("CDR Search", "Listing daily files…");
  try {
    // Prefer only days that exist (faster progress)
    const files = await apiGet(`cdr/files?from=${from}&to=${to}`);
    let days = files.days || [];
    if (!days.length) {
      // still walk calendar so user sees 100% over empty range
      days = eachDayKey(fromKey, toKey);
    }
    if (!days.length) {
      finishProgress(false, "No days in range");
      CDR.busy = false;
      return;
    }

    setProgress(0, `0 / ${days.length} files`);
    const allMatches = [];
    let totalMatch = 0;
    let totalRows = 0;
    let filesHit = 0;

    await scanDays(days, filter, (pct, detail, day) => {
      setProgress(pct, detail);
      if (day.fileExists) filesHit++;
      totalRows += day.totalInFile || 0;
      totalMatch += day.matchCountTotal ?? day.matchCount ?? 0;
      for (const m of day.matches || []) allMatches.push(m);
    }, SEARCH_MAX_SHOW);

    // sort by recv time desc
    allMatches.sort((a, b) => String(b.recvLocal).localeCompare(String(a.recvLocal)));
    CDR.lastSearch = allMatches;

    const meta = document.getElementById("cdr-search-meta");
    const show = allMatches.slice(0, SEARCH_MAX_SHOW);
    const capped = totalMatch > show.length;
    if (meta) {
      meta.textContent =
        `Matched ${totalMatch} call(s) in ${filesHit} file(s) · scanned ${totalRows} rows · showing ${show.length}` +
        (capped ? " (capped)" : "");
      meta.classList.toggle("is-capped", capped);
    }
    renderSearchTable(show);
    setProgress(100, "Complete");
    finishProgress(true, `Found ${totalMatch} record(s)`);
  } catch (e) {
    finishProgress(false, String(e.message || e));
    document.getElementById("btn-progress-close").hidden = false;
  } finally {
    CDR.busy = false;
  }
}

function renderSearchTable(rows) {
  const tbody = document.getElementById("cdr-result-tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="9">No matching records.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const p = partyView(r);
      const dir = (r.dir || "").toLowerCase();
      return `<tr>
        <td class="mono">${escapeHtml(r.recvLocal || "")}</td>
        <td>${dir ? `<span class="dir-pill ${dir}">${dir}</span>` : "—"}</td>
        <td class="mono">${escapeHtml(p.from)}</td>
        <td class="mono">${escapeHtml(p.to)}</td>
        <td class="mono" title="TAC1 = code-used (out TAC / access)">${escapeHtml(p.tac1)}</td>
        <td class="mono" title="TAC2 = incoming trunk TAC">${escapeHtml(p.tac2)}</td>
        <td class="mono">${fmtDur(r.durationSec)}</td>
        <td class="mono" title="Avaya condition code">${escapeHtml(condLabel(r.cond))}</td>
      </tr>`;
    })
    .join("");
}

async function calcDaily() {
  if (CDR.busy) return;
  CDR.busy = true;
  const day = document.getElementById("cdr-day")?.value;
  if (!day) {
    alert("Pick a day");
    CDR.busy = false;
    return;
  }
  const f = getChartFilters("daily");
  const fl = chartFilterLabel(f);
  showProgress("Daily hourly", `Filter ${fl} · scanning…`);
  try {
    const ymd = ymdFromInput(day);
    setProgress(10, `${ymd}.txt`);
    // Pull full match list so filter + concurrent are accurate
    const r = await scanDay(ymd, {}, CHART_MAX_MATCHES);
    setProgress(70, r.fileExists ? `Filtering ${fl}…` : "File not found");
    const rows = filterRecords(r.matches || r.Matches || [], f);
    const hourly = hourlyFromRecords(rows);
    const peak = peakOf(hourly);
    const concurrent = computeConcurrentPeak(rows);
    const total = rows.length;
    renderHourChart(document.getElementById("cdr-daily-chart"), hourly);
    renderKpis(
      document.getElementById("cdr-daily-kpi"),
      kpisForChart({
        total,
        peak,
        concurrent,
        filterLabel: fl,
        extra: [
          { label: "File", value: r.fileExists ? r.fileName || ymd + ".txt" : "missing" },
          { label: "Parsed OK", value: r.parseOk ?? "—" },
        ],
      })
    );
    setProgress(100, r.fileExists ? `OK · ${total} matched` : "No file");
    finishProgress(true, r.fileExists ? "Daily chart ready" : "No file for that day");
  } catch (e) {
    finishProgress(false, String(e.message || e));
    document.getElementById("btn-progress-close").hidden = false;
  } finally {
    CDR.busy = false;
  }
}

async function calcWeekly() {
  if (CDR.busy) return;
  CDR.busy = true;
  const startStr = document.getElementById("cdr-week-start")?.value;
  if (!startStr) {
    alert("Pick week start date");
    CDR.busy = false;
    return;
  }
  const start = parseLocalDate(startStr);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    days.push(`${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`);
  }
  const f = getChartFilters("weekly");
  const fl = chartFilterLabel(f);
  showProgress("Weekly hourly", `Filter ${fl} · scanning 7 days…`);
  try {
    const hourly = emptyHourly();
    const allRows = [];
    let filesHit = 0;
    await scanDays(
      days,
      {},
      (pct, detail, day) => {
        setProgress(pct, detail);
        if (day.fileExists) {
          filesHit++;
          const rows = filterRecords(day.matches || day.Matches || [], f);
          allRows.push(...rows);
          addHourly(hourly, hourlyFromRecords(rows));
        }
      },
      CHART_MAX_MATCHES
    );
    const peak = peakOf(hourly);
    const concurrent = computeConcurrentPeak(allRows);
    const total = allRows.length;
    renderHourChart(document.getElementById("cdr-weekly-chart"), hourly);
    renderKpis(
      document.getElementById("cdr-weekly-kpi"),
      kpisForChart({
        total,
        peak,
        concurrent,
        filterLabel: fl,
        extra: [
          { label: "Files found", value: `${filesHit} / 7` },
          { label: "Avg / day", value: filesHit ? Math.round(total / filesHit) : 0 },
        ],
      })
    );
    setProgress(100, "Complete");
    finishProgress(true, "Weekly chart ready");
  } catch (e) {
    finishProgress(false, String(e.message || e));
    document.getElementById("btn-progress-close").hidden = false;
  } finally {
    CDR.busy = false;
  }
}

async function calcMonthly() {
  if (CDR.busy) return;
  CDR.busy = true;
  const monthStr = document.getElementById("cdr-month")?.value;
  if (!monthStr) {
    alert("Pick a month");
    CDR.busy = false;
    return;
  }
  const [y, m] = monthStr.split("-").map(Number);
  const from = `${y}-${pad2(m)}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${pad2(m)}-${pad2(last)}`;
  const f = getChartFilters("monthly");
  const fl = chartFilterLabel(f);

  showProgress("Monthly hourly", `Filter ${fl} · listing month…`);
  try {
    const files = await apiGet(`cdr/files?from=${from}&to=${to}`);
    let days = files.days || [];
    if (!days.length) {
      days = eachDayKey(ymdFromInput(from), ymdFromInput(to));
    }
    const hourly = emptyHourly();
    const allRows = [];
    let filesHit = 0;
    await scanDays(
      days,
      {},
      (pct, detail, day) => {
        setProgress(pct, detail);
        if (day.fileExists) {
          filesHit++;
          const rows = filterRecords(day.matches || day.Matches || [], f);
          allRows.push(...rows);
          addHourly(hourly, hourlyFromRecords(rows));
        }
      },
      CHART_MAX_MATCHES
    );
    const peak = peakOf(hourly);
    const concurrent = computeConcurrentPeak(allRows);
    const total = allRows.length;
    renderHourChart(document.getElementById("cdr-monthly-chart"), hourly);
    renderKpis(
      document.getElementById("cdr-monthly-kpi"),
      kpisForChart({
        total,
        peak,
        concurrent,
        filterLabel: fl,
        extra: [
          { label: "Files found", value: filesHit },
          { label: "Days in month", value: last },
        ],
      })
    );
    setProgress(100, "Complete");
    finishProgress(true, "Monthly chart ready");
  } catch (e) {
    finishProgress(false, String(e.message || e));
    document.getElementById("btn-progress-close").hidden = false;
  } finally {
    CDR.busy = false;
  }
}

function exportCsv() {
  const rows = CDR.lastSearch || [];
  if (!rows.length) {
    alert("Run Search first.");
    return;
  }
  // Excel-friendly: UTF-8 BOM + comma CSV; open in Excel → Data/Sort works
  const header = [
    "Recv time",
    "Dir",
    "Calling From",
    "Called To",
    "TAC1",
    "TAC2",
    "Duration sec",
    "Cond",
    "Cond meaning",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const p = partyView(r);
    const cond = String(r.cond || "").trim();
    const meaning = condLabel(cond).includes("·")
      ? condLabel(cond).split("·")[1].trim()
      : "";
    lines.push(
      [r.recvLocal, r.dir, p.from, p.to, p.tac1, p.tac2, r.durationSec, cond, meaning]
        .map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`)
        .join(",")
    );
  }
  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cdr-export-${toDateInputValue(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fmtLastCall(st) {
  if (!st.lastCall) return "no call file today";
  const age = Number(st.lastCallAgeSec);
  if (!Number.isFinite(age)) return `last call ${st.lastCall}`;
  if (age < 90) return `last call ${age}s ago`;
  if (age < 3600) return `last call ${Math.floor(age / 60)}m ago`;
  return `last call ${Math.floor(age / 3600)}h ago`;
}

async function apiPost(path, body) {
  return fetchJson(apiUrl(path), {
    method: "POST",
    body: body == null ? "{}" : JSON.stringify(body),
  });
}

async function ensureCdrLoggerIfDown(st) {
  if (st && st.loggerUp === true) return st;
  try {
    const r = await apiPost("cdr/logger/ensure", {});
    return {
      ...st,
      loggerUp: r.up === true,
      loggerPort: r.port || (st && st.loggerPort),
      todayFile: r.todayFile || (st && st.todayFile),
      lastCall: r.lastCall || (st && st.lastCall),
      lastCallAgeSec: r.lastCallAgeSec ?? (st && st.lastCallAgeSec),
      todayBytes: r.todayBytes ?? (st && st.todayBytes),
    };
  } catch {
    return st;
  }
}

async function refreshCdrStatus() {
  const el = document.getElementById("cdr-status-line");
  const pill = document.getElementById("cdr-logger-pill");
  const banner = document.getElementById("cdr-live-banner");
  try {
    let st = await apiGet("cdr/status");
    if (st.loggerUp !== true) st = (await ensureCdrLoggerIfDown(st)) || st;
    const up = st.loggerUp === true;
    if (pill) pill.textContent = up ? "Logger UP" : "Logger DOWN";
    if (el) {
      const fileName = st.todayFile || (st.latest ? `${st.latest}.txt` : "no file today");
      el.textContent = `port ${st.loggerPort || 9000} · ${fmtLastCall(st)} · ${fileName}`;
    }
    if (banner) {
      banner.classList.remove("warn", "ok", "bad");
      banner.classList.add(up ? "ok" : "bad");
    }
  } catch (e) {
    if (pill) pill.textContent = "Logger ?";
    if (el) el.textContent = "API error: " + (e.message || e);
    banner?.classList.remove("ok", "bad");
    banner?.classList.add("warn");
  }
}

export function initCdrUi() {
  const now = new Date();
  const weekStart = addDays(now, -((now.getDay() + 6) % 7)); // Monday-start

  const elFrom = document.getElementById("cdr-from");
  const elTo = document.getElementById("cdr-to");
  const elDay = document.getElementById("cdr-day");
  const elWeek = document.getElementById("cdr-week-start");
  const elMonth = document.getElementById("cdr-month");
  const elErlangDay = document.getElementById("erlang-day");
  // CDR Search default: today → today
  if (elFrom) elFrom.value = toDateInputValue(now);
  if (elTo) elTo.value = toDateInputValue(now);
  if (elDay) elDay.value = toDateInputValue(now);
  if (elWeek) elWeek.value = toDateInputValue(weekStart);
  if (elMonth) elMonth.value = toMonthInputValue(now);
  if (elErlangDay) elErlangDay.value = toDateInputValue(now);

  bindChartToggles();
  suggestErlangN().catch(() => {});

  document.getElementById("btn-cdr-search")?.addEventListener("click", runSearch);
  document.getElementById("btn-cdr-export")?.addEventListener("click", exportCsv);
  document.getElementById("btn-cdr-calc-daily")?.addEventListener("click", calcDaily);
  document.getElementById("btn-cdr-calc-weekly")?.addEventListener("click", calcWeekly);
  document.getElementById("btn-cdr-calc-monthly")?.addEventListener("click", calcMonthly);
  document.getElementById("btn-cdr-calc-erlang")?.addEventListener("click", calcErlang);
  document.getElementById("btn-progress-close")?.addEventListener("click", () => hideProgress());

  // empty charts until Calculate
  renderHourChart(document.getElementById("cdr-daily-chart"), emptyHourly());
  renderHourChart(document.getElementById("cdr-weekly-chart"), emptyHourly());
  renderHourChart(document.getElementById("cdr-monthly-chart"), emptyHourly());
  const emptyK = [
    { label: "Calls", value: "—" },
    { label: "Peak hour", value: "—" },
    { label: "Concurrent", value: "—" },
    { label: "Filter", value: "ALL" },
  ];
  renderKpis(document.getElementById("cdr-daily-kpi"), emptyK);
  renderKpis(document.getElementById("cdr-weekly-kpi"), emptyK);
  renderKpis(document.getElementById("cdr-monthly-kpi"), emptyK);
  renderKpis(document.getElementById("cdr-erlang-kpi"), [
    { label: "Traffic Load", value: "—" },
    { label: "Channels Available", value: "—" },
    { label: "Block %", value: "—" },
    { label: "Max Concurrent", value: "—" },
    { label: "Channels Needed", value: "—" },
    { label: "Service Grade", value: "—" },
  ]);

  refreshCdrStatus();
  if (!CDR.statusTimer) {
    CDR.statusTimer = setInterval(() => {
      const panel = document.getElementById("panel-cdr");
      if (panel && !panel.classList.contains("hidden")) refreshCdrStatus();
    }, 8000);
  }
}

export function onCdrTabShow() {
  refreshCdrStatus();
  suggestErlangN().catch(() => {});
}

/* ---------- Erlang B (offline CDR .txt only) ---------- */

/** Erlang B blocking probability for N trunks, load A. */
function erlangB(n, A) {
  const N = Math.max(0, Math.floor(Number(n) || 0));
  const a = Math.max(0, Number(A) || 0);
  if (N <= 0) return 1;
  if (a <= 0) return 0;
  // Numerically stable recurrence
  let inv = 1;
  for (let k = 1; k <= N; k++) {
    inv = 1 + (k / a) * inv;
  }
  const B = 1 / inv;
  // Clamp float dust to 0 when effectively zero
  return B < 1e-12 ? 0 : B;
}

/**
 * Target Block 0% = "all calls answered" (zero blocking).
 * Float dust must not count as fail when B is ~0 (e.g. N=100, modest load).
 */
function blockMeetsTarget(B, targetB) {
  const b = Math.max(0, Number(B) || 0);
  const t = Number(targetB);
  if (!Number.isFinite(t) || t < 0) return b <= 0.01;
  if (t <= 0) {
    // 0% target: pass when blocking is effectively zero
    return b <= 1e-6; // ≤ 0.0001%
  }
  return b <= t + 1e-12;
}

/** Smallest N with B(N,A) meeting target (cap 5000). targetB=0 → near-zero block. */
function suggestedTrunks(A, targetB) {
  const a = Math.max(0, Number(A) || 0);
  let t = Number(targetB);
  if (!Number.isFinite(t) || t < 0) t = 0.01;
  if (t <= 0) t = 1e-6;
  t = Math.min(0.99, t);
  if (a <= 0) return 0;
  let n = Math.max(1, Math.ceil(a));
  while (n < 5000 && !blockMeetsTarget(erlangB(n, a), t)) n++;
  return n;
}

function formatBlockPct(B) {
  const b = Math.max(0, Number(B) || 0);
  if (b <= 0) return "0%";
  if (b < 1e-6) return "~0%";
  if (b < 0.0001) return `${(b * 100).toFixed(4)}%`;
  if (b < 0.01) return `${(b * 100).toFixed(3)}%`;
  return `${(b * 100).toFixed(2)}%`;
}

/** Local midnight ms for yyyyMMdd */
function dayStartMs(ymd) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** Occupancy seconds of records overlapping [hour, hour+1) on that calendar day. */
function occupancySecondsInHour(records, ymd, hour) {
  const h0 = dayStartMs(ymd) + hour * 3600 * 1000;
  const h1 = h0 + 3600 * 1000;
  let sec = 0;
  for (const r of records) {
    const end = parseCdrEndMs(r);
    if (end == null) continue;
    const dur = Math.max(0, Number(r.durationSec) || 0);
    if (dur <= 0) continue;
    const start = end - dur * 1000;
    const o0 = Math.max(start, h0);
    const o1 = Math.min(end, h1);
    if (o1 > o0) sec += (o1 - o0) / 1000;
  }
  return sec;
}

/** Pick busy hour by max concurrent; return { hour, A, concurrent, callsInHour }. */
function pickBusyHour(records, ymd) {
  let bestHour = 0;
  let bestConc = -1;
  let bestA = 0;
  let bestCalls = 0;
  for (let h = 0; h < 24; h++) {
    const inHour = records.filter((r) => {
      const end = parseCdrEndMs(r);
      if (end == null) return false;
      const dur = Math.max(0, Number(r.durationSec) || 0);
      if (dur <= 0) return false;
      const start = end - dur * 1000;
      const h0 = dayStartMs(ymd) + h * 3600 * 1000;
      const h1 = h0 + 3600 * 1000;
      return start < h1 && end > h0;
    });
    const conc = computeConcurrentPeak(inHour).max;
    const A = occupancySecondsInHour(records, ymd, h) / 3600;
    const calls = records.filter((r) => Number(r.hour) === h || (parseCdrEndMs(r) != null && new Date(parseCdrEndMs(r)).getHours() === h)).length;
    if (conc > bestConc || (conc === bestConc && A > bestA)) {
      bestConc = conc;
      bestHour = h;
      bestA = A;
      bestCalls = calls;
    }
  }
  return {
    hour: bestHour,
    A: bestA,
    concurrent: Math.max(0, bestConc),
    callsInHour: bestCalls,
  };
}

async function suggestErlangN() {
  const inp = document.getElementById("erlang-n");
  if (!inp || (inp.value && Number(inp.value) > 0)) return;
  try {
    const r = await apiGet("trunk-data");
    const items = r.data?.items || r.items || [];
    const sum = items.reduce((a, it) => a + (Number(it.total) || 0), 0);
    if (sum > 0) {
      inp.placeholder = String(sum);
      inp.dataset.autoN = String(sum);
    }
  } catch {
    /* offline / no cache */
  }
}

function resolveErlangN() {
  const inp = document.getElementById("erlang-n");
  const v = Number(inp?.value);
  if (v > 0) return Math.floor(v);
  const auto = Number(inp?.dataset.autoN || inp?.placeholder);
  if (auto > 0) return Math.floor(auto);
  return 0;
}

async function calcErlang() {
  if (CDR.busy) return;
  CDR.busy = true;
  const day = document.getElementById("erlang-day")?.value;
  if (!day) {
    alert("Pick a day");
    CDR.busy = false;
    return;
  }
  const f = getChartFilters("erlang");
  const fl = chartFilterLabel(f);
  // 0% = "answer all calls" (zero blocking) — allowed. Empty/invalid → default 1%.
  let targetPct = Number(document.getElementById("erlang-target-b")?.value);
  if (!Number.isFinite(targetPct) || targetPct < 0) targetPct = 1;
  if (targetPct > 100) targetPct = 100;
  const targetB = targetPct / 100; // 0 is valid

  showProgress("Erlang (offline CDR)", `Filter ${fl} · reading .txt…`);
  try {
    await suggestErlangN();
    const ymd = ymdFromInput(day);
    setProgress(15, `${ymd}.txt`);
    const r = await scanDay(ymd, {}, CHART_MAX_MATCHES);
    if (!r.fileExists) {
      renderKpis(document.getElementById("cdr-erlang-kpi"), [
        { label: "Traffic Load", value: "—" },
        { label: "Channels Available", value: "—" },
        { label: "Block %", value: "—" },
        { label: "Max Concurrent", value: "—" },
        { label: "Channels Needed", value: "—" },
        { label: "Service Grade", value: "no file" },
      ]);
      const meta = document.getElementById("cdr-erlang-meta");
      if (meta) meta.textContent = `No offline file ${ymd}.txt — logger must write CDR first.`;
      setProgress(100, "Missing file");
      finishProgress(false, "No CDR file for that day");
      document.getElementById("btn-progress-close").hidden = false;
      return;
    }
    setProgress(55, `Filter ${fl}…`);
    const rows = filterRecords(r.matches || r.Matches || [], f).filter(
      (x) => (Number(x.durationSec) || 0) > 0
    );
    const bh = pickBusyHour(rows, ymd);
    const A = bh.A;
    let N = resolveErlangN();
    if (N <= 0) {
      N = Math.max(bh.concurrent, Math.ceil(A) || 1);
    }
    const B = erlangB(N, A);
    const need = suggestedTrunks(A, targetB);
    const blockLabel = formatBlockPct(B);
    let gos = "OK";
    let gosClass = "gos-ok";
    if (!blockMeetsTarget(B, targetB)) {
      gos = "Fail";
      gosClass = "gos-bad";
    } else if (targetB > 0 && B > targetB * 0.5) {
      gos = "Watch";
      gosClass = "gos-warn";
    }

    renderKpis(document.getElementById("cdr-erlang-kpi"), [
      { label: "Traffic Load", value: `${A.toFixed(2)} erl` },
      { label: "Channels Available", value: N },
      { label: "Block %", value: blockLabel },
      {
        label: "Max Concurrent",
        value: `${bh.concurrent} @ ${bh.hour}:00`,
      },
      { label: "Channels Needed", value: need },
      { label: "Service Grade", value: gos },
    ]);
    // colour Service Grade cell
    const gosEl = document.querySelector("#cdr-erlang-kpi .cdr-kpi:last-child .cdr-kpi-v");
    if (gosEl) gosEl.className = `cdr-kpi-v ${gosClass}`;

    const meta = document.getElementById("cdr-erlang-meta");
    if (meta) {
      const tgtLabel = targetPct === 0 ? "0% (answer all)" : `${targetPct}%`;
      meta.textContent =
        `Offline file ${ymd}.txt · filter ${fl} · busy hour ${bh.hour}:00–${bh.hour + 1}:00 · ` +
        `Traffic Load ${A.toFixed(2)} erl · Channels Available ${N} · Block ${blockLabel} · ` +
        `Channels Needed ${need} (target ${tgtLabel}) · answered calls only (duration > 0)`;
    }
    setProgress(100, "Done");
    finishProgress(true, "Erlang calculated from offline CDR");
  } catch (e) {
    finishProgress(false, String(e.message || e));
    document.getElementById("btn-progress-close").hidden = false;
  } finally {
    CDR.busy = false;
  }
}
