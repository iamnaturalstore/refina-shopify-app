// refina-backend/routes/privacyWebhooks.js
import express from "express";
import crypto from "crypto";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../lib/firestore.js";

const router = express.Router();
const rawJson = express.raw({ type: "application/json" });

function verifyShopifyHmacFromRaw(req) {
  const secret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_API_SECRET_KEY || "";
  if (!secret) return false;
  const received = String(req.get("X-Shopify-Hmac-Sha256") || "");

  let bodyBuf;
  const b = req.body;
  if (Buffer.isBuffer(b)) bodyBuf = b;
  else if (typeof b === "string") bodyBuf = Buffer.from(b, "utf8");
  else if (b && typeof b === "object") bodyBuf = Buffer.from(JSON.stringify(b));
  else bodyBuf = Buffer.alloc(0);

  const digest = crypto.createHmac("sha256", secret).update(bodyBuf).digest("base64");
  const recvBuf = Buffer.from(received);
  const digBuf = Buffer.from(digest);
  if (recvBuf.length !== digBuf.length) return false;
  return crypto.timingSafeEqual(recvBuf, digBuf);
}

/** Purge offline session(s) for a shop */
async function purgeOfflineSession(shop) {
  const storage = (shopify?.config && shopify.config.sessionStorage) || shopify?.sessionStorage || null;
  if (!storage?.deleteSession) return;

  const candidateIds = [];
  try { if (shopify?.session?.getOfflineId) candidateIds.push(shopify.session.getOfflineId(shop)); } catch {}
  try { if (shopify?.api?.session?.getOfflineId) candidateIds.push(shopify.api.session.getOfflineId(shop)); } catch {}
  candidateIds.push(`offline_${shop}`);

  const seen = new Set();
  for (const id of candidateIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try { await storage.deleteSession(id); } catch {}
  }
}

// --- APP_UNINSTALLED webhook ---
router.post("/app_uninstalled", rawJson, async (req, res) => {
  try {
    if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");

    const hdr = String(req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase();
    const shop = hdr.endsWith(".myshopify.com") ? hdr : (hdr ? `${hdr}.myshopify.com` : "");
    if (!shop) {
      console.warn("[Webhook] APP_UNINSTALLED missing/invalid shop header");
      return res.sendStatus(400);
    }

    // 1) Authoritative: force Free/NONE, clear interval, stamp uninstall
    await dbAdmin.collection("plans").doc(shop).set(
      {
        level: "free",
        status: "NONE",
        billingInterval: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
        _source: "webhook:APP_UNINSTALLED",
        uninstalledAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 2) Purge offline sessions
    try { await purgeOfflineSession(shop); } catch (e) {
      console.warn(`[Webhook] purgeOfflineSession failed for ${shop}:`, e?.message || e);
    }

    // 3) Optional cleanups (keep fast or queue)
    // try { await dbAdmin.collection("storeSettings").doc(shop).delete(); } catch {}

    console.log(`✅ APP_UNINSTALLED handled for ${shop}: plan→free/NONE, sessions purged`);
    return res.sendStatus(200);
  } catch (err) {
    console.error("[Webhook] APP_UNINSTALLED handler error", err);
    return res.sendStatus(500);
  }
});

// GDPR stubs (unchanged)
router.post("/customers/data_request", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("📨 GDPR customers/data_request:", req.body.toString());
  return res.sendStatus(200);
});
router.post("/customers/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🗑️  GDPR customers/redact:", req.body.toString());
  return res.sendStatus(200);
});
router.post("/shop/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🏪 GDPR shop/redact:", req.body.toString());
  return res.sendStatus(200);
});

export default router;
