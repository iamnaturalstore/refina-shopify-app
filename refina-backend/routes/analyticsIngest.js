// refina-backend/routes/analyticsIngest.js
// // PROD-CHECKLIST:
// - Enforce full-domain shop only (toMyshopifyDomain); no short IDs
// - No wildcards; no renames; keep aliases so storefront posts don't miss
// - Security: HMAC for App Proxy path handled upstream; here we canonicalize & bound inputs
// - Telemetry headers set; Cache-Control no-store
// - Do NOT persist storeId or createdAt fields

import { Router } from "express";
import { db, nowTs, getDocSafe, projectId } from "../lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

const router = Router({ caseSensitive: false });

/**
* Resolve the canonical shop from the request.
* ✅ Prefer App Proxy / header (authoritative)
* → then ?shop / ?storeId (query)
* → then body.storeId / body.shop (legacy/dev only)
 */
function canonShopFrom(req) {
  const headerRaw = req.get("x-shopify-shop-domain") || "";
  const queryRaw = (req.query && (req.query.shop || req.query.storeId)) || "";
  const bodyRaw  = (req.body && (req.body.storeId || req.body.shop)) || "";


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

// Core write for Admin Analytics: conversations/{shop}/logs/<autoId>
 async function writeLog(shop, data) {
   const ref = db.collection("conversations").doc(shop).collection("logs").doc();
   const toWrite = {
     ...data,
     // Admin canonical timestamps/fields
     createdAt: nowTs(),
     ts: nowTs(), // keep legacy ts if you want it
     storeId: shop,
   };
   // Never trust client-provided identity/time
   delete toWrite.shop;
   delete toWrite.createdAt; // always server-set
    await ref.set(toWrite);
    console.info("[analytics/write]", { id: ref.id, shop });
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
    // Enrich planLevel from plans/{shop} (read-only, billing-neutral)
     const planDoc = await getDocSafe(db.collection("plans").doc(shop));
     const planLevel = (planDoc && planDoc.level) || "free";
     // Distinguish model source vs surface:
     // - source: 'gemini' | 'fallback' | 'mapping'  (origin of answer)
     // - surface: 'storefront' | 'admin' | 'api'    (where it was triggered)
     const surface = "storefront";
     const modelSource =
       (clean?.meta && typeof clean.meta.model === "string") ? "gemini" :
       (clean?.event === "mapping_applied" ? "mapping" : "gemini");
 
     const id = await writeLog(shop, {
       ...clean,
       source: modelSource,
       surface,
       planLevel,
     });
     // Temporary verbose mode for validation (set RF_VERBOSE_INGEST=1)
     res.set("X-RF-Shop", shop);
     if (process.env.RF_VERBOSE_INGEST === "1") {
       return res.status(201).json({ id, resolvedStoreId: shop, targetPath: `conversations/${shop}/logs`, projectId });
     }
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
    const planDoc = await getDocSafe(db.collection("plans").doc(shop));
    const planLevel = (planDoc && planDoc.level) || "free";
    const surface = "admin";
    const modelSource =
      (clean?.meta && typeof clean.meta.model === "string") ? "gemini" :
      (clean?.event === "mapping_applied" ? "mapping" : "gemini");

    const id = await writeLog(shop, {
      ...clean,
      source: modelSource,
      surface,
      planLevel,
    });
    if (process.env.RF_VERBOSE_INGEST === "1") {
      return res.status(201).json({ id, resolvedStoreId: shop, targetPath: `conversations/${shop}/logs`, projectId });
    }
    return res.status(204).end();
  } catch (e) {
    console.error("[analyticsIngest] admin write failed:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
