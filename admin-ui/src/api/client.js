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

/* ─────────────────────────────────────────────────────────────
   Reauth helpers (fallback when headers are missing)
   ───────────────────────────────────────────────────────────── */
function sameOrigin(urlOrPath) {
  try {
    const u = new URL(urlOrPath, window.location.origin);
    return u.origin === window.location.origin;
  } catch { return false; }
}
function isProtectedApi(urlOrPath) {
  try {
    const p = new URL(urlOrPath, window.location.origin).pathname;
    // Treat our privileged API namespaces as requiring a valid session
    return /^\/api\/(billing|admin|auth|semantic|privacy)\b/.test(p);
  } catch { return false; }
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

/* ─────────────────────────────────────────────────────────────
   Safe top-frame redirect helpers
   - Always normalize to an absolute URL on our origin
   - Auto-attach host/shop if missing
   ───────────────────────────────────────────────────────────── */
export function buildEmbeddedUrl(pathOrUrl = "/embedded", extraParams = {}) {
  const qs = new URLSearchParams(window.location.search || "");
  const host = qs.get("host") || getHost();
  const shop = qs.get("shop") || getShop();

  // Normalize to absolute URL; absolute inputs remain absolute.
  const u = new URL(pathOrUrl, window.location.origin);

  if (host && !u.searchParams.get("host")) u.searchParams.set("host", host);
  if (shop && !u.searchParams.get("shop")) u.searchParams.set("shop", shop);
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export function forceTopFrameRedirect(urlOrPath = "/embedded", extraParams = {}) {
  const url = buildEmbeddedUrl(urlOrPath, extraParams); // always absolute & includes host/shop
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

  const fetchInit = { cache: "no-store", credentials: "include", ...baseInit };
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

        // If we got 401/403 *without* Shopify reauth headers, but it's our protected API,
  // fail forward by forcing a top-frame bounce through /api/auth.
  if ((res.status === 401 || res.status === 403) && sameOrigin(finalUrl) && isProtectedApi(finalUrl)) {
    if (__reauthInFlight) {
      return new Promise(() => {});
    }
    __reauthInFlight = true;

    const shop = getShop();
    const host = getHost();
    const to = buildEmbeddedUrl("/api/auth", { shop, host });

    // eslint-disable-next-line no-console
    console.log("[api] 401/403 without reauth headers → forcing /api/auth");
    forceTopFrameRedirect(to);
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
   - Use the unified `api()` which:
     • uses App Bridge authenticatedFetch
     • auto-appends shop/host for relative URLs
     • follows Shopify 401 reauth headers (top-frame redirect)
     • returns: { data, status, ok } or throws on non-OK
   ───────────────────────────────────────────────────────────── */

/* ---------------- Analytics API ---------------- */
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
    return api.get(url); // → { data, status, ok }
  },

  async getAnalyticsEvents({ limit, cursor } = {}) {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    const url = `/api/admin/analytics/logs${qs.toString() ? `?${qs.toString()}` : ""}`;
    return api.get(url);
  },
};

/* ---------------- Billing API ---------------- */
export const billingApi = {
  async getPlan({ fresh } = {}) {
    // Do NOT force fresh=1 by default. Let callers decide.
    const url = fresh ? `/api/billing/plan?fresh=1` : `/api/billing/plan`;
    return api.get(url);
  },

  async upgrade({ returnUrl } = {}) {
    const payload = returnUrl ? { returnUrl } : {};
    return api.post(`/api/billing/upgrade`, payload);
  },

  async downgrade() {
    return api.post(`/api/billing/downgrade`, {});
  },

  async status() {
    return api.get(`/api/billing/status`);
  },

  async sync() {
    return api.post(`/api/billing/sync`, {});
  },

  // Legacy (kept for backwards compat; not used by the new Billing page)
  async subscribe({ plan, returnUrl } = {}) {
    return api.post(`/api/billing/subscribe`, { plan, returnUrl });
  },
};

export default api;
