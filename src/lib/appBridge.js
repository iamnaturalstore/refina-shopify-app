// Safe, CDN-friendly App Bridge access (no React wrapper).
export function getApiKeyFromMeta() {
  return document.querySelector('meta[name="shopify-api-key"]')?.content || "";
}

export function getHostParam() {
  // Keep the *encoded* host – App Bridge expects the base64 host param.
  const p = new URLSearchParams(window.location.search);
  return p.get("host") || window.__SHOPIFY_DEV_HOST__ || "";
}

function getABGlobal() {
  // Try a few common globals the CDN may expose
  return (
    window.appBridge ||
    window["app-bridge"] ||
    (window.Shopify && window.Shopify.appBridge) ||
    window.ShopifyAppBridge ||
    null
  );
}

export function getAppBridge() {
  const AB = getABGlobal();
  if (!AB) return null;

  if (!window.__AB_APP__) {
    const apiKey = getApiKeyFromMeta();
    const host = getHostParam();
    if (!apiKey || !host) return null;

    // UMD exposes createApp on the global
    window.__AB_APP__ = AB.createApp({ apiKey, host });
  }
  return window.__AB_APP__;
}

export function getActions() {
  const AB = getABGlobal();
  return AB?.actions || null;
}
