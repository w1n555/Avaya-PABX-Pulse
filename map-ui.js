/**
 * Map View — offline Leaflet + map/tiles/{z}/{x}/{y}.jpg
 * Coordinates: hand-edit map/sites.json
 * Live data: hostname prefix → site, GW from gateway cache, KPI from alarm cache (no extra OSSI).
 * Pin light: any GW MAJOR or DOWN → red; else any MINOR → yellow; WARNING = green.
 * Map Major/Minor KPI = boxes, not alarm rows: each GW with that severity +
 * CM as 1 if it has its own (non-GGGV*) alarm, e.g. 1 G450 + 1 CM T1 = 2.
 */

import { openGatewayDetail } from "./gateway-ui.js?v=20260825i";

function apiUrlMap(path) {
  let dir = window.location.pathname || "/";
  if (/\.html?$/i.test(dir)) dir = dir.replace(/\/[^/]*$/, "/");
  else if (!dir.endsWith("/")) dir += "/";
  return dir + "api/" + String(path).replace(/^\//, "");
}

function siteUrlMap(path) {
  let dir = window.location.pathname || "/";
  if (/\.html?$/i.test(dir)) dir = dir.replace(/\/[^/]*$/, "/");
  else if (!dir.endsWith("/")) dir += "/";
  return dir + String(path).replace(/^\//, "");
}

async function fetchJsonMap(url, opts = {}) {
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

const MAP = {
  connected: false,
  tabActive: false,
  cfg: { center: [22.35, 114.15], zoom: 11, minZoom: 10, maxZoom: 14, sites: [] },
  gateways: [],
  gwUpdated: null,
  alarms: [],
  alarmSummary: {},
  alarmUpdated: null,
  nextAt: 0,
  ossiBusy: false,
  countdownTimer: null,
  selected: null,
  query: "",
  map: null,
  layer: null,
  markers: {},
  resetAdded: false,
  fittedOnce: false,
  zoomBound: false,
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function siteCodeFromHostname(hostname) {
  const h = String(hostname || "").trim();
  const i = h.indexOf("-");
  return (i > 0 ? h.slice(0, i) : h).toUpperCase();
}

function siteLight(site) {
  const down = Number(site.down || 0);
  const mj = Number(site.mj || 0);
  const mn = Number(site.mn || 0);
  if (mj > 0 || down > 0) return "red";
  if (mn > 0) return "yellow";
  return "green";
}

function lightLabel(light) {
  if (light === "red") return "Major";
  if (light === "yellow") return "Minor";
  return "Healthy";
}

function fmtGwTs(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  } catch {
    /* fall through */
  }
  return String(s).replace("T", " ").replace("Z", "").slice(0, 19);
}

function latestMapTs() {
  const a = MAP.gwUpdated;
  const b = MAP.alarmUpdated;
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? a : b;
  return String(a) >= String(b) ? a : b;
}

function paintMapCountdown() {
  /* countdown chip removed — app.js owns Auto status */
}

function startMapCountdownPaint() {
  /* no local countdown timer */
}

export function syncMapCountdown(nextAtMs) {
  const t = Number(nextAtMs);
  if (t) {
    const maxAt = Date.now() + 90 * 1000;
    MAP.nextAt = Math.min(t, maxAt);
  }
  paintMapCountdown();
}

export function setOssiBusy(busy) {
  MAP.ossiBusy = !!busy;
  paintMapCountdown();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function buildSiteRows() {
  const byCode = new Map();
  for (const s of MAP.cfg.sites || []) {
    const code = String(s.code || "").trim().toUpperCase();
    if (!code) continue;
    const lat = Number(s.lat);
    const lng = Number(s.lng);
    byCode.set(code, {
      code,
      name: String(s.name || "").trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      dummy: !!s.dummy,
      dummyMj: Number(s.dummyMj || 0),
      dummyMn: Number(s.dummyMn || 0),
      gws: [],
      mj: 0,
      mn: 0,
      wn: 0,
      down: 0,
      live: false,
    });
  }

  for (const g of MAP.gateways || []) {
    const code = siteCodeFromHostname(g.hostname);
    if (!code) continue;
    if (!byCode.has(code)) {
      byCode.set(code, {
        code,
        name: "",
        lat: null,
        lng: null,
        dummy: false,
        dummyMj: 0,
        dummyMn: 0,
        gws: [],
        mj: 0,
        mn: 0,
        wn: 0,
        down: 0,
        live: false,
      });
    }
    const row = byCode.get(code);
    row.live = true;
    row.gws.push(g);
    row.mj += Number(g.mj || 0);
    row.mn += Number(g.mn || 0);
    row.wn += Number(g.wn || 0);
    if (String(g.node || "").toUpperCase() !== "UP") row.down += 1;
  }

  const out = [...byCode.values()].map((row) => {
    if (!row.live) {
      row.mj = row.dummyMj;
      row.mn = row.dummyMn;
    }
    row.light = siteLight(row);
    row.gwCount = row.gws.length;
    return row;
  });
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

function filteredSites(rows) {
  const q = (MAP.query || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((s) => {
    const hay = [s.code, s.name, ...s.gws.map((g) => g.hostname), ...s.gws.map((g) => g.ip)]
      .map((x) => String(x || "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

function mgFromPort(port) {
  const m = String(port || "")
    .trim()
    .match(/^0*(\d+)V/i);
  return m ? Number(m[1]) : null;
}

function sevRank(sev) {
  const s = String(sev || "").toUpperCase();
  if (s === "MAJOR" || s === "MAJ") return "mj";
  if (s === "MINOR" || s === "MIN") return "mn";
  return "";
}

/** Boxes: each GW with MJ/MN counts 1; CM own (cabinet/T1, not GGGV*) counts 1. */
function alarmCounts() {
  const gwMj = new Set();
  const gwMn = new Set();
  for (const g of MAP.gateways || []) {
    const mg = Number(g.mg);
    if (!mg) continue;
    if (Number(g.mj || 0) > 0) gwMj.add(mg);
    if (Number(g.mn || 0) > 0) gwMn.add(mg);
  }
  let cmMj = false;
  let cmMn = false;
  for (const a of MAP.alarms || []) {
    const rank = sevRank(a.severity);
    if (!rank) continue;
    const mg = mgFromPort(a.port);
    if (mg != null) {
      if (rank === "mj") gwMj.add(mg);
      else gwMn.add(mg);
    } else if (rank === "mj") cmMj = true;
    else cmMn = true;
  }
  return {
    maj: gwMj.size + (cmMj ? 1 : 0),
    min: gwMn.size + (cmMn ? 1 : 0),
  };
}

function paintMapStats(rows) {
  const gws = MAP.gateways || [];
  const online = gws.filter((g) => String(g.node || "").toUpperCase() === "UP").length;
  const healthy = rows.filter((s) => s.light === "green").length;
  const { maj, min } = alarmCounts();
  setText("map-stat-sites", `${healthy} / ${rows.length}`);
  setText("map-stat-gws", `${online} / ${gws.length}`);
  setText("map-stat-critical", String(maj));
  setText("map-stat-minor", String(min));
  setText("map-stat-updated", fmtGwTs(latestMapTs()));
  setText("map-meta-updated", fmtGwTs(latestMapTs()));
  const gwCard = document.getElementById("map-stat-gws-card");
  if (gwCard) {
    gwCard.classList.remove("accent-red", "accent-green");
    if (gws.length && online === gws.length) gwCard.classList.add("accent-green");
    else if (gws.length && online < gws.length) gwCard.classList.add("accent-red");
  }
}

function paintUnmapped(rows) {
  const el = document.getElementById("map-unmapped");
  if (!el) return;
  const miss = rows.filter((s) => s.lat == null || s.lng == null);
  if (!miss.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = `No coordinates (add to map/sites.json): ${miss.map((s) => s.code).join(", ")}`;
}

function paintMapOverview(rows) {
  const attn = document.getElementById("map-side-attention");
  const status = document.getElementById("map-side-overview-status");
  const mappedEl = document.getElementById("map-side-mapped");
  const notEl = document.getElementById("map-side-not-mapped");
  const red = rows.filter((s) => s.light === "red");
  const yellow = rows.filter((s) => s.light === "yellow");
  const live = rows.filter((s) => s.live);
  const onMap = live.filter((s) => s.lat != null && s.lng != null);
  const notMap = live.filter((s) => s.lat == null || s.lng == null);
  if (status) {
    status.textContent =
      red.length || yellow.length
        ? `${red.length + yellow.length} site(s) need attention. Click a site for details.`
        : "No alarms. Click a site for details.";
  }
  if (attn) {
    const hot = [...red, ...yellow].slice(0, 8);
    if (!hot.length) {
      attn.innerHTML = "";
    } else {
      attn.innerHTML = hot
        .map((s) => {
          const bits = [];
          if (s.down) bits.push(`DOWN ${s.down}`);
          if (s.mj) bits.push(`MJ ${s.mj}`);
          if (s.mn) bits.push(`MN ${s.mn}`);
          return `<button type="button" class="map-attn-btn is-${s.light}" data-code="${escapeHtml(s.code)}">
            <span class="map-attn-code">${escapeHtml(s.code)}</span>
            <span class="map-attn-meta">${escapeHtml(bits.join(" · ") || lightLabel(s.light))}</span>
          </button>`;
        })
        .join("");
      attn.querySelectorAll(".map-attn-btn").forEach((btn) => {
        btn.addEventListener("click", () => selectSite(btn.getAttribute("data-code")));
      });
    }
  }
  if (mappedEl) {
    mappedEl.textContent = onMap.length
      ? onMap.map((s) => s.code).join(" · ")
      : "None";
  }
  if (notEl) {
    notEl.textContent = notMap.length
      ? `${notMap.map((s) => s.code).join(" · ")}  — add lat/lng in map/sites.json`
      : "All live sites are mapped.";
  }
}

function renderSide(site) {
  const empty = document.getElementById("map-side-empty");
  const body = document.getElementById("map-side-body");
  if (!empty || !body) return;
  if (!site) {
    empty.hidden = false;
    body.hidden = true;
    body.classList.remove("is-red", "is-yellow", "is-green");
    paintMapOverview(buildSiteRows());
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  body.classList.remove("is-red", "is-yellow", "is-green");
  body.classList.add(`is-${site.light}`);
  const title = document.getElementById("map-side-title");
  const sub = document.getElementById("map-side-sub");
  const light = document.getElementById("map-side-light");
  const meta = document.getElementById("map-side-meta");
  if (title) title.textContent = site.code;
  if (sub) {
    sub.textContent = site.name || (site.dummy ? "Dummy coordinate — edit map/sites.json" : "—");
  }
  if (light) {
    light.className = `map-light ${site.light}`;
    light.textContent = lightLabel(site.light).toUpperCase();
  }
  if (meta) {
    meta.innerHTML = [
      { k: "Gateways", v: site.gwCount, acc: "" },
      { k: "Down", v: site.down, acc: "red" },
      { k: "Major", v: site.mj, acc: "red" },
      { k: "Minor", v: site.mn, acc: "yellow" },
      { k: "Warning", v: site.wn, acc: "" },
    ]
      .map(
        (it) => `<div class="map-stat${it.acc ? ` accent-${it.acc}` : ""}">
          <div class="map-stat-k">${escapeHtml(it.k)}</div>
          <div class="map-stat-v">${escapeHtml(String(it.v))}</div>
        </div>`
      )
      .join("");
  }
  const tbody = document.getElementById("map-side-tbody");
  if (!tbody) return;
  if (!site.gws.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="7">${
      MAP.connected ? "No live GW for this code yet." : "Login to load live GW / alarms."
    }</td></tr>`;
    return;
  }
  tbody.innerHTML = site.gws
    .slice()
    .sort((a, b) => Number(a.mg) - Number(b.mg))
    .map((g) => {
      const node = String(g.node || "").toUpperCase() === "DOWN" ? "DOWN" : "UP";
      const nodeCls = node === "UP" ? "node-up" : "node-down";
      const host = g.hostname || "—";
      const ip = g.ip || "—";
      return `<tr>
        <td class="mono">${escapeHtml(String(g.mg ?? "—"))}</td>
        <td><button type="button" class="gw-host-btn" data-mg="${escapeHtml(String(g.mg ?? ""))}" title="Open Media Gateway Status">${escapeHtml(host)}</button></td>
        <td class="map-ip" title="${escapeHtml(ip)}">${escapeHtml(ip)}</td>
        <td><span class="badge-node ${nodeCls}">${node}</span></td>
        <td class="mono">${g.mj || 0}</td>
        <td class="mono">${g.mn || 0}</td>
        <td class="mono">${g.wn || 0}</td>
      </tr>`;
    })
    .join("");
}

function selectSite(code) {
  const rows = buildSiteRows();
  const site = rows.find((s) => s.code === code) || null;
  MAP.selected = site ? site.code : null;
  renderSide(site);
  for (const [k, mk] of Object.entries(MAP.markers)) {
    const el = mk.getElement && mk.getElement();
    if (el) el.classList.toggle("is-selected", k === MAP.selected);
    if (mk.setZIndexOffset) mk.setZIndexOffset(k === MAP.selected ? 800 : 0);
  }
  if (site && site.lat != null && site.lng != null && MAP.map) {
    const z = Math.max(MAP.map.getZoom(), 13);
    MAP.map.setView([site.lat, site.lng], z, { animate: true });
  }
}

function markerHtml(site) {
  const dummy = site.dummy ? " is-dummy" : "";
  const pulse = site.light === "green" ? "" : " is-pulse";
  return `<div class="map-pin map-pin-${site.light}${dummy}${pulse}">
    <span class="map-pin-code">${escapeHtml(site.code)}</span>
    <span class="map-pin-dot"></span>
  </div>`;
}

function tooltipHtml(site) {
  const bits = [];
  if (site.down > 0) bits.push(`DOWN ${site.down}`);
  if (site.mj > 0) bits.push(`MJ ${site.mj}`);
  if (site.mn > 0) bits.push(`MN ${site.mn}`);
  if (site.wn > 0) bits.push(`WN ${site.wn}`);
  const name = site.name
    ? `<div class="map-tip-name">${escapeHtml(site.name)}</div>`
    : "";
  const counts = bits.length ? `<div class="map-tip-alarms">${escapeHtml(bits.join(" · "))}</div>` : "";
  return `<div class="map-tip-inner">
    <div class="map-tip-code">${escapeHtml(site.code)}</div>
    ${name}
    <div class="map-tip-status map-tip-${site.light}">${escapeHtml(lightLabel(site.light))}</div>
    <div class="map-tip-row">Gateways ${escapeHtml(String(site.gwCount))}</div>
    ${counts}
  </div>`;
}

function sitesWithCoords(rows) {
  return (rows || []).filter((s) => s.lat != null && s.lng != null);
}

/** Pixel-space push-apart. Strength falls to 0 at maxZoom so pins return to true lat/lng. */
function spreadSiteLatLngs(sites) {
  const L = window.L;
  const out = new Map();
  if (!MAP.map || !L) return out;
  const minZ = Number(MAP.cfg.minZoom || 10);
  const maxZ = Number(MAP.cfg.maxZoom || 14);
  const zoom = MAP.map.getZoom();
  const t = Math.max(0, Math.min(1, (zoom - minZ) / Math.max(1, maxZ - minZ)));
  const minPx = 64 * (1 - t);
  for (const s of sites) {
    out.set(s.code, L.latLng(s.lat, s.lng));
  }
  if (minPx < 4 || sites.length < 2) return out;
  const pts = sites.map((s) => {
    const p = MAP.map.latLngToLayerPoint(L.latLng(s.lat, s.lng));
    return { code: s.code, x: p.x, y: p.y };
  });
  for (let iter = 0; iter < 24; iter++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let dx = pts[j].x - pts[i].x;
        let dy = pts[j].y - pts[i].y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          dx = 1;
          dy = 0;
          d = 0.01;
        }
        if (d >= minPx) continue;
        const push = (minPx - d) / 2;
        dx /= d;
        dy /= d;
        pts[i].x -= dx * push;
        pts[i].y -= dy * push;
        pts[j].x += dx * push;
        pts[j].y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const p of pts) {
    out.set(p.code, MAP.map.layerPointToLatLng(L.point(p.x, p.y)));
  }
  return out;
}

function applySpreadToMarkers() {
  const rows = sitesWithCoords(filteredSites(buildSiteRows()));
  const spread = spreadSiteLatLngs(rows);
  for (const site of rows) {
    const mk = MAP.markers[site.code];
    const ll = spread.get(site.code);
    if (mk && ll) mk.setLatLng(ll);
  }
}

function fitToSites(opts = {}) {
  const L = window.L;
  if (!MAP.map || !L) return;
  const rows = sitesWithCoords(buildSiteRows());
  if (!rows.length) {
    MAP.map.setView(MAP.cfg.center || [22.35, 114.15], Number(MAP.cfg.zoom || 11), {
      animate: opts.animate === true,
    });
    return;
  }
  const b = L.latLngBounds(rows.map((s) => [s.lat, s.lng]));
  MAP.map.fitBounds(b, {
    padding: [56, 56],
    maxZoom: Math.min(13, Number(MAP.cfg.maxZoom || 14)),
    animate: opts.animate === true,
  });
}

function redrawMarkers() {
  const L = window.L;
  if (!MAP.map || !L) return;
  if (MAP.layer) MAP.layer.clearLayers();
  else MAP.layer = L.layerGroup().addTo(MAP.map);
  MAP.markers = {};
  const rows = filteredSites(buildSiteRows());
  const withCoords = sitesWithCoords(rows);
  const spread = spreadSiteLatLngs(withCoords);
  for (const site of withCoords) {
    const ll = spread.get(site.code) || L.latLng(site.lat, site.lng);
    const icon = L.divIcon({
      className: "map-pin-wrap",
      html: markerHtml(site),
      iconSize: [58, 32],
      iconAnchor: [29, 32],
    });
    const mk = L.marker(ll, { icon, keyboard: true, riseOnHover: true });
    mk.bindTooltip(tooltipHtml(site), {
      className: "map-tip",
      direction: "top",
      offset: [0, -10],
      opacity: 1,
      sticky: false,
    });
    mk.on("click", () => selectSite(site.code));
    mk.addTo(MAP.layer);
    MAP.markers[site.code] = mk;
  }
  if (MAP.selected) {
    const still = rows.find((s) => s.code === MAP.selected);
    renderSide(still || null);
    if (!still) MAP.selected = null;
    else {
      const el = MAP.markers[MAP.selected] && MAP.markers[MAP.selected].getElement && MAP.markers[MAP.selected].getElement();
      if (el) el.classList.add("is-selected");
      if (MAP.markers[MAP.selected] && MAP.markers[MAP.selected].setZIndexOffset) {
        MAP.markers[MAP.selected].setZIndexOffset(800);
      }
    }
  }
}

function resetMapView() {
  fitToSites({ animate: true });
}

function addResetControl() {
  const L = window.L;
  if (!MAP.map || !L || MAP.resetAdded) return;
  const Ctrl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control map-reset-control");
      const a = L.DomUtil.create("a", "", bar);
      a.href = "#";
      a.title = "Fit all sites";
      a.setAttribute("role", "button");
      a.setAttribute("aria-label", "Fit all site icons");
      a.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 3.4 3.5 10.8h2.3V20h5.2v-5.6h2V20h5.2v-9.2h2.3L12 3.4z"/></svg>';
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.disableScrollPropagation(bar);
      L.DomEvent.on(a, "click", (ev) => {
        L.DomEvent.preventDefault(ev);
        L.DomEvent.stopPropagation(ev);
        resetMapView();
      });
      return bar;
    },
  });
  MAP.map.addControl(new Ctrl());
  MAP.resetAdded = true;
}

function ensureMap() {
  const L = window.L;
  const host = document.getElementById("map-canvas");
  if (!host || !L) return false;
  if (MAP.map) {
    setTimeout(() => MAP.map.invalidateSize(), 80);
    return true;
  }
  const cfg = MAP.cfg;
  const maxZ = Number(cfg.maxZoom || 14);
  const minZ = Number(cfg.minZoom || 10);
  MAP.map = L.map(host, {
    center: cfg.center || [22.35, 114.15],
    zoom: Number(cfg.zoom || 11),
    minZoom: minZ,
    maxZoom: maxZ,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer("map/tiles/{z}/{x}/{y}.jpg", {
    minZoom: minZ,
    maxZoom: maxZ,
    maxNativeZoom: maxZ,
    errorTileUrl: "",
    attribution: "Tiles © Esri · offline cache",
  }).addTo(MAP.map);
  addResetControl();
  if (!MAP.zoomBound) {
    MAP.map.on("zoomend", () => applySpreadToMarkers());
    MAP.zoomBound = true;
  }
  setTimeout(() => MAP.map.invalidateSize(), 120);
  return true;
}

function paintAll() {
  const all = buildSiteRows();
  paintMapStats(all);
  paintUnmapped(all);
  if (!MAP.selected) paintMapOverview(all);
  if (MAP.tabActive) {
    ensureMap();
    redrawMarkers();
  }
}

async function loadSitesFile() {
  const data = await fetchJsonMap(siteUrlMap("map/sites.json") + "?t=" + Date.now());
  const sites = Array.isArray(data.sites) ? data.sites : [];
  MAP.cfg = {
    center: Array.isArray(data.center) && data.center.length === 2 ? data.center : [22.35, 114.15],
    zoom: Number(data.zoom || 11),
    minZoom: Number(data.minZoom || 10),
    maxZoom: Number(data.maxZoom || 14),
    sites,
  };
}

async function loadGatewayCache() {
  let items = [];
  let updated = null;
  try {
    const data = await fetchJsonMap(apiUrlMap("gateways"));
    if (Array.isArray(data.items)) {
      items = data.items;
      updated = data.lastUpdate || null;
    }
  } catch {
    /* old DLL */
  }
  if (!items.length) {
    try {
      const td = await fetchJsonMap(apiUrlMap("trunk-data"));
      const inner = td.data || td;
      const gw = inner && inner.gateways;
      if (gw && Array.isArray(gw.items)) {
        items = gw.items;
        updated = gw.lastUpdate || inner.lastUpdate || null;
      }
    } catch {
      /* ignore */
    }
  }
  if (!items.length) {
    try {
      const data = await fetchJsonMap(siteUrlMap("gateways_cache.json") + "?t=" + Date.now());
      if (Array.isArray(data.items)) {
        items = data.items;
        updated = data.lastUpdate || null;
      }
    } catch {
      /* ignore */
    }
  }
  MAP.gateways = items;
  MAP.gwUpdated = updated;
}

function unwrapAlarms(data) {
  if (!data || typeof data !== "object") return null;
  let d = data;
  if (d.alarms && typeof d.alarms === "object" && (d.alarms.active || d.alarms.summary)) {
    d = d.alarms;
  }
  if (d.data && typeof d.data === "object" && d.data.alarms) {
    d = d.data.alarms;
  }
  if (!Array.isArray(d.active) && !d.summary) return null;
  return d;
}

async function loadAlarmCache() {
  let d = null;
  try {
    d = unwrapAlarms(await fetchJsonMap(apiUrlMap("alarms")));
  } catch {
    /* old DLL */
  }
  if (!d) {
    try {
      const td = await fetchJsonMap(apiUrlMap("trunk-data"));
      d = unwrapAlarms(td);
    } catch {
      /* ignore */
    }
  }
  if (!d) {
    try {
      d = unwrapAlarms(await fetchJsonMap(siteUrlMap("alarms_cache.json") + "?t=" + Date.now()));
    } catch {
      /* ignore */
    }
  }
  if (!d) return;
  const incoming = Array.isArray(d.active) ? d.active : [];
  if ((MAP.alarms || []).length > 0 && incoming.length === 0 && d.ok !== true) return;
  MAP.alarms = incoming;
  MAP.alarmSummary = d.summary && typeof d.summary === "object" ? d.summary : {};
  if (d.lastUpdate) MAP.alarmUpdated = d.lastUpdate;
}

export async function refreshMapFromCache() {
  await Promise.all([loadGatewayCache().catch(() => {}), loadAlarmCache().catch(() => {})]);
  paintAll();
}

export async function onMapTabShow() {
  MAP.tabActive = true;
  startMapCountdownPaint();
  paintMapCountdown();
  try {
    await loadSitesFile();
  } catch (e) {
    console.warn("map/sites.json:", e?.message || e);
  }
  await refreshMapFromCache();
  ensureMap();
  redrawMarkers();
  setTimeout(() => {
    if (!MAP.map) return;
    MAP.map.invalidateSize();
    if (!MAP.fittedOnce) {
      fitToSites({ animate: false });
      MAP.fittedOnce = true;
    }
    applySpreadToMarkers();
  }, 200);
}

export function setMapTabActive(active) {
  MAP.tabActive = !!active;
}

export function setMapSessionConnected(connected) {
  MAP.connected = !!connected;
  if (MAP.connected) startMapCountdownPaint();
  paintMapCountdown();
  if (MAP.tabActive) refreshMapFromCache().catch(() => {});
}

export function initMapUi() {
  startMapCountdownPaint();
  const search = document.getElementById("map-search");
  if (search) {
    search.addEventListener("input", () => {
      MAP.query = search.value || "";
      paintAll();
    });
  }
  const close = document.getElementById("map-side-close");
  if (close) {
    close.addEventListener("click", () => {
      MAP.selected = null;
      renderSide(null);
      for (const mk of Object.values(MAP.markers)) {
        const el = mk.getElement && mk.getElement();
        if (el) el.classList.remove("is-selected");
        if (mk.setZIndexOffset) mk.setZIndexOffset(0);
      }
    });
  }
  const tbody = document.getElementById("map-side-tbody");
  if (tbody) {
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest && ev.target.closest(".gw-host-btn");
      if (!btn) return;
      ev.preventDefault();
      const mg = Number(btn.getAttribute("data-mg"));
      if (!mg) return;
      const tab = document.querySelector('.tab[data-tab="gateway"]');
      if (tab) tab.click();
      openGatewayDetail(mg, { showModal: true });
    });
  }
}
