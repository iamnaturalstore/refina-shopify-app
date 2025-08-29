// refina-backend/routes/analytics.js
// Admin Analytics routes (full-domain shop keys only)
// Final URLs (server mounts at /api/admin):
//   GET /api/admin/analytics/logs
//   GET /api/admin/analytics/overview

import { Router } from "express";
import { db } from "../bff/lib/firestore.js";

console.log("[analytics] router loaded (registering /analytics/logs & /analytics/overview)");

function requireFullShop(req, res) {
  const headerShop = (req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase();
  const candidate = String(
    (res.locals && res.locals.shop) || headerShop || (req.query && req.query.shop) || ""
  ).trim().toLowerCase();

  const isFull = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(candidate);
  if (!isFull) {
    res.status(400).json({ error: "Missing or invalid 'shop'. Provide full *.myshopify.com domain." });
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
function startOfDayUTC(d) { const dt = new Date(d); dt.setUTCHours(0,0,0,0); return dt; }
function endOfDayUTC(d)   { const dt = new Date(d); dt.setUTCHours(23,59,59,999); return dt; }

function toISO(x) {
  try {
    if (x && typeof x.toDate === "function") return x.toDate().toISOString();
    if (x instanceof Date) return x.toISOString();
    const d = new Date(x);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return null;
}
function groupByDayUTC(items, getDate) {
  const out = new Map();
  for (const it of items) {
    const iso = toISO(getDate(it));
    if (!iso) continue;
    const day = iso.slice(0, 10);
    out.set(day, (out.get(day) || 0) + 1);
  }
  return Array.from(out.entries()).map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
function coerceDateMaybe(v) {
  try {
    if (v && typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    if (typeof v === "string") return new Date(v);
  } catch {}
  return null;
}

/** Robust, indexless-friendly fetch: try FieldPath.documentId() → "__name__" → plain limit */
async function fetchRecentDocs(logsCol, cap = 500) {
  // 1) Preferred: FieldPath.documentId()
  try {
    const mod = await import("firebase-admin/firestore");
    const FieldPath = mod.FieldPath || (mod.default && mod.default.FieldPath);
    if (FieldPath && typeof FieldPath.documentId === "function") {
      const snap = await logsCol.orderBy(FieldPath.documentId(), "desc").limit(cap).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
    }
    throw new Error("FieldPath unavailable");
  } catch (e1) {
    // 2) Fallback: "__name__"
    try {
      const snap = await logsCol.orderBy("__name__", "desc").limit(cap).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
    } catch (e2) {
      // 3) Last resort: just limit()
      const snap = await logsCol.limit(cap).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
    }
  }
}

/** ---------------- handlers ---------------- */

async function handleLogs(req, res) {
  console.error("analytics/logs entry", {
    path: req.originalUrl,
    shopHeader: (req.get("X-Shopify-Shop-Domain") || "").toLowerCase(),
    hasLocalsShop: !!(res.locals && res.locals.shop),
  });

  if (String(req.query.diag) === "1") {
    const shopEcho =
      (res.locals && res.locals.shop) ||
      (req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase() ||
      (req.query.shop || "");
    return res.json({ ok: true, shop: shopEcho, note: "diag mode (no Firestore)" });
  }

  const shop = requireFullShop(req, res);
  if (!shop) return;

  const fromQ = parseYYYYMMDD(req.query.from);
  const toQ = parseYYYYMMDD(req.query.to);
  const days = parseDaysParam(req.query.days, 30);
  const to = toQ || new Date();
  const from = fromQ || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(Number(req.query.limit) || 50, 1000);

  const logsCol = db.collection("conversations").doc(shop).collection("logs");

  try {
    const fallbackCap = Math.max(limit * 4, 200);
    const recent = await fetchRecentDocs(logsCol, fallbackCap);

    const rows = recent
      .map(({ id, data }) => {
        const tsRaw = data.ts ?? data.createdAt ?? data.timestamp ?? null;
        const dateObj = coerceDateMaybe(tsRaw);
        return { id, data, dateObj };
      })
      .filter((x) => x.dateObj && x.dateObj >= startOfDayUTC(from) && x.dateObj <= endOfDayUTC(to))
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
      range: { from: startOfDayUTC(from).toISOString(), to: endOfDayUTC(to).toISOString() },
      count: rows.length,
      rows,
    });
  } catch (err) {
    console.error("analytics/logs error:", {
      path: req.originalUrl,
      shop,
      err: err && (err.stack || err.message || err),
    });
    return res.status(500).json({ error: "Failed to load analytics logs." });
  }
}

async function handleOverview(req, res) {
  console.error("analytics/overview entry", {
    path: req.originalUrl,
    shopHeader: (req.get("X-Shopify-Shop-Domain") || "").toLowerCase(),
    hasLocalsShop: !!(res.locals && res.locals.shop),
  });

  if (String(req.query.diag) === "1") {
    const shopEcho =
      (res.locals && res.locals.shop) ||
      (req.get("X-Shopify-Shop-Domain") || "").trim().toLowerCase() ||
      (req.query.shop || "");
    return res.json({ ok: true, shop: shopEcho, note: "diag mode (no Firestore)" });
  }

  const shop = requireFullShop(req, res);
  if (!shop) return;

  const fromQ = parseYYYYMMDD(req.query.from);
  const toQ = parseYYYYMMDD(req.query.to);
  const days = parseDaysParam(req.query.days, 30);
  const to = toQ || new Date();
  const from = fromQ || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);

  const logsCol = db.collection("conversations").doc(shop).collection("logs");

  try {
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
      .filter((e) => e.ts && e.ts >= startOfDayUTC(from) && e.ts <= endOfDayUTC(to))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);

    const series = groupByDayUTC(entries, (e) => e.ts);
    const totals = {
      events: entries.length,
      aiEvents: entries.filter((e) => e.hadAi).length,
      sessions: new Set(entries.map((e) => e.sessionId).filter(Boolean)).size || null,
    };

    return res.json({
      range: { from: startOfDayUTC(from).toISOString(), to: endOfDayUTC(to).toISOString() },
      totals,
      rows: series,
    });
  } catch (err) {
    console.error("analytics/overview error:", {
      path: req.originalUrl,
      shop,
      err: err && (err.stack || err.message || err),
    });
    return res.status(500).json({ error: "Failed to load analytics overview." });
  }
}

/** Export a plain Router: server mounts at /api/admin → final URLs /api/admin/analytics/* */
const analyticsRouter = Router();
analyticsRouter.get("/analytics/logs", (req, res) => { handleLogs(req, res); });
analyticsRouter.get("/analytics/overview", (req, res) => { handleOverview(req, res); });
export default analyticsRouter;
