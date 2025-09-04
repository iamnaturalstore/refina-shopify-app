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

// --- Helper functions (no changes needed) ---
function parseYYYYMMDD(s) { /* ... */ }
function parseDaysParam(s, fallbackDays = 30, min = 1, max = 365) { /* ... */ }
function startOfDayUTC(d) { /* ... */ }
function endOfDayUTC(d)   { /* ... */ }
function toISO(x) { /* ... */ }
function groupByDayUTC(items, getDate) { /* ... */ }
function coerceDateMaybe(v) { /* ... */ }
async function fetchRecentDocs(logsCol, cap = 500) { /* ... */ }


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

  // FINAL FIX: Pointing to the correct Firestore collection
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

  // FINAL FIX: Pointing to the correct Firestore collection
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
    console.error("analytics/overview error:", { path: req.originalUrl, shop, err: err.message });
    return res.status(500).json({ error: "Failed to load analytics overview." });
  }
}

const analyticsRouter = Router();
analyticsRouter.get("/analytics/logs", handleLogs);
analyticsRouter.get("/analytics/overview", handleOverview);
export default analyticsRouter;
