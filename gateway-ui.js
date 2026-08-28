/**
 * Media Gateway status — OSSI list media-gateway + Active alarm counts by MG Port.
 * First open / manual Refresh → progress popup %.
 * Session Auto 60s (Trunk checkbox) packs Trunk + Alarm + Gateway.
 */

import { apiUrl, siteUrl, fetchJson, escapeHtml, fmtUpdated } from "./http.js?v=20260827b";
import { showProgress, setProgress, finishProgress } from "./cdr-ui.js?v=20260827b";

/** Magic TG for refresh/one when CmApi has no /gateways route. */
const TG_GATEWAY = 9995;
/** refresh/one tg = 990000 + MG → list configuration media-gateway N */
const TG_GW_CONFIG_BASE = 990000;

const GW = {
  data: { items: [], summary: {} },
  query: "",
  nextAt: 0,
  countdownTimer: null,
  tabActive: false,
  connected: false,
  loading: false,
  ossiBusy: false,
  pendingSilent: false,
  detailMg: null,
  configByMg: {},
  alarmByPort: {},
  configLoadingMg: 0,
  detailQuery: "",
};

function paintGwUpdated() {
  const ts = fmtUpdated(GW.data.lastUpdate);
  const card = document.getElementById("gw-stat-updated");
  if (card) card.textContent = ts;
  const el = document.getElementById("gw-meta-updated");
  if (el) el.textContent = ts;
}

function normPortKey(port) {
  const s = String(port || "")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");
  const m = s.match(/^0*(\d+)V(\d+)$/i);
  if (!m) return s;
  const gw = m[1];
  const rest = m[2];
  if (rest.length <= 2) return `${String(Number(gw)).padStart(3, "0")}V${Number(rest)}`;
  const slot = rest.slice(0, -2);
  const circ = rest.slice(-2);
  return `${String(Number(gw)).padStart(3, "0")}V${Number(slot)}${String(Number(circ)).padStart(2, "0")}`;
}

async function refreshAlarmPortMap() {
  try {
    const data = await fetchJson(apiUrl("alarms"));
    const items = (data && (data.active || data.items)) || [];
    const map = {};
    for (const a of items) {
      const key = normPortKey(a.port);
      if (!key) continue;
      const sev = String(a.severity || "").toUpperCase();
      const rank = sev.startsWith("MAJ") ? 3 : sev.startsWith("MIN") ? 2 : 1;
      const label = rank === 3 ? "MAJOR" : rank === 2 ? "MINOR" : "WARNING";
      if (!map[key] || rank > map[key].rank) map[key] = { rank, label };
    }
    GW.alarmByPort = map;
  } catch {
    /* keep last map */
  }
}

function chipAlarm(p, board) {
  if (Number(p.mj) > 0) return { cls: "alarm-major", label: "MAJOR" };
  if (Number(p.mn) > 0) return { cls: "alarm-minor", label: "MINOR" };
  if (Number(p.wn) > 0) return { cls: "alarm-warn", label: "WARNING" };
  const hit = GW.alarmByPort && GW.alarmByPort[normPortKey(p.port)];
  if (hit) {
    if (hit.rank === 3) return { cls: "alarm-major", label: hit.label };
    if (hit.rank === 2) return { cls: "alarm-minor", label: hit.label };
    return { cls: "alarm-warn", label: hit.label };
  }
  const bkey = board ? normPortKey(board.board) : "";
  const boardHit = bkey && GW.alarmByPort && GW.alarmByPort[bkey];
  if (boardHit && boardHit.rank === 3) {
    return { cls: "alarm-major", label: "MAJOR" };
  }
  return { cls: "", label: "" };
}

function filteredGwRows() {
  const q = (GW.query || "").trim().toLowerCase();
  const items = GW.data.items || [];
  if (!q) return items;
  return items.filter((r) => {
    const host = String(r.hostname || "").toLowerCase();
    const ip = String(r.ip || "").toLowerCase();
    return host.includes(q) || ip.includes(q);
  });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function paintGwSummary() {
  const items = GW.data.items || [];
  const total = items.length;
  const failed = items.filter((r) => r.error).length;
  const online = items.filter(
    (r) => !r.error && String(r.node || "").toUpperCase() === "UP"
  ).length;
  const down = items.filter(
    (r) => !r.error && String(r.node || "").toUpperCase() !== "UP"
  ).length;
  const s = GW.data.summary || {};
  setText("gw-stat-online", `${online} / ${total}`);
  setText("gw-stat-down", String(down));
  setText("gw-stat-mj", String(s.mj ?? 0));
  setText("gw-stat-mn", String(s.mn ?? 0));
  setText("gw-stat-wn", String(s.wn ?? 0));
  const onlineCard = document.getElementById("gw-stat-online-card");
  if (onlineCard) {
    onlineCard.classList.remove("accent-red", "accent-green");
    if (total > 0 && down === 0 && failed === 0) onlineCard.classList.add("accent-green");
    else if (down > 0 || failed > 0) onlineCard.classList.add("accent-red");
  }
}

function rowClass(r) {
  if (r.error) return "sev-fail";
  if (String(r.node || "").toUpperCase() === "DOWN") return "sev-major";
  if (Number(r.mj) > 0) return "sev-major";
  if (Number(r.mn) > 0) return "sev-minor";
  if (Number(r.wn) > 0) return "sev-warn";
  return "";
}

function alarmCell(n, kind) {
  const v = Number(n) || 0;
  const hot = v > 0 ? ` gw-alarm-${kind}` : "";
  return `<td class="mono gw-alarm${hot}">${v}</td>`;
}

function renderGwTable() {
  const tbody = document.getElementById("gw-tbody");
  if (!tbody) return;
  if (GW.loading && !(GW.data.items || []).length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="7">Updating… (waiting for OSSI — Trunk update may be running)</td></tr>`;
    return;
  }
  const rows = filteredGwRows();
  if (!rows.length) {
    const q = (GW.query || "").trim();
    const msg = !GW.connected
      ? "Login required for live OSSI media gateways."
      : q
        ? `No hostname / IP contains “${q}”.`
        : "No media gateways.";
    tbody.innerHTML = `<tr class="empty"><td colspan="7">${escapeHtml(msg)}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const failed = !!r.error;
      const node = failed
        ? "UPDATE FAILED"
        : String(r.node || "").toUpperCase() === "DOWN"
          ? "DOWN"
          : "UP";
      const nodeCls = failed ? "node-fail" : node === "UP" ? "node-up" : "node-down";
      const host = r.hostname || "—";
      return `<tr class="${rowClass(r)}" data-mg="${escapeHtml(String(r.mg ?? ""))}">
        <td class="mono">${escapeHtml(String(r.mg ?? "—"))}</td>
        <td><button type="button" class="gw-host-btn" data-mg="${escapeHtml(String(r.mg ?? ""))}" title="Open gateway details">${escapeHtml(host)}</button></td>
        <td><span class="badge-node ${nodeCls}">${node}</span></td>
        <td class="mono">${escapeHtml(r.ip || "—")}</td>
        ${alarmCell(r.mj, "mj")}
        ${alarmCell(r.mn, "mn")}
        ${alarmCell(r.wn, "wn")}
      </tr>`;
    })
    .join("");
}

export function getOpenGatewayDetailMg() {
  if (!GW.tabActive || !GW.detailMg) return null;
  const pane = document.getElementById("gw-detail-view");
  if (pane && pane.hidden) return null;
  return GW.detailMg;
}

/** Port-joined MJ/MN on live GWs (not UPDATE FAILED, not DOWN-only). */
export function getGatewayMjMn() {
  let mj = 0;
  let mn = 0;
  for (const r of GW.data.items || []) {
    if (r.error) continue;
    mj += Number(r.mj || 0);
    mn += Number(r.mn || 0);
  }
  return { mj, mn };
}

function applyGwPayload(data) {
  if (!data || typeof data !== "object") return false;
  let d = data;
  if (d.gateways && typeof d.gateways === "object" && (d.gateways.items || d.gateways.summary)) {
    d = d.gateways;
  }
  if (d.data && typeof d.data === "object" && d.data.gateways) {
    d = d.data.gateways;
  }
  if (!Array.isArray(d.items) && !d.summary) return false;
  let incoming = Array.isArray(d.items) ? d.items : [];
  const prev = GW.data.items || [];
  if (prev.length > 0 && incoming.length === 0) {
    return false;
  }
  if (prev.length > incoming.length && incoming.length > 0) {
    const seen = new Set(incoming.map((g) => Number(g.mg)));
    const extra = prev
      .filter((g) => !seen.has(Number(g.mg)))
      .map((g) => ({ ...g, error: "UPDATE FAILED" }));
    incoming = incoming.concat(extra);
  }
  GW.data = {
    ok: d.ok !== false,
    items: incoming,
    summary: d.summary || {},
    lastUpdate: d.lastUpdate || GW.data.lastUpdate,
    connected: d.connected,
  };
  paintGwSummary();
  renderGwTable();
  paintGwUpdated();
  try {
    if (typeof window.__cmApplyAlarmFlash === "function") window.__cmApplyAlarmFlash();
  } catch {
    /* alarm ui optional */
  }
  return true;
}

async function forceOssiGateways() {
  const res = await fetchJson(apiUrl("refresh/one"), {
    method: "POST",
    body: JSON.stringify({ tg: TG_GATEWAY }),
  });
  const payload = res && (res.gateways || (res.gatewayRefresh ? res : null));
  if (payload) {
    applyGwPayload(payload);
    return true;
  }
  throw new Error((res && (res.error || res.Error)) || "refresh/one returned no gateway payload");
}

async function loadGateways(opts = {}) {
  const force = !!opts.force;
  const showModal = !!opts.showModal;
  GW.loading = true;
  if (force) renderGwTable();

  let ok = false;
  try {
    if (force && GW.connected) {
      if (showModal) {
        showProgress("Loading Media Gateways", "OSSI list media-gateway…");
        setProgress(20, "list media-gateway…");
        try {
          await forceOssiGateways();
          ok = true;
        } catch (e) {
          console.warn("gateway list:", e?.message || e);
        }
        setProgress(100, ok ? "Complete" : "Failed");
        finishProgress(
          ok,
          ok ? "Refresh complete" : document.getElementById("gw-auto-status")?.textContent || "Gateway update incomplete"
        );
      } else {
        try {
          await forceOssiGateways();
          ok = true;
        } catch (e) {
          console.warn("gateway auto:", e?.message || e);
        }
      }
    }

    if (!ok || !force) {
      let data = null;
      try {
        data = await fetchJson(apiUrl("gateways"));
      } catch {
        /* 404 old DLL */
      }
      if (!data || !Array.isArray(data.items)) {
        try {
          const td = await fetchJson(apiUrl("trunk-data"));
          const inner = td.data || td;
          if (inner && inner.gateways) data = inner.gateways;
        } catch {
          /* ignore */
        }
      }
      if (!data || !Array.isArray(data.items)) {
        try {
          data = await fetchJson(siteUrl("gateways_cache.json") + "?t=" + Date.now());
        } catch {
          data = null;
        }
      }
      if (data) {
        applyGwPayload(data);
        ok = true;
      }
    }
  } finally {
    GW.loading = false;
    paintGwUpdated();
  }
  return GW.data;
}

export function setGatewaySessionConnected(connected) {
  GW.connected = !!connected;
  if (GW.connected) {
    loadGateways({ force: false, showModal: false }).catch(() => {});
  }
}

export function setGatewayTabActive(active) {
  GW.tabActive = !!active;
}

export function setOssiBusy(busy) {
  GW.ossiBusy = !!busy;
  if (!busy && GW.pendingSilent && GW.connected && !GW.loading) {
    GW.pendingSilent = false;
    refreshGatewaysSilent().catch(() => {});
  }
}

export function onGatewayTabShow() {
  GW.tabActive = true;
  // Cache only — Auto 90s / login pack refreshes list media-gateway
  loadGateways({ force: false, showModal: false }).catch(() => {});
  renderGwTable();
}

/** Called after Trunk + Alarm cycle — silent list media-gateway. */
export async function refreshGatewaysSilent() {
  if (!GW.connected) return;
  if (GW.loading || GW.ossiBusy) {
    GW.pendingSilent = true;
    return;
  }
  GW.pendingSilent = false;
  try {
    await loadGateways({ force: true, showModal: false });
  } catch {
    /* next cycle */
  }
  if (GW.pendingSilent && !GW.loading) {
    GW.pendingSilent = false;
    try {
      await loadGateways({ force: true, showModal: false });
    } catch {
      /* ignore */
    }
  }
}

/** Trunk Auto countdown drives Gateway "Next" so all share one 90s. */
export function syncGatewayCountdown(nextAtMs) {
  const t = Number(nextAtMs);
  if (t) {
    const maxAt = Date.now() + 90 * 1000;
    GW.nextAt = Math.min(t, maxAt);
  }
}

function gwRowByMg(mg) {
  return (GW.data.items || []).find((x) => Number(x.mg) === Number(mg)) || null;
}

function nocBoardType(typ, code) {
  const t = `${typ || ""} ${code || ""}`.toUpperCase();
  if (/(DS1|TRUNK|BRI|MM710|MM714|MM718)/.test(t)) return "Trunk";
  if (/(ANA|ANALOG|MM716)/.test(t)) return "Analog";
  if (/(DCP|DIGITAL|MM717)/.test(t)) return "Digital";
  if (/(ICC|S8300|LSP)/.test(t)) return "LSP";
  if (/(ANN|VAL|ANNOUNCE)/.test(t)) return "Announcements";
  return String(typ || "—").trim() || "—";
}

function showGwList() {
  const list = document.getElementById("gw-list-view");
  const det = document.getElementById("gw-detail-view");
  const card = document.getElementById("gateway-card");
  if (list) list.hidden = false;
  if (det) det.hidden = true;
  if (card) card.classList.remove("gw-detail-open");
}

function showGwDetailPane() {
  const list = document.getElementById("gw-list-view");
  const det = document.getElementById("gw-detail-view");
  const card = document.getElementById("gateway-card");
  if (list) list.hidden = true;
  if (det) det.hidden = false;
  if (card) card.classList.add("gw-detail-open");
}

function paintGwDetailHeader(mg) {
  const row = gwRowByMg(mg) || {};
  setText("gw-detail-title", row.hostname || "—");
  const meta = document.getElementById("gw-detail-meta");
  if (meta) {
    const bits = [row.ip, row.type].filter(Boolean);
    meta.textContent = bits.join(" · ");
  }
}

function portUsage(boards, kind) {
  let used = 0;
  let total = 0;
  for (const b of boards || []) {
    if (nocBoardType(b.type, b.code) !== kind) continue;
    const ports = b.ports || [];
    total += ports.length;
    used += ports.filter((p) => p.state === "assigned").length;
  }
  return { used, total };
}

function paintGwDetailBody(payload, statusMsg) {
  let boards = (payload && payload.boards) || [];
  let assigned = (payload && payload.assigned) || [];
  const prev = GW.detailMg ? GW.configByMg[GW.detailMg] : null;
  if (!boards.length && prev && (prev.boards || []).length) {
    payload = prev;
    boards = prev.boards || [];
    assigned = prev.assigned || [];
  }
  const row = gwRowByMg(GW.detailMg) || {};
  const ana = portUsage(boards, "Analog");
  const dcp = portUsage(boards, "Digital");
  setText("gw-dstat-mj", String(payload?.mj ?? row.mj ?? 0));
  setText("gw-dstat-mn", String(payload?.mn ?? row.mn ?? 0));
  setText("gw-dstat-wn", String(payload?.wn ?? row.wn ?? 0));
  setText("gw-dstat-ana", `${ana.used} / ${ana.total}`);
  setText("gw-dstat-dcp", `${dcp.used} / ${dcp.total}`);
  const bt = document.getElementById("gw-board-tbody");
  if (bt) {
    if (!boards.length) {
      bt.innerHTML = `<tr class="empty"><td colspan="4">${escapeHtml(statusMsg || "No modules yet.")}</td></tr>`;
    } else {
      bt.innerHTML = boards
        .map((b) => {
          const ports = b.ports || [];
          const chips = ports
            .map((p) => {
              const st = p.state || "unassigned";
              const ext = p.extension ? `<span class="gw-chip-ext">${escapeHtml(p.extension)}</span>` : "";
              const btype = nocBoardType(b.type, b.code);
              const al = chipAlarm(p, b);
              const label =
                al.label ||
                (st === "psa"
                  ? "PSA"
                  : st === "tti"
                    ? "TTI"
                    : st === "unassigned"
                      ? "empty"
                      : btype === "Trunk"
                        ? "trunk"
                        : "station");
              const cls = ["gw-chip", st, al.cls].filter(Boolean).join(" ");
              return `<span class="${escapeHtml(cls)}" title="${escapeHtml(
                [`${p.port || p.n}`, label, p.extension].filter(Boolean).join(" · ")
              )}">${escapeHtml(p.n || "?")}${ext}</span>`;
            })
            .join("");
          const typ = nocBoardType(b.type, b.code);
          const q = (GW.detailQuery || "").trim().toLowerCase();
          const hit =
            !!q &&
            [b.board, b.slot, typ, b.code, b.type]
              .map((x) => String(x || "").toLowerCase())
              .some((s) => s.includes(q));
          return `<tr class="${hit ? "gw-mod-hit" : ""}">
            <td class="mono">${escapeHtml(b.board || "—")}</td>
            <td class="mono gw-board-type">${escapeHtml(typ)}</td>
            <td class="mono">${escapeHtml(b.code || "—")}</td>
            <td><div class="gw-chip-row">${chips || "—"}</div></td>
          </tr>`;
        })
        .join("");
    }
  }
  const pt = document.getElementById("gw-port-tbody");
  if (pt) {
    if (!assigned.length) {
      pt.innerHTML = `<tr class="empty"><td colspan="5">${
        boards.length ? "No assigned ports." : escapeHtml(statusMsg || "—")
      }</td></tr>`;
    } else {
      const q = (GW.detailQuery || "").trim().toLowerCase();
      const shown = q
        ? assigned.filter((a) =>
            [a.port, a.extension, a.name, a.extType, a.code, a.type, a.board, a.slot]
              .map((x) => String(x || "").toLowerCase())
              .join(" ")
              .includes(q)
          )
        : assigned;
      if (!shown.length) {
        pt.innerHTML = `<tr class="empty"><td colspan="5">No assigned ports match “${escapeHtml(q)}”.</td></tr>`;
      } else {
        pt.innerHTML = shown
          .map(
            (a) => `<tr>
            <td class="mono">${escapeHtml(a.port || "—")}</td>
            <td class="mono">${escapeHtml(a.extension || "—")}</td>
            <td>${escapeHtml(a.name || "—")}</td>
            <td>${escapeHtml(a.extType || "—")}</td>
            <td class="mono">${escapeHtml(a.code || a.type || "—")}</td>
          </tr>`
          )
          .join("");
      }
    }
  }
}

export function closeGatewayDetail() {
  GW.detailMg = null;
  showGwList();
}

export function openGatewayDetail(mg, opts = {}) {
  const n = Number(mg);
  if (!n) return;
  GW.detailMg = n;
  showGwDetailPane();
  paintGwDetailHeader(n);
  const cached = GW.configByMg[n];
  paintGwDetailBody(cached || { boards: [], assigned: [] }, cached ? "" : "Click-in OSSI list configuration…");
  refreshAlarmPortMap().then(() => {
    if (GW.detailMg !== n) return;
    const again = GW.configByMg[n];
    if (again) paintGwDetailBody(again, "");
  });
  if (!GW.connected) {
    paintGwDetailBody(cached || { boards: [], assigned: [] }, "Login required for list configuration media-gateway.");
    return;
  }
  const enqueue = window.__cmEnqueueGwConfig;
  if (typeof enqueue === "function") {
    enqueue(n, { showModal: opts.showModal !== false });
  } else {
    runGatewayConfigRefresh(n, { showModal: opts.showModal !== false }).catch(() => {});
  }
}

function friendlyGwConfigError(err) {
  const m = String(err?.message || err || "").trim() || "list configuration media-gateway failed";
  if (/not found|404|no configuration payload/i.test(m)) {
    return "list configuration media-gateway failed — retry";
  }
  return m;
}

function pickGwConfigPayload(res) {
  if (!res || typeof res !== "object") return null;
  let p = null;
  if (Array.isArray(res.boards)) p = res;
  else if (res.gatewayConfig && Array.isArray(res.gatewayConfig.boards)) p = res.gatewayConfig;
  else if (res.gatewayConfigRefresh && Array.isArray(res.boards)) p = res;
  if (!p) return null;
  if (!(p.boards || []).length && p.error) return null;
  return p;
}

async function fetchGwConfigPayload(n) {
  const haveCache = !!(GW.configByMg[n] && (GW.configByMg[n].boards || []).length);
  let lastErr = null;
  try {
    const res = await fetchJson(apiUrl("refresh/one"), {
      method: "POST",
      body: JSON.stringify({ tg: TG_GW_CONFIG_BASE + n }),
    });
    const payload = pickGwConfigPayload(res);
    if (payload) return payload;
    lastErr = (res && (res.error || res.Error)) || "no configuration payload";
  } catch (e) {
    lastErr = e;
  }
  if (haveCache) throw lastErr || new Error("refresh/one failed");
  try {
    const res = await fetchJson(apiUrl("gateways/config"), {
      method: "POST",
      body: JSON.stringify({ mg: n }),
    });
    const payload = pickGwConfigPayload(res);
    if (payload) return payload;
  } catch {
    /* old CmApi has no POST /gateways/config */
  }
  await new Promise((r) => setTimeout(r, 700));
  try {
    const res = await fetchJson(apiUrl("refresh/one"), {
      method: "POST",
      body: JSON.stringify({ tg: TG_GW_CONFIG_BASE + n }),
    });
    const payload = pickGwConfigPayload(res);
    if (payload) return payload;
    lastErr = (res && (res.error || res.Error)) || lastErr;
  } catch (e) {
    lastErr = e;
  }
  throw new Error(friendlyGwConfigError(lastErr));
}

export async function runGatewayConfigRefresh(mg, opts = {}) {
  const n = Number(mg);
  const showModal = !!opts.showModal;
  if (!n) return null;
  if (GW.configLoadingMg === n && !showModal) return GW.configByMg[n] || null;
  GW.configLoadingMg = n;
  GW.loading = true;
  if (showModal) {
    showProgress(`MG ${n} configuration`, "OSSI list configuration media-gateway…");
    setProgress(25, `list configuration media-gateway ${n}…`);
  }
  let payload = null;
  try {
    payload = await fetchGwConfigPayload(n);
  } catch (e) {
    const msg = friendlyGwConfigError(e);
    const keep = GW.configByMg[n] && (GW.configByMg[n].boards || []).length ? GW.configByMg[n] : null;
    if (GW.detailMg === n) {
      paintGwDetailBody(keep || { boards: [], assigned: [] }, keep ? "" : msg);
    }
    GW.configLoadingMg = 0;
    GW.loading = false;
    if (showModal) {
      finishProgress(!!keep, keep ? "Showing last configuration — Auto will retry" : msg);
    }
    if (keep) return keep;
    throw new Error(msg);
  }
  const incoming = (payload.boards || []).length;
  if (incoming) GW.configByMg[n] = payload;
  else if (GW.configByMg[n] && (GW.configByMg[n].boards || []).length) {
    payload = GW.configByMg[n];
  } else {
    GW.configByMg[n] = payload;
  }
  GW.configLoadingMg = 0;
  GW.loading = false;
  const nBoard = (payload.boards || []).length;
  await refreshAlarmPortMap();
  if (GW.detailMg === n) {
    paintGwDetailHeader(n);
    paintGwDetailBody(payload, payload.error || "");
  }
  if (showModal) {
    finishProgress(!payload.error || nBoard > 0, nBoard ? `${nBoard} boards` : payload.error || "No boards");
  }
  return payload;
}

export function initGatewayUi() {
  refreshAlarmPortMap().catch(() => {});

  const search = document.getElementById("gw-search");
  if (search) {
    search.addEventListener("input", () => {
      GW.query = search.value || "";
      paintGwSummary();
      renderGwTable();
    });
  }
  const dsearch = document.getElementById("gw-detail-search");
  if (dsearch) {
    dsearch.addEventListener("input", () => {
      GW.detailQuery = dsearch.value || "";
      const mg = GW.detailMg;
      const cached = mg ? GW.configByMg[mg] : null;
      if (cached) paintGwDetailBody(cached, "");
    });
  }

  const tbody = document.getElementById("gw-tbody");
  if (tbody) {
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest && ev.target.closest(".gw-host-btn");
      if (!btn) return;
      ev.preventDefault();
      const mg = Number(btn.getAttribute("data-mg"));
      if (mg) openGatewayDetail(mg, { showModal: true });
    });
  }
  document.getElementById("btn-gw-detail-back")?.addEventListener("click", () => closeGatewayDetail());

  paintGwSummary();
  renderGwTable();
  paintGwUpdated();
}
