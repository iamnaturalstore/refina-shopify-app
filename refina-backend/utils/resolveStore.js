// refina-backend/utils/resolveStore.js
const sanitize = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9\-_.:/?#]/g, "");

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  // If it's a URL, use the hostname
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const h = (u.hostname || "").toLowerCase();
      return h.endsWith(".myshopify.com") ? h : "";
    }
  } catch { /* ignore */ }
  const cleaned = sanitize(s);
  return cleaned.endsWith(".myshopify.com") ? cleaned : "";
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
  // 1) require ?shop (full myshopify domain)
  const rawShop = q.shop || "";
  const dom = toMyshopifyDomain(rawShop);
  if (dom) return dom;

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
    const e = new Error("shop is required");
    e.status = 400;
    throw e;
  }
  return shop;
}

export { toMyshopifyDomain };
