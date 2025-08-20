// refina-backend/routes/adminSettings.js
import { Router } from "express";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

/* ───────── Store resolution ───────── */

// light sanitize
const sanitize = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9\-_.]/g, "");

/** Canonicalize to "<shop>.myshopify.com" */
function toMyshopifyDomain(raw) {
  const s = sanitize(raw);
  if (!s) return "";
  if (s.endsWith(".myshopify.com")) return s;
  return `${s}.myshopify.com`;
}

/** host (base64) → "<shop>.myshopify.com" */
function shopFromHostB64(hostB64) {
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

/** id_token (JWT) → "<shop>.myshopify.com" via payload.dest */
function shopFromIdToken(idToken) {
  if (!idToken || !idToken.includes(".")) return "";
  try {
    const base64 = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    const dest = payload?.dest; // e.g. "https://refina-demo.myshopify.com"
    if (dest) {
      const hostname = new URL(dest).hostname.toLowerCase();
      if (hostname.endsWith(".myshopify.com")) return hostname;
    }
  } catch {}
  return "";
}

/** Resolve incoming store identifier from query/body and canonicalize */
function resolveShop(source) {
  const q = source || {};
  // 1) explicit storeId | shop
  const raw = q.storeId || q.shop;
  if (raw) {
    const dom = toMyshopifyDomain(raw);
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dom)) return dom;
  }
  // 2) host (base64)
  const fromHost = shopFromHostB64(q.host);
  if (fromHost) return fromHost;
  // 3) id_token (Shopify JWT)
  const fromJwt = shopFromIdToken(q.id_token || q.idToken);
  if (fromJwt) return fromJwt;
  return "";
}

function assertShop(q) {
  const shop = resolveShop(q);
  if (!shop) {
    const e = new Error("storeId is required");
    e.status = 400;
    throw e;
  }
  return shop;
}

/* ───────── Router ───────── */

const router = Router();

/** GET /api/admin/store-settings?storeId|shop|host|id_token */
router.get("/store-settings", async (req, res, next) => {
  try {
    const shop = assertShop(req.query);
    const doc = await dbAdmin.collection("storeSettings").doc(shop).get();
    // We keep plan inside settings for backward compatibility with your UI
    const settings = doc.exists ? doc.data() : { plan: "free" };
    res.json({ storeId: shop, settings });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/store-settings
 * body: { storeId|shop|host|id_token, settings: { ... } }
 */
router.put("/store-settings", async (req, res, next) => {
  try {
    const shop = assertShop({ ...req.query, ...req.body });
    const settings = req.body?.settings || {};
    await dbAdmin.collection("storeSettings").doc(shop).set(
      { ...settings, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    const fresh = await dbAdmin.collection("storeSettings").doc(shop).get();
    res.json({ ok: true, storeId: shop, settings: fresh.exists ? fresh.data() : settings });
  } catch (err) {
    next(err);
  }
});

export default function mountAdminSettingsRoutes(app) {
  app.use("/api/admin", router);
}
