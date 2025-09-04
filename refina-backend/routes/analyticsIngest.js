//refina-backend/routes/analyticsIngest.js
// // PROD-CHECKLIST:
// - Enforce full-domain shop only (toMyshopifyDomain); no short IDs
// - No wildcards; no renames; keep aliases so storefront posts don't miss
// - Security: HMAC for App Proxy path handled upstream; here we canonicalize & bound inputs
// - Telemetry headers set; Cache-Control no-store
// - Do NOT persist storeId or createdAt fields

import { Router } from "express";
import { db, nowTs } from "../bff/lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

const router = Router({ caseSensitive: false });

function canonShopFrom(req) {
  const raw =
    (req.query && (req.query.shop || req.query.storeId)) ||
    req.get("x-shopify-shop-domain") ||
    (req.body && (req.body.shop || req.body.storeId)) ||
    "";
  return toMyshopifyDomain(String(raw || "").toLowerCase().trim());
}

// FINAL FIX: This function now accepts the fields being sent by the storefront.
function sanitizeEventBody(body = {}) {
  const out = {};
  if (!body || typeof body !== 'object') return out;

  // Accept fields from CustomerRecommender.jsx
  if (typeof body.type === "string") out.type = body.type.slice(0, 64);
  if (typeof body.concern === "string") out.concern = body.concern.slice(0, 512);
  if (Array.isArray(body.productIds)) {
    out.productIds = body.productIds.map(id => String(id)).slice(0, 50);
  }
  
  // Also keep the original, more generic structure for flexibility
  if (typeof body.event === "string") out.event = body.event.slice(0, 64);
  if (typeof body.uid === "string") out.uid = body.uid.slice(0, 128);
  
  // Sanitize meta object
  if (body.meta && typeof body.meta === 'object') {
    const sanitizedMeta = {};
    for (const [key, value] of Object.entries(body.meta).slice(0, 20)) {
       sanitizedMeta[String(key).slice(0, 40)] = String(value).slice(0, 256);
    }
    out.meta = sanitizedMeta;
  }
  
  // Legacy payload support
  if (body.payload && typeof body.payload === "object") {
    out.payload = body.payload; // Assuming payload is already structured safely
  }

  return out;
}

// Core write: analytics/{shop}/events/<autoId>
async function writeEvent(shop, data) {
  const ref = db.collection(`analytics/${shop}/events`).doc();
  const toWrite = {
    ...data,
    ts: nowTs() // Use server timestamp for accuracy
  };
  // Remove fields we don't want to persist
  delete toWrite.shop;
  delete toWrite.storeId;
  delete toWrite.createdAt;

  await ref.set(toWrite);
  return ref.id;
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// Storefront (App Proxy mount): server mounts router at /proxy/refina/v1/analytics/ingest
router.post("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-storefront-v2");
  // App Proxy verification is done upstream in server.js
  const shop = req.shopDomain || canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "shop_required" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    const id = await writeEvent(shop, {
      ...clean,
      source: "storefront"
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("[analyticsIngest] storefront write failed:", e?.message || e);
    res.status(500).json({ error: "internal_error" });
  }
});

// Admin/API alias: /api/analytics/ingest
router.post("/analytics/ingest", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-admin-v2");
  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "shop_required" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    const id = await writeEvent(shop, {
      ...clean,
      source: "admin"
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("[analyticsIngest] admin write failed:", e?.message || e);
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
