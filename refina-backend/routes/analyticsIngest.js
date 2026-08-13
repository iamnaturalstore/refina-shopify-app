// Canonical analytics ingest → conversations/{shop}/logs
// Works with ALL mount styles without touching server.js:
//
//   A) app.use("/apps/refina/v1",           analyticsIngestRouter)
//        → POST /analytics/ingest
//        → GET  /analytics/selftest
//
//   B) app.use("/apps/refina/v1/analytics", analyticsIngestRouter)
//        → POST /ingest
//        → GET  /selftest
//
//   C) app.use("/apps/refina/v1/analytics/ingest", analyticsIngestRouter)
//        → POST /            (this file handles "/")
//
// Debugging:
//   - Set RF_VERBOSE_INGEST=1 to return 201 JSON (id, projectId, path).
//   - Logs include: [analytics/ingest ENTER], [analytics/write]

import { Router } from "express";
import { db, nowTs, getDocSafe, projectId } from "../lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

const router = Router({ caseSensitive: false });

// Trace every request that reaches THIS router (any subpath)
router.use((req, _res, next) => {
  next();
});

// If mounted exactly at /apps/refina/v1/analytics/ingest, this catches GET/POST to that base URL.
// A bare diagnostic ping (no event data) gets the health-check response; a real
// tracking ping (image-pixel GET, carrying event data via query string) gets ingested.
router.get("/", (req, res) => {
  if (req.query && req.query.event) return handleIngest(req, res, "storefront");
  return res.status(200).json({ ok: true, handler: "analytics-ingest-v3" });
});
router.post("/", (req, res) => handleIngest(req, res, "storefront"));


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

  if (typeof body.type === "string") out.type = body.type.slice(0, 64);
  if (typeof body.concern === "string") out.concern = body.concern.slice(0, 512);
  if (Array.isArray(body.productIds)) out.productIds = body.productIds.map(String).slice(0, 50);

  if (typeof body.event === "string") out.event = body.event.slice(0, 64);
  if (typeof body.uid === "string") out.uid = body.uid.slice(0, 128);

  if (typeof body.topProductTitle === "string") out.topProductTitle = body.topProductTitle.slice(0, 256);
  if (typeof body.productId === "string") out.productId = body.productId.slice(0, 128);
  if (typeof body.contextId === "string") out.contextId = body.contextId.slice(0, 128);

  if (body.meta && typeof body.meta === "object") {
    const sanitizedMeta = {};
    for (const [key, value] of Object.entries(body.meta).slice(0, 20)) {
      sanitizedMeta[String(key).slice(0, 40)] = String(value).slice(0, 256);
    }
    out.meta = sanitizedMeta;
  }
  if (body.payload && typeof body.payload === "object") out.payload = body.payload;

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
  delete toWrite.shop;       // never trust client-provided identity
  delete toWrite.createdAt;  // always server-set

  await ref.set(toWrite);
  return ref.id;
}

// Shared handler
async function handleIngest(req, res, surfaceHint) {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-v3");

  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "missing_or_invalid_shop" });

  try {
    // The App Proxy hop can 302 the request, which drops the POST body (standard
    // HTTP redirect behavior) — so accept these fields from the query string too,
    // letting body values win when both are present.
    const clean = sanitizeEventBody({ ...(req.query || {}), ...(req.body || {}) });
    const planDoc = await getDocSafe(db.collection("plans").doc(shop)); // read-only; Billing owns writes
    const planLevel = (planDoc && planDoc.level) || "free";

    const surface = surfaceHint || req.get("x-rf-surface") || "storefront";
    const modelSource =
      (clean?.meta && typeof clean.meta.model === "string") ? "gemini" :
      (clean?.event === "mapping_applied" ? "mapping" : "gemini");

    const id = await writeLog(shop, {
      ...clean,
      source: modelSource, // 'gemini' | 'fallback' | 'mapping'
      surface,             // 'storefront' | 'admin' | 'api'
      planLevel,           // 'free' | 'starter/pro' | 'premium' | 'plus'
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
// Support ALL mount styles (A, B, C above)
// ─────────────────────────────────────────────────────────────
router.post("/analytics/ingest", (req, res) => handleIngest(req, res, "storefront")); // A
router.post("/ingest",           (req, res) => handleIngest(req, res, "storefront")); // B
router.post("/",                 (req, res) => handleIngest(req, res, "storefront")); // C

// GET variants — some storefront callers fire an image-pixel GET (survives page
// navigation more reliably than fetch/sendBeacon); all event data travels via
// query string in that case, which handleIngest already reads.
router.get("/analytics/ingest", (req, res) => handleIngest(req, res, "storefront")); // A
router.get("/ingest",           (req, res) => handleIngest(req, res, "storefront")); // B

// Optional diagnostics for A/B:
//   GET /apps/refina/v1/analytics/selftest?shop=refina-demo.myshopify.com
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

// Optional diagnostics for B/C:
//   GET /apps/refina/v1/analytics/selftest  (when mounted at /apps/refina/v1/analytics)
//   GET /apps/refina/v1/analytics/ingest    (when mounted at /apps/refina/v1/analytics/ingest)
//   → use POST "/" for ingest; GET here just to verify router is mounted
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
// also export the handler in case another router wants to delegate
export { handleIngest };
