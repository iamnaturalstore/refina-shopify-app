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
import adminSettingsRouter from "../routes/adminSettings.js"; // Home & Settings
import { toMyshopifyDomain } from "../utils/resolveStore.js";
import analyticsIngestRouter from "../routes/analyticsIngest.js";
import { callGemini } from "./ai/gemini.js";
import { buildGeminiPrompt } from "./ai/buildGeminiPrompt.js";
import { expandConcernToIngredients, getIngredientFacts } from "./lib/knowledge.js";

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

// Gemini pruning/top-K (env-tunable)
const TOPK = Number(process.env.REFINA_GEMINI_TOPK || 60);

// --- Gemini helpers: condense candidates, parse JSON, and normalize the contract ---

function shorten(text = "", max = 240) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function condenseProducts(products = []) {
  return products
    .slice(0, 120)
    .map((p) => ({
      id: p.id || p.productId || p.handle || "",
      name: p.name || p.title || "",
      productType: p.productTypeNormalized || p.productType || "",
      // Prefer normalized arrays if available
      ingredients: Array.isArray(p.ingredientsNormalized)
        ? p.ingredientsNormalized
        : Array.isArray(p.ingredients)
        ? p.ingredients
        : Array.isArray(p.keyIngredients)
        ? p.keyIngredients
        : [],
      keywords: Array.isArray(p.keywordsNormalized)
        ? p.keywordsNormalized
        : Array.isArray(p.keywords)
        ? p.keywords
        : [],
      tags: Array.isArray(p.tags)
        ? p.tags
        : typeof p.tags === "string"
        ? p.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [],
      descriptionShort: shorten(p.descriptionShort || p.description || p.body_html || ""),
      price: p.price || p.minPrice || p.compareAtPrice || undefined,
      usageStep: p.usageStep || p.step || "",
      productType_norm: p.productType_norm || p.productTypeNormalized || p.productType || "",
      category: p.categoryNormalized || p.category || ""
    }))
    .filter((x) => x.id && x.name);
}

// Accepts model text that may be raw JSON or wrapped in ```json fences
function extractJson(text = "") {
  const raw = String(text).trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonLike = fenceMatch ? fenceMatch[1] : raw;
  try {
    return JSON.parse(jsonLike);
  } catch {
    // try to find a top-level JSON object in the text
    const start = jsonLike.indexOf("{");
    const end = jsonLike.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const maybe = jsonLike.slice(start, end + 1);
      try {
        return JSON.parse(maybe);
      } catch {}
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function coerceToContract(obj = {}) {
  const primary = obj.primary || {};
  const alts = Array.isArray(obj.alternatives) ? obj.alternatives : [];
  const explanation = obj.explanation || {};
  if (!obj || typeof obj !== "object") obj = {};

  const safePrimary = {
    id: String(primary.id || "").trim(),
    score: Number.isFinite(primary.score) ? primary.score : 0,
    reasons: Array.isArray(primary.reasons) ? primary.reasons.slice(0, 6).map(String) : [],
    howToUse: Array.isArray(primary.howToUse) ? primary.howToUse.slice(0, 6).map(String) : [],
    tagsMatched: Array.isArray(primary.tagsMatched) ? primary.tagsMatched.slice(0, 8).map(String) : []
  };

  const safeAlts = alts
    .slice(0, 2)
    .map((a) => ({
      id: String(a.id || "").trim(),
      when: String(a.when || "").trim(),
      reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 3).map(String) : []
    }))
    .filter((a) => a.id);

  const safeExpl = {
    oneLiner: String(explanation.oneLiner || "").trim(),
    friendlyParagraph: String(explanation.friendlyParagraph || "").trim(),
    expertBullets: Array.isArray(explanation.expertBullets)
      ? explanation.expertBullets.slice(0, 6).map(String)
      : [],
    usageTips: Array.isArray(explanation.usageTips) ? explanation.usageTips.slice(0, 6).map(String) : []
  };

  // Back-compat fields expected by current UI
  const productIds = [safePrimary.id, ...safeAlts.map((a) => a.id)].filter(Boolean);

  const explanationFlat = safeExpl.friendlyParagraph || safeExpl.oneLiner || "";

  return {
    primary: safePrimary,
    alternatives: safeAlts,
    explanation: safeExpl,
    productIds,
    explanationFlat
  };
}

// ─────────────────────────────────────────────────────────────
// Tiny in-memory TTL cache
// ─────────────────────────────────────────────────────────────
const cache = new Map();
const cacheGet = (k) => {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(k);
    return null;
  }
  return v.val;
};
const cacheSet = (k, val, ttl = CACHE_TTL_MS) => cache.set(k, { val, exp: Date.now() + ttl });

// ─────────────────────────────────────────────────────────────
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

// Ranker with mode & ingredient/type awareness
function rankProducts(products, concern, opts = {}) {
  const { rankMode = "relevant", targetIngredients = [], productType = "" } = opts;
  const terms = tokenize(concern);
  const ingSet = new Set((targetIngredients || []).map((x) => String(x).toLowerCase()));
  const typeTerm = String(productType || "").toLowerCase();

  // base weights
  let w = { title: 3.0, tags: 2.2, keywords: 2.0, description: 1.6, productType: 1.0, ing: 3.2, typeBoost: 1.5 };

  // mode tweaks
  if (rankMode === "rated") {
    w = { ...w, title: 2.6, tags: 2.0, keywords: 1.8, description: 1.4 };
  } else if (rankMode === "popular") {
    w = { ...w, title: 2.6, tags: 1.9, keywords: 1.7, description: 1.3 };
  }

  const scored = [];
  for (const p of products) {
    if (!p) continue;
    const titleText = p.title || p.name || "";
    const desc = stripHtml(p.description || "").slice(0, 800);
    const hay = {
      title: tokenize(titleText),
      tags: (Array.isArray(p.tags) ? p.tags : []).flatMap(tokenize),
      keywords: (Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized : Array.isArray(p.keywords) ? p.keywords : []).flatMap(tokenize),
      description: tokenize(desc),
      productType: tokenize(p.productType || p.productTypeNormalized || "")
    };
    const ings = Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized : Array.isArray(p.ingredients) ? p.ingredients : [];
    let score = 0;

    for (const t of terms) {
      if (hay.title.includes(t)) score += w.title;
      if (hay.tags.includes(t)) score += w.tags;
      if (hay.keywords.includes(t)) score += w.keywords;
      if (hay.description.includes(t)) score += w.description;
      if (hay.productType.includes(t)) score += w.productType;
    }
    // Ingredient & type nudges
    if (ings.some((x) => ingSet.has(String(x).toLowerCase()))) score += w.ing;
    if (typeTerm && hay.productType.includes(typeTerm)) score += w.typeBoost;

    // Light quality nudge: image present
    if (p.handle && (p.image || (Array.isArray(p.images) && p.images[0]?.src))) score += 0.3;

    // Mode: allow optional external signals
    if (rankMode === "rated" && Number.isFinite(p.avgRating) && Number.isFinite(p.reviewCount)) {
      score += (p.avgRating / 5) * Math.log10(1 + p.reviewCount) * 2.0;
    }
    if (rankMode === "popular" && Number.isFinite(p.salesVelocity)) {
      score += Math.log10(1 + p.salesVelocity) * 1.6;
    }

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
  const why = /bestie/i.test(String(tone || ""))
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
      settingsVersion: 1
    };
    await setDocSafe(ref, seed);
    return seed;
  }
  const data = snap.data() || {};
  const s = String(data.tone || "").toLowerCase();
  const tone =
    /bestie|friendly|warm|helpful/.test(s)
      ? "bestie"
      : /expert|pro|concise|direct/.test(s)
      ? "expert"
      : process.env.BFF_DEFAULT_TONE || "expert";
  return {
    tone,
    category: data.category || "Generic",
    domain: data.domain || "",
    enabledPacks: data.enabledPacks || []
  };
}

// Server-authoritative plan (ignore client on App Proxy routes)
async function getPlan(storeId) {
  try {
    const snap = await db.doc(`plans/${storeId}`).get();
    const data = snap.exists ? snap.data() || {} : {};
    const raw = String(data.plan || data.tier || data.name || data.level || "free")
      .toLowerCase()
      .trim();
    if (/\bpremium\b/.test(raw)) return "premium";
    if (/^pro\b/.test(raw)) return "pro";
    return "free";
  } catch {
    return "free";
  }
}

// Fetch products for a store, preferring subcollection products/{storeId}/items
async function fetchProducts(storeId, limit = 1500) {
  try {
    const subSnap = await db.collection(`products/${storeId}/items`).limit(limit).get();
    if (!subSnap.empty) {
      const out = [];
      subSnap.forEach((d) => out.push({ id: d.id, ...d.data(), storeId }));
      return out;
    }
  } catch (e) {
    console.warn(`[BFF] subcollection fetch failed for ${storeId}:`, e?.message || e);
  }

  // Fallback to flat collection (back-compat)
  try {
    const flatSnap = await db.collection("products").where("storeId", "==", storeId).limit(limit).get();
    const out = [];
    flatSnap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
  } catch (e) {
    console.error(
      `[BFF] flat collection fetch failed for ${storeId}:`,
      e?.message || e
    );
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
  const key =
    req.storeId || String(req.query.shop || req.headers["x-shopify-shop-domain"] || req.ip);
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b) {
    b = { tokens: RL.capacity, last: now };
    rlBuckets.set(key, b);
  }
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
// Shopify App Proxy verification (HMAC verified)
// ─────────────────────────────────────────────────────────────
function verifyAppProxy(req) {
  if (!SHOPIFY_APP_SECRET) return { ok: false, reason: "missing_secret" };

  const signature = String(req.query.signature || "");
  const entries = Object.entries(req.query)
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b));
  const message = entries
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
    .join("");

  const expected = crypto.createHmac("sha256", SHOPIFY_APP_SECRET).update(message).digest("hex");
  const provided = signature;

  const shop = String(req.query.shop || req.headers["x-shopify-shop-domain"] || "").toLowerCase();
  return okSafeCompareHex(expected, provided) ? { ok: true, shop } : { ok: false, reason: "bad_signature", shop };
}
function okSafeCompareHex(aHex, bHex) {
  try {
    return aHex.length === bHex.length &&
      crypto.timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
  } catch {
    return false;
  }
}

function requireAppProxy(req, res, next) {
  const v = verifyAppProxy(req);
  if (!v.ok) {
    const status = v.reason === "missing_secret" ? 500 : 401;
    return res.status(status).json({ error: "unauthorized", reason: v.reason });
  }
  if (!v.shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v.shop)) {
    return res.status(400).json({ error: "invalid_shop" });
  }

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

// ───────────────────────── BEGIN Refina settings v1 ─────────────────────────
// (unchanged defaults + now merged with Firestore settings)
const RF_DEFAULT_THEME = {
  presetId: "minimal",
  version: 1,
  tokens: {
    "--rf-color-primary": "#1a73e8",
    "--rf-color-text": "#111111",
    "--rf-radius": "12px",
    "--rf-shadow": "0 8px 28px rgba(0,0,0,0.12)",
    "--rf-spacing": "12px",
    "--rf-font-family":
      "system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
    "--rf-density": "1"
  }
};

function rfStableStringify(x) {
  try {
    const seen = new WeakSet();
    const sortKeys = (obj) => {
      if (obj && typeof obj === "object") {
        if (seen.has(obj)) return obj;
        seen.add(obj);
        if (Array.isArray(obj)) return obj.map(sortKeys);
        const out = {};
        for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
        return out;
      }
      return obj;
    };
    return JSON.stringify(sortKeys(x));
  } catch {
    return JSON.stringify(x);
  }
}
function rfMakeEtag(obj) {
  try {
    const s = rfStableStringify(obj);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `"rf-${(h >>> 0).toString(16)}"`;
  } catch {
    return `"rf-${Date.now().toString(16)}"`;
  }
}

// HMAC-protected App Proxy settings → returns Admin tokens over defaults
app.get("/proxy/refina/v1/settings", requireAppProxy, rateLimitAppProxy, async (req, res) => {
  try {
    const shop = req.storeId; // verified <shop>.myshopify.com

    // Read Admin-saved settings (canonical)
    const snap = await db.doc(`storeSettings/${shop}`).get();
    const doc = snap.exists ? (snap.data() || {}) : {};

    // Back-compat: support legacy { theme:{...} } OR flat shape
    const theme = (doc && typeof doc.theme === "object") ? doc.theme : doc;

    // Merge defaults ← Admin tokens (Admin wins)
    const mergedTokens = { ...RF_DEFAULT_THEME.tokens, ...(theme.tokens || {}) };

    const payload = {
      shop,
      presetId: theme.presetId || RF_DEFAULT_THEME.presetId,
      version: Number(theme.version || RF_DEFAULT_THEME.version),
      tokens: mergedTokens,
      tone: theme.tone || doc.tone || "expert",
      category: theme.category || doc.category || "Beauty",
      domain: theme.domain || doc.domain || "",
      enabledPacks: theme.enabledPacks || doc.enabledPacks || [],
      valid: true,
      updatedAt: new Date().toISOString()
    };

    res.set("X-RF-Handler", "settings-merged-20250902");
    if (String(req.query.dbg || "") === "1") {
      payload.debug = {
        handler: "settings-merged-20250902",
        shop,
        tokenCount: Object.keys(mergedTokens).length,
        tokenSample: {
          "--rf-color-primary": mergedTokens["--rf-color-primary"] || null
        },
        docPath: `storeSettings/${shop}`,
        hadLegacyThemeWrapper: !!(doc && doc.theme && typeof doc.theme === "object")
      };
    }

    const etag = rfMakeEtag(payload);
    if (req.headers["if-none-match"] === etag) {
      res.set("ETag", etag);
      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=30");
      return res.status(304).end();
    }
    res.set("ETag", etag);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=30");
    return res.type("application/json").status(200).send(rfStableStringify(payload));
  } catch (err) {
    const fallback = { ...RF_DEFAULT_THEME, valid: false, error: "theme_fetch_failed" };
    res.set("X-RF-Handler", "settings-fallback-20250902");
    const etag = rfMakeEtag(fallback);
    res.set("ETag", etag);
    res.set("Cache-Control", "public, max-age=60");
    return res.type("application/json").status(200).send(rfStableStringify(fallback));
  }
});


// ────────────────────────── END Refina settings v1 ──────────────────────────

// Webhooks (unchanged except validations)
const rawJson = express.raw({ type: "application/json" });
function verifyWebhookHmac(req, res, next) {
  if (!SHOPIFY_APP_SECRET) return res.status(500).send("missing_secret");
  const hmac = String(req.get("x-shopify-hmac-sha256") || "");
  const body = req.body; // Buffer from express.raw
  try {
    const digest = crypto.createHmac("sha256", SHOPIFY_APP_SECRET).update(body).digest("base64");
    const ok =
      hmac &&
      digest.length === hmac.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
    if (!ok) return res.status(401).send("invalid_hmac");
    return next();
  } catch (e) {
    return res.status(400).send("hmac_error");
  }
}
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
app.post("/webhooks/customers/data_request", rawJson, verifyWebhookHmac, (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  console.log(`[Webhook] ${topic} from ${shop}`);
  res.status(200).send("ok");
});
app.post("/webhooks/customers/redact", rawJson, verifyWebhookHmac, (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  console.log(`[Webhook] ${topic} from ${shop}`);
  res.status(200).send("ok");
});
app.post("/webhooks/shop/redact", rawJson, verifyWebhookHmac, (req, res) => {
  const shop = String(req.get("x-shopify-shop-domain") || "").toLowerCase();
  const topic = String(req.get("x-shopify-topic") || "");
  console.log(`[Webhook] ${topic} from ${shop}`);
  res.status(200).send("ok");
});

// (A) Shopify App Proxy HTML shell (CORRECTED WITH CACHE BUSTING AND CROSSORIGIN)
app.get("/proxy/refina", (_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self' https: data: blob:",
      "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
      "connect-src 'self' https: wss:",
      "img-src 'self' https: data: blob:",
      "style-src 'self' 'unsafe-inline' https:",
      "script-src 'self' https: 'unsafe-inline' 'unsafe-eval'"
    ].join("; ")
  );
  res.setHeader("Cache-Control", "no-store");

  const cacheBust = `v=${Date.now()}`;

  res
    .type("html")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Refina Concierge</title>
  <link rel="stylesheet" href="/apps/refina/concierge.css?${cacheBust}" crossorigin="anonymous"/>
  <link rel="preload" as="script" href="/apps/refina/concierge.js?${cacheBust}" crossorigin="anonymous"/>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/apps/refina/concierge.js?${cacheBust}" defer crossorigin="anonymous"></script>
</body>
</html>`);
});

// (B) App Proxy APIs — authoritative for storefront
app.get("/proxy/refina/v1/concerns", requireAppProxy, rateLimitAppProxy, async (req, res) => {
  try {
    const storeId = req.storeId;
    const docChips = await getDocSafe(db.doc(`commonConcerns/${storeId}`));
    let chips = Array.isArray(docChips?.chips) ? docChips.chips : [];
    if (!chips.length) {
      const colSnap = await db.collection(`commonConcerns/${storeId}/items`).get();
      chips = colSnap.docs.map((d) => d.data()?.text).filter(Boolean);
    }
    res.json({ storeId, chips });
  } catch (e) {
    console.error("GET /proxy/refina/v1/concerns error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/proxy/refina/v1/recommend", requireAppProxy, rateLimitAppProxy, async (req, res) => {
  const t0 = Date.now();
  let meta = { source: "mapping", cache: "miss" };
  try {
    const storeId = req.storeId;
    const concernInput = String(req.body?.concern || "").trim();
    if (!concernInput) return res.status(400).json({ error: "concern required" });

    const plan = await getPlan(storeId);
    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(storeId);
    const { category, tone, domain } = settings;

    const rankMode = String(req.body?.mode || req.query?.mode || "relevant").toLowerCase();
    const requestedType = String(req.body?.productType || "").toLowerCase().trim();
    const routineMode = !requestedType && /beauty|skin|hair|cosmetic/i.test(String(category || ""));

    const cacheKey = ["rec", storeId, normalizedConcern, plan, tone, rankMode, routineMode].join("|");
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: "hit" } });

    const allProducts = await fetchProducts(storeId);
    if (!allProducts.length) {
      console.warn(`[BFF] No products found for storeId=${storeId}`);
    }

    // Deterministic mapping / fallback (used for Free and as fallback when LLM returns no picks)
    const mappingRef = db.doc(`mappings/${storeId}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];

    if (!productIds.length) {
      const ranked = rankProducts(allProducts, normalizedConcern, {
        rankMode,
        targetIngredients: [],
        productType: requestedType
      });
      productIds = ranked.slice(0, 8).map((p) => p.id);
      meta.source = "fallback";
    } else {
      meta.source = "mapping";
    }

    const limit = plan === "free" ? 3 : 8;
    let used = productIds.slice(0, limit);

    // ── Pro/Premium: enrich with Gemini (pre-prune + knowledge facts + timing)
    let enriched = null;
    if (plan !== "free") {
      // Expand concern → ingredients and fetch brief facts for prompt
      let targetIngredients = [];
      try {
        targetIngredients = await expandConcernToIngredients(normalizedConcern);
      } catch { targetIngredients = []; }

      const ingredientFacts = targetIngredients.length ? await getIngredientFacts(targetIngredients) : {};

      // Build a pool biased to target ingredients & requested type
      let pool = allProducts;
      if (targetIngredients.length || requestedType) {
        const ingSet = new Set(targetIngredients.map((x) => String(x).toLowerCase()));
        pool = allProducts.filter((p) => {
          const ings = Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized : Array.isArray(p.ingredients) ? p.ingredients : [];
          const keys = Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized : Array.isArray(p.keywords) ? p.keywords : [];
          const hitIng = ings.some((x) => ingSet.has(String(x).toLowerCase()));
          const hitKey = keys.some((x) => ingSet.has(String(x).toLowerCase()));
          const typeOK = !requestedType || String(p.productTypeNormalized || p.productType || "").toLowerCase().includes(requestedType);
          return (hitIng || hitKey || !targetIngredients.length) && typeOK;
        });
        if (!pool.length) pool = allProducts;
      }

      const candidatesBefore = pool.length;
      const rankedForLLM = rankProducts(pool, normalizedConcern, { rankMode, targetIngredients, productType: requestedType });
      const topK = rankedForLLM.slice(0, TOPK);
      meta.candidatesBefore = candidatesBefore;
      meta.candidatesAfter = topK.length;

      const constraints = {}; // hook for future settings-driven constraints

      const prompt = buildGeminiPrompt({
        concern: concernInput,
        normalizedConcern,
        category,
        tone,
        constraints,
        rankMode,
        routineMode,
        ingredientFacts,
        products: condenseProducts(topK)
      });

      const genConfig = {
        temperature: plan === "premium" ? 0.7 : 0.5,
        topP: 0.9,
        maxOutputTokens: 800
      };

      try {
        const tLLM = Date.now();
        const modelText = await callGemini(prompt, genConfig);
        meta.llmMs = Date.now() - tLLM;

        if (modelText) {
          const parsed = extractJson(modelText);
          if (parsed && typeof parsed === "object") {
            enriched = coerceToContract(parsed);
          }
        }

        // Flip to Gemini only when it actually picked valid in-catalog IDs
        const inIndex = new Set(allProducts.map((p) => p.id));
        const requestedIds = Array.isArray(enriched?.productIds) ? enriched.productIds : [];
        const validIds = [...new Set(requestedIds.filter((id) => typeof id === "string" && inIndex.has(id)))];
        const hasPicks = validIds.length > 0;

        if (hasPicks) {
          used = validIds.slice(0, limit);
          meta.source = "gemini";
        } else if (enriched) {
          // Model returned no fits or invalid JSON
          meta.reason = "gemini_no_fit";
        }
      } catch (err) {
        console.warn("[BFF] Gemini call failed, using deterministic selection:", err?.message || err);
        meta.reason = "gemini_error";
      }
    }

    const safeDomain = String(domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || "").replace(/^\/+|\/+$/g, "");
      const productUrl =
        p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : "");
      return {
        id: p.id,
        title: p.title || p.name || "",
        name: p.title || p.name || "",
        image: p.image || (Array.isArray(p.images) ? p.images[0]?.src : ""),
        description: p.description || "",
        productType: p.productType || "",
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null
      };
    });

    const payload = {
      productIds: used,
      products: hydrate,
      copy: (function shape() {
        let copy = shapeCopy({
          products: allProducts.filter((p) => used.includes(p.id)),
          concern: normalizedConcern,
          tone,
          category
        });
        if (enriched && meta.source === "gemini") {
          const ex = enriched.explanation || {};
          const primary = enriched.primary || {};
          copy = {
            why: (ex.friendlyParagraph || ex.oneLiner || copy.why || "").trim(),
            rationale:
              (Array.isArray(ex.expertBullets) && ex.expertBullets.length
                ? ex.expertBullets.join(" • ")
                : (copy.rationale || "")
              ).trim(),
            extras:
              (
                (Array.isArray(primary.howToUse) && primary.howToUse.length
                  ? primary.howToUse.join(" • ")
                  : (Array.isArray(ex.usageTips) && ex.usageTips.length
                    ? ex.usageTips.join(" • ")
                    : (copy.extras || "")
                  )
                )
              ).trim()
          };
        }
        return copy;
      })(),
      ...(enriched ? { explanation: enriched.explanationFlat || "", enriched } : {}),
      meta: {
        ...meta,
        tone,
        plan,
        rankMode,
        routineMode,
        totalMs: Date.now() - t0
      }
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

// (C) Narrow asset proxies (unchanged)
app.use(
  "/proxy/refina/concierge.js",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => "/concierge.js",
    logLevel: "warn"
  })
);
app.use(
  "/proxy/refina/concierge.css",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => "/concierge.css",
    logLevel: "warn"
  })
);
app.use(
  "/proxy/refina/chunks",
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: (p) => p.replace(/^\/proxy\/refina\/chunks/, "/chunks"),
    logLevel: "warn"
  })
);

// Serve the built Admin UI at /admin-ui/*
const ADMIN_UI_DIR = path.join(__dirname, "../admin-ui-dist");
app.use("/admin-ui", express.static(ADMIN_UI_DIR, { index: false }));

// Serve asset folder for both prefixed and root paths (prevents MIME/type=html errors)
app.use(
  "/admin-ui/assets",
  express.static(path.join(ADMIN_UI_DIR, "assets"), { immutable: true, maxAge: "1y" })
);
app.use(
  "/assets",
  express.static(path.join(ADMIN_UI_DIR, "assets"), { immutable: true, maxAge: "1y" })
);

// SPA fallback (Express v5-safe: use RegExp, not "*")
app.get(/^\/admin-ui(?:\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, "index.html"));
});

// Redirect Embedded entry → /admin-ui/, preserving ?host=&shop=
// (Do not propagate legacy storeId; Admin UI will persist `shop` and `host` itself)
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
    now: new Date().toISOString()
  });
});

// (Legacy direct endpoints; enforce full-domain now)
app.get("/v1/concerns", async (req, res) => {
  try {
    const shop = toMyshopifyDomain(req.query.shop || req.query.storeId || "");
    if (!shop) return res.status(400).json({ error: "shop required" });

    const docChips = await getDocSafe(db.doc(`commonConcerns/${shop}`));
    let chips = Array.isArray(docChips?.chips) ? docChips.chips : [];
    if (!chips.length) {
      const colSnap = await db.collection(`commonConcerns/${shop}/items`).get();
      chips = colSnap.docs.map((d) => d.data()?.text).filter(Boolean);
    }
    res.json({ storeId: shop, chips });
  } catch (e) {
    console.error("GET /v1/concerns error", e);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/v1/recommend", async (req, res) => {
  const t0 = Date.now();
  try {
    const shop = toMyshopifyDomain(req.body?.storeId || req.body?.shop || "");
    const concernInput = String(req.body?.concern || "").trim();
    const plan = String(req.body?.plan || "free").toLowerCase();
    if (!shop || !concernInput)
      return res.status(400).json({ error: "shop and concern required" });

    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(shop);
    const { category, tone, domain } = settings;

    const cacheKey = ["rec", shop, normalizedConcern, plan, tone].join("|");
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: "hit" } });

    const allProducts = await fetchProducts(shop);

    const mappingRef = db.doc(`mappings/${shop}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];

    let source = "mapping";
    if (!productIds.length) {
      const ranked = rankProducts(allProducts, normalizedConcern);
      productIds = ranked.slice(0, 8).map((p) => p.id);
      source = "fallback";
    }

    const used = productIds.slice(0, plan === "free" ? 3 : 8);

    const safeDomain = String(domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || "").replace(/^\/+|\/+$/g, "");
      const productUrl =
        p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : "");
      return {
        id: p.id,
        title: p.title || p.name || "",
        name: p.title || p.name || "",
        image: p.image || (Array.isArray(p.images) ? p.images[0]?.src : ""),
        description: p.description || "",
        productType: p.productType || "",
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null
      };
    });

    const copy = shapeCopy({
      products: allProducts.filter((p) => used.includes(p.id)),
      concern: normalizedConcern,
      tone,
      category
    });

    const payload = {
      productIds: used,
      products: hydrate,
      copy,
      meta: { source, cache: "miss", tone, plan }
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

// Canonicalize to <shop>.myshopify.com for Admin/Billing routes
function canonicalizeShopParam(req, _res, next) {
  const raw = String((req.query.shop || req.query.storeId || "")).toLowerCase().trim();
  const full = toMyshopifyDomain(raw);
  if (full) {
    req.query.shop = full;
    // TEMP back-compat: mirror storeId to full; remove after clients fully migrated
    req.query.storeId = full; // TODO: remove once unused
  }
  next();
}

// mount routers with this guard first:
app.use("/api/admin", canonicalizeShopParam);
app.use("/api/billing", canonicalizeShopParam); // ensure billing sees full-domain

// ── Admin Settings POST alias (UI posts here; provide handler to avoid 404)
// Accepts POST /api/admin/store-settings and upserts storeSettings/{shop}.
// Keeps schema minimal and defers reads to GET /proxy/refina/v1/settings.
app.post("/api/admin/store-settings", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "admin-store-settings-alias-20250903");

  const shop = toMyshopifyDomain(req.query.shop || req.body?.shop || "");
  if (!shop) return res.status(400).json({ error: "shop_required" });

  // sanitize tokens: only CSS custom properties (start with --)
  const rawTokens = (req.body && typeof req.body.tokens === "object") ? req.body.tokens : {};
  const tokens = {};
  for (const [k, v] of Object.entries(rawTokens)) {
    if (typeof k === "string" && k.startsWith("--")) tokens[k] = String(v);
  }

  const toneRaw = String(req.body?.tone || "").toLowerCase();
  const tone =
    /bestie|friendly|warm|helpful/.test(toneRaw) ? "bestie" :
    /expert|pro|concise|direct/.test(toneRaw) ? "expert" : undefined;

  const payload = {
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(tone ? { tone } : {}),
    ...(req.body?.category ? { category: String(req.body.category) } : {}),
    ...(req.body?.presetId ? { presetId: String(req.body.presetId) } : {}),
    ...(Number.isFinite(Number(req.body?.version)) ? { version: Number(req.body.version) } : {}),
    ...(Array.isArray(req.body?.enabledPacks) ? { enabledPacks: req.body.enabledPacks.slice(0, 24).map(String) } : {}),
    ...(req.body?.domain ? { domain: String(req.body.domain).replace(/^https?:\/\//, "").replace(/\/+$/, "") } : {})
  };

  try {
    await db.doc(`storeSettings/${shop}`).set(payload, { merge: true });
    return res.status(200).json({ ok: true, shop, updated: Object.keys(payload) });
  } catch (e) {
    console.error("POST /api/admin/store-settings failed:", e?.message || e);
    return res.status(500).json({ error: "persist_failed" });
  }
});

// Billing APIs used by Home + Billing page
app.use("/api/billing", billingRouter); // /api/billing/plan, /subscribe, /sync

// Admin APIs used by Home/Settings/Analytics
app.use("/api/admin", analyticsRouter); // /api/admin/analytics/* (overview, logs)
app.use("/api/admin", adminSettingsRouter); // /api/admin/* (existing GET/PUT etc.)
app.use("/api/admin", analyticsIngestRouter);
app.use("/api", analyticsIngestRouter);

// ALSO expose storefront analytics ingest on the App Proxy base
// (Shopify forwards /apps/refina/v1/analytics/ingest → /proxy/refina/v1/analytics/ingest)
app.use("/proxy/refina/v1/analytics/ingest", requireAppProxy, rateLimitAppProxy, analyticsIngestRouter);

// ─────────────────────────────────────────────────────────────
/* Listen */
app.listen(PORT, () => {
  console.log(`Refina BFF running on :${PORT}`);
  console.log(
    `HTML shell:     GET  /proxy/refina  (loads /apps/refina/concierge.(css|js) via App Proxy)`
  );
  console.log(
    `APIs (AppProxy):GET  /proxy/refina/v1/concerns  |  POST /proxy/refina/v1/recommend (HMAC)`
  );
  console.log(
    `Assets (narrow):GET  /proxy/refina/concierge.js  →  ${ASSETS_BASE_URL}/concierge.js`
  );
  console.log(
    `                GET  /proxy/refina/concierge.css  →  ${ASSETS_BASE_URL}/concierge.css`
  );
  console.log(
    `                GET  /proxy/refina/chunks/*       →  ${ASSETS_BASE_URL}/chunks/*`
  );
  console.log(`Admin stub:     GET  /embedded`);
  console.log(`Health:         GET  /v1/health`);
  console.log(`Origin:             ${PUBLIC_BACKEND_ORIGIN}`);
});
