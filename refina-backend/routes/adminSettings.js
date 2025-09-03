import { Router } from "express";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

/* ───────── Store resolution (WITH DEBUG LOGGING) ───────── */
const sanitize = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
const FULL_SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function toMyshopifyDomain(raw) {
  const s = sanitize(raw);
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : "";
}

function shopFromHostB64(hostB64) {
  if (!hostB64) return "";
  try {
    const decoded = Buffer.from(hostB64, "base64").toString("utf8");
    const mAdmin = decoded.match(/^admin\.shopify\.com\/store\/([^\/?#]+)/i);
    if (mAdmin?.[1]) {
      const full = `${sanitize(mAdmin[1])}.myshopify.com`;
      return FULL_SHOP_RE.test(full) ? full : "";
    }
    const mShop = decoded.match(/^([^\/?#]+)\.myshopify\.com\/admin/i);
    if (mShop?.[1]) {
      const full = `${sanitize(mShop[1])}.myshopify.com`;
      return FULL_SHOP_RE.test(full) ? full : "";
    }
  } catch {}
  return "";
}

function shopFromIdToken(idToken) {
  if (!idToken || !idToken.includes(".")) return "";
  try {
    const base64 = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    const dest = payload?.dest;
    if (dest) {
      const hostname = new URL(dest).hostname.toLowerCase();
      return FULL_SHOP_RE.test(hostname) ? hostname : "";
    }
  } catch {}
  return "";
}

function resolveShop(source = {}) {
  console.log("[resolveShop] Starting resolution with source:", source);

  // 0) Prefer Shopify header
  const headerShop = source["x-shopify-shop-domain"] || source["X-Shopify-Shop-Domain"] || source.shopifyShop || "";
  console.log(`[resolveShop] 0. Header check: found raw value '${headerShop}'`);
  if (headerShop) {
    const full = toMyshopifyDomain(headerShop);
    if (FULL_SHOP_RE.test(full)) {
      console.log(`[resolveShop] 0. SUCCESS from header: '${full}'`);
      return full;
    }
  }

  // 1) Explicit query/body
  const raw = source.shop || source.storeId || "";
  console.log(`[resolveShop] 1. Query/Body check: found raw value '${raw}'`);
  if (raw) {
    const s = sanitize(raw);
    console.log(`[resolveShop] 1. Sanitized value: '${s}'`);
    const isMatch = FULL_SHOP_RE.test(s);
    console.log(`[resolveShop] 1. Regex test result: ${isMatch}`);
    if (isMatch) {
      console.log(`[resolveShop] 1. SUCCESS from query/body: '${s}'`);
      return s;
    }
  }

  // 2) host (base64)
  const fromHost = shopFromHostB64(source.host);
  console.log(`[resolveShop] 2. Host (b64) check: resolved to '${fromHost}'`);
  if (fromHost) {
    console.log(`[resolveShop] 2. SUCCESS from host: '${fromHost}'`);
    return fromHost;
  }

  // 3) id_token (Shopify JWT)
  const fromJwt = shopFromIdToken(source.id_token || source.idToken);
  console.log(`[resolveShop] 3. JWT check: resolved to '${fromJwt}'`);
  if (fromJwt) {
    console.log(`[resolveShop] 3. SUCCESS from JWT: '${fromJwt}'`);
    return fromJwt;
  }

  console.log("[resolveShop] FAILED: No shop could be resolved.");
  return "";
}

/* ───────── Router ───────── */

const router = Router();

router.get("/store-settings", async (req, res) => {
  console.log("GET /api/admin/store-settings request received.");
  const shop = resolveShop({ ...(req.query || {}), ...(req.headers || {}) });
  if (!shop) {
    console.error("[GET /store-settings] Failed to resolve shop. Responding with 400.");
    return res.status(400).json({ error: "shop required" });
  }

  try {
    const ref = dbAdmin.collection("storeSettings").doc(shop);
    const snap = await ref.get();
    const settings = snap.exists ? (snap.data() || {}) : { plan: "free" };
    res.set("Cache-Control", "no-store");
    return res.json({ storeId: shop, settings });
  } catch (e) {
    console.error("GET /api/admin/store-settings DB error:", e?.message || e);
    return res.status(500).json({ error: "read_failed", message: e.message });
  }
});

router.put("/store-settings", async (req, res) => {
  console.log("PUT /api/admin/store-settings request received.");
  try {
    const shop = resolveShop({ ...(req.query || {}), ...(req.body || {}), ...(req.headers || {}) });
    if (!shop) {
      console.error("[PUT /store-settings] Failed to resolve shop. Responding with 400.");
      return res.status(400).json({ error: "shop required" });
    }

    const settings = req.body?.settings || {};
    const ref = dbAdmin.collection("storeSettings").doc(shop);
    await ref.set({ ...settings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const fresh = await ref.get();
    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      storeId: shop,
      settings: fresh.exists ? fresh.data() : settings,
    });
  } catch (e) {
    console.error("PUT /api/admin/store-settings DB error:", e?.message || e);
    return res.status(500).json({ error: "update_failed" });
  }
});

export default router;

