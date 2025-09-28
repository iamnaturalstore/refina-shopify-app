// refina-backend/routes/privacyWebhooks.js
import express from "express";
import crypto from "crypto";
import dbAdmin from "../utils/firebaseAdmin.js";

const router = express.Router();

// Use raw body for HMAC verification
const rawJson = express.raw({ type: "application/json" });

function verifyShopifyHmacFromRaw(req) {
  const secret =
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    "";
  const received = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest("base64");
  if (received.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(received));
}

// --- NEW: APP_UNINSTALLED webhook -------------------------------
router.post("/app_uninstalled", rawJson, async (req, res) => {
  try {
    if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");

    // Shopify passes shop domain via header; payload also contains it, but header is fine.
    const shop = req.get("X-Shopify-Shop-Domain") || "";
    if (!shop) {
      console.warn("[Webhook] APP_UNINSTALLED missing shop header");
      return res.sendStatus(400);
    }

    // Reset cached plan so a fresh install starts clean
    await dbAdmin
      .collection("plans")
      .doc(shop)
      .set(
        {
          level: "free",
          status: "NONE",
          updatedAt: Date.now(),
          // (optional) marker so you know why it flipped:
          _source: "webhook:APP_UNINSTALLED",
        },
        { merge: true }
      );

    console.log(`✅ APP_UNINSTALLED handled for ${shop} → plans/${shop} set to free/NONE`);
    return res.sendStatus(200);
  } catch (err) {
    console.error("[Webhook] APP_UNINSTALLED handler error", err);
    return res.sendStatus(500);
  }
});
// ---------------------------------------------------------------

// POST /api/privacy/customers/data_request
router.post("/customers/data_request", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("📨 GDPR customers/data_request:", req.body.toString());
  return res.sendStatus(200);
});

// POST /api/privacy/customers/redact
router.post("/customers/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🗑️  GDPR customers/redact:", req.body.toString());
  // TODO: remove customer PII in your DB if stored
  return res.sendStatus(200);
});

// POST /api/privacy/shop/redact
router.post("/shop/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🏪 GDPR shop/redact:", req.body.toString());
  // TODO: remove shop PII in your DB if stored
  return res.sendStatus(200);
});

export default router;
