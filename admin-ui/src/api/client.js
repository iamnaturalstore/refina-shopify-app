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
  } catch {}
})();

function getPersisted(key, storeKey) {
  const q = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const h = new URLSearchParams(hashQ);
  return q.get(key) || h.get(key) || sessionStorage.getItem(storeKey) || "";
}

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
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

export async function api(path, init = {}) {
  getAppBridge(); // throws fast if misconfigured
  const finalUrl = withContext(path);
  const isJSON = init.body && typeof init.body === "object" && !(init.body instanceof FormData);
  const baseInit = isJSON
    ? { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) }, body: JSON.stringify(init.body) }
    : init;
  const fetchInit = { cache: "no-store", ...baseInit };
  const res = await _fetchFn(finalUrl, fetchInit);
  if (res.status === 401 || res.status === 403) {
    const need = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1";
    const to = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url");
    if (need && to) {
      window.top.location.href = to;
      return new Promise(() => {});
    }
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || (typeof data === "string" ? data : "") || "Request failed";
    throw new Error(msg);
  }
  return { data, status: res.status, ok: res.ok }; // Return a consistent object
}

// NEW: Add convenience wrappers to the main 'api' function object
api.get = (path, init) => api(path, { ...init, method: "GET" });
api.post = (path, body, init) => api(path, { ...init, method: "POST", body });
api.put = (path, body, init) => api(path, { ...init, method: "PUT", body });
api.delete = (path, init) => api(path, { ...init, method: "DELETE" });

export default api;
