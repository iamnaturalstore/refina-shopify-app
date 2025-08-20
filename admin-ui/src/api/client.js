// admin-ui/src/api/client.js — FINAL
import createApp from "@shopify/app-bridge";
import { authenticatedFetch } from "@shopify/app-bridge-utils";

// Persist host/shop/storeId once per load to survive navigation
(function persistParams() {
  const q = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const h = new URLSearchParams(hashQ);
  const pick = (k) => q.get(k) || h.get(k) || null;
  const pairs = [["host","shopify-host"], ["shop","shopify-shop"], ["storeId","storeId"]];
  for (const [key, storeKey] of pairs) {
    const v = pick(key);
    if (v) sessionStorage.setItem(storeKey, v);
  }
})();

function getPersisted(key, storeKey) {
  const q = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const h = new URLSearchParams(hashQ);
  return q.get(key) || h.get(key) || sessionStorage.getItem(storeKey) || "";
}

function getHost()   { return getPersisted("host", "shopify-host"); }
function getShop()   { return getPersisted("shop", "shopify-shop"); }
export function getStoreIdFromUrl() {
  const explicit = getPersisted("storeId", "storeId");
  if (explicit) return explicit.toLowerCase();
  const s = getShop().toLowerCase();
  return s.endsWith(".myshopify.com") ? s.replace(".myshopify.com", "") : "";
}

export function withContext(path) {
  const url = new URL(path, window.location.origin);
  const params = new URLSearchParams(url.search);
  const host = getHost(), shop = getShop(), storeId = getPersisted("storeId", "storeId");
  if (host && !params.has("host")) params.set("host", host);
  if (shop && !params.has("shop")) params.set("shop", shop);
  if (storeId && !params.has("storeId")) params.set("storeId", storeId);
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
  const res = await _fetchFn(finalUrl, isJSON
    ? { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) }, body: JSON.stringify(init.body) }
    : init
  );
  if (res.status === 401 || res.status === 403) {
    const need = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1";
    const to = res.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url");
    if (need && to) { window.top.location.href = to; return new Promise(() => {}); }
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}
