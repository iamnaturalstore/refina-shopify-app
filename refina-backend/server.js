// refina/backend/server.js

import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import shopify from "./shopify.js";
import billingRoutes from "./routes/billing.js";

// 🔐 Downgrade to free on uninstall (Firestore)
import admin from "firebase-admin";

dotenv.config({ path: "../.env" }); // 👈 Ensure it loads from root

// --- Firebase Admin init (reuses existing init if present) ---
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_KEY) {
    console.warn("⚠️ FIREBASE_SERVICE_KEY missing — uninstall webhook will not update Firestore.");
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_KEY)),
    });
  }
}
const db = admin.apps.length ? admin.firestore() : null;

const app = express();

// Needed to resolve __dirname with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Middleware
app.use(cookieParser());
app.use(express.json());

// Optional: Shopify protection middleware (only if you’re using embedded app SDK)
// app.use(shopify.cspHeaders())
// app.use(shopify.verifyRequest())

// ✅ Routes
app.use("/api/billing", billingRoutes);

// 🔔 Webhook receiver (Shopify will POST here)
app.post("/webhooks", express.text({ type: "*/*" }), async (req, res) => {
  try {
    await shopify.webhooks.process({
      rawBody: req.body,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (e) {
    console.error("❌ Webhook processing failed", e);
    res.status(500).send("Webhook error");
  }
});

// 🧩 Register webhook handlers at startup
shopify.webhooks.addHandlers({
  APP_UNINSTALLED: {
    deliveryMethod: shopify.api.webhooks.deliveryMethod.Http,
    callbackUrl: "/webhooks",
    // Downgrade to free when the app is uninstalled
    callback: async (_topic, shop /*, body */) => {
      try {
        if (!db) {
          console.warn("⚠️ Firestore not initialized; cannot downgrade on uninstall.");
          return;
        }
        const storeId = shop.replace(".myshopify.com", "");
        await db.collection("plans").doc(storeId).set(
          {
            level: "free",
            shopDomain: shop,
            chargeId: null,
            trialEndsAt: null,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        console.log(`🔻 ${shop} uninstalled. Downgraded to free.`);
      } catch (err) {
        console.error("❌ Failed to downgrade plan on uninstall:", err);
      }
    },
  },
});

// (Optional) Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development" });
});

// ✅ Start server
const PORT = process.env.BACKEND_PORT || 3000;

app.listen(PORT, () => {
  console.log("✅ HOST from .env:", process.env.HOST);
  console.log(`🚀 Backend server running at http://localhost:${PORT}`);
});
