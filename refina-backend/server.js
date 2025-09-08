// refina-backend/server.js (ESM, PROD-ONLY, Express v5-safe) - Theme App Embed + Admin CSP fix
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import cors from "cors";
import proxy from "http-proxy-middleware";
const { createProxyMiddleware } = proxy;

import shopify from "./shopify.js";
import billingRoutes from "./routes/billing.js";
import settingsRoutes from "./routes/settings.js";
import { db, getDocSafe, setDocSafe, nowTs } from "./bff/lib/firestore.js";

// NEW: Admin/BFF routes that the Admin UI uses
import analyticsRoutes from "./routes/analytics.js";
import adminSettingsRoutes from "./routes/adminSettings.js";     // Home & Settings pages
import analyticsIngestRoutes from "./routes/analyticsIngest.js"; // event logs intake (if used by Admin)
import privacyWebhooksRoutes from "./routes/privacyWebhooks.js"; // if your Admin UI surfaces privacy tools
import semanticRoutes from "./routes/semantic.js";               // if used (search/semantic endpoints)


// --- Config ------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "8081", 10);
const UI_DIST_PATH = `${process.cwd()}/admin-ui-dist`;
const ASSETS_BASE_URL = String(process.env.ASSETS_BASE_URL || "https://refina.netlify.app").replace(/\/+$/, "");

// --- App Initialization ------------------------------------------------------
const app = express();

// --- Shopify Auth & Webhook Routes (Public) --------------------------------
// These routes must come BEFORE any session validation or body parsing.
app.get("/api/auth", async (req, res) => {
  try {
    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(req.query.shop, true),
      callbackPath: "/api/auth/callback",
      isOnline: false,
      req,
      res,
    });
  } catch (e) {
    console.error("Auth begin error:", e);
    res.status(500).send(e.message);
  }
});

app.get("/api/auth/callback", async (req, res) => {
  try {
    const callback = await shopify.auth.callback({ req, res });
    // Land on the embedded Admin SPA so App Bridge boots inside the iframe
    res.redirect(`/?shop=${callback.session.shop}&host=${req.query.host}`);
  } catch (e) {
    console.error("Auth callback error:", e);
    res.status(500).send(e.message);
  }
});

app.post("/api/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    await shopify.webhooks.process({ req, res });
    console.log("Webhook processed successfully.");
  } catch (e) {
    console.error(`Failed to process webhook: ${e.message}`);
    if (!res.headersSent) res.status(500).send(e.message);
  }
});

// Put this before you mount /api routes
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`[API] ${req.method} ${req.path} -> ${res.statusCode} ${ms}ms`);
  });
  next();
});


// --- Security Checkpoint for Shopify Admin API -------------------------------
// All API routes below this point are for the Shopify Admin UI and require a
// valid session. This middleware handles the 401 Unauthorized errors and
// triggers the re-authentication flow correctly.
app.use("/api/*", shopify.validateAuthenticatedSession());

// --- Protected Shopify Admin API Routes --------------------------------------
app.use(express.json());
app.use(cors());

app.use("/api/billing", billingRoutes);
app.use("/api/settings", settingsRoutes);

// NEW: mount the Admin/BFF routes the UI expects
app.use("/api/admin/analytics", analyticsRoutes);
app.use("/api/admin/settings", adminSettingsRoutes);
app.use("/api/analytics/ingest", analyticsIngestRoutes);
app.use("/api/privacy", privacyWebhooksRoutes);
app.use("/api/semantic", semanticRoutes);


// --- Admin UI CSP (embed in Shopify Admin) -----------------------------------
// Apply frame-ancestors CSP to Admin UI pages/assets, but NOT to App Proxy/BFF.
const BFF_PREFIXES = ["/launcher.js", "/v1/", "/proxy/"];
app.use((req, res, next) => {
  const isBffOrProxy = BFF_PREFIXES.some((p) => req.path.startsWith(p));
  if (!isBffOrProxy) {
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
    );
    // Ensure no conflicting legacy header sneaks in
    try { res.removeHeader("X-Frame-Options"); } catch {}
  }
  next();
});

// --- Shopify App Frontend Serving (Admin SPA) --------------------------------
// This serves your compiled React app for the Shopify Admin.
app.use(express.static(UI_DIST_PATH));
app.use("/*", (req, res, next) => {
  // Allow BFF routes to pass through to the next section.
  const bffPaths = ["/launcher.js", "/v1/", "/proxy/"];
  if (bffPaths.some((p) => req.path.startsWith(p))) {
    return next();
  }
  // For all other paths, serve the React app's index.html.
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(readFileSync(join(UI_DIST_PATH, "index.html")));
});

// ─────────────────────────────────────────────────────────────
// BFF & App Proxy Logic (for public storefront widget)
// ─────────────────────────────────────────────────────────────
const cache = new Map();
const cacheGet = (k) => {
  const v = cache.get(k);
  if (!v || Date.now() > v.exp) { cache.delete(k); return null; }
  return v.val;
};
const cacheSet = (k, val, ttl = (24 * 60 * 60 * 1000)) =>
  cache.set(k, { val, exp: Date.now() + ttl });

function normalizeConcern(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
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
  scored.sort(
    (a, b) =>
      b._score - a._score || (a.title || a.name || "").localeCompare(b.title || b.name || "")
  );
  return scored;
}
function shapeCopy({ products, concern, tone, category }) {
  const first = products[0] || {};
  const name = first.title || first.name || "this pick";
  const middleWord = /beauty|skin|hair|cosmetic/i.test(category) ? "ingredients" : "features";
  const why =
    /bestie/i.test(String(tone || ""))
      ? `I picked ${name} because it lines up beautifully with “${concern}”. It’s a solid, low-fuss match from this store.`
      : `Recommended: ${name}. It aligns strongly with “${concern}” based on the store’s catalogue signals.`;
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
      enabledPacks: (process.env.BFF_ENABLED_PACKS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      domain: "",
      createdAt: nowTs(),
      settingsVersion: 1,
    };
    await setDocSafe(ref, seed);
    return seed;
  }
  const data = snap.data() || {};
  const s = String(data.tone || "").toLowerCase();
  const tone = /bestie|friendly|warm|helpful/.test(s)
    ? "bestie"
    : /expert|pro|concise|direct/.test(s)
    ? "expert"
    : (process.env.BFF_DEFAULT_TONE || "expert");
  return { tone, category: data.category || "Generic", domain: data.domain || "", enabledPacks: data.enabledPacks || [] };
}

// This proxy is specifically for the App Proxy to forward asset requests
const stripProxyPrefix = (path) => path.replace(/^\/proxy\/refina/, "");
app.use(
  "/proxy/refina",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: stripProxyPrefix,
    logLevel: "warn",
  })
);

// Launcher script for the Theme App Embed
app.get("/launcher.js", async (_req, res) => {
  try {
    const r = await fetch(`${ASSETS_BASE_URL}/index.html`);
    if (!r.ok) throw new Error("Could not fetch index.html from assets host");
    const html = await r.text();
    const m = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i);
    if (!m) throw new Error("Could not find entry script in index.html");
    const file = m[1].replace(/^\//, "");
    const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gi)].map((x) =>
      x[1].replace(/^\//, "")
    );
    const base = "/proxy/refina"; // All assets must be loaded via the app proxy
    const entryUrl = `${base}/${file}`;
    const cssUrls = css.map((href) => `${base}/${href}`);
    res
      .type("application/javascript")
      .send(
        `(function(){ const css = ${JSON.stringify(
          cssUrls
        )}; for (const href of css) { const l=document.createElement("link"); l.rel="stylesheet"; l.href=href; document.head.appendChild(l); } const s=document.createElement("script"); s.type="module"; s.src=${JSON.stringify(
          entryUrl
        )}; document.head.appendChild(s); })();`
      );
  } catch (e) {
    res
      .type("application/javascript")
      .status(500)
      .send(`console.error("Refina launcher error:", ${JSON.stringify(e.message)});`);
  }
});

// BFF API endpoints
app.get("/v1/health", (_req, res) =>
  res.json({ ok: true, now: new Date().toISOString(), cacheSize: cache.size, version: "unified-server" })
);
app.post("/v1/recommend", express.json(), async (req, res) => {
  const t0 = Date.now();
  try {
    const { storeId, concern, plan } = req.body || {};
    if (!storeId || !concern) return res.status(400).json({ error: "storeId and concern required" });

    const normalizedConcern = normalizeConcern(concern);
    const settings = await getSettings(storeId);
    const { category, tone, domain } = settings;

    const cacheKey = ["rec", storeId, normalizedConcern, plan, tone].join("|");
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: "hit" } });

    const snaps = await db.collection("products").where("storeId", "==", storeId).limit(1500).get();
    const allProducts = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));

    const mappingRef = db.doc(`mappings/${storeId}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];
    let source = productIds.length ? "mapping" : "fallback";
    if (!productIds.length) {
      productIds = rankProducts(allProducts, normalizedConcern).slice(0, 8).map((p) => p.id);
    }

    const used = productIds.slice(0, String(plan).toLowerCase() === "free" ? 3 : 8);
    const safeDomain = String(domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || "").replace(/^\/+|\/+$/g, "");
      const productUrl =
        p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : "");
      return {
        id,
        title: p.title || p.name || "",
        name: p.title || p.name || "",
        image: p.image || p.images?.[0]?.src || "",
        description: p.description || "",
        productType: p.productType || "",
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null,
      };
    });

    const copy = shapeCopy({ products: hydrate, concern: normalizedConcern, tone, category });
    const payload = { productIds: used, products: hydrate, copy, meta: { source, cache: "miss", tone } };
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

// --- Server Listen -----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Refina Unified Server running on :${PORT}`);
});
