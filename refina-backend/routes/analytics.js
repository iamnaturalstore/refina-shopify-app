// Admin Analytics routes (full-domain shop keys only)
// Final URLs (server mounts at /api/admin):
//   GET /api/admin/analytics/logs
//   GET /api/admin/analytics/overview

import { Router } from "express";
import { db } from "../bff/lib/firestore.js";
import { FieldPath } from "firebase-admin/firestore";

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

// --- Helper functions ---
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

// FINAL FIX: A simpler, more robust function to fetch documents.
async function fetchRecentDocs(logsCol, cap = 500) {
  try {
    // This is the modern, standard way to order by document creation time.
    // It's reliable and doesn't require complex fallbacks.
    const snap = await logsCol.orderBy(FieldPath.documentId(), "desc").limit(cap).get();
    
    // Ensure we always return an array, even if there are no docs.
    if (!snap.docs) return []; 
    
    return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  } catch (err) {
    console.error("Error in fetchRecentDocs:", err.message);
    // If the query fails for any reason (e.g., permissions), return an empty array.
    return [];
  }
}

/** ---------------- handlers ---------------- */

async function handleLogs(req, res) {
  const shop = requireFullShop(req, res);
  if (!shop) return;

  const fromQ = parseYYYYMMDD(req.query.from);
  const toQ = parseYYYYMMDD(req.query.to);
  const days = parseDaysParam(req.query.days, 30);
  const to = toQ || new Date();
  const from = fromQ || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(Number(req.query.limit) || 50, 1000);

  const logsCol = db.collection("analytics").doc(shop).collection("events");

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
        plan: data.plan ?? null,
        model: data.model ?? null,
        ts: toISO(data.ts ?? data.createdAt ?? data.timestamp ?? null),
        meta: data.meta ?? null,
      }));

    return res.json({
      range: { from: startOfDayUTC(from).toISOString(), to: endOfDayUTC(to).toISOString() },
      count: rows.length,
      rows,
    });
  } catch (err) {
    console.error("analytics/logs error:", { path: req.originalUrl, shop, err: err.message });
    return res.status(500).json({ error: "Failed to load analytics logs." });
  }
}

async function handleOverview(req, res) {
  const shop = requireFullShop(req, res);
  if (!shop) return;

  const fromQ = parseYYYYMMDD(req.query.from);
  const toQ = parseYYYYMMDD(req.query.to);
  const days = parseDaysParam(req.query.days, 30);
  const to = toQ || new Date();
  const from = fromQ || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);

  const logsCol = db.collection("analytics").doc(shop).collection("events");

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
          hadAi: !!(data.concern || data.model || (Array.isArray(data.productIds) && data.productIds.length > 0)),
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
    console.error("analytics/overview error:", { path: req.originalUrl, shop, err: err.message });
    return res.status(500).json({ error: "Failed to load analytics overview." });
  }
}

const analyticsRouter = Router();
analyticsRouter.get("/analytics/logs", handleLogs);
analyticsRouter.get("/analytics/overview", handleOverview);
export default analyticsRouter;

