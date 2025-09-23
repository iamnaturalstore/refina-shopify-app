// refina-backend/routes/analyticsIngest.js
// // PROD-CHECKLIST:
// - Enforce full-domain shop only (toMyshopifyDomain); no short IDs
// - No wildcards; no renames; keep aliases so storefront posts don't miss
// - Security: HMAC for App Proxy path handled upstream; here we canonicalize & bound inputs
// - Telemetry headers set; Cache-Control no-store
// - Do NOT persist storeId or createdAt fields

import { Router } from "express";
import { db, nowTs } from "../lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

const router = Router({ caseSensitive: false });

/**
 * Resolve the canonical shop from the request.
 * ✅ Prefer body.storeId / body.shop (widget/Admin UI)
 * → then ?shop / ?storeId (query)
 * → then x-shopify-shop-domain (proxy/header)
 */
function canonShopFrom(req) {
  const bodyRaw = (req.body && (req.body.storeId || req.body.shop)) || "";
  const queryRaw = (req.query && (req.query.shop || req.query.storeId)) || "";
  const headerRaw = req.get("x-shopify-shop-domain") || "";

  const raw = String(bodyRaw || queryRaw || headerRaw || "")
    .toLowerCase()
    .trim();

  return toMyshopifyDomain(raw);
}

// Accept/sanitize event payload from widget/Admin UI
function sanitizeEventBody(body = {}) {
  const out = {};
  if (!body || typeof body !== "object") return out;

  // Primary fields
  if (typeof body.type === "string") out.type = body.type.slice(0, 64);
  if (typeof body.concern === "string") out.concern = body.concern.slice(0, 512);
  if (Array.isArray(body.productIds)) {
    out.productIds = body.productIds.map((id) => String(id)).slice(0, 50);
  }

  // Generic/legacy fields
  if (typeof body.event === "string") out.event = body.event.slice(0, 64);
  if (typeof body.uid === "string") out.uid = body.uid.slice(0, 128);

  // Meta object (bounded)
  if (body.meta && typeof body.meta === "object") {
    const sanitizedMeta = {};
    for (const [key, value] of Object.entries(body.meta).slice(0, 20)) {
      sanitizedMeta[String(key).slice(0, 40)] = String(value).slice(0, 256);
    }
    out.meta = sanitizedMeta;
  }

  // Legacy payload passthrough (bounded by caller)
  if (body.payload && typeof body.payload === "object") {
    out.payload = body.payload;
  }

  return out;
}

// Core write: analytics/{shop}/events/<autoId>
// (Keep path aligned with Admin readers.)
async function writeEvent(shop, data) {
  const ref = db.collection('analytics').doc(shop).collection('events').doc();
  const toWrite = {
    ...data,
    ts: nowTs(), // server timestamp
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

// Storefront/App UI root (when mounted at /proxy/refina/v1/analytics/ingest)
router.post("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-storefront-v2");

  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "missing_or_invalid_shop" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    await writeEvent(shop, { ...clean, source: "storefront" });
    // Historical behavior: No Content
    res.set("X-RF-Shop", shop);
    return res.status(204).end();
  } catch (e) {
    console.error("[analyticsIngest] storefront write failed:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// Admin/API alias (also used when router mounted at /apps/refina/v1 → /apps/refina/v1/analytics/ingest)
router.post("/analytics/ingest", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-admin-v2");

  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "missing_or_invalid_shop" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    await writeEvent(shop, { ...clean, source: "admin" });
    // Historical behavior: No Content
    return res.status(204).end();
  } catch (e) {
    console.error("[analyticsIngest] admin write failed:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
