// refina-backend/bff/server.js — PROD ONLY
import express from "express";
import cors from "cors";
import proxy from "http-proxy-middleware";
const { createProxyMiddleware } = proxy;

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

import { db, getDocSafe, setDocSafe, nowTs } from "./lib/firestore.js";

// ── Config ───────────────────────────────────────────────────
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);
const CACHE_TTL_MS = Number(process.env.BFF_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

const ASSETS_BASE_URL = String(
  process.env.ASSETS_BASE_URL || "https://refina.netlify.app"
).replace(/\/+$/, "");

const PUBLIC_BACKEND_ORIGIN = String(
  process.env.PUBLIC_BACKEND_ORIGIN ||
  process.env.APP_PUBLIC_URL ||
  "https://refina-shopify-app.onrender.com"
).replace(/\/+$/, "");

// Resolve paths relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Built embedded admin bundle directory:
// repo: refina-backend/admin-ui-dist (sibling of bff/)
const ADMIN_DIST_DIR = process.env.ADMIN_DIST_DIR ||
  path.resolve(__dirname, "..", "admin-ui-dist");

// ── Tiny in-memory TTL cache ─────────────────────────────────
const cache = new Map();
const cacheGet = (k) => {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(k); return null; }
  return v.val;
};
const cacheSet = (k, val, ttl = CACHE_TTL_MS) => cache.set(k, { val, exp: Date.now() + ttl });

// ── Helpers ──────────────────────────────────────────────────
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

// ── App ──────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// Shared CSP builder
const SHOPIFY_ANCESTORS = "https://*.myshopify.com https://admin.shopify.com";
const buildCsp = () => [
  "default-src 'self' https: data: blob:",
  `frame-ancestors ${SHOPIFY_ANCESTORS}`,
  "connect-src 'self' https: wss:",
  "img-src 'self' https: data: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "script-src 'self' https: 'unsafe-inline' 'unsafe-eval'",
].join("; ");

// (A) Normalize to trailing slash: /proxy/refina → /proxy/refina/
app.get("/proxy/refina", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/proxy/refina/${qs}`);
});

// (B) HTML shell at /proxy/refina/  (Shopify forwards /apps/refina → here via our redirect)
app.get("/proxy/refina/", (_req, res) => {
  res.setHeader("Content-Security-Policy", buildCsp());
  res.setHeader("Cache-Control", "no-store");

  // Use relative file names (directory base is guaranteed by trailing slash)
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Refina Concierge</title>
  <link rel="preload" as="script" href="concierge.js"/>
  <link rel="stylesheet" href="concierge.css"/>
</head>
<body>
  <div id="refina-root"></div>
  <script type="module" src="concierge.js" defer></script>
</body>
</html>`);
});

// (C) Asset proxy ONLY for subpaths, e.g. /proxy/refina/concierge.js
app.use(
  "/proxy/refina/",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: (path) => path.replace(/^\/proxy\/refina\/?/, ""), // → /concierge.js
    logLevel: "warn",
  })
);

// (D) Embedded admin (App URL) — serve built bundle from admin-ui-dist
function setEmbeddedHeaders(res) {
  res.setHeader("Content-Security-Policy", buildCsp());
  res.setHeader("Cache-Control", "no-store");
}
const adminIndex = path.join(ADMIN_DIST_DIR, "index.html");

// Serve /embedded (root) — index.html or a stub if missing
app.get("/embedded", (_req, res) => {
  setEmbeddedHeaders(res);
  if (fs.existsSync(adminIndex)) {
    res.sendFile(adminIndex);
  } else {
    res
      .type("html")
      .send(`<!doctype html><html><head><meta charset="utf-8"/><title>Refina Admin</title></head>
<body><h1>Refina Admin</h1><p>Embedded UI bundle not found yet.</p></body></html>`);
  }
});

// Serve static assets under /embedded (e.g., /embedded/assets/*)
app.use(
  "/embedded",
  (req, res, next) => { setEmbeddedHeaders(res); next(); },
  express.static(ADMIN_DIST_DIR, { index: false, fallthrough: true })
);

// SPA fallback for deep links under /embedded/*
app.get("/embedded/*", (_req, res) => {
  setEmbeddedHeaders(res);
  if (fs.existsSync(adminIndex)) {
    res.sendFile(adminIndex);
  } else {
    res.status(404).type("text/plain").send("Admin UI not built yet");
  }
});

// ── Health ───────────────────────────────────────────────────
app.get("/v1/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    cacheSize: cache.size,
    version: "bff-esm-prod",
    proxy: `prod → ${ASSETS_BASE_URL}`,
    origin: PUBLIC_BACKEND_ORIGIN,
  });
});

// ── Concerns ─────────────────────────────────────────────────
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

// ── Recommend ────────────────────────────────────────────────
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

// ── Listen ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Refina BFF running on :${PORT}`);
  console.log(`HTML shell:        GET  /proxy/refina/`);
  console.log(`Asset proxy:       GET  /proxy/refina/*  →  ${ASSETS_BASE_URL}/*`);
  console.log(`Admin (embedded):  GET  /embedded  (serving ${ADMIN_DIST_DIR})`);
  console.log(`Health:            GET  /v1/health`);
  console.log(`Public origin:         ${PUBLIC_BACKEND_ORIGIN}`);
});
