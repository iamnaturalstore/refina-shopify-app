// refina-backend/routes/analytics.js
import { Router } from "express";
import { dbAdmin } from "../firebaseAdmin.js"; // shared Firebase Admin (single init)

/** ──────────────────────────────────────────────────────────────────────────
 * Helpers (validation, canonicalization, stable JSON for ETag)
 * ────────────────────────────────────────────────────────────────────────── */

function assertString(v, name) {
  if (typeof v !== "string" || !v.trim()) {
    const e = new Error(`${name} is required`);
    e.status = 400;
    throw e;
  }
}

const sanitize = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, "");

/** Canonicalize to "<shop>.myshopify.com" */
function toMyshopifyDomain(raw) {
  const s = sanitize(raw);
  if (!s) return "";
  if (s.endsWith(".myshopify.com")) return s;
  return `${s}.myshopify.com`;
}

/** Resolve incoming store identifier from query and canonicalize */
function resolveStoreDomain(q) {
  const raw = q.storeId || q.shop || "";
  const dom = toMyshopifyDomain(raw);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dom)) return "";
  return dom;
}

/** Normalize a per-row timestamp from createdAt | timestamp (Firestore TS or ISO string) */
function normalizeTimestamp(data) {
  const t = data?.createdAt ?? data?.timestamp;
  if (!t) return null;
  if (typeof t?.toDate === "function") return t.toDate(); // Firestore Timestamp
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Stable JSON (sorted keys) for deterministic ETag */
function stableJson(obj) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return v;
      seen.add(v);
      if (Array.isArray(v)) return v.map(walk);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}
function makeEtag(obj) {
  const s = stableJson(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `"anx-${(h >>> 0).toString(16)}"`; // short, deterministic
}

/** ──────────────────────────────────────────────────────────────────────────
 * Router
 * ────────────────────────────────────────────────────────────────────────── */

const router = Router();

/**
 * GET /api/admin/analytics/overview?storeId=xxx|shop=xxx&days=30
 * - Order-only fetch (createdAt → timestamp fallback), filter in memory.
 * - Avoids Firestore where(Date) vs string mismatches.
 * - Adds ETag + short-lived private caching for Admin UX.
 */
router.get("/analytics/overview", async (req, res, next) => {
  try {
    const storeDomain = resolveStoreDomain(req.query);
    assertString(storeDomain, "storeId or shop");

    const daysRaw = parseInt(req.query.days, 10);
    const daysNum = Math.max(1, Math.min(90, Number.isFinite(daysRaw) ? daysRaw : 30));
    const since = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000);
    const LIMIT = 2000;

    const coll = dbAdmin.collection("conversations").doc(storeDomain).collection("logs");

    // Try createdAt first
    let snap = await coll.orderBy("createdAt", "desc").limit(LIMIT).get();
    let docs = snap.docs.filter((d) => {
      const dt = normalizeTimestamp(d.data());
      return dt && dt >= since;
    });

    // Fallback to timestamp if createdAt not present
    if (docs.length === 0) {
      snap = await coll.orderBy("timestamp", "desc").limit(LIMIT).get();
      docs = snap.docs.filter((d) => {
        const dt = normalizeTimestamp(d.data());
        return dt && dt >= since;
      });
    }

    const total = docs.length;
    const concernCounts = new Map();
    const productCounts = new Map();
    const planCounts = { free: 0, pro: 0, premium: 0, unknown: 0 };

    for (const d of docs) {
      const data = d.data() || {};
      const concern = (data.concern || data.input || data.query || "").toString().trim();
      if (concern) concernCounts.set(concern, (concernCounts.get(concern) || 0) + 1);

      // Normalize legacy plan names: map "pro+" / "pro plus" → "premium"
      const _rawPlan = (data.plan || data.tier || "").toString().toLowerCase().trim();
      const _normPlan =
        /\bpremium\b/.test(_rawPlan) || /\bpro\s*\+|\bpro\W*plus\b/.test(_rawPlan)
          ? "premium"
          : /\bpro\b/.test(_rawPlan)
          ? "pro"
          : _rawPlan || "unknown";
      if (planCounts[_normPlan] !== undefined) planCounts[_normPlan] += 1;
      else planCounts.unknown += 1;

      const productIds = Array.isArray(data.productIds)
        ? data.productIds
        : Array.isArray(data.products)
        ? data.products.map((p) => p?.id || p?.productId).filter(Boolean)
        : [];

      for (const pid of productIds) {
        const key = String(pid);
        productCounts.set(key, (productCounts.get(key) || 0) + 1);
      }
    }

    const topConcerns = [...concernCounts.entries()]
      .map(([label, count]) => ({
        label,
        count,
        share: total ? Math.round((count / total) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topProducts = [...productCounts.entries()]
      .map(([productId, count]) => ({ productId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const payload = {
      storeId: storeDomain,
      rangeDays: daysNum,
      totalEvents: total,
      uniqueConcerns: concernCounts.size,
      uniqueProductsSuggested: productCounts.size,
      planCounts,
      topConcerns,
      topProducts,
      generatedAt: new Date().toISOString()
    };

    // Caching: short-lived, private; ETag for cheap revalidate
    const etag = makeEtag(payload);
    res.set("ETag", etag);
    res.set("Cache-Control", "private, max-age=60, stale-while-revalidate=30");
    res.set("X-Refina-Store", storeDomain);

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    res.type("application/json").status(200).send(stableJson(payload));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/analytics/logs?storeId=xxx|shop=xxx&limit=50&after=ISO
 * - Order-only fetch + optional in-memory `after` filter.
 * - Response shape preserved.
 * - No-store cache (may include sensitive text snippets).
 */
router.get("/analytics/logs", async (req, res, next) => {
  try {
    const storeDomain = resolveStoreDomain(req.query);
    assertString(storeDomain, "storeId or shop");

    const LIMIT = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const after = req.query.after ? new Date(req.query.after) : null;

    const coll = dbAdmin.collection("conversations").doc(storeDomain).collection("logs");

    // Try createdAt first
    let snap = await coll.orderBy("createdAt", "desc").limit(LIMIT).get();
    let docs = snap.docs;

    // If nothing under createdAt, fall back to timestamp
    if (docs.length === 0) {
      snap = await coll.orderBy("timestamp", "desc").limit(LIMIT).get();
      docs = snap.docs;
    }

    // Optional after filter (client-side to avoid type mismatches)
    if (after instanceof Date && !Number.isNaN(after.getTime())) {
      docs = docs.filter((d) => {
        const dt = normalizeTimestamp(d.data());
        return dt && dt < after;
      });
    }

    const rows = docs.map((d) => {
      const data = d.data() || {};
      const ts = normalizeTimestamp(data);

      const productIds = Array.isArray(data.productIds)
        ? data.productIds
        : Array.isArray(data.products)
        ? data.products.map((p) => p?.id || p?.productId).filter(Boolean)
        : [];

      // Normalize plan for output rows, too
      const _rawPlan = (data.plan || data.tier || "").toString().toLowerCase().trim();
      const _normPlan =
        /\bpremium\b/.test(_rawPlan) || /\bpro\s*\+|\bpro\W*plus\b/.test(_rawPlan)
          ? "premium"
          : /\bpro\b/.test(_rawPlan)
          ? "pro"
          : _rawPlan || "unknown";

      return {
        id: d.id,
        createdAt: ts ? ts.toISOString() : null,
        concern: (data.concern || data.input || data.query || "").toString(),
        plan: _normPlan,
        productIds,
        summary: (data.explanation || data.answer || "").toString().slice(0, 160)
      };
    });

    res.set("Cache-Control", "no-store");
    res.set("X-Refina-Store", storeDomain);
    res.status(200).json({ storeId: storeDomain, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

/** Router-scoped error handler to preserve status codes and avoid leaking internals */
router.use((err, _req, res, _next) => {
  const status = Number(err.status) || 500;
  const code =
    status === 400
      ? "bad_request"
      : status === 401
      ? "unauthorized"
      : status === 404
      ? "not_found"
      : "internal_error";
  if (status >= 500) {
    // Minimal server-side log; no payload echo
    console.error("[analytics] error:", err?.message || err);
  }
  res.status(status).json({ error: code, message: err?.message || "Unexpected error" });
});

export default router;
