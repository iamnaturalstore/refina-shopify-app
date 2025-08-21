// refina-backend/routes/analytics.js
import { Router } from "express";
import { dbAdmin } from "../firebaseAdmin.js"; // shared Firebase Admin (single init)

/** ──────────────────────────────────────────────────────────────────────────
 * Helpers
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

/** ──────────────────────────────────────────────────────────────────────────
 * Router
 * ────────────────────────────────────────────────────────────────────────── */

const router = Router();

/**
 * GET /api/admin/analytics/overview?storeId=xxx|shop=xxx&days=30
 * - Order-only fetch (createdAt → timestamp fallback), filter in memory.
 * - Avoids Firestore where(Date) vs string mismatches.
 */
router.get("/analytics/overview", async (req, res, next) => {
  try {
    const storeDomain = resolveStoreDomain(req.query);
    assertString(storeDomain, "storeId or shop");

    const daysNum = Math.max(1, parseInt(req.query.days, 10) || 30);
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
        share: total ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topProducts = [...productCounts.entries()]
      .map(([productId, count]) => ({ productId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      storeId: storeDomain,
      rangeDays: daysNum,
      totalEvents: total,
      uniqueConcerns: concernCounts.size,
      uniqueProductsSuggested: productCounts.size,
      planCounts,
      topConcerns,
      topProducts,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/analytics/logs?storeId=xxx|shop=xxx&limit=50&after=ISO
 * - Order-only fetch + optional in-memory `after` filter.
 * - Response shape preserved.
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
        summary: (data.explanation || data.answer || "").toString().slice(0, 160),
      };
    });

    res.json({ storeId: storeDomain, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

export default router;
