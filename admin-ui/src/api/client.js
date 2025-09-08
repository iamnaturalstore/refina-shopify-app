// admin-ui/src/api/client.js
// Centralized API client for the Admin UI.
// Works with App Bridge by accepting an injected authenticated fetch
// (via setAuthedFetch), and also falls back to App Bridge's authenticatedFetch
// automatically if available.

// ─────────────────────────────────────────────────────────────
// App Bridge fallback (safe to import; uses host from URL)
// ─────────────────────────────────────────────────────────────
import { authenticatedFetch } from "@shopify/app-bridge-utils";
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

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s.endsWith(".myshopify.com") ? s : "";
}

function getHost() {
  return getPersisted("host", "shopify-host");
}

export function getShop() {
  const raw = getPersisted("shop", "shopify-shop");
  return toMyshopifyDomain(raw);
}

export function getStoreIdFromUrl() {
  return (getShop() || "").toLowerCase();
}

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

// ─────────────────────────────────────────────────────────────
// Authenticated fetch injection (from useAuthenticatedFetch)
// ─────────────────────────────────────────────────────────────
let _authedFetch = null;

/**
 * Call this once in your app root, if you like:
 *   import { authenticatedFetch } from "@shopify/app-bridge-utils";
 *   import app from "../appBridge";
 *   setAuthedFetch(authenticatedFetch(app));
 *
 * If you forget, we'll fall back to authenticatedFetch(app) automatically.
 */
export function setAuthedFetch(fn) {
  _authedFetch = typeof fn === "function" ? fn : null;
}

function getAuthedFetch() {
  try {
    if (_authedFetch) return _authedFetch;
    if (app) {
      // Lazily create an authenticated fetch from App Bridge
      return authenticatedFetch(app);
    }
  } catch {}
  return fetch; // ultimate fallback (will 401 on protected routes)
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
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        body: JSON.stringify(init.body),
      }
    : init;

  const fetchInit = { cache: "no-store", ...baseInit };
  const f = getAuthedFetch();
  const res = await f(finalUrl, fetchInit);

  // Handle reauthorization headers from the backend
  if (res.status === 401 || res.status === 403) {
    const need = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1";
    const to = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url");
    if (need && to) {
      const abs = to.startsWith("http")
        ? to
        : new URL(to, window.location.origin).toString();
      try {
        window.top.location.href = abs; // embedded app: redirect top
      } catch {
        window.location.href = abs;
      }
      return new Promise(() => {}); // hand off to navigation
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
    if (from && to) {
      qs.set("from", from);
      qs.set("to", to);
    } else if (days != null) {
      qs.set("days", String(days));
    }
    const url = `/api/admin/analytics/overview${qs.toString() ? `?${qs.toString()}` : ""}`;
    return api.get(url);
  },

  async getAnalyticsEvents({ limit, cursor } = {}) {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    const url = `/api/admin/analytics/logs${qs.toString() ? `?${qs.toString()}` : ""}`;
    return api.get(url);
  },
};

export const billingApi = {
  async getPlan() {
    return api.get(`/api/billing/plan`);
  },
  async subscribe({ plan }) {
    return api(`/api/billing/subscribe`, {
      method: "POST",
      body: { plan },
    });
  },
};

export default api;
