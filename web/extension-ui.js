/**
 * Extension inventory — OSSI list extension + list station (Port merge).
 * Login enqueues full list; refresh every 1h via queue (yields to 60s pack).
 * Tab show = cache only. Search + Type ON/OFF like Alarm.
 */

import { showProgress, setProgress, finishProgress } from "./cdr-ui.js";

/** Magic TG for refresh/one when CmApi has no /extensions route. */
const TG_EXTENSION = 9994;
/** Max rows painted after filter (full set stays in memory). */
const SHOW_CAP = 5000;
/** Hourly auto list extension interval (ms). */
export const EXTENSION_INTERVAL_MS = 60 * 60 * 1000;

function apiUrlExt(path) {
  let dir = window.location.pathname || "/";
  if (/\.html?$/i.test(dir)) dir = dir.replace(/\/[^/]*$/, "/");
  else if (!dir.endsWith("/")) dir += "/";
  return dir + "api/" + String(path).replace(/^\//, "");
}

function siteUrlExt(path) {
  let dir = window.location.pathname || "/";
  if (/\.html?$/i.test(dir)) dir = dir.replace(/\/[^/]*$/, "/");
  else if (!dir.endsWith("/")) dir += "/";
  return dir + String(path).replace(/^\//, "");
}

async function fetchJsonExt(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error((body && (body.error || body.Error)) || res.statusText);
  return body && typeof body === "object" ? body : {};
}

const EXT = {
  data: { items: [], summary: {} },
  /** mg number → hostname from list media-gateway cache (no extra OSSI). */
  gwByMg: {},
  query: "",
  typeOn: {},
  nextAt: 0,
  countdownTimer: null,
  tabActive: false,
  connected: false,
  loading: false,
  ossiBusy: false,
};

/** Avaya port 043V419 → media-gateway 43. IP Sxxxxx / X have no MG. */
function mgFromPort(port) {
  const m = String(port || "").trim().match(/^0*(\d+)V/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function gatewayForExt(row) {
  const mg = mgFromPort(row && row.port);
  if (mg == null) return "—";
  const host = EXT.gwByMg[mg];
  return host || `GW${String(mg).padStart(2, "0")}`;
}

function ingestGatewayItems(items) {
  if (!Array.isArray(items) || !items.length) return false;
  const map = {};
  for (const g of items) {
    const mg = Number(g.mg);
    const host = String(g.hostname || "").trim();
    if (Number.isFinite(mg) && mg > 0 && host) map[mg] = host;
  }
  if (!Object.keys(map).length) return false;
  EXT.gwByMg = map;
  return true;
}

async function loadGatewayMap() {
  try {
    const data = await fetchJsonExt(apiUrlExt("gateways"));
    if (ingestGatewayItems(data && data.items)) return true;
  } catch {
    /* old DLL / 404 */
  }
  try {
    const td = await fetchJsonExt(apiUrlExt("trunk-data"));
    const inner = td.data || td;
    const items = inner && inner.gateways && inner.gateways.items;
    if (ingestGatewayItems(items)) return true;
  } catch {
    /* ignore */
  }
  try {
    const data = await fetchJsonExt(siteUrlExt("gateways_cache.json") + "?t=" + Date.now());
    if (ingestGatewayItems(data && data.items)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUpdated(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(iso).slice(0, 19);
  }
}

function setExtStatus(_msg) {
  /* Auto status chip is owned by app.js paintAutoStatusChip */
}

function paintExtUpdated() {
  const el = document.getElementById("ext-meta-updated");
  if (el) el.textContent = fmtUpdated(EXT.data.lastUpdate);
}

function typesFromItems() {
  const set = new Set();
  for (const r of EXT.data.items || []) {
    const t = String(r.type || "").trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function paintExtTypeFilters() {
  const host = document.getElementById("ext-type-btns");
  if (!host) return;
  const types = typesFromItems();
  for (const t of types) {
    if (EXT.typeOn[t] === undefined) EXT.typeOn[t] = true;
  }
  if (!types.length) {
    host.innerHTML = `<span class="hint" style="margin:0">No types yet</span>`;
    return;
  }
  host.innerHTML = types
    .map((t) => {
      const on = EXT.typeOn[t] !== false;
      return `<button type="button" class="btn cdr-toggle alarm-type-btn${on ? " is-on" : ""}" data-ext-type="${escapeHtml(
        t
      )}" aria-pressed="${on}" title="ON=show · OFF=hide">${escapeHtml(t)}</button>`;
    })
    .join("");
  host.querySelectorAll("[data-ext-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-ext-type");
      EXT.typeOn[t] = !EXT.typeOn[t];
      btn.classList.toggle("is-on", !!EXT.typeOn[t]);
      btn.setAttribute("aria-pressed", EXT.typeOn[t] ? "true" : "false");
      paintExtSummary();
      renderExtTable();
    });
  });
}

function filteredExtRows() {
  const q = (EXT.query || "").trim().toLowerCase();
  return (EXT.data.items || []).filter((r) => {
    const t = String(r.type || "").trim() || "—";
    if (EXT.typeOn[t] === false) return false;
    if (!q) return true;
    const hay = [r.extension, r.type, r.port, gatewayForExt(r), r.name]
      .map((x) => String(x || "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

function paintExtSummary() {
  const el = document.getElementById("ext-summary-kpi");
  if (!el) return;
  const total = (EXT.data.items || []).length;
  const filtered = filteredExtRows();
  const shown = Math.min(filtered.length, SHOW_CAP);
  const ports = filtered.filter((r) => {
    const p = String(r.port || "").trim();
    return p && p !== "—";
  }).length;
  el.innerHTML = [
    { k: "Total", v: total, acc: "green" },
    { k: "Matched", v: filtered.length, acc: "" },
    { k: "Showing", v: shown, acc: "" },
    { k: "Ports", v: ports, acc: "blue" },
    { k: "Last Update", v: fmtUpdated(EXT.data.lastUpdate), acc: "", ts: true },
  ]
    .map(
      (it) => `<div class="map-stat${it.acc ? ` accent-${it.acc}` : ""}">
        <div class="map-stat-k">${escapeHtml(it.k)}</div>
        <div class="map-stat-v${it.ts ? " map-stat-v-ts" : ""}">${escapeHtml(String(it.v))}</div>
      </div>`
    )
    .join("");
}

function renderExtTable() {
  const tbody = document.getElementById("ext-tbody");
  if (!tbody) return;
  if (EXT.loading && !(EXT.data.items || []).length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">Updating… (list extension queued / running)</td></tr>`;
    return;
  }
  const rows = filteredExtRows();
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${
      EXT.connected
        ? "No extensions (or all types hidden / search empty)."
        : "Login required — list extension runs after login (queued)."
    }</td></tr>`;
    return;
  }
  const slice = rows.slice(0, SHOW_CAP);
  tbody.innerHTML = slice
    .map((r) => {
      return `<tr>
        <td class="mono">${escapeHtml(r.extension || "—")}</td>
        <td>${escapeHtml(r.type || "—")}</td>
        <td class="mono">${escapeHtml(r.port || "—")}</td>
        <td class="mono">${escapeHtml(gatewayForExt(r))}</td>
        <td>${escapeHtml(r.name || "—")}</td>
      </tr>`;
    })
    .join("");
}

function paintExtCountdown() {
  /* countdown chip removed — app.js owns Auto status */
}

function applyExtPayload(data) {
  if (!data || typeof data !== "object") return false;
  let d = data;
  if (d.extensions && typeof d.extensions === "object" && (d.extensions.items || d.extensions.summary)) {
    d = d.extensions;
  }
  if (d.data && typeof d.data === "object" && d.data.extensions) {
    d = d.data.extensions;
  }
  if (!Array.isArray(d.items) && !d.summary) return false;
  const incoming = Array.isArray(d.items) ? d.items : [];
  const prev = EXT.data.items || [];
  // Incomplete more? cut short — keep fuller cache
  if (prev.length >= 100 && incoming.length > 0 && incoming.length < prev.length * 0.5) {
    console.warn("extension payload looks truncated", incoming.length, "vs", prev.length);
    setExtStatus(`list extension incomplete (${incoming.length}) — keeping last ${prev.length}`);
    return false;
  }
  EXT.data = {
    ok: d.ok !== false,
    items: incoming,
    summary: d.summary || {},
    lastUpdate: d.lastUpdate || EXT.data.lastUpdate,
    connected: d.connected,
    error: d.error,
  };
  paintExtTypeFilters();
  paintExtSummary();
  renderExtTable();
  paintExtUpdated();
  return true;
}

function friendlyExtError(err) {
  const msg = String(err?.message || err || "");
  // CmApi HttpClient when bridge busy / restarted / request aborted
  if (/sending the request|connection|refused|reset|canceled|timed? ?out/i.test(msg)) {
    return "OSSI refresh busy or timed out — showing last cache";
  }
  return msg || "Extension update incomplete";
}

async function forceOssiExtensions() {
  const res = await fetchJsonExt(apiUrlExt("refresh/one"), {
    method: "POST",
    body: JSON.stringify({ tg: TG_EXTENSION }),
  });
  const payload = res && (res.extensions || (res.extensionRefresh ? res : null));
  if (payload) {
    applyExtPayload(payload);
    const t = payload.timing || res.timing;
    const n = (EXT.data.items || []).length;
    if (payload.error && !n) {
      throw new Error(payload.error);
    }
    if (payload.error && n) {
      setExtStatus(`${n} extensions (cache kept · ${payload.error})`);
      return true;
    }
    if (t && t.listSec != null) {
      const ports = t.portRows != null ? t.portRows : (EXT.data.summary && EXT.data.summary.portCount);
      const st = t.stationSec != null ? ` + list station ${t.stationSec}s` : "";
      const extra = ports != null ? ` · ${ports} ports` : "";
      setExtStatus(`list extension ${t.listSec}s${st} (${t.rows ?? n} rows${extra})`);
    } else {
      setExtStatus(`${n} extensions`);
    }
    return true;
  }
  throw new Error((res && (res.error || res.Error)) || "refresh/one returned no extension payload");
}

async function loadExtCacheOnly() {
  let data = null;
  try {
    data = await fetchJsonExt(apiUrlExt("extensions"));
  } catch {
    /* 404 old DLL */
  }
  if (!data || !Array.isArray(data.items)) {
    try {
      const td = await fetchJsonExt(apiUrlExt("trunk-data"));
      const inner = td.data || td;
      if (inner && inner.extensions) data = inner.extensions;
    } catch {
      /* ignore */
    }
  }
  if (!data || !Array.isArray(data.items)) {
    try {
      data = await fetchJsonExt(siteUrlExt("extensions_cache.json") + "?t=" + Date.now());
    } catch {
      data = null;
    }
  }
  if (data && Array.isArray(data.items)) {
    await loadGatewayMap();
    applyExtPayload(data);
    return true;
  }
  return false;
}

async function loadExtensions(opts = {}) {
  const force = !!opts.force;
  const showModal = !!opts.showModal;
  EXT.loading = true;
  paintExtCountdown();
  if (force) renderExtTable();
  await loadGatewayMap();

  let liveOk = false;
  let forceErr = null;
  try {
    if (force && EXT.connected) {
      if (showModal) {
        showProgress("Loading Extensions", "OSSI list extension + list station…");
        setProgress(15, "list extension + list station (may take ~1 min)…");
      }
      setExtStatus(showModal ? "Updating extensions…" : "Queued / updating list extension…");
      try {
        await forceOssiExtensions();
        liveOk = true;
      } catch (e) {
        forceErr = e;
        console.warn("list extension:", e?.message || e);
        setExtStatus(friendlyExtError(e));
      }
    }

    // Cache paint: tab show, or OSSI force failed (still show last good list)
    if (!liveOk) {
      const cached = await loadExtCacheOnly();
      if (cached && forceErr) {
        const n = (EXT.data.items || []).length;
        setExtStatus(`Showing cache ${n} · ${friendlyExtError(forceErr)}`);
      }
    }

    if (force && showModal) {
      const n = (EXT.data.items || []).length;
      if (liveOk) {
        setProgress(100, "Complete");
        finishProgress(true, `Refresh complete · ${n} extensions`);
      } else if (n > 0) {
        setProgress(100, "Cache");
        finishProgress(true, `Showing cache ${n} · OSSI refresh failed`);
      } else {
        setProgress(100, "Failed");
        finishProgress(false, friendlyExtError(forceErr) || "Extension update incomplete");
      }
    }
  } finally {
    EXT.loading = false;
    paintExtCountdown();
    paintExtUpdated();
  }
  return EXT.data;
}

function startExtCountdownPaint() {
  /* no local countdown timer */
}

export function setExtensionSessionConnected(connected) {
  EXT.connected = !!connected;
  if (!EXT.connected) {
    setExtStatus("");
    EXT.nextAt = 0;
    paintExtCountdown();
  } else {
    startExtCountdownPaint();
    loadExtensions({ force: false, showModal: false }).catch(() => {});
    paintExtCountdown();
  }
}

export function setExtensionTabActive(active) {
  EXT.tabActive = !!active;
  paintExtCountdown();
}

export function setOssiBusy(busy) {
  EXT.ossiBusy = !!busy;
}

export function onExtensionTabShow() {
  EXT.tabActive = true;
  startExtCountdownPaint();
  loadExtensions({ force: false, showModal: false }).catch(() => {});
  renderExtTable();
  paintExtCountdown();
}

/** Run OSSI list extension (caller must own queue / not overlap 60s pack). */
export async function runExtensionRefresh(opts = {}) {
  if (!EXT.connected) return false;
  const showModal = !!opts.showModal;
  try {
    await loadExtensions({ force: true, showModal });
    return true;
  } catch {
    return false;
  }
}

export function armExtensionNext(fromNowMs = EXTENSION_INTERVAL_MS) {
  EXT.nextAt = Date.now() + Math.max(1000, fromNowMs);
  paintExtCountdown();
}

export function getExtensionNextAt() {
  return EXT.nextAt || 0;
}

export function isExtensionLoading() {
  return !!EXT.loading;
}

export function initExtensionUi() {
  startExtCountdownPaint();

  const search = document.getElementById("ext-search");
  if (search) {
    search.addEventListener("input", () => {
      EXT.query = search.value || "";
      paintExtSummary();
      renderExtTable();
    });
  }

  loadExtensions({ force: false, showModal: false }).catch(() => {});
}
