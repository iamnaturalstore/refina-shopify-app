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
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
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
function resolveShop(source = {}) {
  // 1) explicit storeId | shop
  const raw = source.storeId || source.shop;
  if (raw) {
    const dom = toMyshopifyDomain(raw);
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dom)) return dom;
  }
  // 2) host (base64)
  const fromHost = shopFromHostB64(source.host);
  if (fromHost) return fromHost;
  // 3) id_token (Shopify JWT)
  const fromJwt = shopFromIdToken(source.id_token || source.idToken);
  if (fromJwt) return fromJwt;
  return "";
}

/* ───────── Router ───────── */

const router = Router();

/** GET /api/admin/store-settings?storeId|shop|host|id_token
 *  Returns { storeId, settings }. Never 500s on read.
 */
router.get("/store-settings", async (req, res) => {
  const shop = resolveShop(req.query);
  if (!shop) return res.status(400).json({ error: "shop required" });

  try {
    const ref = dbAdmin.collection("storeSettings").doc(shop);
    const snap = await ref.get();
    // Keep minimal back-compat: default plan "free" if nothing there
    const settings = snap.exists ? (snap.data() || {}) : { plan: "free" };
    return res.json({ storeId: shop, settings });
  } catch (e) {
    console.error("GET /api/admin/store-settings error:", e?.message || e);
    // don’t 500 on read; UI can work with empty settings
    return res.json({ storeId: shop, settings: {} });
  }
});

/** PUT /api/admin/store-settings
 *  Body: { storeId|shop|host|id_token, settings: { ... } }
 */
router.put("/store-settings", async (req, res) => {
  try {
    const shop = resolveShop({ ...(req.query || {}), ...(req.body || {}) });
    if (!shop) return res.status(400).json({ error: "shop required" });

    const settings = req.body?.settings || {};
    const ref = dbAdmin.collection("storeSettings").doc(shop);
    await ref.set({ ...settings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    const fresh = await ref.get();
    return res.json({
      ok: true,
      storeId: shop,
      settings: fresh.exists ? fresh.data() : settings,
    });
  } catch (e) {
    console.error("PUT /api/admin/store-settings error:", e?.message || e);
    return res.status(500).json({ error: "update_failed" });
  }
});

export default router;
