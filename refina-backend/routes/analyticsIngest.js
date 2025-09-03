// refina-backend/routes/analyticsIngest.js
// PROD-CHECKLIST:
// - Enforce full-domain shop only (toMyshopifyDomain); no short IDs
// - No wildcards; no renames; keep aliases so storefront posts don't miss
// - Security: HMAC for App Proxy path handled upstream; here we canonicalize & bound inputs
// - Telemetry headers set; Cache-Control no-store
// - Do NOT persist storeId or createdAt fields

import { Router } from "express";
import { db, nowTs } from "../bff/lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

const router = Router({ caseSensitive: false });

function canonShopFrom(req) {
  // Prefer explicit query param, then header, then body
  const raw =
    (req.query && (req.query.shop || req.query.storeId)) ||
    req.get("x-shopify-shop-domain") ||
    (req.body && (req.body.shop || req.body.storeId)) ||
    "";
  return toMyshopifyDomain(String(raw || "").toLowerCase().trim());
}

function sanitizeEventBody(body = {}) {
  const out = {};
  // Only allow a few top-level fields
  if (typeof body.event === "string") out.event = body.event.slice(0, 64);
  if (typeof body.uid === "string") out.uid = body.uid.slice(0, 128);
  if (body.meta && typeof body.meta === "object") {
    // shallow copy, cap size
    const m = {};
    for (const [k, v] of Object.entries(body.meta)) {
      if (mSize(m) > 4096) break;
      if (typeof k !== "string") continue;
      const key = k.slice(0, 40);
      const val = typeof v === "string" ? v.slice(0, 256) : (isJsonable(v) ? v : String(v));
      m[key] = val;
    }
    out.meta = m;
  }
  if (body.payload && typeof body.payload === "object") {
    // retain small safe payloads only
    const p = {};
    for (const [k, v] of Object.entries(body.payload)) {
      if (mSize(p) > 8192) break;
      if (typeof k !== "string") continue;
      const key = k.slice(0, 40);
      const val = typeof v === "string" ? v.slice(0, 512) : (isJsonable(v) ? v : String(v));
      p[key] = val;
    }
    out.payload = p;
  }
  return out;
}

function mSize(obj) {
  try { return Buffer.byteLength(JSON.stringify(obj)); } catch { return 0; }
}
function isJsonable(v) {
  try { JSON.stringify(v); return true; } catch { return false; }
}

// Core write: analytics/{shop}/events/<autoId>
async function writeEvent(shop, data) {
  const ref = db.collection(`analytics/${shop}/events`).doc();
  // Explicitly avoid persisting storeId or createdAt (use ts)
  const toWrite = {
    ...data,
    ts: nowTs()
  };
  await ref.set(toWrite);
  return ref.id;
}

// ─────────────────────────────────────────────────────────────
// Routes (no wildcards). We keep aliases so callers don't miss.
// Mounted in server.js at:
//   - /api/admin            (→ expects /analytics/ingest)
//   - /api                  (→ expects /analytics/ingest)
//   - /proxy/refina/v1/analytics/ingest  (→ expects "/")
// ─────────────────────────────────────────────────────────────

// Storefront (App Proxy mount): server mounts router at /proxy/refina/v1/analytics/ingest
router.post("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-20250903");
  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "shop_required" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    const id = await writeEvent(shop, {
      ...clean,
      // telemetry only (not persisted as storeId/createdAt)
      source: "storefront"
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("[analyticsIngest] storefront write failed:", e?.message || e);
    res.status(500).json({ error: "internal_error" });
  }
});

// Admin/API alias: /api/analytics/ingest
router.post("/analytics/ingest", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-20250903");
  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "shop_required" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    const id = await writeEvent(shop, {
      ...clean,
      source: "admin"
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("[analyticsIngest] admin write failed:", e?.message || e);
    res.status(500).json({ error: "internal_error" });
  }
});

// Additional alias for back-compat (if any caller uses /v1/analytics/ingest under /api)
router.post("/v1/analytics/ingest", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "analytics-ingest-20250903");
  const shop = canonShopFrom(req);
  if (!shop) return res.status(400).json({ error: "shop_required" });

  try {
    const clean = sanitizeEventBody(req.body || {});
    const id = await writeEvent(shop, {
      ...clean,
      source: "alias"
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("[analyticsIngest] alias write failed:", e?.message || e);
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
