import createApp from "@shopify/app-bridge";
import * as actions from "@shopify/app-bridge/actions";

// Canonicalize to "<shop>.myshopify.com" (lowercase)
function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

function requireEnvKey() {
  const k = import.meta.env.VITE_SHOPIFY_API_KEY;
  if (!k) throw new Error("VITE_SHOPIFY_API_KEY missing in admin-ui build");
  return k;
}

let _app = null;
let _context = null;

function ensureAppBridge() {
  if (_app) return _app;

  const qs = new URLSearchParams(window.location.search || "");

  let shop = (qs.get("shop") || "").trim().toLowerCase();
  let storeId = (qs.get("storeId") || "").trim().toLowerCase();
  let host = qs.get("host");

  // Canonicalize any provided storeId; prefer full domain everywhere
  if (storeId) storeId = toMyshopifyDomain(storeId);

  // If shop is missing but we have a (now full) storeId, mirror it
  if (!shop && storeId) shop = storeId;

  // If still missing, derive shop from host (base64 "<shop>.myshopify.com/admin")
  if (!shop && host) {
    try {
      const decoded = atob(host); // e.g., "refina-demo.myshopify.com/admin"
      const candidate = (decoded.split("/")[0] || "").toLowerCase();
      if (candidate.endsWith(".myshopify.com")) shop = candidate;
    } catch {
      /* ignore */
    }
  }

  // If host is missing but shop is known, compute it
  if (!host && shop) host = btoa(`${shop}/admin`);

  // Hard guards: in embedded admin we should always have both by now
  if (!shop) throw new Error("Missing 'shop' (<shop>.myshopify.com) in query/context");
  if (!host) throw new Error("Missing 'host' in query/context");

  const apiKey = requireEnvKey();
  _app = createApp({ apiKey, host, forceRedirect: true });

  // Always return full-domain storeId (same as shop)
  _context = { app: _app, actions, shop, host, storeId: shop };
  return _app;
}

/** Default export: the singleton App Bridge instance */
const app = ensureAppBridge();
export default app;

/** Compatibility accessor for pages that expect the full context shape */
export function initAppBridge() {
  ensureAppBridge();
  return _context;
}

export { actions };
