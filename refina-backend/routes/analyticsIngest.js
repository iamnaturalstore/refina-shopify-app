// refina-backend/routes/analyticsIngest.js
// // PROD-CHECKLIST:
// - Enforce full-domain shop only (toMyshopifyDomain); no short IDs
// - No wildcards; no renames; keep aliases so storefront posts don't miss
// - Security: HMAC for App Proxy path handled upstream; here we canonicalize & bound inputs
// - Telemetry headers set; Cache-Control no-store
// - Do NOT persist storeId or createdAt fields

// refina-backend/routes/analyticsIngest.js
// Canonical analytics ingest → conversations/{shop}/logs
// Works with BOTH mount styles without touching server.js:
//
//   A) app.use("/apps/refina/v1",           analyticsIngestRouter)
//        → POST /analytics/ingest
//        → GET  /analytics/selftest
//
//   B) app.use("/apps/refina/v1/analytics", analyticsIngestRouter)
//        → POST /ingest
//        → GET  /selftest
//
// Debugging:
//   - Set RF_VERBOSE_INGEST=1 to return 201 JSON (id, projectId, path).
//   - Logs: [analytics/ingest ENTER], [analytics/write]

import { Router } from "express";
import { db, nowTs, getDocSafe, projectId } from "../lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

const router = Router({ caseSensitive: false });

// ─────────────────────────────────────────────────────────────
// Identity: prefer App Proxy header → query → body (secure)
// ─────────────────────────────────────────────────────────────
function canonShopFrom(req) {
  const headerRaw = req.get("x-shopify-shop-domain") || "";
  const queryRaw  = (req.query && (req.query.shop || req.query.storeId)) || "";
  const bodyRaw   = (req.body && (req.body.storeId || req.body.shop)) || "";
  const raw = String(headerRaw || queryRaw || bodyRaw || "").toLowerCase().trim();
  return toMyshopifyDomain(raw);
}

// ─────────────────────────────────────────────────────────────
// Accept/sanitize event payload from widget/Admin UI
// ─────────────────────────────────────────────────────────────
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

  // Optional passthrough (bounded by caller)
  if (body.payload && typeof body.payload === "object") {
    out.payload = body.payload;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Core write → conversations/{shop}/logs/{autoId}
// ─────────────────────────────────────────────────────────────
async function writeLog(shop, data) {
  const ref = db.collection("conversations").doc(shop).collection("logs").doc();
  const toWrite = {
    ...data,
    createdAt: nowTs(), // canonical for Admin
    ts: nowTs(),        // optional legacy
    storeId: shop,      // explicit for collectionGroup queries
  };
  // Never trust client-provided identity/time
  delete toWrite.shop;
  delete toWrite.createdAt;

  await ref.set(toWrite);
  console.info("[analytics/write]", { id: ref.id, shop });
  return ref.id;
}

// ─────────────────────────────────────────────────────────────
async function handleIngest(req, res, surfaceHint) {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-v3");
  console.info("[analytics/ingest ENTER]", { url: req.originalUrl });

  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "missing_or_invalid_shop" });

  try {
    const clean = sanitizeEventBody(req.body || {});

    // Enrich plan level (read-only; Billing remains sole writer of plans/*)
    const planDoc = await getDocSafe(db.collection("plans").doc(shop));
    const planLevel = (planDoc && planDoc.level) || "free";

    // Distinguish model origin vs surface
    const surface = surfaceHint || req.get("x-rf-surface") || "storefront";
    const modelSource =
      (clean?.meta && typeof clean.meta.model === "string") ? "gemini" :
      (clean?.event === "mapping_applied" ? "mapping" : "gemini");

    const id = await writeLog(shop, {
      ...clean,
      source: modelSource, // 'gemini' | 'fallback' | 'mapping'
      surface,             // 'storefront' | 'admin' | 'api'
      planLevel,           // 'free' | 'pro' | 'premium' | 'plus'
    });

    if (process.env.RF_VERBOSE_INGEST === "1") {
      return res.status(201).json({
        id,
        resolvedStoreId: shop,
        targetPath: `conversations/${shop}/logs`,
        projectId,
      });
    }
    return res.status(204).end();
  } catch (e) {
    console.error("[analytics/ingest ERROR]", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
}

// ─────────────────────────────────────────────────────────────
// Support BOTH mount styles without changing server.js
//   A) Mounted at /apps/refina/v1           → POST /analytics/ingest
//   B) Mounted at /apps/refina/v1/analytics → POST /ingest
// ─────────────────────────────────────────────────────────────
router.post("/analytics/ingest", (req, res) => handleIngest(req, res, "storefront"));
router.post("/ingest",           (req, res) => handleIngest(req, res, "storefront"));

// Optional diagnostics (works with both mounts):
//   GET /apps/refina/v1/analytics/selftest?shop=refina-demo.myshopify.com
//   GET /apps/refina/v1/selftest?shop=refina-demo.myshopify.com
router.get("/analytics/selftest", async (req, res) => {
  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "missing_or_invalid_shop" });
  const id = await writeLog(shop, {
    concern: "SELFTEST",
    normalizedConcern: "selftest",
    productIds: [],
    explanation: "diagnostic write",
    source: "mapping",
    surface: "admin",
    planLevel: "free",
  });
  return res.status(200).json({ ok: true, id, shop, projectId });
});

router.get("/selftest", async (req, res) => {
  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "missing_or_invalid_shop" });
  const id = await writeLog(shop, {
    concern: "SELFTEST",
    normalizedConcern: "selftest",
    productIds: [],
    explanation: "diagnostic write",
    source: "mapping",
    surface: "admin",
    planLevel: "free",
  });
  return res.status(200).json({ ok: true, id, shop, projectId });
});

export default router;
