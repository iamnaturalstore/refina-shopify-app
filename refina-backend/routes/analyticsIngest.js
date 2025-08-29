// refina-backend/routes/analyticsIngest.js
import express from "express";
import { db, nowTs } from "../bff/lib/firestore.js";
import {
  toMyshopifyDomain,
  shopFromHostB64,
  shopFromIdToken,
} from "../utils/resolveStore.js";

const router = express.Router();

console.log("[analyticsIngest] router loaded");


/**
 * Resolve full "<shop>.myshopify.com" ONLY (no bare handles, no short IDs).
 * Sources, in order (more tolerant to Admin requests):
 *  - res.locals.shop  (set by your canonicalize middleware)
 *  - X-Shopify-Shop-Domain header
 *  - ?shop= (must be full-domain)
 *  - ?host= (Shopify Admin base64)
 *  - id_token / idToken (JWT with .dest)
 *  - Origin / Referer (storefront)
 */
  function resolveShopStrict(req, res) {
  const q = req.query || {};
  const b = req.body || {};

  // 0) from middleware (preferred) or Shopify header
  const localsShop = toMyshopifyDomain((res?.locals?.shop) || "");
  if (localsShop) return localsShop;

  const headerShop = toMyshopifyDomain(req.get("X-Shopify-Shop-Domain") || "");
  if (headerShop) return headerShop;

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

/** Coerce various timestamp shapes → Date, else null */
function coerceDateMaybe(v) {
  try {
    if (!v) return null;
    if (v && typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    if (typeof v === "string") {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  } catch {}
  return null;
}

async function ingestHandler(req, res) {
  try {
    const shop = resolveShopStrict(req, res);
    const body = req.body || {};

    // Timestamp: accept client ts if valid; else server ts
    const clientTs = coerceDateMaybe(body.ts);
  

    // Normalize/guard inputs
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    let plan = (body.plan || "unknown").toString().toLowerCase();
    if (plan === "premuim") plan = "premium"; // typo backstop

    const doc = {
      // Canonical fields only (no legacy storeId/createdAt)
      // (We do NOT redundantly persist storeId; shop is encoded in the path.)
      ts: clientTs || nowTs(),      // Date or Firestore Timestamp
      plan,                         // "free" | "pro" | "premium" | "unknown"

      // Event details (kept simple and safe for UI)
      type: body.type || body.event || "concern",
      concern: body.concern ?? body.query ?? null,
      product: body.product ?? null,
      productIds,
      summary: typeof body.summary === "string" ? body.summary : "",

      // Optional extras that UI might use later
      sessionId: body.sessionId ?? null,
      model: body.model ?? null,
      explanation: body.explanation ?? null,

      // Server timestamp for last-write-wins
      updatedAt: nowTs(),
    };

    // Write where readers look: conversations/{shop}/logs
    const ref = await db
      .collection("conversations")
      .doc(shop)
      .collection("logs")
      .add(doc);

    // Helpful prod telemetry
    res.set("X-Firebase-Project", db.app?.options?.projectId || "(unknown)");
    res.set("X-Shop", shop);

    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    console.error("[analytics ingest] error:", e);
    const code = e.status || 500;
    return res
      .status(code)
      .json({ ok: false, error: e.message || "ingest failed" });
  }
}

/**
 * Routes (exact, no wildcards):
 * We register both so it works whether mounted at /api or /api/admin:
 *  - /analytics/ingest
 *  - /admin/analytics/ingest
 */
router.post("/analytics/ingest", ingestHandler);
router.post("/admin/analytics/ingest", ingestHandler);

export default router;
