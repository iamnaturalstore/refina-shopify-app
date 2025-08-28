// refina-backend/routes/analytics.js
// Admin Analytics routes (full-domain shop keys only)
// - No short IDs. No alias writes. No `storeId` in responses.
// - Reads from: conversations/{shop}/logs
// - Endpoints:
//   GET /admin/analytics/logs?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50
//   GET /admin/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=1000

import { Router } from "express";
import { db } from "../bff/lib/firestore.js";

/**
 * Extract and validate full shop domain.
 * Accept only full *.myshopify.com domains; reject short IDs or missing values.
 */
function requireFullShop(req, res) {
  // Prefer verified session, then Shopify header, then explicit query
  const headerShop = (req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase();
  const candidate = String(
    (res.locals && res.locals.shop) || headerShop || (req.query && req.query.shop) || ""
  )
    .trim()
    .toLowerCase();

  const isFull = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(candidate);
  if (!isFull) {
    res.status(400).json({
      error: "Missing or invalid 'shop'. Provide full *.myshopify.com domain.",
    });
    return null;
  }
  return candidate;
}

function parseYYYYMMDD(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [_, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function startOfDayUTC(d) {
  const dt = new Date(d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

function endOfDayUTC(d) {
  const dt = new Date(d);
  dt.setUTCHours(23, 59, 59, 999);
  return dt;
}

/**
 * Choose the timestamp field used in logs.
 * We prefer 'ts', then 'createdAt', then 'timestamp'.
 * This does NOT write anything.
 */
function chooseTsField(docData) {
  if (!docData) return "ts";
  if (docData.ts) return "ts";
  if (docData.createdAt) return "createdAt";
  if (docData.timestamp) return "timestamp";
  return "ts";
}

/**
 * Normalize a Firestore Timestamp, Date, or string into ISO string (UTC).
 */
function toISO(x) {
  try {
    // Firestore admin Timestamp: has toDate()
    if (x && typeof x.toDate === "function") return x.toDate().toISOString();
    // Date
    if (x instanceof Date) return x.toISOString();
    // string or number
    const d = new Date(x);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch (_) {}
  return null;
}

/**
 * Group an array of items by yyyy-mm-dd key (UTC day).
 */
function groupByDayUTC(items, getDate) {
  const out = new Map();
  for (const it of items) {
    const iso = toISO(getDate(it));
    if (!iso) continue;
    const day = iso.slice(0, 10); // yyyy-mm-dd
    out.set(day, (out.get(day) || 0) + 1);
  }
  return Array.from(out.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** -------- Indexless fallbacks & coercion helpers (safe in all schemas) -------- */

/**
 * Always-indexed fallback: read recent docs by document ID, then filter/sort in memory.
 */
async function fetchRecentDocs(logsCol, cap = 500) {
  const snap = await logsCol.orderBy("__name__", "desc").limit(cap).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
}

function coerceDateMaybe(v) {
  try {
    if (v && typeof v.toDate === "function") return v.toDate(); // Firestore Timestamp
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    if (typeof v === "string") return new Date(v);
  } catch (_) {}
  return null;
}

export default function mountAnalytics(app) {
  const r = Router();

  /**
   * GET /admin/analytics/logs
   * Returns recent conversation logs for the shop (no storeId in payload).
   */
  r.get("/admin/analytics/logs", async (req, res) => {
    const shop = requireFullShop(req, res);
    if (!shop) return;

    const fromQ = parseYYYYMMDD(req.query.from);
    const toQ = parseYYYYMMDD(req.query.to);
    const limit = Math.min(Number(req.query.limit) || 50, 1000);

    const to = toQ || new Date(); // default now (UTC)
    const from = fromQ || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default last 30d

    const logsCol = db.collection("conversations").doc(shop).collection("logs");

    try {
      // Fallback-first path: avoid index/type pitfalls by using __name__ and in-memory filter/sort
      const fallbackCap = Math.max(limit * 4, 200);
      const recent = await fetchRecentDocs(logsCol, fallbackCap);

      const rows = recent
        .map(({ id, data }) => {
          const tsRaw = data.ts ?? data.createdAt ?? data.timestamp ?? null;
          const dateObj = coerceDateMaybe(tsRaw);
          return { id, data, dateObj };
        })
        .filter(
          (x) =>
            x.dateObj &&
            x.dateObj >= startOfDayUTC(from) &&
            x.dateObj <= endOfDayUTC(to)
        )
        .sort((a, b) => b.dateObj - a.dateObj)
        .slice(0, limit)
        .map(({ id, data }) => ({
          id,
          concern: data.concern ?? null,
          // Keep common analytics fields if present; do not invent or rename.
          productIds: Array.isArray(data.productIds) ? data.productIds : null,
          matchedProducts: Array.isArray(data.matchedProducts) ? data.matchedProducts : null,
          plan: data.plan ?? null,
          model: data.model ?? null,
          explanation: data.explanation ?? null,
          // Normalized timestamp (no persistence of createdAt/storeId here)
          ts: toISO(data.ts ?? data.createdAt ?? data.timestamp ?? null),
          // Any extra safe fields you may have stored:
          meta: data.meta ?? null,
        }));

      return res.json({
        range: {
          from: startOfDayUTC(from).toISOString(),
          to: endOfDayUTC(to).toISOString(),
        },
        count: rows.length,
        rows,
      });
    } catch (err) {
      console.error("analytics/logs error:", err && (err.stack || err.message || err));
      return res.status(500).json({ error: "Failed to load analytics logs." });
    }
  });

  /**
   * GET /admin/analytics/overview
   * Returns lightweight totals + per-day counts for the time window.
   * No storeId in payload.
   */
  r.get("/admin/analytics/overview", async (req, res) => {
    const shop = requireFullShop(req, res);
    if (!shop) return;

    const fromQ = parseYYYYMMDD(req.query.from);
    const toQ = parseYYYYMMDD(req.query.to);
    const limit = Math.min(Number(req.query.limit) || 1000, 5000); // cap to avoid huge scans

    const to = toQ || new Date();
    const from = fromQ || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30d default

    const logsCol = db.collection("conversations").doc(shop).collection("logs");

    try {
      // Indexless fallback: pull recent docs by __name__, then filter/sort
      const fallbackCap = Math.max(limit * 4, 500);
      const recent = await fetchRecentDocs(logsCol, fallbackCap);

      const entries = recent
        .map(({ data }) => {
          const tsRaw = data.ts ?? data.createdAt ?? data.timestamp ?? null;
          return {
            ts: coerceDateMaybe(tsRaw),
            plan: data.plan ?? null,
            model: data.model ?? null,
            // if you store a sessionId, include it to enable distinct counts client-side
            sessionId: data.sessionId ?? null,
            hadAi: !!(data.explanation || data.model || data.productIds),
          };
        })
        .filter(
          (e) => e.ts && e.ts >= startOfDayUTC(from) && e.ts <= endOfDayUTC(to)
        )
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);

      const series = groupByDayUTC(entries, (e) => e.ts);
      const totals = {
        events: entries.length,
        aiEvents: entries.filter((e) => e.hadAi).length,
        // If you store sessionId, estimate sessions (distinct) for the window:
        sessions:
          new Set(entries.map((e) => e.sessionId).filter(Boolean)).size || null,
      };

      return res.json({
        range: {
          from: startOfDayUTC(from).toISOString(),
          to: endOfDayUTC(to).toISOString(),
        },
        totals,
        rows: series, // [{ date:'YYYY-MM-DD', count:Number }, ...]
      });
    } catch (err) {
      console.error("analytics/overview error:", err && (err.stack || err.message || err));
      return res.status(500).json({ error: "Failed to load analytics overview." });
    }
  });

  app.use(r);
}
