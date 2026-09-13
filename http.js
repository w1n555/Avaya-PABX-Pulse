/**
 * Shared URL + fetch + HTML escape for Pulse UI modules.
 * No imports from *-ui.js (avoid cycles). Nested IIS: /CM/api/...
 * Mutating CmApi routes expect X-Api-Key from config.local.js (install.ps1).
 */

export function siteUrl(path) {
  let dir = window.location.pathname || "/";
  if (/\.html?$/i.test(dir)) dir = dir.replace(/\/[^/]*$/, "/");
  else if (!dir.endsWith("/")) dir += "/";
  return dir + String(path).replace(/^\//, "");
}

export function apiUrl(path) {
  return siteUrl("api/" + String(path).replace(/^\//, ""));
}

function apiHeaders(extra) {
  const headers = { "Content-Type": "application/json", ...(extra || {}) };
  try {
    const k = (typeof window !== "undefined" && window.__PULSE_API_KEY__) || "";
    if (k) headers["X-Api-Key"] = String(k);
  } catch (_) { /* ignore */ }
  return headers;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...opts,
    headers: apiHeaders(opts.headers || {}),
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

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtUpdated(iso) {
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
