// refina-backend/routes/privacyWebhooks.js
import express from "express";
import crypto from "crypto";
import { dbAdmin } from "../lib/firestore.js";

const router = express.Router();

// Use raw body for HMAC verification (must be mounted before any JSON parser)
const rawJson = express.raw({ type: "application/json" });

function verifyShopifyHmacFromRaw(req) {
  const secret =
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    "";
  if (!secret) return false;

  const receivedB64 = String(req.get("X-Shopify-Hmac-Sha256") || "");

  // Normalize body to a Buffer
  let bodyBuf;
  const b = req.body;
  if (Buffer.isBuffer(b)) {
    bodyBuf = b;
  } else if (typeof b === "string") {
    bodyBuf = Buffer.from(b, "utf8");
  } else if (b && typeof b === "object") {
    bodyBuf = Buffer.from(JSON.stringify(b));
  } else {
    bodyBuf = Buffer.alloc(0);
  }

  // Compute raw HMAC bytes and compare to decoded header
  const digestRaw = crypto.createHmac("sha256", secret).update(bodyBuf).digest(); // <Buffer>
  const receivedRaw = Buffer.from(receivedB64, "base64");

  if (receivedRaw.length !== digestRaw.length) return false;
  return crypto.timingSafeEqual(receivedRaw, digestRaw);
}

// --- APP_UNINSTALLED webhook -----------------------------------
router.post("/app_uninstalled", rawJson, async (req, res) => {
  try {
    if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");

    // Shopify passes shop domain via header; payload also contains it
    const shop = (req.get("X-Shopify-Shop-Domain") || "").toLowerCase();
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

// Helpers for safe logging if body isn’t a Buffer
const asBodyString = (req) =>
  Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);

// POST /api/privacy/customers/data_request
router.post("/customers/data_request", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("📨 GDPR customers/data_request:", asBodyString(req));
  return res.sendStatus(200);
});

// POST /api/privacy/customers/redact
router.post("/customers/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🗑️  GDPR customers/redact:", asBodyString(req));
  // TODO: remove customer PII in your DB if stored
  return res.sendStatus(200);
});

// POST /api/privacy/shop/redact
router.post("/shop/redact", rawJson, (req, res) => {
  if (!verifyShopifyHmacFromRaw(req)) return res.status(401).send("Invalid HMAC");
  console.log("🏪 GDPR shop/redact:", asBodyString(req));
  // TODO: remove shop PII in your DB if stored
  return res.sendStatus(200);
});

export default router;
