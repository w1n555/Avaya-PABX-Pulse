/**
 * Avaya NOC UI — Trunk (OSSI) + CDR tab (mock UI for now)
 * OSSI via /CM/api · trunk_data.json + monitored_trunks.json
 */

import { apiUrl, fetchJson, escapeHtml } from "./http.js?v=20260827b";
import {
  initCdrUi,
  onCdrTabShow,
  showProgress,
  setProgress,
  hideProgress,
  finishProgress,
} from "./cdr-ui.js?v=20260827b";
import {
  initAlarmUi,
  onAlarmTabShow,
  setAlarmSessionConnected,
  setAlarmTabActive,
  refreshAlarmsSilent,
  syncAlarmCountdown,
  setOssiBusy as setAlarmOssiBusy,
} from "./alarm-ui.js?v=20260827b";
import {
  initGatewayUi,
  onGatewayTabShow,
  setGatewaySessionConnected,
  setGatewayTabActive,
  refreshGatewaysSilent,
  syncGatewayCountdown,
  setOssiBusy as setGatewayOssiBusy,
  runGatewayConfigRefresh,
  getOpenGatewayDetailMg,
  openGatewayDetail,
} from "./gateway-ui.js?v=20260827b";
import {
  initExtensionUi,
  onExtensionTabShow,
  setExtensionSessionConnected,
  setExtensionTabActive,
  runExtensionRefresh,
  armExtensionNext,
  EXTENSION_INTERVAL_MS,
  setOssiBusy as setExtensionOssiBusy,
  runExtensionDetailRefresh,
} from "./extension-ui.js?v=20260827b";
import {
  initMapUi,
  onMapTabShow,
  setMapSessionConnected,
  setMapTabActive,
  refreshMapFromCache,
  syncMapCountdown,
  setOssiBusy as setMapOssiBusy,
} from "./map-ui.js?v=20260827b";

function setOssiBusy(busy) {
  try {
    setAlarmOssiBusy(busy);
  } catch {
    /* ignore */
  }
  try {
    setGatewayOssiBusy(busy);
  } catch {
    /* ignore */
  }
  try {
    setExtensionOssiBusy(busy);
  } catch {
    /* ignore */
  }
  try {
    setMapOssiBusy(busy);
  } catch {
    /* ignore */
  }
}

/** Local login/manual pack owns busy; otherwise follow backend Auto pack / countdown=0. */
function paintOssiBusyFromPack() {
  if (state.refreshing) {
    setOssiBusy(true);
    return;
  }
  const due = state.nextRefreshAt > 0 && Date.now() >= state.nextRefreshAt;
  setOssiBusy(!!state.backendRefreshing || due);
}

const REFRESH_INTERVAL_SEC = 90;
/** Login 後永遠 Auto 90s pack (Python backend) — UI only shows countdown + cache. */
function autoEnabled() {
  return !!state.connected;
}
/** This browser tab explicitly clicked Login (not auto-resume from leftover OSSI). */
const UI_SESSION_KEY = "cm_noc_ui_logged_in";
const NOTES_LS_KEY = "cm_noc_notes";

/** File-only / OSSI jobs — never overlap a live status trunk / display alarms. */
const cmdQueue = [];
let queueRunning = false;

function readLocalNotes() {
  try {
    const raw = localStorage.getItem(NOTES_LS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeLocalNote(tg, note) {
  try {
    const all = readLocalNotes();
    all[String(tg)] = String(note ?? "");
    localStorage.setItem(NOTES_LS_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

function noteForTg(tg, fallback = "") {
  const key = Number(tg);
  if (Object.prototype.hasOwnProperty.call(state.noteDrafts, key)) return state.noteDrafts[key];
  const local = readLocalNotes()[String(key)];
  if (local != null) return local;
  return fallback || "";
}

function rememberNote(tg, note) {
  const key = Number(tg);
  const val = String(note ?? "");
  state.noteDrafts[key] = val;
  writeLocalNote(key, val);
  const mon = state.monitored.find((m) => Number(m.tg) === key);
  if (mon) mon.note = val;
}

function enqueueJob(job) {
  cmdQueue.push(job);
  if (state.refreshing) {
    setStatus(`Queued ${cmdQueue.length} command(s) — waiting for OSSI…`);
  }
  pumpQueue();
}

async function pumpQueue() {
  if (queueRunning) return;
  if (state.refreshing) return;
  queueRunning = true;
  try {
    while (cmdQueue.length && !state.refreshing) {
      const job = cmdQueue.shift();
      try {
        await runQueuedJob(job);
      } catch (e) {
        console.warn("queue job failed:", job?.kind, e?.message || e);
        if (
          job?.kind === "add" ||
          job?.kind === "status" ||
          job?.kind === "gw-config" ||
          job?.kind === "ext-detail" ||
          job?.kind === "remove"
        ) {
          finishProgress(false, String(e.message || e));
          const btn = $("btn-progress-close");
          if (btn) btn.hidden = false;
        } else if (job?.kind === "note") {
          cmdQueue.push(job);
          break;
        }
      }
    }
  } finally {
    queueRunning = false;
    if (cmdQueue.length && !state.refreshing) pumpQueue();
  }
}

async function runQueuedJob(job) {
  if (job.kind === "note") {
    const res = await api("monitored/note", {
      method: "POST",
      body: JSON.stringify({ tg: job.tg, note: job.note }),
    });
    applyMonitoredResponse(res);
    if (state.noteDrafts[job.tg] === job.note) delete state.noteDrafts[job.tg];
    return;
  }
  if (job.kind === "add") {
    const nLeft = cmdQueue.filter((j) => j.kind === "add").length;
    showProgress("Add trunk", nLeft ? `Adding TG ${job.tg} (${nLeft} more queued)…` : `Adding TG ${job.tg}…`);
    setProgress(20, `Saving TG ${job.tg}…`);
    const res = await api("monitored/add", {
      method: "POST",
      body: JSON.stringify({ tg: job.tg, note: job.note || "" }),
    });
    applyMonitoredResponse(res);
    renderTrunkTable();
    if (state.connected) {
      setProgress(55, `status trunk ${job.tg}…`);
      const one = await api("refresh/one", {
        method: "POST",
        body: JSON.stringify({ tg: job.tg }),
      });
      if (one.item) applyOneTrunkItem(one.item);
      else await loadTrunkData({ soft: true });
    }
    setProgress(100, "Done");
    finishProgress(true, `TG ${job.tg} added`);
    return;
  }
  if (job.kind === "remove") {
    setProgress(40, `Removing TG ${job.tg}…`);
    const res = await api("monitored/remove", {
      method: "POST",
      body: JSON.stringify({ tg: job.tg }),
    });
    applyMonitoredResponse(res);
    state.trunkItems = state.trunkItems.filter((x) => Number(x.tg) !== Number(job.tg));
    if (state.detailTg === job.tg) closeDetail();
    renderTrunkTable();
    setProgress(100, "Removed");
    finishProgress(true, `TG ${job.tg} removed`);
    return;
  }
  if (job.kind === "status") {
    if (job.showModal) {
      showProgress(`TG ${job.tg}`, `status trunk ${job.tg}…`);
      setProgress(40, `status trunk ${job.tg}…`);
    }
    const one = await api("refresh/one", {
      method: "POST",
      body: JSON.stringify({ tg: job.tg }),
    });
    if (one.item) applyOneTrunkItem(one.item);
    if (state.detailTg != null && Number(state.detailTg) === Number(job.tg) && one.item) {
      paintDetailFromItem(one.item);
    }
    if (job.showModal) {
      setProgress(100, "Done");
      finishProgress(true, one.item && one.item.error ? `TG ${job.tg} UPDATE FAILED` : `TG ${job.tg} updated`);
    }
    return;
  }
  if (job.kind === "extensions") {
    // Low priority inventory — only runs when 90s pack is idle (pumpQueue waits on refreshing)
    state.refreshing = true;
    state.refreshingSince = Date.now();
    state.packPhase = "extensions";
    try {
      setOssiBusy(true);
    } catch {
      /* ignore */
    }
    try {
      setStatus("OSSI list extension + uniform-dialplan…");
      await runExtensionRefresh({ showModal: !!job.showModal });
      armExtensionNext(EXTENSION_INTERVAL_MS);
      setStatus("");
    } finally {
      state.refreshing = false;
      state.refreshingSince = 0;
      if (state.packPhase === "extensions") state.packPhase = "";
      try {
        paintOssiBusyFromPack();
      } catch {
        /* ignore */
      }
      healAutoCountdown();
    }
    return;
  }
  if (job.kind === "gw-config") {
    state.refreshing = true;
    state.refreshingSince = Date.now();
    try {
      setOssiBusy(true);
    } catch {
      /* ignore */
    }
    try {
      setStatus(`OSSI list configuration media-gateway ${job.mg}…`);
      await runGatewayConfigRefresh(job.mg, { showModal: !!job.showModal });
      setStatus("");
    } finally {
      state.refreshing = false;
      state.refreshingSince = 0;
      try {
        paintOssiBusyFromPack();
      } catch {
        /* ignore */
      }
      healAutoCountdown();
    }
    return;
  }
  if (job.kind === "ext-detail") {
    state.refreshing = true;
    state.refreshingSince = Date.now();
    try {
      setOssiBusy(true);
    } catch {
      /* ignore */
    }
    state.packPhase = "ext-detail";
    const cmd = extDetailCommand(job.type);
    try {
      setStatus(`OSSI ${cmd} ${job.ext}…`);
      await runExtensionDetailRefresh(job.ext, { showModal: !!job.showModal, type: job.type });
      setStatus("");
    } finally {
      state.refreshing = false;
      state.refreshingSince = 0;
      if (state.packPhase === "ext-detail") state.packPhase = "";
      try {
        paintOssiBusyFromPack();
      } catch {
        /* ignore */
      }
      healAutoCountdown();
    }
    return;
  }
}

/** Enqueue list extension + uniform-dialplan (login / 1h / manual). Coalesce duplicate jobs. */
function enqueueExtensionRefresh(opts = {}) {
  const showModal = !!opts.showModal;
  const has = cmdQueue.some((j) => j.kind === "extensions");
  if (has) {
    // Promote to modal if user clicked Refresh while already queued
    if (showModal) {
      const job = cmdQueue.find((j) => j.kind === "extensions");
      if (job) job.showModal = true;
      setStatus(`Queued list extension + uniform-dialplan (${cmdQueue.length} command(s)) — waiting for OSSI…`);
    }
    pumpQueue();
    return;
  }
  enqueueJob({ kind: "extensions", showModal, reason: opts.reason || "auto" });
}

/** Enqueue one-GW list configuration (click-in). Coalesce to latest MG. */
function enqueueGwConfig(mg, opts = {}) {
  const n = Number(mg);
  if (!n) return;
  const showModal = opts.showModal !== false;
  if (showModal) {
    showProgress(`MG ${n} configuration`, "OSSI list configuration media-gateway…");
    setProgress(
      state.refreshing ? 12 : 20,
      state.refreshing
        ? `Waiting for OSSI… then list configuration media-gateway ${n}`
        : `list configuration media-gateway ${n}…`
    );
  }
  for (let i = cmdQueue.length - 1; i >= 0; i -= 1) {
    if (cmdQueue[i].kind === "gw-config") cmdQueue.splice(i, 1);
  }
  enqueueJob({ kind: "gw-config", mg: n, showModal });
  healAutoCountdown();
}

function extDetailCommand(type) {
  const t = String(type || "").trim().toLowerCase();
  if (t === "vdn" || t === "vdn-extension" || t.startsWith("vdn")) return "display vdn";
  if (t === "hunt-group" || t === "hunt" || t.startsWith("hunt")) return "display hunt-group";
  return "display station";
}

/** Enqueue one display station|vdn|hunt-group (click-in). Coalesce to latest ext. Yields to 90s pack. */
function enqueueExtDetail(ext, opts = {}) {
  const extStr = String(ext || "").trim();
  if (!extStr) return;
  const type = opts.type || "";
  const cmd = extDetailCommand(type);
  const showModal = opts.showModal !== false;
  if (showModal) {
    showProgress(`Extension ${extStr}`, `${cmd}…`);
    setProgress(
      state.refreshing ? 12 : 20,
      state.refreshing
        ? `Queued ${cmd} … waiting for OSSI`
        : `${cmd} ${extStr}…`
    );
  }
  for (let i = cmdQueue.length - 1; i >= 0; i -= 1) {
    if (cmdQueue[i].kind === "ext-detail") cmdQueue.splice(i, 1);
  }
  enqueueJob({ kind: "ext-detail", ext: extStr, type, showModal });
  healAutoCountdown();
}

function openGatewayTab(mg) {
  const n = Number(mg);
  if (!n) return;
  const tab = document.querySelector('.tab[data-tab="gateway"]');
  if (tab) tab.click();
  openGatewayDetail(n, { showModal: true });
}

/** Hourly list extension + uniform-dialplan while session is live (not every 60s). */
function startExtensionHourlyTimer() {
  stopExtensionHourlyTimer();
  armExtensionNext(EXTENSION_INTERVAL_MS);
  state.extensionTimer = setInterval(() => {
    if (!state.connected) return;
    if (!autoEnabled()) return;
    enqueueExtensionRefresh({ showModal: false, reason: "hourly" });
  }, EXTENSION_INTERVAL_MS);
}

function stopExtensionHourlyTimer() {
  if (state.extensionTimer) {
    clearInterval(state.extensionTimer);
    state.extensionTimer = null;
  }
}

const $ = (id) => document.getElementById(id);

const state = {
  connected: false,
  connecting: false,
  timer: null,
  heartbeatTimer: null,
  _heartbeatBeat: null,
  _hbFails: 0,
  _hbGone: 0,
  countdownTimer: null,
  /** Hourly list extension + uniform-dialplan (not 60s pack) */
  extensionTimer: null,
  /** Fast poll of trunk_data while progressive OSSI status runs */
  livePollTimer: null,
  /** @type {{tg:number,order:number,note:string}[]} */
  monitored: [],
  /** @type {object[]} live trunk rows joined with notes */
  trunkItems: [],
  disconnecting: false,
  detailTg: null,
  dragTg: null,
  /** epoch ms when next auto progressive refresh should fire */
  nextRefreshAt: 0,
  refreshing: false,
  /** Python backend Auto pack in flight (not this tab's login/manual pack) */
  backendRefreshing: false,
  _wasPackBusy: false,
  packPhase: "",
  /** true once heartbeat/trunk-data/session provided secondsUntilRefresh */
  _haveServerSchedule: false,
  autoIntervalSec: REFRESH_INTERVAL_SEC,
  /** epoch ms when progressiveRefresh entered (stuck guard) */
  refreshingSince: 0,
  activeTab: "trunk",
  /** tg -> { until, timer } for Updated flash */
  flashTimers: {},
  /** tg -> note text being typed / not yet confirmed on server */
  noteDrafts: {},
  /** tg -> epoch ms. UPDATE FAILED sticks until a successful refresh/one for that TG. */
  tgStickyError: {},
  /** 60s re-sync of CM display time */
  cmTimeTimer: null,
  /** 1s local tick so System Time looks live */
  cmTimeTickTimer: null,
  /** CM wall-clock ms at last successful OSSI sync */
  cmTimeAnchorMs: null,
  /** Date.now() at last successful OSSI sync */
  cmTimeLocalAnchor: null,
  lastCmTimeAt: 0,
};

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One status trunk; retry once — SAT/lock blips are the usual UPDATE FAILED. */
async function refreshOneTrunk(tg) {
  const once = () =>
    api("refresh/one", {
      method: "POST",
      body: JSON.stringify({ tg }),
    });
  try {
    const res = await once();
    const item = res && (res.item || res.Item);
    if (item && item.tg != null && !item.error) return { res, item };
    await sleepMs(450);
    const res2 = await once();
    return { res: res2, item: res2 && (res2.item || res2.Item) };
  } catch (e) {
    await sleepMs(450);
    const res2 = await once();
    return { res: res2, item: res2 && (res2.item || res2.Item) };
  }
}

async function api(path, opts = {}) {
  try {
    return await fetchJson(apiUrl(path), opts);
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      throw new Error(msg || "Network error");
    }
    throw e instanceof Error ? e : new Error(msg || "Request failed");
  }
}

/**
 * Login-card error only (connect panel).
 * Never put trunk poll / TG OSSI failures here — those show as Status "UPDATE FAILED".
 */
function setError(msg) {
  const el = $("error-line");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

/**
 * Monitoring / auto messages go next to 60s countdown (trunk-auto-status).
 * Login / connect messages stay on connect-panel status-line.
 */
function statusLooksUpdating(msg) {
  const s = String(msg || "");
  if (!s) return false;
  if (/complete|acked/i.test(s) && !/Updating/i.test(s)) return false;
  return /Updat|queued|waiting for OSSI|OSSI busy|Auto update…/i.test(s);
}

function setStatus(msg) {
  const connectEl = $("status-line");
  const barIds = ["trunk-auto-status", "map-auto-status", "gw-auto-status", "alarm-auto-status", "ext-auto-status"];
  const preferBar = state.connected && barIds.some((id) => $(id));
  if (preferBar) {
    if (!msg) {
      paintAutoStatusChip();
      if (connectEl) {
        connectEl.hidden = true;
        connectEl.textContent = "";
      }
      return;
    }
    const updating = statusLooksUpdating(msg);
    for (const id of barIds) {
      const el = $(id);
      if (!el) continue;
      el.hidden = false;
      el.textContent = msg;
      el.title = msg;
      el.classList.toggle("is-updating", updating);
    }
    if (connectEl) {
      connectEl.hidden = true;
      connectEl.textContent = "";
    }
    return;
  }
  if (!connectEl) return;
  if (!msg) {
    connectEl.hidden = true;
    connectEl.textContent = "";
    return;
  }
  connectEl.hidden = false;
  connectEl.textContent = msg;
}

function setSessionLabel(text, ok) {
  const el = $("meta-session");
  el.textContent = text;
  el.style.color = ok ? "var(--ok)" : "";
}

/** Login state machine: before login hide tabs/content; after show; dim login fields. */
function applyUiMode() {
  const tabs = $("main-tabs");
  const btnDisc = $("btn-disconnect");
  const btnConn = $("btn-connect");
  const fields = ["inp-host", "inp-port", "inp-user", "inp-pass"];
  const connectPanel = $("connect-panel");
  const dimTargets = document.querySelectorAll("[data-panel]");

  if (tabs) tabs.hidden = false;

  if (state.connected) {
    dimTargets.forEach((el) => el.classList.remove("dimmed"));
    const card = $("trunk-card");
    if (card) card.classList.remove("dimmed");
    if (btnDisc) btnDisc.disabled = false;
    if (btnConn) btnConn.disabled = true;
    fields.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = true;
    });
    if (connectPanel) connectPanel.classList.add("is-logged-in");
    if ($("connect-hint")) {
      $("connect-hint").hidden = true;
      $("connect-hint").textContent = "";
    }
  } else {
    dimTargets.forEach((el) => el.classList.add("dimmed"));
    const card = $("trunk-card");
    if (card) card.classList.add("dimmed");
    if (btnDisc) btnDisc.disabled = true;
    if (btnConn) btnConn.disabled = !!state.connecting;
    fields.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = false;
    });
    if (connectPanel) connectPanel.classList.remove("is-logged-in");
    if ($("connect-hint")) {
      $("connect-hint").hidden = false;
      $("connect-hint").textContent =
        "Login with Host / Password. F5 keeps the session; closing the tab logs off OSSI after about 5 minutes.";
    }
  }
}

function markUiLoggedIn() {
  try {
    sessionStorage.setItem(UI_SESSION_KEY, "1");
  } catch {
    /* private mode */
  }
}

function clearUiLoggedIn() {
  try {
    sessionStorage.removeItem(UI_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function hasUiLoggedInFlag() {
  try {
    return sessionStorage.getItem(UI_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function tickClock() {
  const el = $("live-clock");
  if (el) el.textContent = new Date().toLocaleTimeString();
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtKpiTs(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).replace("T", " ").replace("Z", "").slice(0, 19);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(iso).replace("T", " ").replace("Z", "").slice(0, 19);
  }
}

function utilColorClass(item) {
  return item.statusColor || "green";
}

function trunkRowSeverity(it) {
  if (it.error) return "sev-fail";
  if (!it.hasLive) return "";
  const c = utilColorClass(it);
  if (c === "red") return "sev-major";
  if (c === "yellow") return "sev-minor";
  return "";
}

function applyTrunkRowSeverity(tr, it) {
  if (!tr) return;
  tr.classList.remove("sev-fail", "sev-major", "sev-minor", "has-oos");
  const sev = trunkRowSeverity(it);
  if (sev) tr.classList.add(sev);
  if (!it.error && Number(it.oos) > 0) tr.classList.add("has-oos");
}

function paintTrunkSummary(rows) {
  const list = rows || mergeRows();
  const n = list.length;
  let healthy = 0;
  let warn = 0;
  let crit = 0;
  let oosRows = 0;
  let newest = null;
  let newestMs = 0;
  for (const it of list) {
    if (it.error || utilColorClass(it) === "red") crit += 1;
    else if (!it.hasLive) {
      /* waiting for first status */
    } else if (utilColorClass(it) === "yellow") warn += 1;
    else healthy += 1;
    if (!it.error && Number(it.oos) > 0) oosRows += 1;
    if (it.lastUpdate) {
      const ms = Date.parse(it.lastUpdate);
      if (Number.isFinite(ms) && ms >= newestMs) {
        newestMs = ms;
        newest = it.lastUpdate;
      } else if (!Number.isFinite(ms) && !newest) newest = it.lastUpdate;
    }
  }
  const set = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  set("trunk-stat-groups", `${healthy} / ${n}`);
  set("trunk-stat-warn", String(warn));
  set("trunk-stat-crit", String(crit));
  set("trunk-stat-oos", String(oosRows));
  set("trunk-stat-updated", newest ? fmtKpiTs(newest) : "—");
  const groups = $("trunk-stat-groups-card");
  if (groups) {
    groups.classList.remove("accent-red", "accent-green", "accent-yellow");
    if (!n) {
      /* empty */
    } else if (crit > 0) groups.classList.add("accent-red");
    else if (warn > 0) groups.classList.add("accent-yellow");
    else groups.classList.add("accent-green");
  }
  const oosCard = $("trunk-stat-oos-card");
  if (oosCard) oosCard.classList.toggle("accent-red", oosRows > 0);
}

function mergeRows() {
  /** Prefer monitored order; join live trunk_data by tg. */
  const byTg = new Map((state.trunkItems || []).map((it) => [Number(it.tg), it]));
  const mon = state.monitored.length
    ? state.monitored
    : (state.trunkItems || []).map((it, i) => ({
        tg: Number(it.tg),
        order: i,
        note: it.note || "",
      }));

  return mon.map((m) => {
    const live = byTg.get(m.tg) || {};
    const sticky = !!(state.tgStickyError && state.tgStickyError[m.tg]);
    const emptyCounts =
      live.tg != null &&
      !live.error &&
      Number(live.total || 0) === 0 &&
      Number(live.idle || 0) === 0 &&
      Number(live.busy || 0) === 0;
    const err = live.error || (sticky ? "UPDATE FAILED" : null) || (emptyCounts ? "UPDATE FAILED" : null);
    return {
      tg: m.tg,
      order: m.order,
      note: noteForTg(m.tg, m.note ?? live.note ?? ""),
      name: live.name || "",
      type: live.type || "",
      tac: live.tac || "",
      total: err ? null : live.total,
      idle: err ? null : live.idle,
      busy: err ? null : live.busy,
      oos: err ? null : live.oos,
      utilizationPct: err ? null : live.utilizationPct,
      statusColor: err ? "red" : live.statusColor,
      lastUpdate: live.lastUpdate,
      error: err,
      hasLive: !!live.tg || live.total != null,
    };
  });
}

function stripStaleTrunkCounts(row) {
  return {
    ...row,
    total: null,
    idle: null,
    busy: null,
    oos: null,
    utilizationPct: null,
    channels: [],
  };
}

function utilCellHtml(it) {
  if (!it.hasLive) return `<strong>—</strong>`;
  if (it.error) return `<strong>—</strong>`;
  const color = utilColorClass(it);
  const util = Number(it.utilizationPct || 0);
  const cls = color === "yellow" ? "util-yellow" : color === "red" ? "util-red" : "util-green";
  return `<strong>${util.toFixed(1)}%</strong><div class="util-bar"><i class="${cls}" style="width:${Math.min(
    100,
    util
  )}%"></i></div>`;
}

function statusCellHtml(it) {
  if (!it.hasLive) return `<span class="badge muted">—</span>`;
  // Per-TG OSSI get fail → Status only (no login popup / no global error banner)
  if (it.error) {
    return `<span class="badge fail" title="UPDATE FAILED"><span class="dot"></span>UPDATE FAILED</span>`;
  }
  const color = utilColorClass(it);
  const label = color === "red" ? "MAJOR" : color === "yellow" ? "MINOR" : "GREEN";
  return `<span class="badge ${color}" title="${label}"><span class="dot"></span>${label}</span>`;
}

function buildTrunkRow(it) {
  const tr = document.createElement("tr");
  tr.className = "tg-row";
  tr.dataset.tg = String(it.tg);
  tr.draggable = true;
  applyTrunkRowSeverity(tr, it);
  if (it.error) tr.title = "UPDATE FAILED";
  else tr.removeAttribute("title");

  tr.innerHTML = `
      <td class="col-drag"><span class="drag-handle" title="Drag to reorder">⋮⋮</span></td>
      <td class="tg-cell"><button type="button" class="link-tg" data-open="${it.tg}" title="Open detail">${it.tg}</button></td>
      <td class="col-note"><input type="text" class="note-input" data-note-tg="${it.tg}" maxlength="200" value="${escapeHtml(
        it.note || ""
      )}" placeholder="Note…" /></td>
      <td class="name-cell">${escapeHtml(it.name || "—")}${
        it.type ? `<span class="name">${escapeHtml(it.type)}${it.tac ? " · TAC " + escapeHtml(it.tac) : ""}</span>` : ""
      }</td>
      <td class="col-total mono">${it.error ? "—" : it.total ?? "—"}</td>
      <td class="col-idle mono">${it.error ? "—" : it.idle ?? "—"}</td>
      <td class="col-busy mono">${it.error ? "—" : it.busy ?? "—"}</td>
      <td class="col-oos mono">${it.error ? "—" : it.oos ?? "—"}</td>
      <td class="col-util">${utilCellHtml(it)}</td>
      <td class="col-status">${statusCellHtml(it)}</td>
      <td class="mono col-updated" data-updated-tg="${it.tg}">${fmtTime(it.lastUpdate)}</td>
      <td><button type="button" class="btn btn-danger btn-rm" data-rm="${it.tg}">Remove</button></td>
    `;
  return tr;
}

function renderTrunkTable() {
  const tbody = $("trunk-tbody");
  const rows = mergeRows();

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="12">${
      state.connected ? "No monitored TGs — add a trunk group number above." : "Monitored trunk groups appear after Login."
    }</td></tr>`;
    paintTrunkSummary(rows);
    return;
  }

  // Preserve note focus while rebuilding structure (order/add/remove)
  const focusTg = document.activeElement?.classList?.contains("note-input")
    ? Number(document.activeElement.getAttribute("data-note-tg"))
    : null;
  const focusVal = focusTg != null ? document.activeElement.value : null;
  const focusPos =
    focusTg != null && typeof document.activeElement.selectionStart === "number"
      ? document.activeElement.selectionStart
      : null;

  tbody.innerHTML = "";
  for (const it of rows) {
    tbody.appendChild(buildTrunkRow(it));
  }
  bindRowInteractions(tbody);

  if (focusTg != null) {
    const inp = tbody.querySelector(`.note-input[data-note-tg="${focusTg}"]`);
    if (inp) {
      inp.value = focusVal ?? inp.value;
      inp.focus();
      if (focusPos != null) {
        try {
          inp.setSelectionRange(focusPos, focusPos);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Re-apply any active flashes after rebuild
  for (const [tg, info] of Object.entries(state.flashTimers)) {
    if (info && info.until > Date.now()) {
      const cell = tbody.querySelector(`td.col-updated[data-updated-tg="${tg}"]`);
      if (cell) cell.classList.add("updated-flash");
    }
  }
  paintTrunkSummary(rows);
}

/**
 * In-place update one TG row — no full table reload (avoids flash cut-off / lag dim).
 */
function patchTrunkRow(item, { flash = false } = {}) {
  if (!item || item.tg == null) return;
  const tg = Number(item.tg);
  const mon = state.monitored.find((m) => Number(m.tg) === tg);
  const it = {
    tg,
    order: mon?.order ?? item.order ?? 0,
    note: noteForTg(tg, mon?.note ?? item.note ?? ""),
    name: item.name || "",
    type: item.type || "",
    tac: item.tac || "",
    total: item.total,
    idle: item.idle,
    busy: item.busy,
    oos: item.oos,
    utilizationPct: item.utilizationPct,
    statusColor: item.statusColor,
    lastUpdate: item.lastUpdate,
    error: item.error,
    hasLive: item.tg != null || item.total != null,
  };

  const tbody = $("trunk-tbody");
  let tr = tbody?.querySelector(`tr.tg-row[data-tg="${tg}"]`);
  if (!tr || !tbody || tbody.querySelector("tr.empty")) {
    // Row missing / empty placeholder — full structure paint once
    renderTrunkTable();
    if (flash) flashUpdatedTg(tg);
    return;
  }

  if (it.error) tr.title = "UPDATE FAILED";
  else tr.removeAttribute("title");
  applyTrunkRowSeverity(tr, it);

  const setTxt = (sel, val) => {
    const el = tr.querySelector(sel);
    if (el) el.textContent = val == null || val === "" ? "—" : String(val);
  };
  setTxt(".col-total", it.error ? "—" : it.total ?? "—");
  setTxt(".col-idle", it.error ? "—" : it.idle ?? "—");
  setTxt(".col-busy", it.error ? "—" : it.busy ?? "—");
  setTxt(".col-oos", it.error ? "—" : it.oos ?? "—");

  const nameCell = tr.querySelector(".name-cell");
  if (nameCell) {
    nameCell.innerHTML = `${escapeHtml(it.name || "—")}${
      it.type ? `<span class="name">${escapeHtml(it.type)}${it.tac ? " · TAC " + escapeHtml(it.tac) : ""}</span>` : ""
    }`;
  }
  const utilCell = tr.querySelector(".col-util");
  if (utilCell) utilCell.innerHTML = utilCellHtml(it);
  const stCell = tr.querySelector(".col-status");
  if (stCell) stCell.innerHTML = statusCellHtml(it);

  const noteInp = tr.querySelector(".note-input");
  if (
    noteInp &&
    document.activeElement !== noteInp &&
    !Object.prototype.hasOwnProperty.call(state.noteDrafts, tg)
  ) {
    noteInp.value = it.note || "";
  }

  const upd = tr.querySelector(".col-updated");
  if (upd) {
    const wasFlashing = upd.classList.contains("updated-flash");
    upd.textContent = fmtTime(it.lastUpdate);
    if (wasFlashing) upd.classList.add("updated-flash");
  }

  if (flash) flashUpdatedTg(tg);
  paintTrunkSummary();
}

function markTrunkStickyError(tg, on) {
  const key = Number(tg);
  if (!key) return;
  if (!state.tgStickyError) state.tgStickyError = {};
  if (on) state.tgStickyError[key] = Date.now();
  else delete state.tgStickyError[key];
}

function applyStickyTrunkErrors(items) {
  const sticky = state.tgStickyError || {};
  if (!items || !items.length || !Object.keys(sticky).length) return items || [];
  return items.map((it) => {
    const tg = Number(it.tg);
    if (!sticky[tg] && !it.error) return it;
    return stripStaleTrunkCounts({
      ...it,
      error: it.error || "UPDATE FAILED",
      statusColor: "red",
    });
  });
}

/** Merge one TG status item into state and patch row; flash Updated 2s. */
function applyOneTrunkItem(item) {
  if (!item || item.tg == null) return;
  const tg = Number(item.tg);
  if (
    item.error ||
    (Number(item.total || 0) === 0 && Number(item.idle || 0) === 0 && Number(item.busy || 0) === 0)
  ) {
    markTrunkStickyError(tg, true);
    item = stripStaleTrunkCounts({
      ...item,
      error: "UPDATE FAILED",
      statusColor: "red",
    });
  } else {
    markTrunkStickyError(tg, false);
  }
  const idx = state.trunkItems.findIndex((x) => Number(x.tg) === tg);
  if (idx >= 0) {
    const prev = state.trunkItems[idx];
    state.trunkItems[idx] = { ...prev, ...item };
    if (item.error) {
      state.trunkItems[idx] = stripStaleTrunkCounts(state.trunkItems[idx]);
    } else if (!Array.isArray(item.channels) && Array.isArray(prev.channels)) {
      state.trunkItems[idx].channels = prev.channels;
    }
  } else state.trunkItems.push(item);
  // Header "Updated" under Refresh button
  const meta = $("meta-updated");
  if (meta && item.lastUpdate) meta.textContent = fmtTime(item.lastUpdate);
  patchTrunkRow({ ...state.trunkItems.find((x) => Number(x.tg) === tg), tg }, { flash: !item.error });
  // Detail open on this TG → repaint member table from same cache (no extra OSSI)
  if (state.detailTg != null && Number(state.detailTg) === tg && Array.isArray(item.channels) && !item.error) {
    paintDetailFromItem({ ...item, tg });
  }
}

function paintCountdown() {
  paintAutoStatusChip();
}

function startCountdownClock() {
  if (state.countdownTimer) return;
  state.countdownTimer = setInterval(() => {
    // Safety: local login/manual pack must never stick "Updating…" forever
    if (state.refreshing && state.refreshingSince > 0 && Date.now() - state.refreshingSince > 180_000) {
      console.warn("progressiveRefresh stuck >180s — forcing unlock");
      state.refreshing = false;
      state.refreshingSince = 0;
    }
    paintCountdown();
    paintAutoStatusChip();
    healAutoCountdown();
    if (!state.refreshing) {
      try {
        paintOssiBusyFromPack();
      } catch {
        /* ignore */
      }
    }
    // Auto pack is Python backend — clock only paints countdown + heal. Do not progressiveRefresh.
  }, 250);
}

function currentOpenMg() {
  try {
    const n = Number(getOpenGatewayDetailMg());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function heartbeatPayload() {
  return {
    tab: state.activeTab || "trunk",
    skipTime: true,
    packing: !!state.refreshing,
    openMg: currentOpenMg(),
  };
}

function scheduleSource(src) {
  if (!src || typeof src !== "object") return null;
  if (src.secondsUntilRefresh != null || src.refreshing != null || src.autoIntervalSec != null) return src;
  const inner = src.data;
  if (inner && typeof inner === "object") {
    if (inner.secondsUntilRefresh != null || inner.refreshing != null || inner.autoIntervalSec != null) return inner;
  }
  return src;
}

function applyServerSchedule(src) {
  const inner = scheduleSource(src);
  if (!inner) return;
  const hasRefreshing = inner.refreshing != null;
  const sec = Number(inner.secondsUntilRefresh);
  const hasSec = Number.isFinite(sec) && sec >= 0;
  if (!hasRefreshing && !hasSec && inner.autoIntervalSec == null) return;
  const interval = Number(inner.autoIntervalSec);
  if (Number.isFinite(interval) && interval > 0) state.autoIntervalSec = interval;
  const wasBackend = !!state.backendRefreshing;
  if (hasRefreshing) {
    state.backendRefreshing = !!inner.refreshing;
  }
  if (hasSec) {
    state._haveServerSchedule = true;
    state.nextRefreshAt = Date.now() + sec * 1000;
    try {
      syncAlarmCountdown(state.nextRefreshAt);
    } catch {
      /* alarm ui optional */
    }
    try {
      syncGatewayCountdown(state.nextRefreshAt);
    } catch {
      /* gateway ui optional */
    }
    try {
      syncMapCountdown(state.nextRefreshAt);
    } catch {
      /* map ui optional */
    }
  }
  if (!state.refreshing) {
    try {
      paintOssiBusyFromPack();
    } catch {
      /* ignore */
    }
  }
  if (wasBackend && !state.backendRefreshing && !state.refreshing) {
    try {
      refreshMapFromCache();
    } catch {
      /* ignore */
    }
    try {
      if (state.activeTab === "alarm") onAlarmTabShow();
      else if (state.activeTab === "gateway") onGatewayTabShow();
    } catch {
      /* ignore */
    }
  }
  paintAutoStatusFromSchedule(inner);
  paintCountdown();
}

function paintAutoStatusFromSchedule(src) {
  if (src && typeof src === "object") {
    const phase = String(src.packPhase || "").toLowerCase();
    if (src.refreshing) {
      state._wasPackBusy = true;
      if (phase) state.packPhase = phase;
    } else if (!state.refreshing) {
      state.packPhase = phase;
    }
  }
  paintAutoStatusChip();
}

function autoStatusMessage() {
  if (!state.connected) return "";
  const busy = !!state.refreshing || !!state.backendRefreshing;
  const sec = state.nextRefreshAt
    ? Math.min(
        REFRESH_INTERVAL_SEC,
        Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000))
      )
    : null;
  const due = sec === 0 && !!state.nextRefreshAt;
  const phase = String(state.packPhase || "").toLowerCase();
  const msgs = {
    trunks: "Updating trunks… (live, per TG)",
    alarms: "Updating alarms…",
    gateways: "Updating gateways…",
    config: "Updating gateway configuration…",
    extensions: "Updating extensions…",
    "ext-detail": "Updating extension detail…",
  };
  if (busy) {
    if (msgs[phase]) return msgs[phase];
    if (state.refreshing && !state.backendRefreshing) return "Updating…";
    return msgs.trunks;
  }
  // Countdown hit 0 but pack has not started — do not keep "Updating trunks"
  if (due && state.backendRefreshing) {
    return msgs[phase] || msgs.trunks;
  }
  if (sec != null) {
    if (state._wasPackBusy) {
      return `Auto update complete — next in ${sec}s`;
    }
    return `Waiting for Auto — next in ${sec}s`;
  }
  return "Waiting for Auto…";
}

function paintAutoStatusChip() {
  const barIds = ["trunk-auto-status", "map-auto-status", "gw-auto-status", "alarm-auto-status", "ext-auto-status"];
  if (!state.connected) {
    for (const id of barIds) {
      const el = $(id);
      if (!el) continue;
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-updating");
    }
    return;
  }
  const msg = autoStatusMessage();
  const updating = statusLooksUpdating(msg);
  for (const id of barIds) {
    const el = $(id);
    if (!el) continue;
    el.hidden = false;
    el.textContent = msg;
    el.title = msg;
    el.classList.toggle("is-updating", updating);
  }
}

function armNextRefresh(fromNowSec = REFRESH_INTERVAL_SEC) {
  let sec = Number(fromNowSec);
  if (!Number.isFinite(sec) || sec < 1) sec = REFRESH_INTERVAL_SEC;
  // Never park Auto for hours — leftover 24h lock showed "Next: 86373s" on Gateway Details.
  if (sec > REFRESH_INTERVAL_SEC) sec = REFRESH_INTERVAL_SEC;
  state.nextRefreshAt = Date.now() + sec * 1000;
  try {
    syncAlarmCountdown(state.nextRefreshAt);
  } catch {
    /* alarm ui optional */
  }
  try {
    syncGatewayCountdown(state.nextRefreshAt);
  } catch {
    /* gateway ui optional */
  }
  try {
    syncMapCountdown(state.nextRefreshAt);
  } catch {
    /* map ui optional */
  }
  paintCountdown();
}

/** Trust server secondsUntilRefresh. Do not snap a local 90s to force a browser pack. */
function healAutoCountdown() {
  if (!autoEnabled()) return;
  const maxAt = Date.now() + REFRESH_INTERVAL_SEC * 1000;
  if (state._haveServerSchedule) {
    if (state.nextRefreshAt) {
      try {
        syncGatewayCountdown(state.nextRefreshAt);
      } catch {
        /* ignore */
      }
      try {
        syncMapCountdown(state.nextRefreshAt);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  // No server schedule yet: wait. Only clamp insane leftover 24h local values.
  if (state.nextRefreshAt > maxAt + 1500) {
    state.nextRefreshAt = maxAt;
  }
  if (state.nextRefreshAt) {
    try {
      syncGatewayCountdown(state.nextRefreshAt);
    } catch {
      /* ignore */
    }
    try {
      syncMapCountdown(state.nextRefreshAt);
    } catch {
      /* ignore */
    }
  }
}

function bindRowInteractions(tbody) {
  tbody.querySelectorAll(".link-tg").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(Number(btn.dataset.open));
    });
  });
  tbody.querySelectorAll(".btn-rm").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeTg(Number(btn.dataset.rm));
    });
  });
  tbody.querySelectorAll(".note-input").forEach((inp) => {
    let t = null;
    const save = () => saveNote(Number(inp.dataset.noteTg), inp.value);
    inp.addEventListener("change", save);
    inp.addEventListener("blur", save);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        inp.blur();
      }
    });
    inp.addEventListener("input", () => {
      rememberNote(Number(inp.dataset.noteTg), inp.value);
      clearTimeout(t);
      t = setTimeout(save, 800);
    });
    inp.addEventListener("mousedown", (e) => e.stopPropagation());
    inp.addEventListener("click", (e) => e.stopPropagation());
  });

  tbody.querySelectorAll("tr.tg-row").forEach((tr) => {
    tr.addEventListener("dragstart", (e) => {
      state.dragTg = Number(tr.dataset.tg);
      tr.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tr.dataset.tg);
    });
    tr.addEventListener("dragend", () => {
      tr.classList.remove("dragging");
      state.dragTg = null;
      tbody.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });
    tr.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      tr.classList.add("drag-over");
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("drag-over"));
    tr.addEventListener("drop", async (e) => {
      e.preventDefault();
      tr.classList.remove("drag-over");
      const from = state.dragTg ?? Number(e.dataTransfer.getData("text/plain"));
      const to = Number(tr.dataset.tg);
      if (!from || !to || from === to) return;
      await reorder(from, to);
    });
  });
}

async function reorder(fromTg, toTg) {
  const list = state.monitored.map((x) => ({ ...x }));
  const fromIdx = list.findIndex((x) => x.tg === fromTg);
  const toIdx = list.findIndex((x) => x.tg === toTg);
  if (fromIdx < 0 || toIdx < 0) return;
  const [item] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, item);
  list.forEach((it, i) => {
    it.order = i;
  });
  state.monitored = list;
  renderTrunkTable();
  try {
    const res = await api("monitored", {
      method: "PUT",
      body: JSON.stringify({
        items: list.map((it) => ({ tg: it.tg, order: it.order, note: it.note || "" })),
        refreshStatus: false,
      }),
    });
    applyMonitoredResponse(res);
  } catch (e) {
    console.warn("reorder:", e?.message || e);
    await loadMonitored();
  }
}

async function saveNote(tg, note) {
  rememberNote(tg, note);
  try {
    const res = await api("monitored/note", {
      method: "POST",
      body: JSON.stringify({ tg, note }),
    });
    applyMonitoredResponse(res);
    if (state.noteDrafts[tg] === note) delete state.noteDrafts[tg];
  } catch (e) {
    console.warn("save note (will retry):", e?.message || e);
    enqueueJob({ kind: "note", tg, note });
  }
}

function applyMonitoredResponse(res) {
  if (res.items && Array.isArray(res.items)) {
    state.monitored = res.items.map((it, i) => ({
      tg: Number(it.tg),
      order: Number(it.order ?? i),
      note: noteForTg(it.tg, it.note || ""),
    }));
  } else if (res.trunks) {
    state.monitored = res.trunks.map((tg, i) => ({
      tg: Number(tg),
      order: i,
      note: noteForTg(
        tg,
        (state.monitored.find((m) => m.tg === Number(tg)) || {}).note || ""
      ),
    }));
  }
}

function renderTrunkMeta(data) {
  const meta = $("meta-updated");
  if (meta) meta.textContent = fmtTime(data && data.lastUpdate);
  const card = $("trunk-stat-updated");
  if (card && data && data.lastUpdate) card.textContent = fmtKpiTs(data.lastUpdate);
  // Last-known CM host from cache is OK to show; session label must follow LIVE state only
  if (data && data.host) $("meta-host").textContent = data.host;
  // Never set "Monitoring" from stale trunk_data.connected — only after real Login / session/status
  if (state.connected) {
    setSessionLabel("Monitoring (OSSI)", true);
  } else {
    setSessionLabel("Disconnected", false);
  }
}

/**
 * @param {{ soft?: boolean, flashChanges?: boolean }} [opts]
 * soft: never throw / never wipe rows on empty or 502
 * flashChanges: green-flash Updated cells whose lastUpdate advanced
 */
async function loadTrunkData(opts = {}) {
  const soft = !!opts.soft;
  const flashChanges = !!opts.flashChanges;
  try {
    const res = await api("trunk-data");
    const data = res.data || res;
    const items = (data && data.items) || [];
    const prevByTg = {};
    for (const it of state.trunkItems || []) {
      prevByTg[Number(it.tg)] = it.lastUpdate || "";
    }
    // Never flash empty table on transient empty/error while we already have rows
    if (items.length > 0 || state.trunkItems.length === 0) {
      state.trunkItems = applyStickyTrunkErrors(items);
    }
    renderTrunkMeta(data);

    // Prefer in-place patches when table already has the same TG set (no lag reload)
    const tbody = $("trunk-tbody");
    const existing = tbody ? tbody.querySelectorAll("tr.tg-row") : [];
    const canPatch =
      existing.length > 0 &&
      items.length > 0 &&
      existing.length === mergeRows().length &&
      [...existing].every((tr) => items.some((it) => Number(it.tg) === Number(tr.dataset.tg)));

    if (canPatch) {
      for (const it of state.trunkItems) {
        const tg = Number(it.tg);
        const cur = it.lastUpdate || "";
        const changed = cur && cur !== (prevByTg[tg] || "") && !it.error;
        patchTrunkRow(it, { flash: flashChanges && changed });
      }
    } else {
      renderTrunkTable();
      if (flashChanges) {
        for (const it of state.trunkItems || []) {
          const tg = Number(it.tg);
          const cur = it.lastUpdate || "";
          if (cur && cur !== (prevByTg[tg] || "")) flashUpdatedTg(tg);
        }
      }
    }

    if (data && (data.secondsUntilRefresh != null || data.refreshing != null || data.autoIntervalSec != null)) {
      applyServerSchedule(data);
    }
    // Soft fill System Time only if we have no anchor yet (don't reset tick every 2s)
    if (state.connected && state.cmTimeAnchorMs == null) {
      const ct = data.cmTime || (data.systemTime ? { systemTime: data.systemTime } : null);
      if (_cmTimeText(ct)) setCmTimeAnchor(ct);
    }
    return data;
  } catch (e) {
    if (soft) {
      console.warn("trunk-data soft fail:", e.message || e);
      return null;
    }
    throw e;
  }
}

async function loadMonitored() {
  const res = await api("monitored");
  applyMonitoredResponse(res);
  renderTrunkTable();
}

/** Soft load — page must not hang if bridge is down (502). */
async function loadMonitoredSoft() {
  try {
    await loadMonitored();
  } catch (e) {
    console.warn("monitored unavailable:", e.message || e);
  }
}

/* ---------- Login progress modal (English, 3 coarse steps) ---------- */
function setLoginPct(pct, detail) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = $("login-bar-fill");
  const label = $("login-pct");
  if (fill) fill.style.width = p + "%";
  if (label) label.textContent = p + "%";
  if (detail != null && $("login-modal-detail")) {
    $("login-modal-detail").textContent = detail;
  }
}

/** Live OSSI command on the login bar (NOC-visible). */
function setLoginOssi(command, pct) {
  const cmd = String(command || "").trim();
  const el = $("login-ossi-cmd");
  if (el) el.textContent = cmd || "—";
  const sub = $("login-modal-sub");
  if (sub && cmd) sub.textContent = cmd;
  if (pct != null) setLoginPct(pct, cmd);
}

function showLoginModal(title = "Connecting to CM") {
  const m = $("login-modal");
  if (!m) return;
  m.hidden = false;
  const close = $("btn-login-modal-close");
  if (close) close.hidden = true;
  const spin = $("login-modal-spinner");
  if (spin) spin.className = "modal-spinner";
  const titleEl = $("login-modal-title");
  if (titleEl) titleEl.textContent = title;
  const sub = $("login-modal-sub");
  if (sub) sub.textContent = "Please wait…";
  const detail = $("login-modal-detail");
  if (detail) detail.textContent = "";
  setLoginPct(0, "");
  const isLogout = /log\s*out/i.test(title);
  const labels = isLogout
    ? ["Stop auto refresh", "OSSI logoff", "Done"]
    : ["Start OSSI bridge", "Connect to CM (SSH + OSSI login)", "OSSI cache (all tabs)"];
  m.querySelectorAll(".progress-steps li").forEach((li) => {
    li.classList.remove("active", "done", "fail");
    const n = Number(li.dataset.step);
    if (labels[n - 1]) li.textContent = labels[n - 1];
  });
  const cmdEl = $("login-ossi-cmd");
  if (cmdEl && !isLogout) cmdEl.textContent = "—";
}

function hideLoginModal(delayMs = 0) {
  const m = $("login-modal");
  if (!m) return;
  const go = () => {
    m.hidden = true;
  };
  if (delayMs > 0) setTimeout(go, delayMs);
  else go();
}

/**
 * @param {number} step 1..3
 * @param {"active"|"done"|"fail"} kind
 * @param {string} [detail]
 */
function setLoginStep(step, kind, detail) {
  const list = $("login-progress-steps");
  if (!list) return;
  list.querySelectorAll("li").forEach((li) => {
    const n = Number(li.dataset.step);
    if (n < step) {
      li.classList.remove("active", "fail");
      li.classList.add("done");
    } else if (n === step) {
      li.classList.remove("done", "active", "fail");
      li.classList.add(kind === "fail" ? "fail" : kind === "done" ? "done" : "active");
    } else {
      li.classList.remove("active", "done", "fail");
    }
  });
  if (detail != null) $("login-modal-detail").textContent = detail;
  if (kind === "fail") {
    $("login-modal-spinner").className = "modal-spinner fail";
    $("login-modal-sub").textContent = "Login failed";
    $("btn-login-modal-close").hidden = false;
    setLoginPct(100, detail);
  } else if (kind === "done" && step >= 3) {
    $("login-modal-spinner").className = "modal-spinner done";
    $("login-modal-sub").textContent = "Connected · all tab caches ready";
    setLoginPct(100, detail);
    const cmdEl = $("login-ossi-cmd");
    if (cmdEl) cmdEl.textContent = detail || "done";
  } else {
    $("login-modal-sub").textContent = detail || "Please wait…";
    const pct =
      step <= 1 ? (kind === "done" ? 12 : 6) : step === 2 ? (kind === "done" ? 22 : 14) : 24;
    setLoginPct(pct, detail);
  }
}

function failLoginModal(msg) {
  const active = $("login-progress-steps")?.querySelector("li.active");
  const step = active ? Number(active.dataset.step) : 2;
  setLoginStep(step, "fail", msg || "Login failed");
}

/**
 * Paint TG detail from cached item (channels from 60s status trunk).
 * No OSSI when data already in trunkItems / refresh/one response.
 */
function paintDetailFromItem(item, opts = {}) {
  if (!item) return;
  const tg = Number(item.tg);
  const mon = state.monitored.find((m) => Number(m.tg) === tg);
  const note = (item.note || (mon && mon.note) || "").trim();
  $("detail-title").textContent = `${tg}${item.name ? " · " + item.name : ""}`;
  const counts =
    opts.counts ||
    (item.total != null
      ? { total: item.total, idle: item.idle, busy: item.busy, oos: item.oos }
      : null);
  $("detail-meta").textContent = [
    item.type ? item.type : "",
    item.tac ? "TAC " + item.tac : "",
    note ? "Note: " + note : "",
    counts
      ? `Total ${counts.total ?? "—"} · Idle ${counts.idle ?? "—"} · Busy ${counts.busy ?? "—"}`
      : "",
    item.lastUpdate ? `Updated ${fmtTime(item.lastUpdate)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const channels = item.channels || opts.channels || [];
  const tbody = $("detail-tbody");
  if (!channels.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${
      item.error ||
      opts.error ||
      "No channel cache yet — wait for the next Auto 90s."
    }</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const ch of channels) {
    const tr = document.createElement("tr");
    const busy = String(ch.busy || "").toLowerCase() === "yes";
    tr.innerHTML = `
      <td class="mono">${escapeHtml(ch.member || "")}</td>
      <td class="mono">${escapeHtml(ch.port || "—")}</td>
      <td>${escapeHtml(ch.state || "—")}</td>
      <td>${busy ? '<span class="badge yellow"><span class="dot"></span>yes</span>' : "no"}</td>
      <td class="mono">${escapeHtml(ch.connected || "—")}</td>
    `;
    tbody.appendChild(tr);
  }
}

/** Open detail from list cache — no immediate OSSI (shared with 60s poll). */
async function openDetail(tg) {
  if (!state.connected) {
    setError("Login required to view channel details.");
    return;
  }
  state.detailTg = tg;
  $("trunk-list-view").hidden = true;
  $("trunk-detail-view").hidden = false;
  $("detail-title").textContent = `${tg}`;
  $("detail-meta").textContent = "";
  $("detail-tbody").innerHTML = `<tr class="empty"><td colspan="5">Loading…</td></tr>`;

  // Prefer in-memory cache from last 60s / refresh/one
  const local = (state.trunkItems || []).find((x) => Number(x.tg) === Number(tg));
  if (local && Array.isArray(local.channels)) {
    paintDetailFromItem(local);
    return;
  }
  // Server trunk_data cache (still no extra OSSI if channels present)
  try {
    await loadDetail(tg, { force: false });
  } catch (e) {
    $("detail-tbody").innerHTML = `<tr class="empty"><td colspan="5">${escapeHtml(
      String(e.message || e)
    )}</td></tr>`;
  }
}

/**
 * @param {number} tg
 * @param {{ force?: boolean }} [opts] force:true → one OSSI status trunk (Refresh 此 TG)
 */
async function loadDetail(tg, opts = {}) {
  const force = !!opts.force;
  if (force) {
    if (state.refreshing) {
      showProgress(`TG ${tg}`, "Queued status trunk — waiting for OSSI…");
      setProgress(12, `Waiting for OSSI… then status trunk ${tg}`);
    }
    enqueueJob({ kind: "status", tg: Number(tg), showModal: true });
    const localBusy = (state.trunkItems || []).find((x) => Number(x.tg) === Number(tg));
    if (localBusy) {
      paintDetailFromItem(localBusy);
      return localBusy;
    }
  }

  // Client cache
  const local = (state.trunkItems || []).find((x) => Number(x.tg) === Number(tg));
  if (!force && local && Array.isArray(local.channels)) {
    paintDetailFromItem(local);
    return local;
  }

  // Server cache (or live if no channels yet)
  const res = await api(`trunks/${tg}/detail`);
  const mon = state.monitored.find((m) => Number(m.tg) === Number(tg));
  const item = {
    tg,
    name: res.name,
    type: res.type,
    tac: res.tac,
    note: res.note || (mon && mon.note) || "",
    total: res.counts?.total,
    idle: res.counts?.idle,
    busy: res.counts?.busy,
    oos: res.counts?.oos,
    channels: res.channels || [],
    lastUpdate: res.lastUpdate,
    error: res.error,
  };
  // Merge channels into trunkItems for next open
  if (item.channels.length || res.fromCache) {
    const idx = state.trunkItems.findIndex((x) => Number(x.tg) === Number(tg));
    if (idx >= 0) {
      state.trunkItems[idx] = { ...state.trunkItems[idx], ...item };
    }
  }
  paintDetailFromItem(item, { counts: res.counts, channels: res.channels, error: res.error });
  return item;
}

function closeDetail() {
  state.detailTg = null;
  $("trunk-detail-view").hidden = true;
  $("trunk-list-view").hidden = false;
}

/**
 * Login OSSI pack: every tab's commands, cache to disk, live command on the bar.
 * Trunk failures stay on the row — they must not fail login.
 */
async function runLoginOssiCache() {
  state.refreshing = true;
  state.refreshingSince = Date.now();
  state.packPhase = "trunks";
  try {
    setOssiBusy(true);
  } catch {
    /* ignore */
  }
  setLoginStep(3, "active", "Preparing OSSI cache…");
  setLoginOssi("Preparing OSSI cache…", 24);

  try {
    try {
      await loadMonitoredSoft();
    } catch {
      /* ignore */
    }
    let list = tgListForRefresh();
    if (!list.length) {
      try {
        const st = await api("session/status");
        const m = st.monitored || st.Monitored || [];
        if (Array.isArray(m) && m.length) {
          list = m.map((x) => Number(x)).filter((tg) => tg >= 1);
          if (!state.monitored.length) {
            state.monitored = list.map((tg, i) => ({ tg, order: i, note: "" }));
          }
        }
      } catch {
        /* ignore */
      }
    }

    const n = list.length;
    const trunkLo = 24;
    const trunkHi = 72;
    for (let i = 0; i < n; i++) {
      const tg = list[i];
      const cmd = `status trunk ${tg}  (${i + 1}/${n})`;
      const pct = trunkLo + ((i + 1) / n) * (trunkHi - trunkLo);
      setLoginOssi(cmd, pct);
      const tr = document.querySelector(`tr.tg-row[data-tg="${tg}"]`);
      if (tr) tr.classList.add("row-updating");
      try {
        const { res, item } = await refreshOneTrunk(tg);
        if (item && item.tg != null) applyOneTrunkItem(item);
        else if (res?.data?.items || res?.data?.Items) {
          state.trunkItems = applyStickyTrunkErrors(res.data.items || res.data.Items);
          renderTrunkTable();
        }
      } catch {
        applyOneTrunkItem({
          tg,
          error: "UPDATE FAILED",
          statusColor: "red",
          lastUpdate: new Date().toISOString(),
        });
      } finally {
        const tr2 = document.querySelector(`tr.tg-row[data-tg="${tg}"]`);
        if (tr2) tr2.classList.remove("row-updating");
        if (i < n - 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    try {
      await loadTrunkData({ soft: true, flashChanges: false });
    } catch {
      /* cache paint optional */
    }

    state.packPhase = "alarms";
    setLoginOssi("display alarms", 80);
    try {
      await api("refresh/one", {
        method: "POST",
        body: JSON.stringify({ tg: 9996 }),
      });
    } catch (e) {
      console.warn("login display alarms:", e?.message || e);
      setLoginOssi(`display alarms (failed — will retry on Auto ${REFRESH_INTERVAL_SEC}s)`, 80);
    }

    state.packPhase = "gateways";
    setLoginOssi("list media-gateway", 92);
    try {
      await api("refresh/one", {
        method: "POST",
        body: JSON.stringify({ tg: 9995 }),
      });
    } catch (e) {
      console.warn("login list media-gateway:", e?.message || e);
      setLoginOssi(`list media-gateway (failed — will retry on Auto ${REFRESH_INTERVAL_SEC}s)`, 92);
    }

    state.packPhase = "extensions";
    setLoginOssi("list extension + list station + list uniform-dialplan", 94);
    try {
      setExtensionSessionConnected(true);
    } catch {
      /* ignore */
    }
    try {
      await runExtensionRefresh({ showModal: false });
      armExtensionNext(EXTENSION_INTERVAL_MS);
    } catch (e) {
      console.warn("login list extension:", e?.message || e);
      setLoginOssi("list extension (failed — queued)", 94);
      enqueueExtensionRefresh({ showModal: false, reason: "login-retry" });
    }
    pumpQueue();
  } finally {
    state.refreshing = false;
    state.refreshingSince = 0;
    state.packPhase = "";
    try {
      paintOssiBusyFromPack();
    } catch {
      /* ignore */
    }
  }
}

function forceSessionDropped(reason) {
  if (!state.connected && !state.connecting) {
    applyUiMode();
    return;
  }
  state.connected = false;
  state.connecting = false;
  state.backendRefreshing = false;
  state._haveServerSchedule = false;
  clearUiLoggedIn();
  stopHeartbeat();
  stopLivePoll();
  stopExtensionHourlyTimer();
  setAlarmSessionConnected(false);
  setGatewaySessionConnected(false);
  setExtensionSessionConnected(false);
  setMapSessionConnected(false);
  setSessionLabel("Disconnected", false);
  if (reason) setStatus(reason);
  applyUiMode();
}

async function connect() {
  if (state.connecting) return;
  setError("");
  setStatus("Login…");
  setSessionLabel("Connecting…", false);
  state.connecting = true;
  const btn = $("btn-connect");
  if (btn) btn.disabled = true;
  try {
    showLoginModal();
  } catch (e) {
    console.warn("showLoginModal:", e);
  }
  try {
    const body = {
      host: $("inp-host").value.trim(),
      port: Number($("inp-port").value) || 5022,
      username: $("inp-user").value.trim(),
      password: $("inp-pass").value,
    };
    if (!body.host || !body.username || !body.password) {
      throw new Error("Host, User, and Password are required");
    }

    // 1) Bridge warm-up / auto-start (site-local Python)
    setLoginStep(1, "active", "Starting local OSSI bridge…");
    try {
      const h = await api("health?ensure=1");
      if (h && h.bridgeHealthy) {
        setLoginStep(1, "done", "OSSI bridge is ready");
      } else {
        // connect will try ensure again
        setLoginStep(1, "done", "Bridge warm-up skipped — will retry on connect");
      }
    } catch (e) {
      setLoginStep(1, "done", "Bridge check failed — will retry on connect");
    }

    // 2) SSH + OSSI login (display time + list trunk-group inside this call)
    setLoginStep(
      2,
      "active",
      `SSH ${body.host}:${body.port} · display time · list trunk-group`
    );
    setLoginOssi(`SSH ${body.host}:${body.port} · display time · list trunk-group`, 16);
    const res = await api("session/connect", { method: "POST", body: JSON.stringify(body) });
    setLoginStep(2, "done", "OSSI session open · display time · list trunk-group");

    state.connected = true;
    state.disconnecting = false;
    markUiLoggedIn();
    $("meta-host").textContent = res.host || body.host;
    setSessionLabel("Monitoring (OSSI)", true);
    applyUiMode();
    // System Time from connect's display time → anchor for 1s local tick
    if (_cmTimeText(res.cmTime) || _cmTimeText(res)) {
      setCmTimeAnchor(res.cmTime || res);
    }

    try {
      await loadMonitoredSoft();
    } catch {
      /* ignore */
    }
    if (res.trunkData) {
      const td = res.trunkData;
      state.trunkItems = td.items || td.Items || [];
      renderTrunkMeta(td);
      renderTrunkTable();
    } else {
      try {
        await loadTrunkData({ soft: true });
      } catch {
        /* ignore */
      }
    }

    // 3) Every tab's OSSI → cache (live command on the bar)
    await runLoginOssiCache();

    setAlarmSessionConnected(true);
    setGatewaySessionConnected(true);
    setExtensionSessionConnected(true);
    setMapSessionConnected(true);
    setLoginStep(3, "done", "Cached status trunk · alarms · gateways · extensions");
    setLoginOssi("Cached · all tabs ready", 100);
    setError("");
    setStatus("Logged in. Trunk / Alarm / Gateway / Extension ready.");
    state.packPhase = "";
    state.backendRefreshing = false;
    onSessionLive();
    armNextRefresh(REFRESH_INTERVAL_SEC);
    startExtensionHourlyTimer();
    hideLoginModal(700);
    refreshCmTime({ soft: true, force: false }).catch(() => {});
  } catch (e) {
    // Real login failure only (SSH / password / bridge)
    state.connected = false;
    clearUiLoggedIn();
    const msg = String(e.message || e);
    setError(msg);
    setSessionLabel("Disconnected", false);
    setStatus("");
    try {
      failLoginModal(msg);
    } catch {
      /* modal optional */
    }
  } finally {
    state.connecting = false;
    applyUiMode();
  }
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  const beat = () => {
    if (!state.connected) return;
    // Keepalive only — never ask the bridge to run display time on this path.
    api("session/heartbeat", {
      method: "POST",
      body: JSON.stringify(heartbeatPayload()),
    })
      .then((r) => {
        if (!state.connected) return;
        // CmApi soft-fail (8s timeout) — OSSI may still be up; do not reset or drop.
        if (r && r.soft) return;
        if (r && r.connected === false) {
          state._hbGone = (state._hbGone || 0) + 1;
          if (state._hbGone >= 2) {
            forceSessionDropped("OSSI session ended — please Login again.");
          }
          return;
        }
        state._hbFails = 0;
        state._hbGone = 0;
        applyServerSchedule(r);
      })
      .catch(() => {
        if (!state.connected) return;
        state._hbFails = (state._hbFails || 0) + 1;
        // 4 × 15s ≈ 1 min of real network failure; skip while a pack is in flight.
        if (state._hbFails >= 4 && !state.refreshing) {
          forceSessionDropped("OSSI unreachable — please Login again.");
        }
      });
  };
  state._heartbeatBeat = beat;
  state.heartbeatTimer = setInterval(beat, 15_000);
  beat();
}

function stopLivePoll() {
  if (state.livePollTimer) {
    clearInterval(state.livePollTimer);
    state.livePollTimer = null;
  }
}

/**
 * Poll trunk_data every 2s while logged in (all tabs).
 * Picks up backend refreshing + secondsUntilRefresh + progressive trunk writes.
 * Skip while this tab owns a login/manual pack. Flash only on Trunk tab.
 */
function startLivePoll() {
  stopLivePoll();
  state.livePollTimer = setInterval(() => {
    if (!state.connected || state.disconnecting) return;
    if (state.refreshing) return;
    loadTrunkData({
      soft: true,
      flashChanges: state.activeTab === "trunk",
    });
  }, 2000);
  loadTrunkData({ soft: true, flashChanges: false });
}

/** Ensure live poll + countdown are running after Login / resume. */
function onSessionLive() {
  startHeartbeat();
  startLivePoll();
  startCountdownClock();
  startCmTimeWatch();
  if (
    !state._haveServerSchedule &&
    (!state.nextRefreshAt || state.nextRefreshAt < Date.now())
  ) {
    armNextRefresh(REFRESH_INTERVAL_SEC);
  }
  paintCountdown();
}

function stopCmTimeWatch() {
  if (state.cmTimeTimer) {
    clearInterval(state.cmTimeTimer);
    state.cmTimeTimer = null;
  }
  if (state.cmTimeTickTimer) {
    clearInterval(state.cmTimeTickTimer);
    state.cmTimeTickTimer = null;
  }
}

/**
 * System Time: OSSI sync ~60s, then local 1s tick so the clock runs live.
 * Display = CM_anchor + (now − local_anchor). Re-sync corrects drift.
 */
function startCmTimeWatch() {
  stopCmTimeWatch();
  setTimeout(() => refreshCmTime({ soft: true, force: true }), 400);
  state.cmTimeTimer = setInterval(() => {
    if (!state.connected) return;
    if (state.refreshing) return;
    refreshCmTime({ soft: true, force: true });
  }, 60_000);
  state.cmTimeTickTimer = setInterval(() => {
    if (!state.connected) return;
    paintCmTimeTick();
  }, 1000);
  paintCmTimeTick();
}

function _cmTimeText(info) {
  if (!info) return "";
  const t = (info.systemTime || info.time || info.SystemTime || info.Time || "").trim();
  if (!t || t === "—" || t === "-" || t === "null" || t === "undefined") return "";
  return t;
}

/** Parse CM systemTime "MM/DD/YYYY HH:mm:ss" (and close variants) → Date */
function parseCmSystemTime(text) {
  const s = String(text || "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], 0);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatCmSystemTime(d) {
  if (!d || Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

/** Anchor CM wall clock for local 1s advancement. */
function setCmTimeAnchor(info) {
  const text = _cmTimeText(info);
  if (!text) return false;
  const d = parseCmSystemTime(text);
  if (!d || Number.isNaN(d.getTime())) return false;
  state.cmTimeAnchorMs = d.getTime();
  state.cmTimeLocalAnchor = Date.now();
  state.lastCmTimeAt = Date.now();
  paintCmTimeTick();
  const el = $("meta-cm-time");
  if (el) {
    el.title = "CM System Time (synced ~60s, ticks locally each second)";
  }
  return true;
}

function clearCmTimeAnchor() {
  state.cmTimeAnchorMs = null;
  state.cmTimeLocalAnchor = null;
  state.lastCmTimeAt = 0;
  const el = $("meta-cm-time");
  if (el) {
    el.textContent = "—";
    el.title = "";
  }
}

/** Paint live CM time = anchor + local elapsed. */
function paintCmTimeTick() {
  const el = $("meta-cm-time");
  if (!el) return;
  if (state.cmTimeAnchorMs == null || state.cmTimeLocalAnchor == null) {
    if (!state.connected) el.textContent = "—";
    return;
  }
  const elapsed = Date.now() - state.cmTimeLocalAnchor;
  const shown = new Date(state.cmTimeAnchorMs + elapsed);
  el.textContent = formatCmSystemTime(shown);
}

async function refreshCmTime(opts = {}) {
  if (!state.connected) return null;
  try {
    let info = null;
    // Dedicated display time (not heartbeat) — heartbeat must stay non-blocking.
    if (!state.refreshing) {
      try {
        const ct = await api("cm-time?force=1");
        if (_cmTimeText(ct)) info = ct;
      } catch {
        /* OSSI busy / no route */
      }
    }
    if (!_cmTimeText(info)) {
      try {
        const hb = await api("session/heartbeat", {
          method: "POST",
          body: JSON.stringify(heartbeatPayload()),
        });
        if (_cmTimeText(hb?.cmTime) || _cmTimeText(hb)) info = hb.cmTime || hb;
      } catch {
        /* ignore */
      }
    }
    if (!_cmTimeText(info)) {
      try {
        const st = await api("session/status");
        info = st.cmTime || { ok: !!st.connected, systemTime: st.systemTime, time: st.time };
      } catch {
        /* ignore */
      }
    }
    if (_cmTimeText(info)) {
      setCmTimeAnchor(info);
      return info;
    }
    return info;
  } catch (e) {
    if (!opts.soft) console.warn("cm-time:", e.message || e);
    return null;
  }
}

async function disconnect() {
  state.disconnecting = true;
  state.refreshing = false;
  stopHeartbeat();
  stopLivePoll();
  stopCmTimeWatch();
  showLoginModal("Logging out");
  const s1 = document.querySelector('#login-progress-steps li[data-step="1"]');
  const s2 = document.querySelector('#login-progress-steps li[data-step="2"]');
  const s3 = document.querySelector('#login-progress-steps li[data-step="3"]');
  if (s1) s1.textContent = "Stop auto refresh";
  if (s2) s2.textContent = "OSSI logoff";
  if (s3) s3.textContent = "Done";
  setLoginStep(1, "active", "Stopping timers…");
  setLoginPct(20, "Stopping timers…");
  try {
    setLoginStep(2, "active", "Closing OSSI session…");
    setLoginPct(55, "session/disconnect…");
    await api("session/disconnect", { method: "POST", body: "{}" });
    setLoginStep(2, "done", "OSSI logged off");
    setLoginPct(85, "OSSI logged off");
  } catch {
    setLoginStep(2, "done", "Disconnect (session already closed)");
    setLoginPct(85, "Session already closed");
  }
  state.connected = false;
  state.disconnecting = false;
  state.tgStickyError = {};
  clearUiLoggedIn();
  setSessionLabel("Disconnected", false);
  setStatus("Logged out — OSSI session closed. Login again to monitor.");
  clearCmTimeAnchor();
  setAlarmSessionConnected(false);
  setGatewaySessionConnected(false);
  setExtensionSessionConnected(false);
  setMapSessionConnected(false);
  stopExtensionHourlyTimer();
  clearAuto();
  closeDetail();
  applyUiMode();
  setLoginStep(3, "done", "Logged out");
  setLoginPct(100, "Logged out");
  hideLoginModal(600);
  // restore login step labels for next Login
  setTimeout(() => {
    if (s1) s1.textContent = "Start OSSI bridge";
    if (s2) s2.textContent = "Connect to CM (SSH + OSSI login)";
    if (s3) s3.textContent = "OSSI cache (all tabs)";
  }, 700);
}

/** Solid green Updated flash for full 2s; survives sibling row patches. */
function flashUpdatedTg(tg) {
  const key = String(tg);
  const prev = state.flashTimers[key];
  if (prev?.timer) clearTimeout(prev.timer);
  const cell = document.querySelector(`td.col-updated[data-updated-tg="${tg}"]`);
  if (!cell) return;
  cell.classList.remove("flash-fade");
  cell.classList.add("updated-flash");
  const until = Date.now() + 2000;
  // Hold solid 2s, then short fade, then clear
  const tHold = setTimeout(() => {
    const c = document.querySelector(`td.col-updated[data-updated-tg="${tg}"]`);
    if (c) c.classList.add("flash-fade");
    const tClear = setTimeout(() => {
      const c2 = document.querySelector(`td.col-updated[data-updated-tg="${tg}"]`);
      if (c2) c2.classList.remove("updated-flash", "flash-fade");
      delete state.flashTimers[key];
    }, 400);
    state.flashTimers[key] = { until: Date.now() + 400, timer: tClear };
  }, 2000);
  state.flashTimers[key] = { until, timer: tHold };
}

/** TG list for OSSI poll: monitored first, else trunk_data rows. */
function tgListForRefresh() {
  if (state.monitored.length) return state.monitored.map((m) => Number(m.tg));
  return (state.trunkItems || [])
    .map((it) => Number(it.tg))
    .filter((tg) => tg >= 1);
}

async function addTg() {
  const tg = Number($("inp-tg").value);
  const note = ($("inp-tg-note").value || "").trim();
  if (!tg || tg < 1) {
    showProgress("Add trunk", "Enter a valid TG number.");
    finishProgress(false, "Enter a valid TG number.");
    const btn = $("btn-progress-close");
    if (btn) btn.hidden = false;
    return;
  }
  setError("");
  if (state.monitored.some((m) => Number(m.tg) === tg)) {
    if (note) rememberNote(tg, note);
    $("inp-tg").value = "";
    $("inp-tg-note").value = "";
    renderTrunkTable();
    showProgress("Add trunk", `TG ${tg} already in list`);
    finishProgress(true, `TG ${tg} already in list`);
    return;
  }
  state.monitored = state.monitored.concat([{ tg, order: state.monitored.length, note }]);
  if (note) rememberNote(tg, note);
  $("inp-tg").value = "";
  $("inp-tg-note").value = "";
  renderTrunkTable();
  if (state.refreshing) {
    showProgress("Add trunk", `Queued TG ${tg} — waiting for OSSI…`);
    setProgress(15, `status trunk ${tg} queued`);
  } else {
    showProgress("Add trunk", `Adding TG ${tg}…`);
    setProgress(15, `Saving TG ${tg}…`);
  }
  enqueueJob({ kind: "add", tg, note });
}

function enqueueRemoveTg(tg) {
  const n = Number(tg);
  if (!n) return;
  if (cmdQueue.some((j) => j.kind === "remove" && Number(j.tg) === n)) {
    pumpQueue();
    return;
  }
  if (state.refreshing) {
    showProgress("Remove trunk", `Queued TG ${n} — waiting for OSSI…`);
    setProgress(12, `Waiting for OSSI… then remove TG ${n}`);
  } else {
    showProgress("Remove trunk", `Removing TG ${n}…`);
    setProgress(20, `Removing TG ${n}…`);
  }
  enqueueJob({ kind: "remove", tg: n });
}

async function removeTg(tg) {
  enqueueRemoveTg(tg);
}

function clearAuto() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.nextRefreshAt = 0;
  state.backendRefreshing = false;
  state._haveServerSchedule = false;
  paintCountdown();
}

function scheduleAuto() {
  // Countdown-driven progressive refresh (see startCountdownClock)
  if (!autoEnabled()) {
    clearAuto();
    return;
  }
  startCountdownClock();
  if (!state.nextRefreshAt) armNextRefresh(REFRESH_INTERVAL_SEC);
  paintCountdown();
}

function bindTabs() {
  document.querySelectorAll(".tab:not(.disabled)").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      state.activeTab = name;
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === btn);
        t.setAttribute("aria-selected", t === btn ? "true" : "false");
      });
      document.querySelectorAll("[data-panel]").forEach((p) => {
        p.classList.toggle("hidden", p.dataset.panel !== name);
      });
      // Only the open tab starts / owns AUTO 60s
      try {
        if (state.connected) {
          api("session/heartbeat", {
            method: "POST",
            body: JSON.stringify(heartbeatPayload()),
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      if (name === "cdr") {
        // CDR: no OSSI Auto 60s
        try {
          onCdrTabShow();
        } catch {
          /* ignore */
        }
        setAlarmTabActive(false);
        setGatewayTabActive(false);
        setExtensionTabActive(false);
        setMapTabActive(false);
        paintCountdown();
      } else if (name === "alarm") {
        try {
          onAlarmTabShow();
        } catch {
          /* ignore */
        }
        setGatewayTabActive(false);
        setExtensionTabActive(false);
        setMapTabActive(false);
        paintCountdown();
      } else if (name === "gateway") {
        try {
          onGatewayTabShow();
        } catch {
          /* ignore */
        }
        setAlarmTabActive(false);
        setExtensionTabActive(false);
        setMapTabActive(false);
        healAutoCountdown();
        paintCountdown();
      } else if (name === "map") {
        try {
          onMapTabShow();
        } catch {
          /* ignore */
        }
        setAlarmTabActive(false);
        setGatewayTabActive(false);
        setExtensionTabActive(false);
        healAutoCountdown();
        paintCountdown();
      } else if (name === "extension") {
        try {
          onExtensionTabShow();
        } catch {
          /* ignore */
        }
        setAlarmTabActive(false);
        setGatewayTabActive(false);
        setMapTabActive(false);
        paintCountdown();
      } else if (name === "trunk") {
        // Show last cache only — no popup / no extra OSSI. Auto 60s will refresh.
        setAlarmTabActive(false);
        setGatewayTabActive(false);
        setExtensionTabActive(false);
        setMapTabActive(false);
        applyUiMode();
        loadTrunkData({ soft: true, flashChanges: false }).catch(() => {});
        paintCountdown();
      } else {
        setAlarmTabActive(false);
        setGatewayTabActive(false);
        setExtensionTabActive(false);
        setMapTabActive(false);
        paintCountdown();
      }
    });
  });
}

function initThemeToggle() {
  const btn = $("btn-theme");
  const root = document.documentElement;
  const apply = (theme) => {
    const t = theme === "light" ? "light" : "dark";
    root.setAttribute("data-theme", t);
    if (btn) btn.textContent = t === "light" ? "☾" : "☀";
    if (btn) btn.title = t === "light" ? "Switch to dark theme" : "Switch to light theme";
    try {
      localStorage.setItem("cm_noc_theme", t);
    } catch {
      /* ignore */
    }
  };
  apply(root.getAttribute("data-theme") || "dark");
  btn?.addEventListener("click", () => {
    const cur = root.getAttribute("data-theme") === "light" ? "light" : "dark";
    apply(cur === "light" ? "dark" : "light");
  });
}

async function init() {
  window.__cmConnect = connect;
  window.__cmDisconnect = disconnect;
  // Login click is bound once in index.html (waits for this module). Do not bind again.
  $("btn-disconnect")?.addEventListener("click", disconnect);

  try {
    initThemeToggle();
  } catch (e) {
    console.warn("theme:", e);
  }
  try {
    bindTabs();
  } catch (e) {
    console.warn("tabs:", e);
  }
  tickClock();
  setInterval(tickClock, 1000);
  try {
    initCdrUi();
  } catch (e) {
    console.warn("CDR UI init:", e);
  }
  try {
    initAlarmUi();
  } catch (e) {
    console.warn("Alarm UI init:", e);
  }
  try {
    initGatewayUi();
  } catch (e) {
    console.warn("Gateway UI init:", e);
  }
  try {
    initExtensionUi();
  } catch (e) {
    console.warn("Extension UI init:", e);
  }
  try {
    initMapUi();
  } catch (e) {
    console.warn("MAP VIEW init:", e);
  }
  // Manual Refresh on Extension tab → enqueue (yields to 60s pack)
  window.__cmEnqueueExtension = (opts) => enqueueExtensionRefresh(opts || {});
  window.__cmEnqueueGwConfig = (mg, opts) => enqueueGwConfig(mg, opts || {});
  window.__cmEnqueueExtDetail = (ext, opts) => enqueueExtDetail(ext, opts || {});
  window.__cmOpenGatewayTab = (mg) => openGatewayTab(mg);

  const modalClose = $("btn-login-modal-close");
  if (modalClose) {
    modalClose.addEventListener("click", () => hideLoginModal());
  }
  $("btn-add-tg")?.addEventListener("click", addTg);
  $("btn-detail-back")?.addEventListener("click", closeDetail);
  $("inp-tg")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTg();
  });
  $("inp-tg-note")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTg();
  });
  const progClose = $("btn-progress-close");
  if (progClose) progClose.addEventListener("click", () => hideProgress());

  // Do NOT sendBeacon session/disconnect on pagehide/beforeunload.
  // F5 and close-tab both fire those events — disconnect made F5 require Login.
  // Close-tab: 5 min UI watchdog logs off OSSI after heartbeat stops.

  // Browser tab focus: stamp heartbeat immediately. Auto pack is backend — cache + countdown only.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (state.connected && typeof state._heartbeatBeat === "function") {
      try {
        state._heartbeatBeat();
      } catch {
        /* ignore */
      }
    }
  });

  startCountdownClock();
  applyUiMode();

  // Soft init: NEVER auto-login. Only resume if this browser tab had clicked Login
  // (sessionStorage) AND bridge still has OSSI — e.g. F5. Fresh open / reboot → must Login.
  try {
    try {
      const st = await api("session/status");
      const allowResume = !!st.connected;

      if (allowResume) {
        // F5 / same API session still logged in → restore UI (do not drop OSSI)
        markUiLoggedIn();
        state.connected = true;
        $("meta-host").textContent = st.host || "—";
        setSessionLabel("Monitoring (OSSI)", true);
        applyUiMode();
        applyServerSchedule(st);
        await loadMonitoredSoft();
        try {
          await loadTrunkData({ soft: true });
        } catch {
          /* cache miss OK */
        }
        onSessionLive();
        setAlarmSessionConnected(true);
        setGatewaySessionConnected(true);
        setExtensionSessionConnected(true);
        setMapSessionConnected(true);
        startExtensionHourlyTimer();
        // F5: cache + countdown from API only — no browser Auto pack
        try {
          const cached = await api("extensions").catch(() => null);
          const n = Array.isArray(cached?.items) ? cached.items.length : 0;
          if (n === 0) {
            enqueueExtensionRefresh({ showModal: false, reason: "resume-empty" });
          }
        } catch {
          enqueueExtensionRefresh({ showModal: false, reason: "resume-empty" });
        }
      } else {
        clearUiLoggedIn();
        state.connected = false;
        setSessionLabel("Disconnected", false);
        applyUiMode();
        await loadMonitoredSoft();
        try {
          await loadTrunkData({ soft: true });
        } catch {
          /* cache miss OK */
        }
      }
    } catch {
      clearUiLoggedIn();
      state.connected = false;
      setSessionLabel("Disconnected", false);
      applyUiMode();
      await loadMonitoredSoft();
      try {
        await loadTrunkData({ soft: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* offline bridge */
  }

  if (!state.connected) {
    try {
      const h = await api("health");
      if (h && h.bridgeHealthy) {
        setStatus("");
      } else {
        setStatus("API is up. Click Login to start the OSSI bridge and connect to CM.");
      }
    } catch {
      setStatus("API not ready — check IIS /CM/api. Login when it is up.");
    }
  }
}

window.__cmConnect = connect;
window.__cmDisconnect = disconnect;
init().catch((e) => {
  const msg = String((e && e.message) || e || "init failed");
  console.error("UI init:", e);
  const el = document.getElementById("error-line");
  if (el) {
    el.hidden = false;
    el.textContent = "UI init failed: " + msg;
  }
});
