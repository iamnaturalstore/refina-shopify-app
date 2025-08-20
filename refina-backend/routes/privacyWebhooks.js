// refina-backend/routes/privacyWebhooks.js
import express from "express";
import crypto from "crypto";

const router = express.Router();

// Use raw body for HMAC verification
const rawJson = express.raw({ type: "application/json" });

function verifyShopifyHmacFromRaw(req) {
  const secret =
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    "";
  const received = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto.createHmac("sha256", secret).update(req.body).digest("base64");
  if (received.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(received));
}

// POST /api/webhooks/customers/data_request
router.post("/customers/data_request", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("📨 GDPR customers/data_request:", req.body.toString());
  return res.sendStatus(200);
});

// POST /api/webhooks/customers/redact
router.post("/customers/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🗑️  GDPR customers/redact:", req.body.toString());
  // TODO: remove customer PII in your DB if stored
  return res.sendStatus(200);
});

// POST /api/webhooks/shop/redact
router.post("/shop/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🏪 GDPR shop/redact:", req.body.toString());
  // TODO: remove shop PII in your DB if stored
  return res.sendStatus(200);
});

export default router;
