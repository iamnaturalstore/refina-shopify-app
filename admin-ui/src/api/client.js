// admin-ui/src/api/client.js — FINAL (named exports only)
import createApp from "@shopify/app-bridge";
import { authenticatedFetch } from "@shopify/app-bridge-utils";

// Persist host/shop once per load to survive navigation
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
  } catch {
    // Don't crash Admin UI over storage issues
  }
})();

function getPersisted(key, storeKey) {
  const q = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const h = new URLSearchParams(hashQ);
  return q.get(key) || h.get(key) || sessionStorage.getItem(storeKey) || "";
}

// Canonicalize to "<shop>.myshopify.com"
function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : "";
}

function getHost() {
  return getPersisted("host", "shopify-host");
}

// ⬅️ Exported helpers
export function getShop() {
  const raw = getPersisted("shop", "shopify-shop");
  return toMyshopifyDomain(raw);
}

export function getStoreIdFromUrl() {
  return (getShop() || "").toLowerCase();
}

// Attach host/shop to any relative Admin API path
export function withContext(path) {
  const url = new URL(path, window.location.origin);
  const params = new URLSearchParams(url.search);

  const host = getHost();
  const shopFull = (getShop() || "").toLowerCase();

  if (host && !params.has("host")) params.set("host", host);
  if (shopFull && !params.has("shop")) params.set("shop", shopFull);

  url.search = params.toString();
  return url.toString();
}

function requireEnvKey() {
  const k = import.meta.env.VITE_SHOPIFY_API_KEY;
  if (!k) throw new Error("VITE_SHOPIFY_API_KEY missing in admin-ui build");
  return k;
}

let _app, _fetchFn;
function getAppBridge() {
  if (_app) return _app;
  const host = getHost();
  const apiKey = requireEnvKey();
  if (!host) throw new Error("Missing host param (and none persisted)");
  _app = createApp({ apiKey, host, forceRedirect: true });
  _fetchFn = authenticatedFetch(_app);
  return _app;
}

/**
 * Authenticated fetch:
 * - Adds host/shop query automatically
 * - Sends JSON when `init.body` is an object
 * - Handles Shopify reauth hints (401/403)
 */
export async function api(path, init = {}) {
  getAppBridge(); // throws fast if misconfigured

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
  const res = await _fetchFn(finalUrl, fetchInit);

  if (res.status === 401 || res.status === 403) {
    const need = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1";
    const to = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url");
    if (need && to) {
      window.top.location.href = to;
      return new Promise(() => {}); // halt
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

  return data;
}

/* ─────────────────────────────
 * Convenience wrappers for pages
 * ───────────────────────────── */
export const adminApi = {
  // Accept either {from,to} or {days}; default to 30 days when not provided
  async getAnalyticsSummary({ days = 30, from, to } = {}) {
    const qs = new URLSearchParams();
    if (from && to) {
      qs.set("from", from);
      qs.set("to", to);
    } else if (days != null) {
      qs.set("days", String(days));
    }
    const url = `/api/admin/analytics/overview${qs.toString() ? `?${qs.toString()}` : ""}`;
    return api(url);
  },

  async getAnalyticsEvents({ limit, cursor } = {}) {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    const url = `/api/admin/analytics/logs${qs.toString() ? `?${qs.toString()}` : ""}`;
    return api(url);
  },
};

export const billingApi = {
  async getPlan() {
    return api(`/api/billing/plan`);
  },
  async subscribe({ plan }) {
    return api(`/api/billing/subscribe`, {
      method: "POST",
      body: { plan },
    });
  },
};

export default api;
