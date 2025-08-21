export function initAppBridge() {
  const qs = new URLSearchParams(window.location.search);

  // allow direct loads in dev; Shopify Admin passes both when embedded
  let storeId = (qs.get('storeId') || '').trim().toLowerCase();
  let shop = qs.get('shop');
  let host = qs.get('host');

  if (!shop && storeId) shop = `${storeId}.myshopify.com`;
  if (!host && shop) host = btoa(`${shop}/admin`);
  if (!shop) { storeId = 'iamnaturalstore'; shop = 'iamnaturalstore.myshopify.com'; }
  if (!host) host = btoa(`${shop}/admin`);

  const apiKey = import.meta.env.VITE_SHOPIFY_API_KEY;
  if (!apiKey) throw new Error('Missing VITE_SHOPIFY_API_KEY');

  const AB = window.appBridge || window.Shopify?.app;
  if (!AB?.createApp) throw new Error('App Bridge CDN not loaded');

  // only force-redirect when actually embedded (Shopify adds embedded=1)
  const isEmbedded = qs.get('embedded') === '1';
  const app = AB.createApp({ apiKey, shop, host, forceRedirect: isEmbedded });

  const actions = AB.actions || window.Shopify?.app?.actions;
  return { app, actions, shop, host, storeId };
}
