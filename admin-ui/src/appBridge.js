// admin-ui/src/appBridge.js — FINAL (full-domain IDs only, with initAppBridge alias)
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

/**
 * Initializes App Bridge and returns { app, actions, shop, host, storeId }.
 * Guarantees:
 * - shop   = "<shop>.myshopify.com"
 * - storeId = shop (full domain; never short)
 * - host is present (derived from shop if missing)
 * No dev fallbacks; no short-ID derivations.
 */
export default function appBridge() {
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
  const app = createApp({ apiKey, host, forceRedirect: true });

  // Always return full-domain storeId (same as shop)
  return { app, actions, shop, host, storeId: shop };
}

// 🔧 Compatibility alias for older imports
export function initAppBridge() {
  return appBridge();
}
