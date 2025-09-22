// refina-backend/server.js — Unified (BFF + Admin UI embed + App Proxy), ESM, Express v5-safe

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware'; // ESM-friendly import
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// Firestore helpers (admin)
import { db, getDocSafe, setDocSafe, nowTs } from './lib/firestore.js';

// Routers used by the Admin UI (baseline BFF)
import billingRouter from './routes/billing.js';
import analyticsRouter from './routes/analytics.js';
import adminSettingsRouter from './routes/adminSettings.js';
import analyticsIngestRouter from './routes/analyticsIngest.js';
import authRouter from './routes/auth.js';

// Optional extras (present in your repo; safe to mount)
import privacyWebhooksRoutes from './routes/privacyWebhooks.js';
import semanticRoutes from './routes/semantic.js';

// BFF helpers that power Gemini & copy shaping
import { callGemini } from './bff/ai/gemini.js';
import { buildGeminiPrompt } from './bff/ai/buildGeminiPrompt.js';
import {
  expandConcernToIngredients,
  getIngredientFacts,
} from './bff/lib/knowledge.js';

// Utilities
import { toMyshopifyDomain } from './utils/resolveStore.js';
import shopify from './shopify.js';
import { fetchFallbackProducts } from './routes/catalog-fallback.js';

// Product Indexing on Install
import mountBackfillRoutes from './routes/backfill.js';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);
const CACHE_TTL_MS = Number(process.env.BFF_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

// Where your built Admin UI lives (vite build → ../refina-backend/admin-ui-dist)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMIN_UI_DIR = path.join(__dirname, 'admin-ui-dist');
const adminUiIndex = path.join(ADMIN_UI_DIR, 'index.html'); // ← added

// Where your storefront assets (concierge.(js|css)) are hosted (Netlify)
const ASSETS_BASE_URL = String(process.env.ASSETS_BASE_URL || 'https://refina.netlify.app').replace(
  /\/+$/,
  ''
);

// Shopify App Proxy secret (HMAC verify)
const SHOPIFY_APP_SECRET = String(
  process.env.SHOPIFY_APP_SECRET || process.env.SHOPIFY_API_SECRET || ''
);

// Gemini pruning/top-K
const TOPK = Number(process.env.REFINA_GEMINI_TOPK || 60);

// Public origin of THIS backend (for logs/health only)
const PUBLIC_BACKEND_ORIGIN = String(
  process.env.PUBLIC_BACKEND_ORIGIN || process.env.APP_PUBLIC_URL || 'https://refina-app.onrender.com'
).replace(/\/+$/, '');

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
// String helpers & ranker (baseline BFF)
// ─────────────────────────────────────────────────────────────
function normalizeConcern(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Ranker with mode & ingredient/type awareness (from BFF)
function rankProducts(products, concern, opts = {}) {
  const { rankMode = 'relevant', targetIngredients = [], productType = '' } = opts;
  const terms = tokenize(concern);
  const ingSet = new Set((targetIngredients || []).map((x) => String(x).toLowerCase()));
  const typeTerm = String(productType || '').toLowerCase();

  let w = { title: 3.0, tags: 2.2, keywords: 2.0, description: 1.6, productType: 1.0, ing: 3.2, typeBoost: 1.5 };
  if (rankMode === 'rated') w = { ...w, title: 2.6, tags: 2.0, keywords: 1.8, description: 1.4 };
  if (rankMode === 'popular') w = { ...w, title: 2.6, tags: 1.9, keywords: 1.7, description: 1.3 };

  const scored = [];
  for (const p of products) {
    if (!p) continue;
    const titleText = p.title || p.name || '';
    const desc = stripHtml(p.description || '').slice(0, 800);
    const hay = {
      title: tokenize(titleText),
      tags: (Array.isArray(p.tags) ? p.tags : []).flatMap(tokenize),
      keywords: (Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized : Array.isArray(p.keywords) ? p.keywords : []).flatMap(tokenize),
      description: tokenize(desc),
      productType: tokenize(p.productType || p.productTypeNormalized || ''),
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
    if (ings.some((x) => ingSet.has(String(x).toLowerCase()))) score += w.ing;
    if (typeTerm && hay.productType.includes(typeTerm)) score += w.typeBoost;
    if (p.handle && (p.image || (Array.isArray(p.images) && p.images[0]?.src))) score += 0.3;

    if (rankMode === 'rated' && Number.isFinite(p.avgRating) && Number.isFinite(p.reviewCount)) {
      score += (p.avgRating / 5) * Math.log10(1 + p.reviewCount) * 2.0;
    }
    if (rankMode === 'popular' && Number.isFinite(p.salesVelocity)) {
      score += Math.log10(1 + p.salesVelocity) * 1.6;
    }

    if (score > 0) scored.push({ ...p, _score: score });
  }
  scored.sort((a, b) => b._score - a._score || (a.title || a.name || '').localeCompare(b.title || b.name || ''));
  return scored;
}

function shapeCopy({ products, concern, tone, category }) {
  const first = products[0] || {};
  const name = first.title || first.name || 'this pick';
  const middleWord = /beauty|skin|hair|cosmetic/i.test(category) ? 'ingredients' : 'features';
  const why =
    /bestie/i.test(String(tone || ''))
      ? `I picked ${name} because it lines up beautifully with “${concern}”. It’s a solid, low-fuss match from this store.`
      : `Recommended: ${name}. It aligns strongly with “${concern}” based on the store’s catalogue signals.`;
  const rationale = `Relevance is based on product ${middleWord}, tags, and related keywords that map to “${concern}”.`;
  const extras = first.description
    ? `Tip: check the product page for usage guidance and added benefits noted in the description.`
    : `Tip: start low and adjust as needed; always follow usage directions on the product page.`;
  return { why, rationale, extras };
}

function detectProductTypeFromQuery(allProducts, query) {
  const q = String(query || '').toLowerCase();
  const types = new Set(
    allProducts.map((p) => String(p.productTypeNormalized || p.productType || '').toLowerCase()).filter(Boolean)
  );
  const syn = new Map([
    ['cleanser', 'cleanser'],
    ['face wash', 'cleanser'],
    ['serum', 'serum'],
    ['essence', 'essence'],
    ['moisturiser', 'moisturizer'],
    ['moisturizer', 'moisturizer'],
    ['cream', 'moisturizer'],
    ['sunscreen', 'sunscreen'],
    ['spf', 'sunscreen'],
    ['retinol', 'retinol'],
    ['retinoid', 'retinol'],
    ['bakuchiol', 'retinol'],
    ['toner', 'toner'],
    ['eye cream', 'eye cream'],
    ['mask', 'mask'],
    ['exfoliant', 'exfoliant'],
    ['aha', 'exfoliant'],
    ['bha', 'exfoliant'],
  ]);
  for (const [k, v] of syn.entries()) if (q.includes(k)) return v;
  for (const t of types) if (t && q.includes(t)) return t;
  return '';
}

async function getSettings(storeId) {
  const ref = db.doc(`storeSettings/${storeId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    const seed = {
      tone: (process.env.BFF_DEFAULT_TONE || 'expert').toLowerCase(),
      category: process.env.BFF_DEFAULT_CATEGORY || 'Generic',
      enabledPacks: (process.env.BFF_ENABLED_PACKS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      domain: '',
      createdAt: nowTs(),
      settingsVersion: 1,
    };
    await setDocSafe(ref, seed);
    return seed;
  }
  const data = snap.data() || {};
  const s = String(data.tone || '').toLowerCase();
  const tone =
    /bestie|friendly|warm|helpful/.test(s) ? 'bestie' : /expert|pro|concise|direct/.test(s) ? 'expert' : process.env.BFF_DEFAULT_TONE || 'expert';
  return { tone, category: data.category || 'Generic', domain: data.domain || '', enabledPacks: data.enabledPacks || [] };
}

// Server-authoritative plan
async function getPlan(storeId) {
  try {
    const snap = await db.doc(`plans/${storeId}`).get();
    const data = snap.exists ? snap.data() || {} : {};
    const raw = String(data.plan || data.tier || data.name || data.level || 'free').toLowerCase().trim();
    if (/\bpremium\b/.test(raw)) return 'premium';
    if (/^pro\b/.test(raw)) return 'pro';
    return 'free';
  } catch {
    return 'free';
  }
}

// Fetch products (subcollection first; fallback to flat)
async function fetchProducts(storeId, limit = 1500) {
  try {
    const subSnap = await db.collection(`products/${storeId}/items`).limit(limit).get();
    if (!subSnap.empty) {
      const out = [];
      subSnap.forEach((d) => out.push({ id: d.id, ...d.data(), storeId }));
      return out;
    }
  } catch {}
  try {
    const flatSnap = await db.collection('products').where('storeId', '==', storeId).limit(limit).get();
    const out = [];
    flatSnap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Shopify App Proxy verification (HMAC)
// ─────────────────────────────────────────────────────────────
function okSafeCompareHex(aHex, bHex) {
  try {
    return aHex.length === bHex.length && crypto.timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
  } catch {
    return false;
  }
}
function verifyAppProxy(req) {
  if (!SHOPIFY_APP_SECRET) return { ok: false, reason: 'missing_secret' };

  const signature = String(req.query.signature || '');
  const entries = Object.entries(req.query)
    .filter(([k]) => k !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b));
  const message = entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('');

  const expected = crypto.createHmac('sha256', SHOPIFY_APP_SECRET).update(message).digest('hex');
  const provided = signature;

  const shop = String(req.query.shop || req.headers['x-shopify-shop-domain'] || '').toLowerCase();
  return okSafeCompareHex(expected, provided) ? { ok: true, shop } : { ok: false, reason: 'bad_signature', shop };
}
function requireAppProxy(req, res, next) {
  const v = verifyAppProxy(req);
  if (!v.ok) {
    const status = v.reason === 'missing_secret' ? 500 : 401;
    return res.status(status).json({ error: 'unauthorized', reason: v.reason });
  }
  if (!v.shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v.shop)) {
    return res.status(400).json({ error: 'invalid_shop' });
  }
  req.shopDomain = v.shop;
  req.storeId = v.shop;
  return next();
}

// Per-shop rate limiter for App Proxy APIs
const rlBuckets = new Map();
const RL = { capacity: 60, refillPerSec: 1 }; // 60 req/min
const REFILL_PER_MS = RL.refillPerSec / 1000;
function rateLimitAppProxy(req, res, next) {
  const key = req.storeId || String(req.query.shop || req.headers['x-shopify-shop-domain'] || req.ip);
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
  res.setHeader('Retry-After', String(retryAfterSec));
  return res.status(429).json({ error: 'rate_limited', retryAfter: retryAfterSec });
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// 🔒 Ensure API routes are mounted before static/catch-alls (fix 404 regressions)
// (Moved ABOVE the canonical redirect middleware)
app.post('/apps/refina/v1/analytics/ingest', (req, res, next) => {
  // If you already have a real handler elsewhere, delegate to it:
  if (typeof handleAnalyticsIngest === 'function') return handleAnalyticsIngest(req, res, next);

  // Minimal no-op fallback so the widget doesn't break (keeps status 2xx):
  // swap this out if you need to persist events.
  res.status(204).end();
});

// ───────── Canonical host + HTTPS enforcement (pre-router) ─────────
// (Unchanged, just moved BELOW the early /apps/refina/v1/* mounts)
const CANONICAL_ORIGIN = String(process.env.APP_URL || process.env.HOST || '').replace(/\/+$/, '');
let CANONICAL_HOST = '';
try {
  CANONICAL_HOST = CANONICAL_ORIGIN ? new URL(CANONICAL_ORIGIN).host : '';
} catch {}

app.use((req, res, next) => {
  // Only enforce if a canonical host is configured
  if (!CANONICAL_HOST) return next();

  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host  = req.get('x-forwarded-host') || req.get('host') || '';

  const needsProto = proto !== 'https';
  const needsHost  = host && CANONICAL_HOST && host.toLowerCase() !== CANONICAL_HOST.toLowerCase();

  if (needsProto || needsHost) {
    const url = new URL(req.originalUrl || '/', `https://${CANONICAL_HOST}`);
    return res.redirect(302, url.toString());
  }
  return next();
});

// ───────────────────────── Admin UI (embedded) ─────────────────────────
// ✅ Option A: serve built Admin UI from ADMIN_UI_DIR consistently

// 1) Long-cache fingerprinted assets
app.use(
  '/admin-ui/assets',
  express.static(path.join(ADMIN_UI_DIR, 'assets'), { immutable: true, maxAge: '1y' })
);

// 2) Root-level static (favicon, manifest, robots, etc.) — no inxpressdex
app.use(
  '/admin-ui',
  express.static(ADMIN_UI_DIR, { index: false, maxAge: '1h' })
);

// Index on Install 
mountBackfillRoutes(app);

// Minimal CSP for pages that Shopify iframes (Admin UI)
const setAdminCsp = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', 'frame-ancestors https://admin.shopify.com https://*.myshopify.com;');
  next();
};

// Serve the Admin SPA at /admin-ui and nested routes with CSP
app.get(/^\/admin-ui(?:\/.*)?$/, setAdminCsp, (_req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'));
});

// Optional alias (/admin) with CSP
app.get(/^\/admin(?:\/.*)?$/, setAdminCsp, (_req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'));
});

// Embedded entry → preflight for OFFLINE session; bounce to top-level OAuth if missing
app.get('/embedded', async (req, res) => {
  try {
    // 1) Resolve canonical shop + host
    const toMyshop = (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      if (!s) return '';
      return s.endsWith('.myshopify.com') ? s : `${s}.myshopify.com`;
    };

    let shop = toMyshop(req.query.shop || req.query.storeId || '');
    let host = String(req.query.host || '').trim();

    if (!shop && host) {
      try {
        const decoded = Buffer.from(host, 'base64').toString('utf8'); // "<shop>.myshopify.com/admin" or "admin.shopify.com/store/<slug>"
        const m1 = decoded.match(/^admin\.shopify\.com\/store\/([^/]+)/i);
        const m2 = decoded.match(/^([^/]+)\.myshopify\.com\/admin/i);
        if (m1?.[1]) shop = toMyshop(m1[1]);
        if (!shop && m2?.[1]) shop = toMyshop(m2[1]);
      } catch { /* ignore */ }
    }
    if (shop && !host) {
      try { host = Buffer.from(`${shop}/admin`).toString('base64'); } catch { host = ''; }
    }

    // 2) If we can’t resolve a shop, still serve the Admin UI (App Bridge can recover via host later)
    if (!shop) {
      return res.sendFile(adminUiIndex);
    }

    // 3) Check for an existing OFFLINE session; if missing → do a TOP-LEVEL hop before OAuth
    try {
      const offlineId = shopify.session.getOfflineId(shop);
      const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
      const sess = storage?.loadSession ? await storage.loadSession(offlineId) : null;

      if (!sess || !sess.accessToken) {
        const base = `https://${req.get('x-forwarded-host') || req.get('host')}`;
        const u = new URL('/api/auth/toplevel', base);
        u.searchParams.set('shop', shop);
        if (host) u.searchParams.set('host', host);
        // After OAuth, return to our Admin UI (embedded)
        u.searchParams.set('return_to', '/admin-ui');
        return res.redirect(302, u.toString());
      }
    } catch {
      const base = `https://${req.get('x-forwarded-host') || req.get('host')}`;
      const u = new URL('/api/auth/toplevel', base);
      u.searchParams.set('shop', shop);
      if (host) u.searchParams.set('host', host);
      u.searchParams.set('return_to', '/admin-ui');
      return res.redirect(302, u.toString());
    }

    // 4) Offline session exists → serve Admin UI
    return res.sendFile(adminUiIndex);
  } catch (e) {
    console.error('/embedded preflight error', e?.message || e);
    return res.sendFile(adminUiIndex);
  }
});

// ───────────────────── Refina Concierge (widget) ─────────────────────
// Serve the widget bundle where the launcher expects it
app.use(
  '/proxy/refina',
  express.static(path.join(process.cwd(), 'public/concierge'), { index: false, maxAge: '1h' })
);

// Minimal API the bundle calls
app.get('/apps/refina/v1/concerns', (_req, res) => {
  res.json({
    concerns: [
      { id: 'dryness', label: 'Dryness' },
      { id: 'acne',    label: 'Acne' },
      { id: 'aging',   label: 'Aging' },
    ],
  });
});

app.post('/apps/refina/v1/recommend', (req, res) => {
  const { concerns = [], profile = {} } = req.body || {};
  // TODO: plug in your real matching logic
  const products = [
    { id: 'sku_123', title: 'Hydrating Serum', price: 29, url: '/p/hydrating-serum' },
  ];
  res.json({ products, concerns, profile });
});




// Canonicalize to <shop>.myshopify.com for Admin/Billing routes
function canonicalizeShopParam(req, _res, next) {
  const raw = String((req.query.shop || req.query.storeId || '')).toLowerCase().trim();
  const full = toMyshopifyDomain(raw);
  if (full) {
    req.query.shop = full;
    req.query.storeId = full; // back-compat
  }
  next();
}
app.use('/api/admin', canonicalizeShopParam);
app.use('/api/billing', canonicalizeShopParam);

// Admin/Billing/Auth/Analytics routes (baseline BFF)
app.use('/api/billing', billingRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', analyticsRouter);
app.use('/api/admin', adminSettingsRouter);
app.use('/api/admin', analyticsIngestRouter);
app.use('/api', analyticsIngestRouter);
app.use('/api/privacy', privacyWebhooksRoutes);
app.use('/api/semantic', semanticRoutes);

// Convenience Admin settings alias (UI posts here)
app.post('/api/admin/store-settings', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-RF-Handler', 'admin-store-settings-alias-20250903');

  const shop = toMyshopifyDomain(req.query.shop || req.body?.shop || '');
  if (!shop) return res.status(400).json({ error: 'shop_required' });

  const rawTokens = req.body && typeof req.body.tokens === 'object' ? req.body.tokens : {};
  const tokens = {};
  for (const [k, v] of Object.entries(rawTokens)) if (typeof k === 'string' && k.startsWith('--')) tokens[k] = String(v);

  const toneRaw = String(req.body?.tone || '').toLowerCase();
  const tone = /bestie|friendly|warm|helpful/.test(toneRaw) ? 'bestie' : /expert|pro|concise|direct/.test(toneRaw) ? 'expert' : undefined;

  const payload = {
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(tone ? { tone } : {}),
    ...(req.body?.category ? { category: String(req.body.category) } : {}),
    ...(req.body?.presetId ? { presetId: String(req.body.presetId) } : {}),
    ...(Number.isFinite(Number(req.body?.version)) ? { version: Number(req.body.version) } : {}),
    ...(Array.isArray(req.body?.enabledPacks) ? { enabledPacks: req.body.enabledPacks.slice(0, 24).map(String) } : {}),
    ...(req.body?.domain ? { domain: String(req.body.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '') } : {}),
  };

  try {
    await db.doc(`storeSettings/${shop}`).set(payload, { merge: true });
    return res.status(200).json({ ok: true, shop, updated: Object.keys(payload) });
  } catch (e) {
    console.error('POST /api/admin/store-settings failed:', e?.message || e);
    return res.status(500).json({ error: 'persist_failed' });
  }
});

// ───────────────────────── App Proxy (storefront) ─────────────────────────

// (A) HTML shell served on App Proxy → loads /apps/refina/concierge.(css|js)
app.get('/proxy/refina', (_req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self' https: data: blob:",
      'frame-ancestors https://*.myshopify.com https://admin.shopify.com',
      "connect-src 'self' https: wss:",
      "img-src 'self' https: data: blob:",
      "style-src 'self' 'unsafe-inline' https:",
      "script-src 'self' https: 'unsafe-inline' 'unsafe-eval'",
    ].join('; ')
  );
  res.setHeader('Cache-Control', 'no-store');

  const cacheBust = `v=${Date.now()}`;
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Refina Concierge</title>
  <link rel="stylesheet" href="concierge.css?${cacheBust}" crossorigin="anonymous"/>
  <link rel="preload" as="script" href="concierge.js?${cacheBust}" crossorigin="anonymous"/>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="concierge.js?${cacheBust}" defer crossorigin="anonymous"></script>
</body>
</html>`);
});

// (B) App Proxy APIs
app.get('/proxy/refina/v1/settings', requireAppProxy, rateLimitAppProxy, async (req, res) => {
  try {
    const shop = req.storeId;
    const snap = await db.doc(`storeSettings/${shop}`).get();
    const saved = snap.exists ? snap.data() || {} : {};

    const DEFAULT_SETTINGS = {
      category: 'Beauty',
      aiTone: 'professional',
      theme: { primaryColor: '#111827', accentColor: '#10B981', borderRadius: 'lg', gridColumns: 3, buttonStyle: 'solid' },
      ui: { showBadges: true, showPrices: true, enableModal: true },
      copy: { heading: 'Find the perfect routine', subheading: 'Tell Refina your concern and we’ll match expert picks.', ctaText: 'Ask Refina' },
    };
    const deepMerge = (base, src) => {
      const t = JSON.parse(JSON.stringify(base));
      const rec = (a, b) => {
        for (const k of Object.keys(b || {})) {
          if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
            if (!a[k]) a[k] = {};
            rec(a[k], b[k]);
          } else {
            a[k] = b[k];
          }
        }
      };
      rec(t, src || {});
      return t;
    };

    const payload = deepMerge(DEFAULT_SETTINGS, saved);
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[BFF] settings fetch failed:', err);
    res.set('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'settings_fetch_failed' });
  }
});

app.get('/proxy/refina/v1/concerns', requireAppProxy, rateLimitAppProxy, async (req, res) => {
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
    console.error('GET /proxy/refina/v1/concerns error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Serve the Admin SPA at root (/) too
app.get("/", setAdminCsp, (_req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, "index.html"));
});


function shorten(text = '', max = 240) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
function condenseProducts(products = []) {
  return products
    .slice(0, 120)
    .map((p) => ({
      id: p.id || p.productId || p.handle || '',
      name: p.name || p.title || '',
      productType: p.productTypeNormalized || p.productType || '',
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
        : typeof p.tags === 'string'
        ? p.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      descriptionShort: shorten(p.descriptionShort || p.description || p.body_html || ''),
      price: p.price || p.minPrice || p.compareAtPrice || undefined,
      usageStep: p.usageStep || p.step || '',
      productType_norm: p.productType_norm || p.productTypeNormalized || p.productType || '',
      category: p.categoryNormalized || p.category || '',
    }))
    .filter((x) => x.id && x.name);
}
function extractJson(text = '') {
  const raw = String(text).trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonLike = fenceMatch ? fenceMatch[1] : raw;
  try {
    return JSON.parse(jsonLike);
  } catch {
    const start = jsonLike.indexOf('{');
    const end = jsonLike.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const maybe = jsonLike.slice(start, end + 1);
      try {
        return JSON.parse(maybe);
      } catch {}
    }
    throw new Error('Model did not return valid JSON.');
  }
}
function coerceToContract(obj = {}) {
  const primary = obj.primary || {};
  const alts = Array.isArray(obj.alternatives) ? obj.alternatives : [];
  const explanation = obj.explanation || {};
  const safePrimary = {
    id: String(primary.id || '').trim(),
    score: Number.isFinite(primary.score) ? primary.score : 0,
    reasons: Array.isArray(primary.reasons) ? primary.reasons.slice(0, 6).map(String) : [],
    howToUse: Array.isArray(primary.howToUse) ? primary.howToUse.slice(0, 6).map(String) : [],
    tagsMatched: Array.isArray(primary.tagsMatched) ? primary.tagsMatched.slice(0, 8).map(String) : [],
  };
  const safeAlts = alts
    .slice(0, 2)
    .map((a) => ({ id: String(a.id || '').trim(), when: String(a.when || '').trim(), reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 3).map(String) : [] }))
    .filter((a) => a.id);
  const safeExpl = {
    oneLiner: String(explanation.oneLiner || '').trim(),
    friendlyParagraph: String(explanation.friendlyParagraph || '').trim(),
    expertBullets: Array.isArray(explanation.expertBullets) ? explanation.expertBullets.slice(0, 6).map(String) : [],
    usageTips: Array.isArray(explanation.usageTips) ? explanation.usageTips.slice(0, 6).map(String) : [],
  };
  const productIds = [safePrimary.id, ...safeAlts.map((a) => a.id)].filter(Boolean);
  const explanationFlat = safeExpl.friendlyParagraph || safeExpl.oneLiner || '';
  return { primary: safePrimary, alternatives: safeAlts, explanation: safeExpl, productIds, explanationFlat };
}

app.post('/proxy/refina/v1/recommend', requireAppProxy, rateLimitAppProxy, async (req, res) => {
  const t0 = Date.now();
  let meta = { source: 'mapping', cache: 'miss', llmMs: 0 };

  try {
    const storeId = req.storeId;
    const concernInput = String(req.body?.concern || '').trim();
    if (!concernInput) return res.status(400).json({ error: 'concern required' });

    const plan = await getPlan(storeId);
    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(storeId);
    const { category, tone, domain } = settings;

    const rankMode = String(req.body?.mode || req.query?.mode || 'relevant').toLowerCase();
    let requestedType = String(req.body?.productType || '').toLowerCase().trim();
    const routineMode = !requestedType && /beauty|skin|hair|cosmetic/i.test(String(category || ''));

    const cacheKey = ['rec-v2', storeId, normalizedConcern, plan, tone, rankMode, routineMode].join('|');
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: 'hit' } });

    const allProducts = await fetchProducts(storeId);
    const catalogById = new Map(allProducts.map((p) => [p.id, p]));

    // Fallback (mapping or ranker)
    const mappingRef = db.doc(`mappings/${storeId}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];
    if (!productIds.length) {
      const ranked = rankProducts(allProducts, normalizedConcern, { rankMode });
      productIds = ranked.slice(0, 8).map((p) => p.id);
      meta.source = 'fallback';
    }

    const limit = plan === 'free' ? 3 : 8;
    let used = productIds.slice(0, limit);
    let enriched = null;

    if (plan !== 'free') {
      // 1) Expand concern → ingredients + facts
      let targetIngredients = [];
      try {
        targetIngredients = await expandConcernToIngredients(normalizedConcern, storeId);
      } catch {
        targetIngredients = [];
      }
      const ingredientFacts = targetIngredients.length ? await getIngredientFacts(targetIngredients, storeId) : {};

      if (!requestedType) requestedType = detectProductTypeFromQuery(allProducts, concernInput);

      // 2) Pre-prune
      let pool = allProducts;
      if (targetIngredients.length || requestedType) {
        const ingSet = new Set(targetIngredients);
        pool = allProducts.filter((p) => {
          const ings = Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized : [];
          const typeOK = !requestedType || String(p.productTypeNormalized || p.productType || '').toLowerCase().includes(requestedType);
          return ((ings.some((x) => ingSet.has(String(x).toLowerCase())) || !targetIngredients.length) && typeOK);
        });
        if (!pool.length) pool = allProducts;
      }

      const rankedForLLM = rankProducts(pool, normalizedConcern, { rankMode, targetIngredients, productType: requestedType });
      const topK = rankedForLLM.slice(0, TOPK);

      // 3) RAG copy
      const prompt = buildGeminiPrompt({
        concern: concernInput,
        normalizedConcern,
        category,
        tone,
        constraints: {},
        rankMode,
        routineMode,
        ingredientFacts,
        products: condenseProducts(topK),
      });
      const genConfig = { temperature: plan === 'premium' ? 0.7 : 0.5, topP: 0.9, maxOutputTokens: 1024 };
      const tLLM = Date.now();
      const modelText = await callGemini(prompt, genConfig).catch(() => null);
      meta.llmMs = Date.now() - tLLM;

      if (modelText) {
        try {
          const parsed = extractJson(modelText);
          if (parsed && typeof parsed === 'object') enriched = coerceToContract(parsed);
        } catch {
          meta.reason = 'gemini_invalid_json';
        }
      } else {
        meta.reason = 'gemini_error';
      }

      const requestedIds = Array.isArray(enriched?.productIds) ? enriched.productIds : [];
      const validIds = [...new Set(requestedIds.filter((id) => typeof id === 'string' && catalogById.has(id)))];
      if (validIds.length > 0) {
        used = validIds.slice(0, limit);
        meta.source = 'gemini';
      } else if (enriched) {
        meta.reason = meta.reason || 'gemini_no_fit';
      }
    }

    const safeDomain = String(domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || '').replace(/^\/+|\/+$/g, '');
      const productUrl = p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : '');
      return {
        id: p.id,
        title: p.title || p.name || '',
        name: p.title || p.name || '',
        image: p.image || (Array.isArray(p.images) ? p.images[0]?.src : ''),
        description: p.description || '',
        productType: p.productType || '',
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null,
      };
    });

    let copy = shapeCopy({ products: hydrate, concern: normalizedConcern, tone, category });
    if (enriched && meta.source === 'gemini') {
      const ex = enriched.explanation || {};
      const primary = enriched.primary || {};
      const toPara = (v) => (Array.isArray(v) ? v.join(' ').replace(/\s*•\s*/g, ' ').trim() : String(v || '').replace(/\s*•\s*/g, ' ').trim());
      copy = {
        why: (ex.friendlyParagraph || ex.oneLiner || copy.why || '').trim(),
        rationale: toPara(ex.expertBullets || copy.rationale),
        extras: toPara(primary.howToUse || ex.usageTips || copy.extras),
      };
    }

    const disclaimer = /beauty|skin|hair|cosmetic/i.test(String(category || '')) ? 'Skincare guidance only — not medical advice.' : '';
    const payload = {
      productIds: used,
      products: hydrate,
      copy,
      disclaimer,
      ...(enriched ? { enriched } : {}),
      meta: { ...meta, tone, plan, rankMode, routineMode, totalMs: Date.now() - t0 },
    };

    // --- Fallback: if no products yet, serve a few via Admin API ---
    if ((!hydrate || hydrate.length === 0) && (!used || used.length === 0)) {
      try {
        const shop = String(storeId || '').toLowerCase(); // <- use your storeId
        let accessToken = req.accessToken;

        // Load offline session token if middleware didn't attach one
        if (!accessToken && shop) {
          const offlineId = shopify.session.getOfflineId(shop);
          const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
          const offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;
          accessToken = offlineSession?.accessToken || null;
        }

        if (shop && accessToken) {
          // Use the user’s concern text as the search hint
          const q = concernInput || '';
          const fb = await fetchFallbackProducts(shop, accessToken, { limit: 10, query: q });

          if (Array.isArray(fb) && fb.length) {
            const fallbackPayload = {
              productIds: fb.map(p => p.id),
              products: fb.map(p => ({
                id: p.id, title: p.title, handle: p.handle, image: p.image, url: p.url
              })),
              copy: copy || 'Here are some products from your catalog while Refina finishes indexing.',
              disclaimer,
              ...(enriched ? { enriched } : {}), // keep existing if any
              meta: { ...meta, tone, plan, rankMode, routineMode, source: 'fallback', totalMs: Date.now() - t0 },
            };
            if (typeof cacheSet === 'function') cacheSet(cacheKey, fallbackPayload);
            return res.json(fallbackPayload);
          }
        }
      } catch (err) {
        console.error('[recommend] fallback error', err);
        // fall through to normal payload
      }
    }
    // --- end fallback ---

    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error('POST /proxy/refina/v1/recommend error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// (C) Narrow asset proxies → Netlify
app.use(
  '/proxy/refina/concierge.js',
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => '/concierge.js',
    logLevel: 'warn',
  })
);
app.use(
  '/proxy/refina/concierge.css',
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => '/concierge.css',
    logLevel: 'warn',
  })
);
app.use(
  '/proxy/refina/chunks',
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: (p) => p.replace(/^\/proxy\/refina\/chunks/, '/chunks'),
    logLevel: 'warn',
  })
);

// Aliases so direct hits to /apps/refina/* also work (Theme Editor & direct backend URLs)
app.use(
  '/apps/refina/concierge.js',
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => '/concierge.js',
    logLevel: 'warn',
  })
);
app.use(
  '/apps/refina/concierge.css',
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: () => '/concierge.css',
    logLevel: 'warn',
  })
);
app.use(
  '/apps/refina/chunks',
  createProxyMiddleware({
    target: ASSETS_BASE_URL,
    changeOrigin: true,
    ws: false,
    pathRewrite: (p) => p.replace(/^\/apps\/refina\/chunks/, '/chunks'),
    logLevel: 'warn',
  })
);

// Quiet the favicon warning in Theme Editor/site previews
app.get('/favicon.ico', (_req, res) => res.status(204).end());


// ALSO expose storefront analytics ingest on App Proxy base
app.use('/proxy/refina/v1/analytics/ingest', requireAppProxy, rateLimitAppProxy, analyticsIngestRouter);

// ───────────────────────── Legacy/health (back-compat) ─────────────────────────
app.get('/v1/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString(), origin: PUBLIC_BACKEND_ORIGIN });
});

app.get('/v1/concerns', async (req, res) => {
  try {
    const shop = toMyshopifyDomain(req.query.shop || req.query.storeId || '');
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const docChips = await getDocSafe(db.doc(`commonConcerns/${shop}`));
    let chips = Array.isArray(docChips?.chips) ? docChips.chips : [];
    if (!chips.length) {
      const colSnap = await db.collection(`commonConcerns/${shop}/items`).get();
      chips = colSnap.docs.map((d) => d.data()?.text).filter(Boolean);
    }
    res.json({ storeId: shop, chips });
  } catch (e) {
    console.error('GET /v1/concerns error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/recommend', async (req, res) => {
  const t0 = Date.now();
  try {
    const shop = toMyshopifyDomain(req.body?.storeId || req.body?.shop || '');
    const concernInput = String(req.body?.concern || '').trim();
    const plan = String(req.body?.plan || 'free').toLowerCase();
    if (!shop || !concernInput) return res.status(400).json({ error: 'shop and concern required' });

    const normalizedConcern = normalizeConcern(concernInput);
    const settings = await getSettings(shop);
    const { category, tone, domain } = settings;

    const cacheKey = ['rec', shop, normalizedConcern, plan, tone].join('|');
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...(cached.meta || {}), cache: 'hit' } });

    const allProducts = await fetchProducts(shop);

    const mappingRef = db.doc(`mappings/${shop}/concernToProducts/${normalizedConcern}`);
    const mapping = await getDocSafe(mappingRef);
    let productIds = Array.isArray(mapping?.productIds) ? mapping.productIds : [];
    let source = 'mapping';
    if (!productIds.length) {
      const ranked = rankProducts(allProducts, normalizedConcern);
      productIds = ranked.slice(0, 8).map((p) => p.id);
      source = 'fallback';
    }

    // pick the top N upfront
    const used = productIds.slice(0, plan === 'free' ? 3 : 8);

    // route-local meta + helpers this handler expects later
    let meta = { source: 'mapping', cache: 'miss' };
    let enriched = null; // keep defined even if unused in this v1 handler
    const disclaimer = /beauty|skin|hair|cosmetic/i.test(String(category || ''))
      ? 'Skincare guidance only — not medical advice.'
      : '';

    // hydrate product objects for the UI
    const safeDomain = String(domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const hydrate = used.map((id) => {
      const p = allProducts.find((x) => x.id === id) || {};
      const handle = String(p.handle || '').replace(/^\/+|\/+$/g, '');
      const productUrl = p.productUrl || (safeDomain && handle ? `https://${safeDomain}/products/${handle}` : '');
      return {
        id: p.id,
        title: p.title || p.name || '',
        name: p.title || p.name || '',
        image: p.image || (Array.isArray(p.images) ? p.images[0]?.src : ''),
        description: p.description || '',
        productType: p.productType || '',
        tags: p.tags || [],
        url: productUrl,
        price: p.price ?? null,
      };
    });

    // friendly copy from what we actually send back
    const copy = shapeCopy({
      products: hydrate, // <- use hydrated list
      concern: normalizedConcern,
      tone,
      category,
    });

    // --- Fallback: if no products, serve a few via Admin API so reviewers see results ---
    if ((!hydrate || hydrate.length === 0) && (!used || used.length === 0)) {
      try {
        const offlineId = shopify.session.getOfflineId(shop);
        const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
        const offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;
        const accessToken = offlineSession?.accessToken || null;

        if (accessToken) {
          const fb = await fetchFallbackProducts(shop, accessToken, {
            limit: 10,
            query: concernInput || '',
          });

          if (Array.isArray(fb) && fb.length) {
            const fallbackPayload = {
              productIds: fb.map((p) => p.id),
              products: fb.map((p) => ({
                id: p.id,
                title: p.title,
                name: p.title,
                handle: p.handle,
                image: p.image,
                url: p.url,
              })),
              copy: copy || 'Here are some products from your catalog while Refina finishes indexing.',
              disclaimer,
              ...(enriched ? { enriched } : {}),
              meta: { ...meta, tone, plan, source: 'fallback', totalMs: Date.now() - t0 },
            };
            if (typeof cacheSet === 'function') cacheSet(cacheKey, fallbackPayload);
            return res.json(fallbackPayload);
          }
        }
      } catch (err) {
        console.error('[v1/recommend] fallback error', err);
        // fall through to normal payload
      }
    }
    // --- end fallback ---

    // normal response path
    const payload = {
      productIds: used,
      products: hydrate,
      copy,
      disclaimer,
      ...(enriched ? { enriched } : {}),
      meta: { ...meta, tone, plan, totalMs: Date.now() - t0 },
    };
    if (typeof cacheSet === 'function') cacheSet(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    console.error('POST /v1/recommend error', e);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    const ms = Date.now() - t0;
    if (ms > 500) console.log(`[BFF] /v1/recommend took ${ms}ms`);
  }
});

// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Refina Unified Server running on :${PORT}`);
  console.log(`Origin:             ${PUBLIC_BACKEND_ORIGIN}`);
  console.log(`Admin UI:           GET  /embedded  → /admin-ui`);
  console.log(`Admin UI Assets:    GET  /admin-ui/assets/*  (immutable)`);
  console.log(`Admin UI Static:    GET  /admin-ui/* (favicon/manifest, no index)`);
  console.log(`App Proxy HTML:     GET  /proxy/refina`);
  console.log(`App Proxy APIs:     GET  /proxy/refina/v1/concerns`);
  console.log(`                    GET  /proxy/refina/v1/settings`);
  console.log(`                    POST /proxy/refina/v1/recommend`);
  console.log(`Narrow assets:      GET  /proxy/refina/concierge.(js|css), /proxy/refina/chunks/* → ${ASSETS_BASE_URL}`);
  console.log(`Health:             GET  /v1/health`);
});
