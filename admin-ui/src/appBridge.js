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
let _nav = null;
let _navInitialized = false;

/** Build a hash-based in-app destination preserving host (& shop) */
function buildHashDestination(path, { host, shop }) {
  let p = String(path || "").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.startsWith("/#/")) p = p.slice(2); // "/#/x" -> "/x"

  const qs = new URLSearchParams();
  if (host) qs.set("host", host);
  if (shop) qs.set("shop", shop);
  const q = qs.toString();
  return q ? `#${p}?${q}` : `#${p}`;
}

function ensureNavigationMenu(app, { host, shop }) {
  if (_navInitialized) return _nav;
  _navInitialized = true;

  try {
    const { NavigationMenu } = actions;
    if (!NavigationMenu) return null;

    const items = [
      { label: "Home",      destination: buildHashDestination("/",          { host, shop }) },
      { label: "Setup",     destination: buildHashDestination("/setup",     { host, shop }) },
      { label: "Analytics", destination: buildHashDestination("/analytics", { host, shop }) },
      { label: "Settings",  destination: buildHashDestination("/settings",  { host, shop }) },
      { label: "Billing",   destination: buildHashDestination("/billing",   { host, shop }) },
    ];

    _nav = NavigationMenu.create(app, { items });

    // Keep active item synced with current hash route
    const updateActive = () => {
      const raw = String(window.location.hash || "").replace(/^#/, ""); // "/path?host=..."
      const path = `/${raw.split("?")[0].replace(/^\/?/, "")}`;

      let idx = 0;
      if (path.startsWith("/setup")) idx = 1;
      else if (path.startsWith("/analytics")) idx = 2;
      else if (path.startsWith("/settings")) idx = 3;
      else if (path.startsWith("/billing")) idx = 4;

      try { _nav.set({ active: idx }); } catch {}
    };

    updateActive();
    window.addEventListener("hashchange", updateActive);

    return _nav;
  } catch (e) {
    console.warn("NavigationMenu init skipped:", e?.message || e);
    return null;
  }
}

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

  // Step 6: initialize NavigationMenu with deep links (includes Setup)
  ensureNavigationMenu(_app, { host, shop });

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
