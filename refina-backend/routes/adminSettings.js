import { Router } from "express";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

/* ───────── Store resolution ───────── */

// light sanitize
const sanitize = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9\-_.]/g, "");

/** Strict full-domain check: "<shop>.myshopify.com" */
const FULL_SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify.com$/;

/** Canonicalize only when already full "<shop>.myshopify.com" */
function toMyshopifyDomain(raw) {
  const s = sanitize(raw);
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : "";
}

/** host (base64) → "<shop>.myshopify.com" */
function shopFromHostB64(hostB64) {
  if (!hostB64) return "";
  try {
    const decoded = Buffer.from(hostB64, "base64").toString("utf8");
    // admin.shopify.com/store/<store>
    const mAdmin = decoded.match(/^admin\.shopify\.com\/store\/([^\/?#]+)/i);
    if (mAdmin?.[1]) {
      const full = `${sanitize(mAdmin[1])}.myshopify.com`;
      return FULL_SHOP_RE.test(full) ? full : "";
    }
    // <shop>.myshopify.com/admin
    const mShop = decoded.match(/^([^\/?#]+)\.myshopify\.com\/admin/i);
    if (mShop?.[1]) {
      const full = `${sanitize(mShop[1])}.myshopify.com`;
      return FULL_SHOP_RE.test(full) ? full : "";
    }
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
      return FULL_SHOP_RE.test(hostname) ? hostname : "";
    }
  } catch {}
  return "";
}

/** Resolve incoming store identifier from headers/query/body and canonicalize (full domain only) */
function resolveShop(source = {}) {
  // 0) Prefer Shopify header if present
  const headerShop =
    source["x-shopify-shop-domain"] ||
    source["X-Shop-Domain"] ||
    source.shopifyShop ||
    "";
  if (headerShop) {
    const full = toMyshopifyDomain(headerShop);
    if (FULL_SHOP_RE.test(full)) return full;
  }

  // 1) Explicit query/body: only accept values that are already full domains
  const raw = source.shop || source.storeId || "";
  if (raw) {
    const s = sanitize(raw);
    if (FULL_SHOP_RE.test(s)) return s; // ❗ do NOT auto-append for bare handles
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
 * Returns { storeId, settings }.
 */
router.get("/store-settings", async (req, res) => {
  const shop = resolveShop({ ...(req.query || {}), ...(req.headers || {}) });
  if (!shop) {
    return res.status(400).json({ error: "shop required" });
  }

  try {
    console.log(`[GET /store-settings] Shop: ${shop}, dbAdmin valid: ${!!dbAdmin}. Attempting DB read...`);
    const ref = dbAdmin.collection("storeSettings").doc(shop);
    
    // ADDED LOGS AROUND THE DATABASE CALL
    console.log(`[GET /store-settings] Getting document: ${ref.path}`);
    const snap = await ref.get();
    console.log(`[GET /store-settings] DB read complete. Document exists: ${snap.exists}`);

    const settings = snap.exists ? (snap.data() || {}) : { plan: "free" };
    res.set("Cache-Control", "no-store");
    return res.json({ storeId: shop, settings });
  } catch (e) {
    console.error("GET /api/admin/store-settings DB error:", e?.message || e);
    return res.status(500).json({ error: "read_failed", message: e.message });
  }
});

/** PUT /api/admin/store-settings
 * Body: { storeId|shop|host|id_token, settings: { ... } }
 */
router.put("/store-settings", async (req, res) => {
  try {
    const shop = resolveShop({ ...(req.query || {}), ...(req.body || {}), ...(req.headers || {}) });
    if (!shop) {
      return res.status(400).json({ error: "shop required" });
    }
    
    console.log(`[PUT /store-settings] Shop: ${shop}, dbAdmin valid: ${!!dbAdmin}. Attempting DB write...`);
    const settings = req.body?.settings || {};
    const ref = dbAdmin.collection("storeSettings").doc(shop);

    await ref.set({ ...settings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log(`[PUT /store-settings] DB write for ${ref.path} complete.`);

    const fresh = await ref.get();
    res.set("Cache-Control", "no-store");
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

