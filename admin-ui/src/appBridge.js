// admin-ui/src/appBridge.js
import createApp from "@shopify/app-bridge";
import * as actions from "@shopify/app-bridge/actions";

/** Canonicalize to "<shop>.myshopify.com" */
function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

/** Resolve API key injected at build time; fallback to Vite env if defined */
function requireApiKey() {
  const fromDefine =
    typeof __APP_BRIDGE_API_KEY__ !== "undefined" && __APP_BRIDGE_API_KEY__
      ? __APP_BRIDGE_API_KEY__
      : undefined;
  const fromVite = import.meta.env?.VITE_SHOPIFY_API_KEY;
  const apiKey = fromDefine || fromVite;
  if (!apiKey) {
    throw new Error(
      "[AppBridge] Missing API key. Ensure admin-ui/vite.config.js defines __APP_BRIDGE_API_KEY__ (or VITE_SHOPIFY_API_KEY)."
    );
  }
  return apiKey;
}

let _app = null;
let _context = null;

function ensureAppBridge() {
  if (_app) return _app;

  const qs = new URLSearchParams(window.location.search || "");
  let shop = (qs.get("shop") || "").trim().toLowerCase();
  let storeId = (qs.get("storeId") || "").trim().toLowerCase();
  let host = qs.get("host");

  // Canonicalize
  if (storeId) storeId = toMyshopifyDomain(storeId);
  if (!shop && storeId) shop = storeId;

  // Derive shop from host if needed
  if (!shop && host) {
    try {
      const decoded = atob(host); // "<shop>.myshopify.com/admin"
      const candidate = (decoded.split("/")[0] || "").toLowerCase();
      if (candidate.endsWith(".myshopify.com")) shop = candidate;
    } catch { /* ignore */ }
  }

  // Compute host if missing
  if (!host && shop) host = btoa(`${shop}/admin`);

  // Hard guards for embedded Admin
  if (!shop) throw new Error("[AppBridge] Missing 'shop' (<shop>.myshopify.com) in URL.");
  if (!host) throw new Error("[AppBridge] Missing 'host' in URL.");

  // ⬇️ Minimal guard: if top-level on "/embedded", normalize to "/" before App Bridge re-embeds
  try {
    if (window.top === window.self && window.location.pathname === "/embedded") {
      const u = new URL(window.location.href);
      u.pathname = "/";
      window.history.replaceState({}, "", u.toString());
    }
  } catch {}

  const apiKey = requireApiKey();
  _app = createApp({ apiKey, host, forceRedirect: true });

  _context = { app: _app, actions, shop, host, storeId: shop };
  return _app;
}

/** Default export: singleton App Bridge instance */
const app = ensureAppBridge();
export default app;

/** Optional accessor for consumers needing the full context */
export function initAppBridge() {
  ensureAppBridge();
  return _context;
}

export { actions };
