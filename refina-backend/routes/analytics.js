// refina-backend/routes/analytics.js
// Admin Analytics routes (full-domain shop keys only)
// Final URLs (server mounts at /api/admin):
//   GET /api/admin/analytics/logs
//   GET /api/admin/analytics/overview
// writer → conversations/{shop}/logs, reader → order by ts desc; fields: concern, productIds, planLevel, model, source, surface, ts.

import { Router } from "express";
import { db } from "../lib/firestore.js";
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
/** Bucket raw event names into the channel a merchant actually recognizes. */
function channelForEvent(eventName) {
  const e = String(eventName || "").toLowerCase();
  if (e === "recommendation_received") return "Widget";
  if (e === "drawer_open" || e === "drawer_confirm") return "PDP Drawer";
  return "Other";
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

// --- Query helper: prefer 'ts' descending, with safe fallbacks ---
async function loadRecent(logsCol, cap) {
  try {
    const snap = await logsCol.orderBy("ts", "desc").limit(cap).get();
    return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  } catch {
    try {
      const snap = await logsCol.orderBy(FieldPath.documentId(), "desc").limit(cap).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
    } catch (err) {
      console.error("[analytics] loadRecent error:", err?.message || err);
      return [];
    }
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

  // ✅ Canonical SoT path
  const logsCol = db.collection("conversations").doc(shop).collection("logs");

  try {
    const cap = Math.max(limit * 4, 200);
    const recent = await loadRecent(logsCol, cap);

    const rows = recent
      .map(({ id, data }) => {
        const tsRaw = data.ts ?? data.timestamp ?? null; // we don't use createdAt anymore
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
        topProductTitle: data.topProductTitle ?? null,
        plan: data.planLevel ?? null,
        model: (data.model ?? data.meta?.model) ?? null,
        source: data.source ?? null,    // 'gemini' | 'fallback' | 'mapping'
        surface: data.surface ?? null,  // 'storefront' | 'admin' | 'api'
        ts: toISO(data.ts ?? data.timestamp ?? null),
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

  const logsCol = db.collection("conversations").doc(shop).collection("logs");

  try {
    const cap = Math.max(limit * 4, 500);
    const recent = await loadRecent(logsCol, cap);

    const entries = recent
      .map(({ data }) => {
        const tsRaw = data.ts ?? data.timestamp ?? null;
        return {
          ts: coerceDateMaybe(tsRaw),
          plan: data.planLevel ?? null,
          model: (data.model ?? data.meta?.model) ?? null,
          source: data.source ?? null,
          surface: data.surface ?? null,
          event: data.event ?? null,
          concern: data.concern ?? null,
          sessionId: data.sessionId ?? null,
          hadAi: data.source !== "cache",
        };
      })
      .filter((e) => e.ts && e.ts >= startOfDayUTC(from) && e.ts <= endOfDayUTC(to))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);

    // product_click is a click-through signal, not a query — keep it out of the
    // query-oriented aggregates (Total Queries, concerns, peak hour) and count it separately.
    const productClicks = entries.filter((e) => e.event === "product_click").length;
    const queryEntries = entries.filter((e) => e.event !== "product_click");

    const series = groupByDayUTC(queryEntries, (e) => e.ts);
    const surfaceCounts = {};
    const hourCounts = {};
    const concernCounts = new Map();
    for (const e of queryEntries) {
      const channel = channelForEvent(e.event);
      surfaceCounts[channel] = (surfaceCounts[channel] || 0) + 1;
      if (e.ts) {
        const hour = e.ts.getUTCHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
      const concern = String(e.concern || "").trim().toLowerCase();
      if (concern) concernCounts.set(concern, (concernCounts.get(concern) || 0) + 1);
    }
    const peakHour = Object.keys(hourCounts).length
      ? Number(Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0][0])
      : null;
    const topConcerns = Array.from(concernCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, count]) => ({ label, count }));
    const totals = {
      events: queryEntries.length,
      aiEvents: queryEntries.filter((e) => e.hadAi).length,
      sessions: new Set(queryEntries.map((e) => e.sessionId).filter(Boolean)).size || null,
      surfaceCounts,
      peakHour,
      uniqueConcerns: concernCounts.size,
      topConcerns,
      productClicks,
      clickThroughRate: queryEntries.length ? productClicks / queryEntries.length : 0,
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
