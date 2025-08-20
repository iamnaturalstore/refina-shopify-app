const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export function getStoreIdFromHost() {
  const params = new URLSearchParams(window.location.search);

  const shopParam = params.get("shop");
  if (shopParam && SHOP_DOMAIN_RE.test(shopParam)) return shopParam;

  const host = params.get("host") || window.__SHOPIFY_DEV_HOST__ || "";
  if (host) {
    try {
      const decoded = atob(host); // e.g. "refina-demo.myshopify.com/admin"
      const shopDomain = decoded.split("/")[0];
      if (SHOP_DOMAIN_RE.test(shopDomain)) return shopDomain;
    } catch {}
  }

  return (
    window.__SHOPIFY_DEV_SHOP__ ||
    import.meta.env.VITE_DEFAULT_SHOP_DOMAIN ||
    "refina-demo.myshopify.com"
  );
}
