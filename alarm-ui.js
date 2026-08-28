/**
 * Active Alarms only — OSSI display alarms (SAT default Active=y).
 * First open / manual Refresh → progress popup %.
 * Session Auto 60s (Trunk checkbox) packs Trunk + Active Alarm so flash works on Trunk tab.
 * Ack = stop webpage flash only (NOT CM clear).
 */

import { apiUrl, siteUrl, fetchJson, escapeHtml, fmtUpdated } from "./http.js?v=20260827d";
import { showProgress, setProgress, finishProgress } from "./cdr-ui.js?v=20260827d";
import { getGatewayMjMn } from "./gateway-ui.js?v=20260827d";

const ALARM = {
  data: { active: [], mtceTypes: [], summary: {} },
  query: "",
  typeOn: {},
  nextAt: 0,
  countdownTimer: null,
  tabActive: false,
  ackedFp: "",
  lastFp: "",
  manualYellow: false,
  manualRed: false,
  connected: false,
  loading: false,
  /** Trunk progressiveRefresh owns OSSI — do not start a second display alarms */
  ossiBusy: false,
  pendingSilent: false,
};

function gwMjMn() {
  try {
    return getGatewayMjMn();
  } catch {
    return { mj: 0, mn: 0 };
  }
}

function alarmFingerprint(active) {
  const alarmPart = (active || [])
    .filter((a) => {
      const s = (a.severity || "").toUpperCase();
      return s === "MAJOR" || s === "MINOR";
    })
    .map((a) => a.id || `${a.mtceName}|${a.severity}|${a.alarmedRaw}`)
    .sort()
    .join(";");
  const g = gwMjMn();
  return `${alarmPart}|gw:${g.mj}:${g.mn}`;
}

export function applyAlarmFlash() {
  const body = document.body;
  body.classList.remove("alarm-bg-major", "alarm-bg-minor");
  if (ALARM.manualRed) {
    body.classList.add("alarm-bg-major");
    return;
  }
  if (ALARM.manualYellow) {
    body.classList.add("alarm-bg-minor");
    return;
  }
  const sum = ALARM.data.summary || {};
  const g = gwMjMn();
  const maj = Number(sum.activeMajor || 0) + Number(g.mj || 0);
  const min = Number(sum.activeMinor || 0) + Number(g.mn || 0);
  const fp = alarmFingerprint(ALARM.data.active);
  ALARM.lastFp = fp;
  if (ALARM.ackedFp && ALARM.ackedFp === fp) return;
  if (maj > 0) body.classList.add("alarm-bg-major");
  else if (min > 0) body.classList.add("alarm-bg-minor");
}

if (typeof window !== "undefined") window.__cmApplyAlarmFlash = applyAlarmFlash;

function mtceTypesActive() {
  const set = new Set();
  for (const a of ALARM.data.active || []) {
    const t = (a.mtceType || a.mtceName || "").trim();
    if (t) set.add(t);
  }
  return [...set].sort();
}

function paintAlarmTypeFilters() {
  const host = document.getElementById("alarm-type-btns");
  if (!host) return;
  const types = mtceTypesActive();
  for (const t of types) {
    if (ALARM.typeOn[t] === undefined) ALARM.typeOn[t] = true;
  }
  if (!types.length) {
    host.innerHTML = `<span class="hint" style="margin:0">No mtce types yet</span>`;
    return;
  }
  host.innerHTML = types
    .map((t) => {
      const on = ALARM.typeOn[t] !== false;
      return `<button type="button" class="btn cdr-toggle alarm-type-btn${on ? " is-on" : ""}" data-mtce="${escapeHtml(
        t
      )}" aria-pressed="${on}" title="ON=show · OFF=hide">${escapeHtml(t)}</button>`;
    })
    .join("");
  host.querySelectorAll(".alarm-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-mtce");
      ALARM.typeOn[t] = !ALARM.typeOn[t];
      btn.classList.toggle("is-on", !!ALARM.typeOn[t]);
      btn.setAttribute("aria-pressed", ALARM.typeOn[t] ? "true" : "false");
      renderAlarmTable();
    });
  });
}

function paintAlarmSummary() {
  const el = document.getElementById("alarm-summary-kpi");
  if (!el) return;
  const s = ALARM.data.summary || {};
  el.innerHTML = [
    { k: "Major", v: s.activeMajor ?? 0, acc: "red" },
    { k: "Minor", v: s.activeMinor ?? 0, acc: "yellow" },
    { k: "Warning", v: s.activeWarning ?? 0, acc: "" },
    { k: "Active Total", v: s.activeTotal ?? (ALARM.data.active || []).length, acc: "" },
    { k: "Last Update", v: fmtUpdated(ALARM.data.lastUpdate), acc: "", ts: true },
  ]
    .map(
      (it) => `<div class="map-stat${it.acc ? ` accent-${it.acc}` : ""}">
        <div class="map-stat-k">${escapeHtml(it.k)}</div>
        <div class="map-stat-v${it.ts ? " map-stat-v-ts" : ""}">${escapeHtml(String(it.v))}</div>
      </div>`
    )
    .join("");
}

function filteredRows() {
  const q = (ALARM.query || "").trim().toLowerCase();
  return (ALARM.data.active || []).filter((a) => {
    const t = a.mtceType || a.mtceName || "";
    if (t && ALARM.typeOn[t] === false) return false;
    if (!q) return true;
    const hay = [
      a.alarmed,
      a.alarmedRaw,
      a.severity,
      a.mtceName,
      a.mtceType,
      a.altName,
      a.port,
      a.status,
    ]
      .map((x) => String(x || "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

function sevClass(sev) {
  const s = (sev || "").toUpperCase();
  if (s === "MAJOR") return "sev-major";
  if (s === "MINOR") return "sev-minor";
  return "sev-warn";
}

function renderAlarmTable() {
  const tbody = document.getElementById("alarm-tbody");
  if (!tbody) return;
  if (ALARM.loading && !(ALARM.data.active || []).length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${
      ALARM.connected ? "No active alarms." : "Login required for live alarms."
    }</td></tr>`;
    return;
  }
  const rows = filteredRows();
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${
      ALARM.connected ? "No active alarms (or all types hidden)." : "Login required for live OSSI alarms."
    }</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((a) => {
      const sev = (a.severity || "").toUpperCase();
      const dateTxt = a.alarmed && a.alarmed !== "—" ? a.alarmed : a.alarmedRaw || "—";
      return `<tr class="${sevClass(sev)}">
        <td class="mono">${escapeHtml(dateTxt)}</td>
        <td><span class="badge-sev ${sevClass(sev)}">${escapeHtml(sev || "—")}</span></td>
        <td>${escapeHtml(a.mtceName || a.mtceType || "—")}${
          a.altName ? ` <span class="name">${escapeHtml(a.altName)}</span>` : ""
        }</td>
        <td class="mono">${escapeHtml(a.port || "—")}</td>
        <td>${escapeHtml(a.status || "active")}</td>
      </tr>`;
    })
    .join("");
}

function applyAlarmPayload(data) {
  if (!data || typeof data !== "object") return false;
  let d = data;
  if (d.alarms && typeof d.alarms === "object" && (d.alarms.active || d.alarms.summary)) {
    d = d.alarms;
  }
  if (d.data && typeof d.data === "object" && d.data.alarms) {
    d = d.data.alarms;
  }
  if (!Array.isArray(d.active) && !d.summary) return false;
  const incoming = Array.isArray(d.active) ? d.active : [];
  const prev = ALARM.data.active || [];
  if (prev.length > 0 && incoming.length === 0 && d.ok !== true) {
    return false;
  }
  if (prev.length > 0 && incoming.length === 0 && d.error) {
    return false;
  }
  // Incomplete OSSI page-in: keep the fuller cache instead of shrinking the table
  if (prev.length >= 20 && incoming.length > 0 && incoming.length < prev.length * 0.5) {
    console.warn("alarm payload looks truncated", incoming.length, "vs", prev.length);
    return false;
  }
  ALARM.data = {
    ok: d.ok !== false,
    active: incoming,
    mtceTypes: d.mtceTypes || [],
    summary: d.summary || {},
    lastUpdate: d.lastUpdate || ALARM.data.lastUpdate,
    connected: d.connected,
  };
  if (!(ALARM.data.mtceTypes || []).length) {
    ALARM.data.mtceTypes = mtceTypesActive();
  }
  for (const t of ALARM.data.mtceTypes || []) {
    if (ALARM.typeOn[t] === undefined) ALARM.typeOn[t] = true;
  }
  paintAlarmTypeFilters();
  paintAlarmSummary();
  renderAlarmTable();
  applyAlarmFlash();
  return true;
}

async function forceOssiActive() {
  const res = await fetchJson(apiUrl("alarms/refresh"), { method: "POST", body: "{}" });
  if (applyAlarmPayload(res)) return true;
  throw new Error((res && (res.error || res.Error)) || "alarms/refresh returned no payload");
}

async function loadAlarms(opts = {}) {
  const force = !!opts.force;
  const showModal = !!opts.showModal;
  ALARM.loading = true;

  let ok = false;
  try {
    if (force && ALARM.connected) {
      if (showModal) {
        showProgress("Loading Active Alarms", "OSSI display alarms…");
        setProgress(15, "display alarms (Active)…");
        try {
          await forceOssiActive();
          ok = true;
        } catch (e) {
          console.warn("alarm active:", e?.message || e);
        }
        setProgress(100, ok ? "Complete" : "Failed");
        finishProgress(ok, ok ? "Refresh complete" : (document.getElementById("alarm-auto-status")?.textContent || "Alarm update incomplete"));
      } else {
        try {
          await forceOssiActive();
          ok = true;
        } catch (e) {
          console.warn("alarm auto:", e?.message || e);
        }
      }
    }

    if (!ok || !force) {
      let data = null;
      try {
        data = await fetchJson(apiUrl("alarms"));
      } catch {
        /* 404 old DLL */
      }
      if (!data || !Array.isArray(data.active)) {
        try {
          const td = await fetchJson(apiUrl("trunk-data"));
          const inner = td.data || td;
          if (inner && inner.alarms) data = inner.alarms;
        } catch {
          /* ignore */
        }
      }
      if (!data || !Array.isArray(data.active)) {
        try {
          data = await fetchJson(siteUrl("alarms_cache.json") + "?t=" + Date.now());
        } catch {
          data = null;
        }
      }
      if (data) {
        applyAlarmPayload(data);
        ok = true;
      }
    }
  } finally {
    ALARM.loading = false;
  }
  return ALARM.data;
}

export function setAlarmSessionConnected(connected) {
  ALARM.connected = !!connected;
  if (!ALARM.connected) {
    document.body.classList.remove("alarm-bg-major", "alarm-bg-minor");
    ALARM.manualYellow = false;
    ALARM.manualRed = false;
    ALARM.ackedFp = "";
    document.getElementById("btn-flash-yellow")?.classList.remove("is-on");
    document.getElementById("btn-flash-red")?.classList.remove("is-on");
  } else {
    loadAlarms({ force: false, showModal: false }).catch(() => {});
  }
}

export function setAlarmTabActive(active) {
  ALARM.tabActive = !!active;
}

export function setOssiBusy(busy) {
  ALARM.ossiBusy = !!busy;
  if (!busy && ALARM.pendingSilent && ALARM.connected && !ALARM.loading) {
    ALARM.pendingSilent = false;
    refreshAlarmsSilent().catch(() => {});
  }
}

export function onAlarmTabShow() {
  ALARM.tabActive = true;
  // Cache only — do not start a second display alarms (that shrinks the table mid-page)
  loadAlarms({ force: false, showModal: false }).catch(() => {});
  renderAlarmTable();
}

/** Called after Trunk cycle — silent Active Alarm + flash. */
export async function refreshAlarmsSilent() {
  if (!ALARM.connected) return;
  if (ALARM.loading || ALARM.ossiBusy) {
    ALARM.pendingSilent = true;
    return;
  }
  ALARM.pendingSilent = false;
  try {
    await loadAlarms({ force: true, showModal: false });
  } catch {
    /* next cycle */
  }
  if (ALARM.pendingSilent && !ALARM.loading) {
    ALARM.pendingSilent = false;
    try {
      await loadAlarms({ force: true, showModal: false });
    } catch {
      /* ignore */
    }
  }
}

/** Trunk Auto countdown drives Alarm "Next" so both share one 90s. */
export function syncAlarmCountdown(nextAtMs) {
  const t = Number(nextAtMs);
  if (t) {
    const maxAt = Date.now() + 90 * 1000;
    ALARM.nextAt = Math.min(t, maxAt);
  }
}

export function initAlarmUi() {
  const search = document.getElementById("alarm-search");
  if (search) {
    search.addEventListener("input", () => {
      ALARM.query = search.value || "";
      renderAlarmTable();
    });
  }

  document.getElementById("btn-alarm-ack")?.addEventListener("click", () => {
    ALARM.ackedFp = alarmFingerprint(ALARM.data.active);
    ALARM.manualYellow = false;
    ALARM.manualRed = false;
    document.getElementById("btn-flash-yellow")?.classList.remove("is-on");
    document.getElementById("btn-flash-red")?.classList.remove("is-on");
    applyAlarmFlash();
  });

  document.getElementById("btn-flash-yellow")?.addEventListener("click", () => {
    ALARM.manualYellow = !ALARM.manualYellow;
    if (ALARM.manualYellow) ALARM.manualRed = false;
    document.getElementById("btn-flash-yellow")?.classList.toggle("is-on", ALARM.manualYellow);
    document.getElementById("btn-flash-red")?.classList.toggle("is-on", ALARM.manualRed);
    applyAlarmFlash();
  });

  document.getElementById("btn-flash-red")?.addEventListener("click", () => {
    ALARM.manualRed = !ALARM.manualRed;
    if (ALARM.manualRed) ALARM.manualYellow = false;
    document.getElementById("btn-flash-red")?.classList.toggle("is-on", ALARM.manualRed);
    document.getElementById("btn-flash-yellow")?.classList.toggle("is-on", ALARM.manualYellow);
    applyAlarmFlash();
  });

  paintAlarmSummary();
  renderAlarmTable();
}
