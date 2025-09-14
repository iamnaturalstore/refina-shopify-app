// admin-ui/src/api/client.js
// Centralized API client for the Admin UI.
// • Uses App Bridge authenticatedFetch
// • Appends shop/host to every request (computes host if missing)
// • On 401 + reauth headers: performs a single top-frame redirect to /api/auth?shop&host

import { authenticatedFetch } from "@shopify/app-bridge-utils";
import { Redirect } from "@shopify/app-bridge/actions";
import app from "../appBridge"; // configured App Bridge instance

/* ─────────────────────────────────────────────────────────────
   Persist host/shop once per load to survive SPA navigation
   ───────────────────────────────────────────────────────────── */
(function persistParams() {
  try {
    const q = new URLSearchParams(window.location.search || "");
    const hashQ = (window.location.hash || "").split("?")[1] || "";
    const h = new URLSearchParams(hashQ);
    const pick = (k) => q.get(k) || h.get(k) || null;

    const shopRaw = (pick("shop") || "").trim().toLowerCase();
    const shop = shopRaw && shopRaw.endsWith(".myshopify.com") ? shopRaw : "";

    let host = (pick("host") || "").trim();
    // If host missing but shop present, compute it (base64 "<shop>.myshopify.com/admin")
    if (!host && shop) {
      try { host = btoa(`${shop}/admin`); } catch { /* ignore */ }
    }

    if (host) sessionStorage.setItem("shopify-host", host);
    if (shop) sessionStorage.setItem("shopify-shop", shop);
  } catch {}
})();

/* ─────────────────────────────────────────────────────────────
   URL/context helpers
   ───────────────────────────────────────────────────────────── */
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
  let host = getPersisted("host", "shopify-host");
  if (!host) {
    const shop = getShop();
    if (shop) {
      try { host = btoa(`${shop}/admin`); } catch { /* ignore */ }
      if (host) sessionStorage.setItem("shopify-host", host);
    }
  }
  return host || "";
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

/* ─────────────────────────────────────────────────────────────
   Authenticated fetch wiring
   ───────────────────────────────────────────────────────────── */
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
  return fetch; // ultimate fallback (will likely 401, handled below)
}

function forceTopFrameRedirect(url) {
  try {
    if (app) {
      const redirect = Redirect.create(app);
      redirect.dispatch(Redirect.Action.REMOTE, url);
      return;
    }
  } catch {}
  try { window.top.location.href = url; } catch { window.location.href = url; }
}

/* ─────────────────────────────────────────────────────────────
   Core API
   ───────────────────────────────────────────────────────────── */
export async function api(path, init = {}) {
  const finalUrl = withContext(path);

  const isJSON =
    init.body && typeof init.body === "object" && !(init.body instanceof FormData);

  const baseInit = isJSON
    ? {
        ...init,
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
        body: JSON.stringify(init.body),
      }
    : { ...init, headers: { Accept: "application/json", ...(init.headers || {}) } };

  const fetchInit = { cache: "no-store", ...baseInit };
  const f = getAuthedFetch();
  const res = await f(finalUrl, fetchInit);

  // Handle Shopify reauthorization handshake
  if (res.status === 401 || res.status === 403) {
    const need = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1";
    let to = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url") || "";
    if (need) {
      if (!to) {
        // Construct a local /api/auth as a safety net
        to = "/api/auth";
      }
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

      // eslint-disable-next-line no-console
      console.log("[api] Reauthorize →", u.toString());
      forceTopFrameRedirect(u.toString());
      return new Promise(() => {});
    }
  }

  const ct = res.headers.get("content-type") || "";
  let data;
  try {
    data = ct.includes("application/json") ? await res.json() : await res.text();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : "") ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return { data, status: res.status, ok: res.ok };
}

// Convenience verbs
api.get = (path, init) => api(path, { ...init, method: "GET" });
api.post = (path, body, init) => api(path, { ...init, method: "POST", body });
api.put = (path, body, init) => api(path, { ...init, method: "PUT", body });
api.delete = (path, init) => api(path, { ...init, method: "DELETE" });

/* ─────────────────────────────────────────────────────────────
   Feature-specific wrappers
   ───────────────────────────────────────────────────────────── */
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
  async getPlan({ fresh } = {}) {
    // Do NOT force fresh=1 by default. Let callers decide.
    const url = fresh ? `/api/billing/plan?fresh=1` : `/api/billing/plan`;
    return api.get(url);
  },
  async upgrade({ returnUrl } = {}) {
    return api(`/api/billing/upgrade`, { method: "POST", body: { returnUrl } });
  },
  async downgrade() {
    return api(`/api/billing/downgrade`, { method: "POST", body: {} });
  },
  async status() {
    return api.get(`/api/billing/status`);
  },
  async sync() {
    return api(`/api/billing/sync`, { method: "POST", body: {} });
  },
  // Legacy (kept for backwards compat; not used by the new Billing page)
  async subscribe({ plan, returnUrl } = {}) {
    return api(`/api/billing/subscribe`, { method: "POST", body: { plan, returnUrl } });
  },
};

export default api;
