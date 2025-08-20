// refina-backend/utils/resolveStore.js
const sanitize = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9\-_.]/g, "");

export function toMyshopifyDomain(raw) {
  const s = sanitize(raw);
  if (!s) return "";
  if (s.endsWith(".myshopify.com")) return s;
  return `${s}.myshopify.com`;
}

export function shopFromHostB64(hostB64) {
  if (!hostB64) return "";
  try {
    const decoded = Buffer.from(hostB64, "base64").toString("utf8");
    // admin.shopify.com/store/<store>
    const mAdmin = decoded.match(/^admin\.shopify\.com\/store\/([^\/?#]+)/i);
    if (mAdmin?.[1]) return `${mAdmin[1].toLowerCase()}.myshopify.com`;
    // <shop>.myshopify.com/admin
    const mShop = decoded.match(/^([^\/?#]+)\.myshopify\.com\/admin/i);
    if (mShop?.[1]) return `${mShop[1].toLowerCase()}.myshopify.com`;
  } catch {}
  return "";
}

export function shopFromIdToken(idToken) {
  if (!idToken || !idToken.includes(".")) return "";
  try {
    const base64 = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    const dest = payload?.dest; // e.g., https://refina-demo.myshopify.com
    if (dest) {
      const hostname = new URL(dest).hostname.toLowerCase();
      if (hostname.endsWith(".myshopify.com")) return hostname;
    }
  } catch {}
  return "";
}

export function resolveStoreDomain(q = {}) {
  // 1) storeId | shop (handle or full domain)
  const raw = q.storeId || q.shop;
  if (raw) {
    const dom = toMyshopifyDomain(raw);
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dom)) return dom;
  }
  // 2) host (base64)
  const fromHost = shopFromHostB64(q.host);
  if (fromHost) return fromHost;
  // 3) id_token / idToken (JWT with .dest)
  const fromJwt = shopFromIdToken(q.id_token || q.idToken);
  if (fromJwt) return fromJwt;
  return "";
}

export function assertShop(q = {}) {
  const shop = resolveStoreDomain(q);
  if (!shop) {
    const e = new Error("storeId or shop is required");
    e.status = 400;
    throw e;
  }
  return shop;
}
