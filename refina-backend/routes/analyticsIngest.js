import express from "express";
import { db, nowTs } from "../bff/lib/firestore.js";
import {
  toMyshopifyDomain,
  shopFromHostB64,
  shopFromIdToken,
} from "../utils/resolveStore.js";

const router = express.Router();

/**
 * Resolve full "<shop>.myshopify.com" ONLY (no bare handles, no short IDs).
 * Sources (in order):
 *  - ?shop= (must be full-domain)
 *  - ?host= (Shopify Admin base64)
 *  - id_token / idToken (JWT with .dest)
 *  - Origin / Referer (storefront on the merchant domain)
 */
function resolveShopStrict(req) {
  const q = req.query || {};
  const b = req.body || {};

  // 1) explicit ?shop
  const s1 = toMyshopifyDomain(q.shop);
  if (s1) return s1;

  // 2) Shopify Admin host (base64)
  const s2 = shopFromHostB64(q.host || q.h);
  if (s2) return s2;

  // 3) JWT with dest
  const s3 = shopFromIdToken(q.id_token || q.idToken || b.id_token || b.idToken);
  if (s3) return s3;

  // 4) storefront origin / referer
  try {
    const origin = req.headers.origin || "";
    const host = new URL(origin).hostname.toLowerCase();
    if (host.endsWith(".myshopify.com")) return host;
  } catch {}
  try {
    const ref = req.headers.referer || "";
    const host = new URL(ref).hostname.toLowerCase();
    if (host.endsWith(".myshopify.com")) return host;
  } catch {}

  const e = new Error("shop is required");
  e.status = 400;
  throw e;
}

async function ingestHandler(req, res) {
  try {
    const shop = resolveShopStrict(req);
    const body = req.body || {};

    // Canonical timestamp (ISO). Server writes authoritative updatedAt.
    const tsIso =
      body.ts && typeof body.ts === "string"
        ? body.ts
        : new Date().toISOString();

    // Normalize/guard inputs
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    let plan = (body.plan || "unknown").toString().toLowerCase();
    if (plan === "premuim") plan = "premium"; // typo backstop

    const doc = {
      // Canonical fields only (no legacy storeId/createdAt)
      shop,                 // full <shop>.myshopify.com
      ts: tsIso,            // ISO string for ordering/filtering
      plan,                 // "free" | "pro" | "premium" | "unknown"

      // Event details
      type: body.type || body.event || "concern",
      concern: body.concern ?? body.query ?? null,
      product: body.product ?? null,
      productIds,
      summary: typeof body.summary === "string" ? body.summary : "",

      // Server timestamp for last-write wins
      updatedAt: nowTs(),
    };

    await db.collection("analyticsLogs").add(doc);

    // Helpful prod telemetry
    res.set("X-Firebase-Project", db.app?.options?.projectId || "(unknown)");
    res.set("X-Shop", shop);

    return res.json({ ok: true });
  } catch (e) {
    console.error("[analytics ingest] error:", e);
    const code = e.status || 500;
    return res
      .status(code)
      .json({ ok: false, error: e.message || "ingest failed" });
  }
}

/**
 * Routes:
 * - Keep /ingest (where this router is mounted, e.g. /api/admin/analytics)
 * - Also expose /api/admin/analytics/ingest and /api/analytics/ingest aliases
 *   so storefront posts never miss, regardless of mount point.
 */
router.post("/ingest", ingestHandler);
router.post("/admin/analytics/ingest", ingestHandler);
router.post("/analytics/ingest", ingestHandler);

export default router;
