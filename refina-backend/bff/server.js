// refina-backend/bff/server.js — PROD, Express v5-safe (no wildcard routes)

import express from "express";
import cors from "cors";
import proxy from "http-proxy-middleware"; // CJS interop in ESM
const { createProxyMiddleware } = proxy;
import crypto from "crypto";

import { db, getDocSafe, setDocSafe, nowTs } from "./lib/firestore.js";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);
const CACHE_TTL_MS = Number(process.env.BFF_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

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
      category: process.env.BFF_DEFAULT_CATEGORY || "Generic",
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

// ─────────────────────────────────────────────────────────────
// Shopify App Proxy verification (for /proxy/refina/v1/*)
// ─────────────────────────────────────────────────────────────
function verifyAppProxy(req) {
  if (!SHOPIFY_APP_SECRET) return { ok: false, reason: "missing_secret" };

  // App Proxy uses `signature` (hex HMAC-SHA256 of concatenated, sorted key=value pairs)
  const provided = String(req.query.signature || "").trim().toLowerCase();
  if (!provided) return { ok: false, reason: "missing_signature" };

  // Build the message from ALL query params except `signature`, sorted by key, concatenated with no separators.
  // Each pair is "key=value"; if a key has multiple values, join them with commas (stable across frameworks).
  const params = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "signature") continue;
    params[k] = Array.isArray(v) ? v.join(",") : String(v);
  }
  const message = Object.keys(params)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${params[k]}`)
    .join("");

  const expected = crypto.createHmac("sha256", SHOPIFY_APP_SECRET).update(message, "utf8").digest("hex");

  // timing-safe compare; guard against unequal lengths which would throw
  const ok =
    expected.length === provided.length &&
    crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));

  const shop = String(req.query.shop || req.headers["x-shopify-shop-domain"] || "").toLowerCase();
  return ok ? { ok: true, shop } : { ok: false, reason: "bad_signature", shop };
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

// (B) Asset proxy for subpaths only (mount with trailing slash; no wildcard patterns)
app.use(
  "/proxy/refina/",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: (path) => {
      // /proxy/refina/concierge.js  →  /concierge.js
      const out = path.replace(/^\/proxy\/refina\/?/, "/");
      return out.startsWith("/") ? out : `/${out}`;
    },
    logLevel: "warn",
  })
);

// (C) Minimal admin stub so App URL is always 200
app.get("/embedded", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Refina Admin</title></head>
<body><h1>Refina Admin</h1><p>Embedded UI coming soon.</p></body></html>`);
});

// (D) Health
app.get("/v1/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    cacheSize: cache.size,
    version: "bff-esm-prod",
    proxy: `→ ${ASSETS_BASE_URL}`,
    origin: PUBLIC_BACKEND_ORIGIN,
  });
});

// (E) Data APIs — App Proxy versions (authoritative for storefront)
//     Frontend calls /apps/refina/v1/* on the shop, which Shopify forwards to /proxy/refina/v1/* here.
app.get("/proxy/refina/v1/concerns", requireAppProxy, async (req, res) => {
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

app.post("/proxy/refina/v1/recommend", requireAppProxy, async (req, res) => {
  const t0 = Date.now();
  try {
    const storeId = req.storeId;
    const concernInput = String(req.body?.concern || "").trim();
    const plan = String(req.body?.plan || "free").toLowerCase();
    if (!concernInput) return res.status(400).json({ error: "concern required" });

    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(storeId);
    const { category, tone, domain } = settings;

    const cacheKey = ["rec", storeId, normalizedConcern, plan, tone].join("|");
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: "hit" } });

    const snaps = await db.collection("products").where("storeId", "==", storeId).limit(1500).get();
    const allProducts = [];
    snaps.forEach(d => allProducts.push({ id: d.id, ...d.data() }));

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
      meta: { source, cache: "miss", tone },
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

    const snaps = await db.collection("products").where("storeId", "==", storeId).limit(1500).get();
    const allProducts = [];
    snaps.forEach(d => allProducts.push({ id: d.id, ...d.data() }));

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
      meta: { source, cache: "miss", tone },
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

// ─────────────────────────────────────────────────────────────
// Listen
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Refina BFF running on :${PORT}`);
  console.log(`HTML shell:   GET  /proxy/refina  (loads /apps/refina/concierge.(css|js) via App Proxy)`);
  console.log(`Asset proxy:  GET  /proxy/refina/*  →  ${ASSETS_BASE_URL}/*`);
  console.log(`APIs:         GET  /proxy/refina/v1/concerns  |  POST /proxy/refina/v1/recommend (App Proxy, HMAC)`);
  console.log(`Admin stub:   GET  /embedded`);
  console.log(`Health:       GET  /v1/health`);
  console.log(`Origin:           ${PUBLIC_BACKEND_ORIGIN}`);
});
