// refina-backend/utils/shopSession.js
import shopify from "../shopify.js";

export function normalizeShop(input) {
  if (!input) throw new Error("Missing shop");
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").split("/")[0];
  if (/^[a-z0-9-]+$/.test(s)) return `${s}.myshopify.com`;
  if (/^[a-z0-9-]+\.myshopify\.com$/.test(s)) return s;
  throw new Error("Invalid shop format");
}

/** Production path: require ONLINE embedded session.
 * Dev fallback (custom-app / offline) only when NODE_ENV!=='production'. */
export async function resolveAdminSession(req, res, maybeShop) {
  const currentId = await shopify.session.getCurrentId({
    isOnline: true,
    rawRequest: req,
    rawResponse: res,
  });
  if (currentId) {
    // FIX: load from sessionStorage instead of non-existent getSession()
    const online = await shopify.sessionStorage.loadSession(currentId);
    if (online) return online;
  }

  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    throw new Error("No embedded session. Open the app from Shopify Admin.");
  }

  const shop = maybeShop ? normalizeShop(maybeShop) : null;

  const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
  if (shop && ADMIN_TOKEN) {
    return shopify.session.customAppSession(shop);
  }

  const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
  if (shop && storage?.loadSession) {
    const offlineId = shopify.session.getOfflineId(shop);
    const offline = await storage.loadSession(offlineId);
    if (offline) return offline;
  }

  throw new Error("No Shopify session available (dev). Provide ?shop=<store> or open embedded app.");
}

export async function getAdminClient(req, res, maybeShop) {
  const session = await resolveAdminSession(req, res, maybeShop);
  return new shopify.clients.Graphql({ session });
}

export function shopToStoreId(shop) {
  if (!shop) throw new Error("Missing shop");
  return shop.split(".")[0];
}
