// refina-backend/routes/analytics.js
// Admin Analytics routes (full-domain shop keys only)
// - No short IDs. No alias writes. No `storeId` in responses.
// - Reads from: conversations/{shop}/logs
// - Endpoints:
//   GET /api/admin/analytics/logs?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50
//   GET /api/admin/analytics/logs?days=30&limit=50
//   GET /api/admin/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=1000
//   GET /api/admin/analytics/overview?days=30&limit=1000
//
// NOTE: This module exports a middleware-compatible function,
// so you can do: app.use(mountAnalytics) or app.use('/api', mountAnalytics).

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

function parseDaysParam(s, fallbackDays = 30, min = 1, max = 365) {
  const n = Number(s);
  if (!Number.isFinite(n)) return fallbackDays;
  return Math.min(Math.max(Math.floor(n), min), max);
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
 * Normalize a Firestore Timestamp, Date, or primitive into ISO string (UTC).
 */
function toISO(x) {
  try {
    if (x && typeof x.toDate === "function") return x.toDate().toISOString(); // Firestore Timestamp
    if (x instanceof Date) return x.toISOString();
    const d = new Date(x);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch (_) {}
  return null;
}

/**
 * Group items by yyyy-mm-dd (UTC).
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

/** -------- Indexless fallbacks & coercion helpers (safe for all schemas) -------- */

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

/**
 * Build and return the analytics Router (mounted under whatever base your server uses).
 */
function buildRouter() {
  const r = Router();

  /**
   * GET /admin/analytics/logs (often mounted as /api/admin/analytics/logs)
   * Returns recent conversation logs for the shop (no storeId in payload).
   * Accepts either from/to or days=30.
   */
  r.get("/admin/analytics/logs", async (req, res) => {
    const shop = requireFullShop(req, res);
    if (!shop) return;

    // Range handling: from/to overrides days
    const fromQ = parseYYYYMMDD(req.query.from);
    const toQ = parseYYYYMMDD(req.query.to);
    const days = parseDaysParam(req.query.days, 30);

    const to = toQ || new Date(); // default now (UTC)
    const from = fromQ || new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const limit = Math.min(Number(req.query.limit) || 50, 1000);
    const logsCol = db.collection("conversations").doc(shop).collection("logs");
    // inside r.get("/admin/analytics/logs", async (req, res) => {
console.error("analytics/logs entry", {
  path: req.originalUrl,
  shopHeader: (req.get("X-Shopify-Shop-Domain") || "").toLowerCase(),
  hasLocalsShop: !!(res.locals && res.locals.shop),
});
if (String(req.query.diag) === "1") {
  const shop = (res.locals && res.locals.shop) ||
               (req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase() ||
               (req.query.shop || "");
  return res.json({ ok: true, shop, note: "diag mode (no Firestore)" });
}


    try {
      // Fallback-first: avoid index/type pitfalls using __name__ and in-memory filter/sort
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
          productIds: Array.isArray(data.productIds) ? data.productIds : null,
          matchedProducts: Array.isArray(data.matchedProducts) ? data.matchedProducts : null,
          plan: data.plan ?? null,
          model: data.model ?? null,
          explanation: data.explanation ?? null,
          ts: toISO(data.ts ?? data.createdAt ?? data.timestamp ?? null),
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
      console.error("analytics/logs error:", {
        shop,
        path: req.originalUrl,
        err: err && (err.stack || err.message || err),
      });
      return res.status(500).json({ error: "Failed to load analytics logs." });
    }
  });

  /**
   * GET /admin/analytics/overview (often mounted as /api/admin/analytics/overview)
   * Returns lightweight totals + per-day counts for the time window.
   * Accepts either from/to or days=30.
   * No storeId in payload.
   */
  r.get("/admin/analytics/overview", async (req, res) => {
    const shop = requireFullShop(req, res);
    if (!shop) return;

    // Range handling: from/to overrides days
    const fromQ = parseYYYYMMDD(req.query.from);
    const toQ = parseYYYYMMDD(req.query.to);
    const days = parseDaysParam(req.query.days, 30);

    const to = toQ || new Date();
    const from = fromQ || new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const limit = Math.min(Number(req.query.limit) || 1000, 5000); // cap to avoid huge scans
    const logsCol = db.collection("conversations").doc(shop).collection("logs");
    // inside r.get("/admin/analytics/overview", async (req, res) => {
console.error("analytics/overview entry", {
  path: req.originalUrl,
  shopHeader: (req.get("X-Shopify-Shop-Domain") || "").toLowerCase(),
  hasLocalsShop: !!(res.locals && res.locals.shop),
});
if (String(req.query.diag) === "1") {
  const shop = (res.locals && res.locals.shop) ||
               (req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase() ||
               (req.query.shop || "");
  return res.json({ ok: true, shop, note: "diag mode (no Firestore)" });
}


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
      console.error("analytics/overview error:", {
        shop,
        path: req.originalUrl,
        err: err && (err.stack || err.message || err),
      });
      return res.status(500).json({ error: "Failed to load analytics overview." });
    }
  });

  return r;
}

/**
 * Export a middleware-compatible function that delegates to a singleton Router.
 * This lets server code do: app.use(mountAnalytics) or app.use('/api', mountAnalytics)
 * without needing to change server.js.
 */
let _routerSingleton = null;
export default function mountAnalytics(req, res, next) {
  if (!_routerSingleton) {
    _routerSingleton = buildRouter();
  }
  return _routerSingleton(req, res, next);
}
