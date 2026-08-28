/**
 * Extension inventory — OSSI list extension + list station (Port merge) + list uniform-dialplan (UDP fill).
 * Login enqueues full list; refresh every 1h via queue (yields to 90s pack).
 * Tab show = cache only. Search + Type ON/OFF like Alarm.
 * Click list-extension rows (not udp-ext) → Details from cache, then one OSSI display.
 */

import { apiUrl, siteUrl, fetchJson, escapeHtml, fmtUpdated } from "./http.js?v=20260827c";
import { showProgress, setProgress, finishProgress } from "./cdr-ui.js?v=20260827c";

/** Fallback TG if POST /extensions/refresh is missing. */
const TG_EXTENSION = 9994;
/** Fallback refresh/one tg = 8000000 + ext if POST /extensions/detail is missing. */
const TG_EXT_DETAIL_BASE = 8000000;
/** Max rows painted after filter (full set stays in memory). */
const SHOW_CAP = 5000;
/** Hourly auto list extension + uniform-dialplan interval (ms). */
export const EXTENSION_INTERVAL_MS = 60 * 60 * 1000;

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
  /** Open Details extension number, or null when list is shown. */
  detailExt: null,
  /** OSSI overlay on header/KPI (port / name / setType); blank must not wipe cache. */
  detailOverlay: {},
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

function insertDigitsOf(row) {
  if (!row || typeof row !== "object") return "—";
  const raw = row.insertDigits ?? row.insert ?? row.InsertDigits;
  const s = String(raw == null ? "" : raw).trim();
  return s || "—";
}

function extKey(v) {
  return String(v ?? "").trim();
}

function isUdpExtType(type) {
  const t = extKey(type).toLowerCase();
  return t.startsWith("udp-");
}

/** display station | display vdn | display hunt-group, or null = cache identity only. */
function ossiCommandForExtType(type) {
  const t = extKey(type).toLowerCase();
  if (!t || t === "—" || t === "-") return null;
  if (t.startsWith("udp-") || t === "announcement" || t === "qsig") return null;
  if (t === "vdn" || t === "vdn-extension" || t.startsWith("vdn")) return "display vdn";
  if (t === "hunt-group" || t === "hunt" || t.startsWith("hunt")) return "display hunt-group";
  if (
    t === "station-user" ||
    t === "phantom-user" ||
    t.includes("station") ||
    t.includes("phantom") ||
    t.includes("analog") ||
    t.includes("dcp") ||
    t.includes("sip") ||
    t.includes("h.323") ||
    t.includes("h323") ||
    t.includes("endpoint")
  ) {
    return "display station";
  }
  return null;
}

/** Fallback magic TG: 8000000 + digits-only ext. Skip if not a finite positive number or > 9999999. */
function extDetailTg(ext) {
  const digits = String(ext ?? "").replace(/\D/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0 || n > 9999999) return null;
  return TG_EXT_DETAIL_BASE + n;
}

function findExtRow(rowOrExt) {
  if (rowOrExt && typeof rowOrExt === "object") {
    const ext = extKey(rowOrExt.extension);
    if (ext) {
      const fromCache = (EXT.data.items || []).find((r) => extKey(r.extension) === ext);
      return fromCache || rowOrExt;
    }
    return null;
  }
  const want = extKey(rowOrExt);
  if (!want) return null;
  return (EXT.data.items || []).find((r) => extKey(r.extension) === want) || null;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val == null || val === "" ? "—" : String(val);
}

function setExtFormStatus(msg) {
  const el = document.getElementById("ext-form-status");
  if (el) el.textContent = msg || "";
}

function identNonEmpty(v) {
  const s = String(v ?? "").trim();
  return s && s !== "—";
}

/** Port 043V612 / GGGV* → media-gateway link. */
function portCellHtml(port) {
  const p = String(port || "").trim();
  if (!identNonEmpty(p)) return "";
  const mg = mgFromPort(p);
  if (mg == null) return escapeHtml(p);
  return `<button type="button" class="gw-host-btn ext-port-gw-btn" data-mg="${mg}" title="Open gateway ${mg}">${escapeHtml(
    p
  )}</button>`;
}

function showExtList() {
  const list = document.getElementById("ext-list-view");
  const det = document.getElementById("ext-detail-view");
  const card = document.getElementById("extension-card");
  if (list) list.hidden = false;
  if (det) det.hidden = true;
  if (card) card.classList.remove("ext-detail-open");
}

function showExtDetailPane() {
  const list = document.getElementById("ext-list-view");
  const det = document.getElementById("ext-detail-view");
  const card = document.getElementById("extension-card");
  if (list) list.hidden = true;
  if (det) det.hidden = false;
  if (card) card.classList.add("ext-detail-open");
}

function pickExtDetailPayload(res) {
  if (!res || typeof res !== "object") return null;
  const p = res.extensionDetail || res.ExtensionDetail || res.extension_detail;
  if (p && typeof p === "object") return p;
  if (Array.isArray(res.formRows) || Array.isArray(res.FormRows)) return res;
  return null;
}

function normalizeFormRows(raw) {
  if (!raw) return [];
  let rows = raw;
  if (!Array.isArray(rows) && typeof rows === "object") {
    rows = Object.entries(rows).map(([k, v]) => ({ label: k, value: v }));
  }
  const out = [];
  for (const r of rows) {
    let label = "";
    let value = "";
    if (Array.isArray(r) && r.length >= 2) {
      label = r[0];
      value = r[1];
    } else if (r && typeof r === "object") {
      label = r.label ?? r.Label ?? r.field ?? r.Field ?? r.name ?? r.Name ?? r.k ?? "";
      value = r.value ?? r.Value ?? r.v ?? r.text ?? r.Text ?? "";
    } else continue;
    label = String(label ?? "").trim();
    if (!label) continue;
    if (/security\s*-?\s*code|password|\bpin\b|passwd/i.test(label)) continue;
    if (/insert\s*digits/i.test(label)) continue;
    out.push({ label, value: value == null ? "" : String(value) });
  }
  return out;
}

function isAnalogSetType(typ) {
  const t = String(typ || "").trim().toLowerCase();
  return t === "analog" || t === "callrid" || t === "callr" || t === "2500" || t === "8110" || t.startsWith("ana");
}

function paintExtButtons(buttons, setType) {
  const wrap = document.getElementById("ext-btn-wrap");
  const tb = document.getElementById("ext-btn-tbody");
  if (!wrap || !tb) return;
  if (isAnalogSetType(setType) || !Array.isArray(buttons) || !buttons.length) {
    wrap.hidden = true;
    tb.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  tb.innerHTML = buttons
    .map((b) => {
      const n = b.n ?? b.N ?? "";
      const lab = String(b.label ?? b.Label ?? "").trim();
      const shown = lab && lab !== "-" ? lab : "—";
      return `<tr><td class="mono">${escapeHtml(String(n))}</td><td>${escapeHtml(shown)}</td></tr>`;
    })
    .join("");
}

function paintExtFormRows(rows, emptyMsg) {
  const tb = document.getElementById("ext-form-tbody");
  if (!tb) return;
  if (!rows || !rows.length) {
    tb.innerHTML = emptyMsg
      ? `<tr class="empty"><td colspan="2">${escapeHtml(emptyMsg)}</td></tr>`
      : "";
    return;
  }
  tb.innerHTML = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.value && String(r.value).trim() && String(r.value).trim() !== "-" ? String(r.value) : "—")}</td></tr>`
    )
    .join("");
}

function paintExtDetailIdentity(row) {
  if (!row) return;
  const ov = EXT.detailOverlay || {};
  const name = identNonEmpty(ov.name) ? String(ov.name).trim() : String(row.name || "").trim();
  const port = identNonEmpty(ov.port) ? String(ov.port).trim() : String(row.port || "").trim();
  const type = String(row.type || "").trim();
  const gw = gatewayForExt({ ...row, port: port || row.port });
  const room = identNonEmpty(ov.room) ? String(ov.room).trim() : String(row.room || "").trim();
  const setType = identNonEmpty(ov.setType) ? String(ov.setType).trim() : "";

  const title = document.getElementById("ext-detail-title");
  if (title) title.textContent = String(row.extension || "—");
  const meta = document.getElementById("ext-detail-meta");
  if (meta) {
    meta.textContent = [identNonEmpty(name) ? name : "", type, identNonEmpty(port) ? port : ""]
      .filter(Boolean)
      .join(" · ");
  }
  setText("ext-dstat-type", setType || type || "—");
  const portEl = document.getElementById("ext-dstat-port");
  if (portEl) {
    const html = identNonEmpty(port) ? portCellHtml(port) || escapeHtml(port) : "";
    portEl.innerHTML = html || "—";
  }
  setText("ext-dstat-gw", gw);
  setText("ext-dstat-updated", fmtUpdated(EXT.data.lastUpdate || row.lastUpdate));

  const pairs = [
    ["Extension", row.extension],
    ["Type", type],
    ["Name", name],
    ["Port", port],
    ["Gateway", gw],
    ["Room", room],
  ].filter(([, v]) => identNonEmpty(v));

  const tb = document.getElementById("ext-ident-tbody");
  if (!tb) return;
  tb.innerHTML = pairs
    .map(([k, v]) => {
      const cell = k === "Port" ? portCellHtml(v) || escapeHtml(v) : escapeHtml(String(v));
      return `<tr><td>${escapeHtml(k)}</td><td>${cell}</td></tr>`;
    })
    .join("");
}

function applyExtDetailOverlay(payload) {
  if (!payload || typeof payload !== "object") return;
  const next = { ...EXT.detailOverlay };
  const name = payload.name ?? payload.Name;
  const port = payload.port ?? payload.Port;
  const setType = payload.setType ?? payload.SetType;
  const room = payload.room ?? payload.Room;
  if (identNonEmpty(name)) next.name = String(name).trim();
  if (identNonEmpty(port)) next.port = String(port).trim();
  if (identNonEmpty(setType)) next.setType = String(setType).trim();
  if (identNonEmpty(room)) next.room = String(room).trim();
  EXT.detailOverlay = next;
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
    const data = await fetchJson(apiUrl("gateways"));
    if (ingestGatewayItems(data && data.items)) return true;
  } catch {
    /* old DLL / 404 */
  }
  try {
    const td = await fetchJson(apiUrl("trunk-data"));
    const inner = td.data || td;
    const items = inner && inner.gateways && inner.gateways.items;
    if (ingestGatewayItems(items)) return true;
  } catch {
    /* ignore */
  }
  try {
    const data = await fetchJson(siteUrl("gateways_cache.json") + "?t=" + Date.now());
    if (ingestGatewayItems(data && data.items)) return true;
  } catch {
    /* ignore */
  }
  return false;
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
    const hay = [r.extension, r.type, insertDigitsOf(r), r.port, gatewayForExt(r), r.name, r.udpType]
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
  const cards = [
    { k: "Total", v: total, acc: "green" },
    { k: "Matched", v: filtered.length, acc: "" },
    { k: "Showing", v: shown, acc: "" },
    { k: "Ports", v: ports, acc: "blue" },
    { k: "Last Update", v: fmtUpdated(EXT.data.lastUpdate), acc: "", ts: true },
  ];
  el.innerHTML = cards
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
    tbody.innerHTML = `<tr class="empty"><td colspan="6">Updating… (list extension + uniform-dialplan queued / running)</td></tr>`;
    return;
  }
  const rows = filteredExtRows();
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="6">${
      EXT.connected
        ? "No extensions (or all types hidden / search empty)."
        : "Login required — list extension + uniform-dialplan runs after login (queued)."
    }</td></tr>`;
    return;
  }
  const slice = rows.slice(0, SHOW_CAP);
  tbody.innerHTML = slice
    .map((r) => {
      const type = String(r.type || "").trim() || "—";
      const ext = String(r.extension || "—");
      const udp = isUdpExtType(type);
      const extCell = udp
        ? escapeHtml(ext)
        : `<button type="button" class="ext-num-btn" data-ext="${escapeHtml(ext)}">${escapeHtml(ext)}</button>`;
      return `<tr class="${udp ? "ext-udp" : ""}">
        <td class="mono">${extCell}</td>
        <td>${escapeHtml(type)}</td>
        <td class="mono">${escapeHtml(insertDigitsOf(r))}</td>
        <td class="mono">${escapeHtml(r.port || "—")}</td>
        <td class="mono">${escapeHtml(gatewayForExt(r))}</td>
        <td>${escapeHtml(r.name || "—")}</td>
      </tr>`;
    })
    .join("");
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
  let res;
  try {
    res = await fetchJson(apiUrl("extensions/refresh"), { method: "POST", body: "{}" });
  } catch {
    res = await fetchJson(apiUrl("refresh/one"), {
      method: "POST",
      body: JSON.stringify({ tg: TG_EXTENSION }),
    });
  }
  if (!applyExtPayload(res)) {
    throw new Error((res && (res.error || res.Error)) || "extensions/refresh returned no payload");
  }
  const n = (EXT.data.items || []).length;
  if (res && res.error && !n) throw new Error(res.error);
  return true;
}

async function loadExtCacheOnly() {
  let data = null;
  try {
    data = await fetchJson(apiUrl("extensions"));
  } catch {
    /* 404 old DLL */
  }
  if (!data || !Array.isArray(data.items)) {
    try {
      const td = await fetchJson(apiUrl("trunk-data"));
      const inner = td.data || td;
      if (inner && inner.extensions) data = inner.extensions;
    } catch {
      /* ignore */
    }
  }
  if (!data || !Array.isArray(data.items)) {
    try {
      data = await fetchJson(siteUrl("extensions_cache.json") + "?t=" + Date.now());
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
  if (force) renderExtTable();
  await loadGatewayMap();

  let liveOk = false;
  let forceErr = null;
  try {
    if (force && EXT.connected) {
      if (showModal) {
        showProgress("Loading Extensions", "OSSI list extension + list station + list uniform-dialplan…");
        setProgress(15, "list extension + list station + list uniform-dialplan (may take ~1–2 min)…");
      }
      try {
        await forceOssiExtensions();
        liveOk = true;
      } catch (e) {
        forceErr = e;
        console.warn("list extension:", e?.message || e);
      }
    }

    // Cache paint: tab show, or OSSI force failed (still show last good list)
    if (!liveOk) {
      await loadExtCacheOnly();
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
  }
  return EXT.data;
}

export function setExtensionSessionConnected(connected) {
  EXT.connected = !!connected;
  if (!EXT.connected) {
    EXT.nextAt = 0;
  } else {
    loadExtensions({ force: false, showModal: false }).catch(() => {});
  }
}

export function setExtensionTabActive(active) {
  EXT.tabActive = !!active;
}

export function setOssiBusy(busy) {
  EXT.ossiBusy = !!busy;
}

export function onExtensionTabShow() {
  EXT.tabActive = true;
  loadExtensions({ force: false, showModal: false }).catch(() => {});
  renderExtTable();
}

/** Run OSSI list extension + uniform-dialplan (caller must own queue / not overlap 60s pack). */
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
}

export function getExtensionNextAt() {
  return EXT.nextAt || 0;
}

export function isExtensionLoading() {
  return !!EXT.loading;
}

export function closeExtensionDetail() {
  EXT.detailExt = null;
  EXT.detailOverlay = {};
  showExtList();
}

export function openExtensionDetail(rowOrExt, opts = {}) {
  const row = findExtRow(rowOrExt);
  if (!row) return;
  if (isUdpExtType(row.type)) return;

  const ext = extKey(row.extension);
  EXT.detailExt = ext;
  EXT.detailOverlay = {};
  showExtDetailPane();
  paintExtDetailIdentity(row);
  paintExtFormRows([]);
  paintExtButtons([], row.type || "");

  const cmd = ossiCommandForExtType(row.type);
  if (!cmd) {
    setExtFormStatus("No CM form for this type (cache identity only).");
    return;
  }
  if (!EXT.connected) {
    setExtFormStatus("Login required for CM form.");
    return;
  }
  const tg = extDetailTg(ext);
  if (tg == null) {
    setExtFormStatus("No CM form for this type (cache identity only).");
    return;
  }
  setExtFormStatus(`Queued ${cmd} … waiting for OSSI`);
  const enqueue = window.__cmEnqueueExtDetail;
  if (typeof enqueue === "function") {
    enqueue(ext, { type: row.type, showModal: opts.showModal !== false });
  } else {
    runExtensionDetailRefresh(ext, { showModal: opts.showModal !== false, type: row.type }).catch(() => {});
  }
}

export async function runExtensionDetailRefresh(ext, opts = {}) {
  const extStr = extKey(ext);
  const showModal = !!opts.showModal;
  const row = findExtRow(extStr);
  const type = opts.type || (row && row.type) || "";
  const cmd = ossiCommandForExtType(type) || "display station";
  const tg = extDetailTg(extStr);
  if (!extStr || tg == null) return null;

  if (showModal) {
    showProgress(`Extension ${extStr}`, `${cmd}…`);
    setProgress(25, `${cmd} ${extStr}…`);
  }
  setExtFormStatus(`${cmd} ${extStr}…`);
  if (EXT.detailExt === extStr) {
    paintExtFormRows([], "Waiting for OSSI…");
  }

  let payload = null;
  try {
    let res;
    try {
      res = await fetchJson(apiUrl("extensions/detail"), {
        method: "POST",
        body: JSON.stringify({ extension: extStr, type }),
      });
    } catch {
      res = await fetchJson(apiUrl("refresh/one"), {
        method: "POST",
        body: JSON.stringify({ tg }),
      });
    }
    payload = pickExtDetailPayload(res);
    if (!payload) {
      throw new Error((res && (res.error || res.Error)) || "extensions/detail returned no payload");
    }
    if (payload.cacheOnly) {
      applyExtDetailOverlay(payload);
      if (EXT.detailExt === extStr) {
        const still = findExtRow(extStr) || row;
        if (still) paintExtDetailIdentity(still);
        paintExtFormRows([]);
        paintExtButtons([], "");
        setExtFormStatus(
          payload.note || payload.Note || "No CM form for this type (cache identity only)."
        );
      }
      if (showModal) {
        setProgress(100, "Cache");
        finishProgress(true, "Cache identity only");
      }
      return payload;
    }
  } catch (e) {
    const msg = String(e?.message || e || `${cmd} failed`);
    if (EXT.detailExt === extStr) {
      setExtFormStatus(msg);
      paintExtFormRows([], msg);
      paintExtButtons([], "");
    }
    if (showModal) finishProgress(false, msg);
    throw e;
  }

  const formRows = normalizeFormRows(payload.formRows || payload.FormRows || payload.fields || payload.Fields);
  applyExtDetailOverlay(payload);
  if (EXT.detailExt === extStr) {
    const still = findExtRow(extStr) || row;
    if (still) paintExtDetailIdentity(still);
    paintExtFormRows(formRows, payload.error ? String(payload.error) : "");
    paintExtButtons(
      payload.buttons || payload.Buttons || [],
      payload.setType || payload.SetType || (still && still.type) || ""
    );
    setExtFormStatus(
      payload.error
        ? String(payload.error)
        : formRows.length
          ? `${cmd} ${extStr}`
          : `${cmd} ${extStr} · no fields`
    );
  }
  if (showModal) {
    if (payload.error && !formRows.length) {
      finishProgress(false, String(payload.error));
    } else {
      setProgress(100, "Complete");
      finishProgress(true, formRows.length ? `${cmd} · ${formRows.length} fields` : `${cmd} complete`);
    }
  }
  return payload;
}

export function initExtensionUi() {
  const search = document.getElementById("ext-search");
  if (search) {
    search.addEventListener("input", () => {
      EXT.query = search.value || "";
      paintExtSummary();
      renderExtTable();
    });
  }

  const tbody = document.getElementById("ext-tbody");
  if (tbody) {
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest && ev.target.closest(".ext-num-btn");
      if (!btn) return;
      ev.preventDefault();
      const ext = btn.getAttribute("data-ext");
      if (ext) openExtensionDetail(ext, { showModal: true });
    });
  }
  document.getElementById("btn-ext-detail-back")?.addEventListener("click", () => closeExtensionDetail());

  const det = document.getElementById("ext-detail-view");
  if (det) {
    det.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest && ev.target.closest(".ext-port-gw-btn");
      if (!btn) return;
      ev.preventDefault();
      const mg = Number(btn.getAttribute("data-mg"));
      if (!mg) return;
      const openGw = window.__cmOpenGatewayTab;
      if (typeof openGw === "function") {
        openGw(mg);
      } else {
        const tab = document.querySelector('.tab[data-tab="gateway"]');
        if (tab) tab.click();
        if (typeof window.__cmEnqueueGwConfig === "function") window.__cmEnqueueGwConfig(mg, { showModal: true });
      }
    });
  }

  loadExtensions({ force: false, showModal: false }).catch(() => {});
}
