// admin-ui/src/api/client.js
// Centralized API client for the Admin UI.
// • Uses App Bridge authenticatedFetch
// • Appends shop/host to every request
// • On 401 + reauth headers: forces a single top-frame redirect to /api/auth?shop&host

import { authenticatedFetch } from "@shopify/app-bridge-utils";
import { Redirect } from "@shopify/app-bridge/actions";
import app from "../appBridge"; // must export a configured App Bridge instance

// ─────────────────────────────────────────────────────────────
// Persist host/shop once per load to survive navigation
// ─────────────────────────────────────────────────────────────
(function persistParams() {
  try {
    const q = new URLSearchParams(window.location.search || "");
    const hashQ = (window.location.hash || "").split("?")[1] || "";
    const h = new URLSearchParams(hashQ);
    const pick = (k) => q.get(k) || h.get(k) || null;
    const pairs = [
      ["host", "shopify-host"],
      ["shop", "shopify-shop"],
    ];
    for (const [key, storeKey] of pairs) {
      const v = pick(key);
      if (v) sessionStorage.setItem(storeKey, v);
    }
  } catch {}
})();

// ─────────────────────────────────────────────────────────────
// URL/context helpers
// ─────────────────────────────────────────────────────────────
function getPersisted(key, storeKey) {
  const q = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const h = new URLSearchParams(hashQ);
  return q.get(key) || h.get(key) || sessionStorage.getItem(storeKey) || "";
}
export function getShop() {
  const raw = getPersisted("shop", "shopify-shop");
  const s = String(raw || "").trim().toLowerCase();
  return s.endsWith(".myshopify.com") ? s : "";
}
function getHost() {
  return getPersisted("host", "shopify-host");
}
export function withContext(path) {
  const url = new URL(path, window.location.origin);
  const params = new URLSearchParams(url.search);
  const host = getHost();
  const shop = getShop();
  if (host && !params.has("host")) params.set("host", host);
  if (shop && !params.has("shop")) params.set("shop", shop);
  url.search = params.toString();
  return url.toString();
}

// ─────────────────────────────────────────────────────────────
// Authenticated fetch (App Bridge) + one-shot reauth guard
// ─────────────────────────────────────────────────────────────
let _authedFetch = null;
let __reauthInFlight = false;

export function setAuthedFetch(fn) {
  _authedFetch = typeof fn === "function" ? fn : null;
}
function getAuthedFetch() {
  try {
    if (_authedFetch) return _authedFetch;
    if (app) return authenticatedFetch(app);
  } catch {}
  return fetch; // ultimate fallback (likely to 401)
}

function forceTopFrameRedirect(url) {
  // Try App Bridge remote redirect first (best for embedded apps)
  try {
    if (app) {
      const redirect = Redirect.create(app);
      redirect.dispatch(Redirect.Action.REMOTE, url);
      return;
    }
  } catch {}
  // Hard fallback
  try { window.top.location.href = url; } catch { window.location.href = url; }
}

// ─────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────
export async function api(path, init = {}) {
  const finalUrl = withContext(path);

  const isJSON =
    init.body && typeof init.body === "object" && !(init.body instanceof FormData);

  const baseInit = isJSON
    ? {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers || {}) },
        body: JSON.stringify(init.body),
      }
    : init;

  const fetchInit = { cache: "no-store", ...baseInit };
  const f = getAuthedFetch();
  const res = await f(finalUrl, fetchInit);

  // Handle reauthorization headers from the backend
  if (res.status === 401 || res.status === 403) {
    const need = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1";
    let to = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url");

    if (need && to) {
      if (__reauthInFlight) {
        // Park concurrent callers while the first one navigates
        return new Promise(() => {});
      }
      __reauthInFlight = true;

      // Upgrade to absolute URL and ALWAYS append shop/host
      const base = window.location.origin;
      const u = to.startsWith("http") ? new URL(to) : new URL(to, base);
      const shop = getShop();
      const host = getHost();
      if (shop && !u.searchParams.get("shop")) u.searchParams.set("shop", shop);
      if (host && !u.searchParams.get("host")) u.searchParams.set("host", host);

      // Breadcrumb so you can confirm it fires exactly once
      // eslint-disable-next-line no-console
      console.log("[api] Reauthorize →", u.toString());

      forceTopFrameRedirect(u.toString());
      // Hand off to navigation so callers don't continue on a 401
      return new Promise(() => {});
    }
  }

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : "") ||
      "Request failed";
    throw new Error(msg);
  }
  return { data, status: res.status, ok: res.ok };
}

// Convenience verbs
api.get = (path, init) => api(path, { ...init, method: "GET" });
api.post = (path, body, init) => api(path, { ...init, method: "POST", body });
api.put = (path, body, init) => api(path, { ...init, method: "PUT", body });
api.delete = (path, init) => api(path, { ...init, method: "DELETE" });

// ─────────────────────────────────────────────────────────────
// Feature-specific wrappers
// ─────────────────────────────────────────────────────────────
export const adminApi = {
  async getAnalyticsSummary({ days = 30, from, to } = {}) {
    const qs = new URLSearchParams();
    if (from && to) { qs.set("from", from); qs.set("to", to); }
    else if (days != null) { qs.set("days", String(days)); }
    const url = `/api/admin/analytics/overview${qs.toString() ? `?${qs}` : ""}`;
    return api.get(url);
  },
  async getAnalyticsEvents({ limit, cursor } = {}) {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    const url = `/api/admin/analytics/logs${qs.toString() ? `?${qs}` : ""}`;
    return api.get(url);
  },
};

export const billingApi = {
  async getPlan() {
    // Legacy helper (kept for callers that still import billingApi)
    return api.get(`/api/billing/plan`);
  },
  async subscribe({ plan }) {
    return api(`/api/billing/subscribe`, { method: "POST", body: { plan } });
  },
};

export default api;
