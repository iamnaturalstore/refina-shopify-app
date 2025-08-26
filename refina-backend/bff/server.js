// refina-backend/bff/server.js — PROD, Express v5-safe (no wildcard routes)

import express from "express";
import cors from "cors";
import proxy from "http-proxy-middleware"; // CJS interop in ESM
const { createProxyMiddleware } = proxy;
import crypto from "crypto";

import { db, getDocSafe, setDocSafe, nowTs } from "./lib/firestore.js";
import billingRouter from "../routes/billing.js";
import path from "path";
import { fileURLToPath } from "url";
import analyticsRouter from "../routes/analytics.js";
import storeSettingsRouter from "../routes/storeSettings.js"; // Home & Settings





// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);
const CACHE_TTL_MS = Number(process.env.BFF_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where your built assets live (Netlify root hosting concierge.(js|css))
const ASSETS_BASE_URL = String(process.env.ASSETS_BASE_URL || "https://refina.netlify.app").replace(/\/+$/, "");

// Public origin of THIS backend (for logs/health only)
const PUBLIC_BACKEND_ORIGIN = String(
  process.env.PUBLIC_BACKEND_ORIGIN ||
  process.env.APP_PUBLIC_URL ||
  "https://refina-shopify-app.onrender.com"
).replace(/\/+$/, "");

// Shopify App Proxy secret (used to verify /proxy/refina/v1/*)
const SHOPIFY_APP_SECRET = String(process.env.SHOPIFY_APP_SECRET || process.env.SHOPIFY_API_SECRET || "");

// ─────────────────────────────────────────────────────────────
// Tiny in-memory TTL cache
// ─────────────────────────────────────────────────────────────
const cache = new Map();
const cacheGet = (k) => {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(k); return null; }
  return v.val;
};
const cacheSet = (k, val, ttl = CACHE_TTL_MS) => cache.set(k, { val, exp: Date.now() + ttl });

// ─────────────────────────────────────────────────────────────
function normalizeConcern(s) {
  return String(s || "").toLowerCase().normalize("NFKC")
    .replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}
function stripHtml(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function tokenize(s) {
  return String(s || "").toLowerCase().normalize("NFKC")
    .replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}
function rankProducts(products, concern) {
  const terms = tokenize(concern);
  const w = { title: 3.0, tags: 2.2, keywords: 2.0, description: 1.6, productType: 1.0 };
  const scored = [];
  for (const p of products) {
    if (!p) continue;
    const titleText = p.title || p.name || "";
    const desc = stripHtml(p.description || "").slice(0, 800);
    const hay = {
      title: tokenize(titleText),
      tags: (Array.isArray(p.tags) ? p.tags : []).flatMap(tokenize),
      keywords: (Array.isArray(p.keywords) ? p.keywords : []).flatMap(tokenize),
      description: tokenize(desc),
      productType: tokenize(p.productType || ""),
    };
    let score = 0;
    for (const t of terms) {
      if (hay.title.includes(t)) score += w.title;
      if (hay.tags.includes(t)) score += w.tags;
      if (hay.keywords.includes(t)) score += w.keywords;
      if (hay.description.includes(t)) score += w.description;
      if (hay.productType.includes(t)) score += w.productType;
    }
    if (p.handle && (p.image || (Array.isArray(p.images) && p.images[0]?.src))) score += 0.3;
    if (score > 0) scored.push({ ...p, _score: score });
  }
  scored.sort((a, b) => b._score - a._score || (a.title || a.name || "").localeCompare(b.title || b.name || ""));
  return scored;
}
function shapeCopy({ products, concern, tone, category }) {
  const first = products[0] || {};
  const name = first.title || first.name || "this pick";
  const middleWord = /beauty|skin|hair|cosmetic/i.test(category) ? "ingredients" : "features";
  const why = /bestie/i.test(String(tone || "")) ?
    `I picked ${name} because it lines up beautifully with “${concern}”. It’s a solid, low-fuss match from this store.` :
    `Recommended: ${name}. It aligns strongly with “${concern}” based on the store’s catalogue signals.`;
  const rationale = `Relevance is based on product ${middleWord}, tags, and related keywords that map to “${concern}”.`;
  const extras = first.description
    ? `Tip: check the product page for usage guidance and added benefits noted in the description.`
    : `Tip: start low and adjust as needed; always follow usage directions on the product page.`;
  return { why, rationale, extras };
}
async function getSettings(storeId) {
  const ref = db.doc(`storeSettings/${storeId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    const seed = {
      tone: (process.env.BFF_DEFAULT_TONE || "expert").toLowerCase(),
      category: (process.env.BFF_DEFAULT_CATEGORY || "Generic"),
      enabledPacks: (process.env.BFF_ENABLED_PACKS || "").split(",").map(s => s.trim()).filter(Boolean),
      domain: "",
      createdAt: nowTs(),
      settingsVersion: 1,
    };
    await setDocSafe(ref, seed);
    return seed;
  }
  const data = snap.data() || {};
  const s = String(data.tone || "").toLowerCase();
  const tone =
    /bestie|friendly|warm|helpful/.test(s) ? "bestie" :
    /expert|pro|concise|direct/.test(s) ? "expert" :
    (process.env.BFF_DEFAULT_TONE || "expert");
  return { tone, category: data.category || "Generic", domain: data.domain || "", enabledPacks: data.enabledPacks || [] };
}

// Server-authoritative plan (ignore client on App Proxy routes)
async function getPlan(storeId) {
  try {
    const snap = await db.doc(`plans/${storeId}`).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const raw = String(data.plan || data.tier || data.name || "free").toLowerCase().trim();
    if (/\bpremium\b/.test(raw) || /\bpro\s*\+|\bpro\s*plus\b|^proplus$/.test(raw)) return "premium";
    if (/^pro\b/.test(raw)) return "pro";
    return "free";
  } catch {
    return "free";
  }
}

// Fetch products for a store, preferring subcollection products/{storeId}/items
async function fetchProducts(storeId, limit = 1500) {
  // Try subcollection first
  try {
    const subSnap = await db.collection(`products/${storeId}/items`).limit(limit).get();
    if (!subSnap.empty) {
      const out = [];
      subSnap.forEach(d => out.push({ id: d.id, ...d.data(), storeId }));
      return out;
    }
  } catch (e) {
    console.warn(`[BFF] subcollection fetch failed for ${storeId}:`, e?.message || e);
  }

  // Fallback to flat collection (back-compat)
  try {
    const flatSnap = await db.collection("products").where("storeId", "==", storeId).limit(limit).get();
    const out = [];
    flatSnap.forEach(d => out.push({ id: d.id, ...d.data() }));
    return out;
  } catch (e) {
    console.error(`[BFF] flat collection fetch failed for ${storeId}:`, e?.message || e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Per-shop rate limiter for App Proxy APIs (no deps)
// ─────────────────────────────────────────────────────────────
const rlBuckets = new Map();
const RL = { capacity: 60, refillPerSec: 1 }; // 60 req/min
const REFILL_PER_MS = RL.refillPerSec / 1000;

function rateLimitAppProxy(req, res, next) {
  // After requireAppProxy, req.storeId is set to <shop>.myshopify.com
  const key = req.storeId || String(req.query.shop || req.headers["x-shopify-shop-domain"] || req.ip);
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b) { b = { tokens: RL.capacity, last: now }; rlBuckets.set(key, b); }
  const elapsed = now - b.last;
  b.last = now;
  b.tokens = Math.min(RL.capacity, b.tokens + elapsed * REFILL_PER_MS);

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return next();
  }
  const retryAfterSec = Math.ceil((1 - b.tokens) / RL.refillPerSec) || 1;
  res.setHeader("Retry-After", String(retryAfterSec));
  return res.status(429).json({ error: "rate_limited", retryAfter: retryAfterSec });
}

// ─────────────────────────────────────────────────────────────
// Shopify App Proxy verification (for /proxy/refina/v1/*)
// ─────────────────────────────────────────────────────────────
function verifyAppProxy(req) {
  if (!SHOPIFY_APP_SECRET) return { ok: false, reason: "missing_secret" };

  // Build raw query string excluding 'signature', sorted by key; concat as k=v (no separators)
  const signature = String(req.query.signature || "");
  const entries = Object.entries(req.query)
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b));
  const message = entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join("");

  const expected = crypto.createHmac("sha256", SHOPIFY_APP_SECRET).update(message).digest("hex");
  const provided = signature;

  // timing-safe compare (hex)
  const ok =
    expected.length === provided.length &&
    crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));

  const shop = String(req.query.shop || req.headers["x-shopify-shop-domain"] || "").toLowerCase();
  return ok ? { ok: true, shop } : { ok: false, reason: ok ? "unknown" : "bad_signature", shop };
}

function requireAppProxy(req, res, next) {
  const v = verifyAppProxy(req);
  if (!v.ok) {
    const status = v.reason === "missing_secret" ? 500 : 401;
    return res.status(status).json({ error: "unauthorized", reason: v.reason });
  }
  if (!v.shop) return res.status(400).json({ error: "missing_shop" });

  // Canonical storeId = full myshopify domain
  req.shopDomain = v.shop;
  req.storeId = v.shop; // used in Firestore paths
  return next();
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ─────────────────────────────────────────────────────────────
// Shopify Webhooks (HMAC verified, raw body)
// ─────────────────────────────────────────────────────────────
const rawJson = express.raw({ type: "application/json" });

function verifyWebhookHmac(req, res, next) {
  if (!SHOPIFY_APP_SECRET) return res.status(500).send("missing_secret");
  const hmac = String(req.get("x-shopify-hmac-sha256") || "");
  const body = req.body; // Buffer from express.raw

  try {
    const digest = crypto.createHmac("sha256", SHOPIFY_APP_SECRET)
      .update(body)
      .digest("base64");

    const ok = hmac &&
      digest.length === hmac.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));

    if (!ok) return res.status(401).send("invalid_hmac");
    return next();
  } catch (e) {
    return res.status(400).send("hmac_error");
  }
}

// App uninstalled
app.post("/webhooks/app/uninstalled", rawJson, verifyWebhookHmac, async (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  try {
    const payload = JSON.parse(req.body.toString("utf8"));
    console.log(`[Webhook] ${topic} from ${shop} — ${payload?.id || ""}`);
  } catch (e) {
    console.error("app/uninstalled parse error", e);
  }
  res.status(200).send("ok");
});

// GDPR: customers/data_request
app.post("/webhooks/customers/data_request", rawJson, verifyWebhookHmac, (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  console.log(`[Webhook] ${topic} from ${shop}`);
  res.status(200).send("ok");
});

// GDPR: customers/redact
app.post("/webhooks/customers/redact", rawJson, verifyWebhookHmac, (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  console.log(`[Webhook] ${topic} from ${shop}`);
  res.status(200).send("ok");
});

// GDPR: shop/redact
app.post("/webhooks/shop/redact", rawJson, verifyWebhookHmac, (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  console.log(`[Webhook] ${topic} from ${shop}`);
  res.status(200).send("ok");
});

// (A) Shopify App Proxy HTML shell (no wildcards, exact path)
app.get("/proxy/refina", (_req, res) => {
  // CSP safe for Shopify storefront iframe
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self' https: data: blob:",
      "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
      "connect-src 'self' https: wss:",
      "img-src 'self' https: data: blob:",
      "style-src 'self' 'unsafe-inline' https:",
      "script-src 'self' https: 'unsafe-inline' 'unsafe-eval'",
    ].join("; ")
  );
  res.setHeader("Cache-Control", "no-store");

  // IMPORTANT: absolute shop paths so the browser requests /apps/refina/... on the shop
  // Shopify forwards those to our Proxy URL /proxy/refina/...
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Refina Concierge</title>
  <link rel="stylesheet" href="/apps/refina/concierge.css"/>
  <link rel="preload" as="script" href="/apps/refina/concierge.js"/>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/apps/refina/concierge.js" defer></script>
</body>
</html>`);
});

// (B) App Proxy APIs — authoritative for storefront
// Frontend calls /apps/refina/v1/* on the shop, Shopify forwards to /proxy/refina/v1/* here.
app.get("/proxy/refina/v1/concerns", requireAppProxy, rateLimitAppProxy, async (req, res) => {
  try {
    const storeId = req.storeId;

    const docChips = await getDocSafe(db.doc(`commonConcerns/${storeId}`));
    let chips = Array.isArray(docChips?.chips) ? docChips.chips : [];
    if (!chips.length) {
      const colSnap = await db.collection(`commonConcerns/${storeId}/items`).get();
      chips = colSnap.docs.map(d => d.data()?.text).filter(Boolean);
    }
    res.json({ storeId, chips });
  } catch (e) {
    console.error("GET /proxy/refina/v1/concerns error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/proxy/refina/v1/recommend", requireAppProxy, rateLimitAppProxy, async (req, res) => {
  const t0 = Date.now();
  try {
    const storeId = req.storeId;
    const concernInput = String(req.body?.concern || "").trim();
    if (!concernInput) return res.status(400).json({ error: "concern required" });

    // Enforce plan server-side; ignore client-provided plan
    const plan = await getPlan(storeId);

    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(storeId);
    const { category, tone, domain } = settings;

    const cacheKey = ["rec", storeId, normalizedConcern, plan, tone].join("|");
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: "hit" } });

    const allProducts = await fetchProducts(storeId);
    if (!allProducts.length) {
      console.warn(`[BFF] No products found for storeId=${storeId}`);
    }

    const mappingRef = db.doc(`mappings/${storeId}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];

    let source = "mapping";
    if (!productIds.length) {
      const ranked = rankProducts(allProducts, normalizedConcern);
      productIds = ranked.slice(0, 8).map(p => p.id);
      source = "fallback";
    }

    const used = productIds.slice(0, plan === "free" ? 3 : 8);
    

    const safeDomain = String(domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || "").replace(/^\/+|\/+$/g, "");
      const productUrl = p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : "");
      return {
        id: p.id,
        title: p.title || p.name || "",
        name: p.title || p.name || "",
        image: p.image || (Array.isArray(p.images) ? p.images[0]?.src : ""),
        description: p.description || "",
        productType: p.productType || "",
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null,
      };
    });

    const copy = shapeCopy({
      products: allProducts.filter(p => used.includes(p.id)),
      concern: normalizedConcern,
      tone,
      category,
    });

    const payload = {
      productIds: used,
      products: hydrate,
      copy,
      meta: { source, cache: "miss", tone, plan },
    };

    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error("POST /proxy/refina/v1/recommend error", e);
    res.status(500).json({ error: "internal_error" });
  } finally {
    const ms = Date.now() - t0;
    if (ms > 500) console.log(`[BFF] /proxy/refina/v1/recommend took ${ms}ms for ${req.storeId}`);
  }
});

// (C) Narrow asset proxies (AFTER App Proxy APIs; no catch-all)
app.use(
  "/proxy/refina/concierge.js",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => "/concierge.js",
    logLevel: "warn",
  })
);

app.use(
  "/proxy/refina/concierge.css",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => "/concierge.css",
    logLevel: "warn",
  })
);

app.use(
  "/proxy/refina/chunks",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: (p) => p.replace(/^\/proxy\/refina\/chunks/, "/chunks"),
    logLevel: "warn",
  })
);
// Serve the built Admin UI at /admin-ui/*
const ADMIN_UI_DIR = path.join(__dirname, "../admin-ui-dist");
app.use("/admin-ui", express.static(ADMIN_UI_DIR, { index: false }));

// SPA fallback (Express v5-safe: use RegExp, not "*")
app.get(/^\/admin-ui(?:\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, "index.html"));
});

// Redirect Embedded entry → /admin-ui/, preserving ?host=&shop=&storeId=
app.get("/embedded", (req, res) => {
  const qs = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  res.set("Cache-Control", "no-store");
  res.redirect(302, `/admin-ui/${qs}`);
});


// (E) Health (legacy direct endpoints are below; storefront should use /proxy/refina/v1/*)
app.get("/v1/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
  });
});

// (Legacy direct endpoints kept for health/local use; storefront should use /proxy/refina/v1/*)
app.get("/v1/concerns", async (req, res) => {
  try {
    const storeId = String(req.query.storeId || "").trim();
    if (!storeId) return res.status(400).json({ error: "storeId required" });

    const docChips = await getDocSafe(db.doc(`commonConcerns/${storeId}`));
    let chips = Array.isArray(docChips?.chips) ? docChips.chips : [];
    if (!chips.length) {
      const colSnap = await db.collection(`commonConcerns/${storeId}/items`).get();
      chips = colSnap.docs.map(d => d.data()?.text).filter(Boolean);
    }
    res.json({ storeId, chips });
  } catch (e) {
    console.error("GET /v1/concerns error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/v1/recommend", async (req, res) => {
  const t0 = Date.now();
  try {
    const { storeId: rawStoreId, concern: rawConcern, plan: rawPlan } = req.body || {};
    const storeId = String(rawStoreId || "").trim();
    const concernInput = String(rawConcern || "").trim();
    const plan = String(rawPlan || "free").toLowerCase();
    if (!storeId || !concernInput) return res.status(400).json({ error: "storeId and concern required" });

    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(storeId);
    const { category, tone, domain } = settings;

    const cacheKey = ["rec", storeId, normalizedConcern, plan, tone].join("|");
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: "hit" } });

    const allProducts = await fetchProducts(storeId);

    const mappingRef = db.doc(`mappings/${storeId}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];

    let source = "mapping";
    if (!productIds.length) {
      const ranked = rankProducts(allProducts, normalizedConcern);
      productIds = ranked.slice(0, 8).map(p => p.id);
      source = "fallback";
    }

    const used = productIds.slice(0, plan === "free" ? 3 : 8);

    const safeDomain = String(domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || "").replace(/^\/+|\/+$/g, "");
      const productUrl = p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : "");
      return {
        id: p.id,
        title: p.title || p.name || "",
        name: p.title || p.name || "",
        image: p.image || (Array.isArray(p.images) ? p.images[0]?.src : ""),
        description: p.description || "",
        productType: p.productType || "",
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null,
      };
    });

    const copy = shapeCopy({
      products: allProducts.filter(p => used.includes(p.id)),
      concern: normalizedConcern,
      tone,
      category,
    });

    const payload = {
      productIds: used,
      products: hydrate,
      copy,
      meta: { source, cache: "miss", tone, plan },
    };

    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error("POST /v1/recommend error", e);
    res.status(500).json({ error: "internal_error" });
  } finally {
    const ms = Date.now() - t0;
    if (ms > 500) console.log(`[BFF] /v1/recommend took ${ms}ms`);
  }
});
app.use("/api/billing", billingRouter); // /api/billing/plan, /subscribe, /sync
// Admin APIs used by Home/Settings/Analytics
app.use("/api/admin", analyticsRouter); // e.g. /api/admin/analytics/overview, /logs
app.use("/api/admin", storeSettingsRouter);   // /api/admin/store-settings (GET/POST)




// ─────────────────────────────────────────────────────────────
// Listen
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Refina BFF running on :${PORT}`);
  console.log(`HTML shell:     GET  /proxy/refina  (loads /apps/refina/concierge.(css|js) via App Proxy)`);
  console.log(`APIs (AppProxy):GET  /proxy/refina/v1/concerns  |  POST /proxy/refina/v1/recommend (HMAC)`);
  console.log(`Assets (narrow):GET  /proxy/refina/concierge.js  →  ${ASSETS_BASE_URL}/concierge.js`);
  console.log(`                GET  /proxy/refina/concierge.css  →  ${ASSETS_BASE_URL}/concierge.css`);
  console.log(`                GET  /proxy/refina/chunks/*       →  ${ASSETS_BASE_URL}/chunks/*`);
  console.log(`Admin stub:     GET  /embedded`);
  console.log(`Health:         GET  /v1/health`);
  console.log(`Origin:             ${PUBLIC_BACKEND_ORIGIN}`);
});
