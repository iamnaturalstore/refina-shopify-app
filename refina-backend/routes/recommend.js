// refina-backend/routes/recommend.js
// Retrieval-augmented concierge + PDP fast paths
// - GET /apps/refina/v1/recommend?mode=verdict|peek (tiny, cacheable)
// - POST /apps/refina/v1/recommend (unchanged core concierge)

import express from "express";
import crypto from "node:crypto";
import { db } from "../bff/lib/firestore.js";
import { buildGeminiPrompt } from "../bff/ai/buildGeminiPrompt.js";
import { ConciergeResponseSchema } from "../ai/jsonSchemas.js";
import { validateConciergeResponse } from "../ai/validateConcierge.js";
import {
  normConcern,
  expandConcernToIngredients,
  getIngredientFacts,
  detectConstraints,
  EO_DENYLIST,
} from "../bff/lib/knowledge.js";
import { callGemini } from "../bff/ai/gemini.js";

import { aiGuard } from "../bff/ai/guard.js";
import { incrementOnInvoke } from "../lib/usage.js";
import { FieldPath } from "firebase-admin/firestore"; // harmless if unused elsewhere

// ─── Admin ping schema (for /admin/ai-ping) ──────────────────────────────────
const PingSchema = {
  type: "OBJECT",
  properties: { ok: { type: "BOOLEAN" } },
  required: ["ok"],
};

// ─── Small math utils ────────────────────────────────────────────────────────
function dot(a, b) { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); }
function cosine(a, b) { const na = norm(a), nb = norm(b); if (!na || !nb) return 0; return dot(a, b) / (na * nb); }
function pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return o; }

// ─────────────────────────────────────────────────────────────
// Phase 2 — Capsule v1 (in-memory, low-churn)
// Goal: high-signal, low-token product objects for prompt input.
// This does NOT change Firestore schema or indexer/enrichment.
// ─────────────────────────────────────────────────────────────

function arr(x, max = 12) {
  if (!Array.isArray(x)) return [];
  return x.map(v => String(v).trim()).filter(Boolean).slice(0, max);
}

function str(x, max = 240) {
  const s = String(x ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

// Rough EO detection fallback (beauty pack can override later)
function hasEssentialOilSignal(p = {}) {
  const tags = arr(p.tags, 80).join(" ").toLowerCase();
  const ing = arr(p.ingredientsNormalized, 80).join(" ").toLowerCase();
  const text = `${tags} ${ing} ${String(p.title || "").toLowerCase()}`;
  return /\b(essential oil|lavender|tea tree|eucalyptus|peppermint|citrus|ros(e)?mary|ylang)\b/.test(text);
}

/**
 * buildCapsuleFromProduct(product)
 * Keeps only what the model needs to rank + explain.
 * We intentionally do NOT send long HTML descriptions.
 * descriptionShort stays available for UI usage elsewhere.
 */
function buildCapsuleFromProduct(p = {}) {
  const capsule = {
    id: String(p.id ?? p.productId ?? ""),
    title: str(p.title || p.name, 120),
    productType: str(p.productType, 60),

    // High-signal lists
    keywords: arr(p.keywords, 12),
    benefits: arr(p.benefits, 8),
    ingredients: arr(p.ingredientsNormalized || p.ingredients, 20),

    // Lightweight fit flags (derive from existing fields if present)
    skinFitTags: arr(p.skinFitTags, 10),

    // Avoidance flags (derive if not already stored)
    avoidFlags: {
      essentialOils: Boolean(p.avoidFlags?.essentialOils) || hasEssentialOilSignal(p),
    },

    // 1-line usage if you have it
    usage: str(p.usage, 120),
  };

  // If you rely on tags for fallback heuristics, keep a tiny subset
  // but cap aggressively to avoid token bloat.
  if (!capsule.keywords.length && Array.isArray(p.tags)) {
    capsule.keywords = arr(p.tags, 10).map(t => t.toLowerCase());
  }

  return capsule;
}

function capsuleCharCount(capsules = []) {
  try {
    return JSON.stringify(capsules).length;
  } catch {
    return 0;
  }
}

// NEW helpers for faster scoring with precomputed query norm
function normSq(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}
function normFromSq(sq) {
  return Math.sqrt(sq || 0);
}
function cosineWithQueryNorm(qVec, qNorm, docVec, docNorm) {
  const nb = Number.isFinite(docNorm) ? docNorm : norm(docVec);
  if (!qNorm || !nb) return 0;
  return dot(qVec, docVec) / (qNorm * nb);
}


// ─── In-memory cache for product embeddings ─────────────────────────────────
// Keyed by storeId + cacheEpoch so bumping cacheEpoch in storeSettings blows it away.
const EMBEDDINGS_CACHE = new Map();

// Single-flight: coalesce concurrent loads per store+epoch
const EMBEDDINGS_INFLIGHT = new Map();

function getEmbeddingsCache(storeId, cacheEpoch) {
  const key = `${storeId || ""}::${cacheEpoch || "none"}`;
  const hit = EMBEDDINGS_CACHE.get(key);
  if (hit && Array.isArray(hit) && hit.length) return hit;

   // If epoch changed, clear old entries for this store (defensive, avoids leaks).
  for (const k of EMBEDDINGS_CACHE.keys()) {
    if (k.startsWith(`${storeId || ""}::`) && k !== key) {
      EMBEDDINGS_CACHE.delete(k);
      EMBEDDINGS_INFLIGHT.delete(k);
    }
  }
  return null;
}

function setEmbeddingsCache(storeId, cacheEpoch, data) {
  const key = `${storeId || ""}::${cacheEpoch || "none"}`;
  EMBEDDINGS_CACHE.set(key, Array.isArray(data) ? data : []);
}

// ─── URL/image helpers ───────────────────────────────────────────────────────
function ensureAbsolute(u, storeId) {
  const url = String(u || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://${storeId}${url}`;
  return `https://${storeId}/${url}`;
}
function pickPrimaryImage(p, storeId) {
  const candidate =
    p.image ||
    (Array.isArray(p.images) && p.images.length ? p.images[0] : "") ||
    p.image_url ||
    "";
  return ensureAbsolute(candidate, storeId);
}

// ─── Embeddings via REST (vectors) ───────────────────────────────────────────
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  "gemini-embedding-001";

async function embedText(text) {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";
  if (!apiKey) {
    console.warn("[Embeddings] API Key missing; returning empty vector.");
    return [];
  }

  const modelName = String(EMBEDDING_MODEL).replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:embedContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    content: { parts: [{ text: String(text || "") }] },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error("[Embeddings] HTTP", resp.status, txt.slice(0, 300));
      return [];
    }

    const data = await resp.json();
    const vals = Array.isArray(data?.embedding?.values) ? data.embedding.values : [];
    return vals.map(Number).filter(n => Number.isFinite(n));
  } catch (e) {
    console.error("[Embeddings] error:", e?.message || e);
    return [];
  }
}

async function loadEmbeddings(storeId, cacheEpoch) {
  // First try in-memory cache (per process, super fast)
  const cached = getEmbeddingsCache(storeId, cacheEpoch);
  if (cached) return cached;

  const key = `${storeId || ""}::${cacheEpoch || "none"}`;

  // Single-flight: if a load is already in progress for this store+epoch, await it
  const inflight = EMBEDDINGS_INFLIGHT.get(key);
  if (inflight) return await inflight;

  const p = (async () => {
    // Read only the vector field to avoid pulling large entities/evidence payloads.
    const col = db
      .collection("productEmbeddings")
      .doc(storeId)
      .collection("items");

    const snap = await col.select("vector").get(); // field mask trims payload drastically

    const allEmb = snap.docs.map((d) => {
  const vec = Float32Array.from(d.get("vector") || []);
  const docNorm = normFromSq(normSq(vec));
  return { id: d.id, vector: vec, docNorm };
});

    setEmbeddingsCache(storeId, cacheEpoch, allEmb);
    return allEmb;
  })();

  EMBEDDINGS_INFLIGHT.set(key, p);

  try {
    return await p;
  } finally {
    // Always clear in-flight entry (success or failure) so we don’t poison the cache
    EMBEDDINGS_INFLIGHT.delete(key);
  }
}

async function loadProductsByIds(storeId, ids) {
  // Batch read via getAll to avoid 1-by-1 round trips.
  const uniq = Array.from(new Set(ids.map(String)));
  if (!uniq.length) return [];

  const col = db.collection("products").doc(storeId).collection("items");
  const refs = uniq.map(id => col.doc(id));

  // Single network call for all refs (Admin SDK).
  const snaps = await db.getAll(...refs);
  return snaps
    .filter(s => s.exists)
    .map(s => ({ id: s.id, ...s.data() }));
}


// ─── Deterministic KB scoring & filters ──────────────────────────────────────
function intersects(a = [], b = []) {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a.map(x => String(x).toLowerCase().trim()));
  for (const y of b) if (set.has(String(y).toLowerCase().trim())) return true;
  return false;
}

function hasEO(ingredientsNormalized = []) {
  if (!Array.isArray(ingredientsNormalized)) return false;
  const lower = ingredientsNormalized.map(x => String(x).toLowerCase().trim());
  const eo = new Set(EO_DENYLIST);
  for (const ing of lower) {
    for (const eoSlug of eo) {
      if (ing.includes(eoSlug)) return true;
    }
  }
  return false;
}

// Build a tiny “concern tokens” set from normalized concern
function concernTokens(normQ) {
  const t = new Set(String(normQ || "").split(/\W+/).filter(Boolean));
  const out = new Set();
  for (const k of t) {
    if (/acne|pimple|blemish|breakout/.test(k)) out.add("acne");
    if (/oil|oily|sebum|shine/.test(k)) out.add("oily");
    if (/sensitive|reactive|irritat/.test(k)) out.add("sensitive");
    if (/pigment|spot|dark|melasma/.test(k)) out.add("pigmentation");
    if (/age|wrinkle|line|photo|sun/.test(k)) out.add("photoaging");
    if (/dry|dehydrat|barrier/.test(k)) out.add("barrier");
    if (/red|rosace/.test(k)) out.add("redness");
    if (/moistur|cream|lotion/.test(k)) out.add("moisturizer");
    if (/serum|treatment/.test(k)) out.add("serum");
  }
  return out;
}

// Score in [0,1]; −Infinity for allergen violations (when constraints.avoidEO)
function ruleScore(product = {}, constraints = {}, normQ = "") {
  const pt = String(product.productType_norm || product.productType || "").toLowerCase();
  const step = String(product.usageStep || product.step || "").toLowerCase();

  const ben = Array.isArray(product.benefitsNormalized) ? product.benefitsNormalized.map(s => s.toLowerCase()) : [];
  const con = Array.isArray(product.concernsNormalized) ? product.concernsNormalized.map(s => s.toLowerCase()) : [];
  const ing = Array.isArray(product.ingredientsNormalized) ? product.ingredientsNormalized.map(s => s.toLowerCase()) : [];

  if (constraints.flags?.avoidEO && hasEO(ing)) return -Infinity;

  const toks = concernTokens(normQ);

  const wantedStep = constraints.step;
  const typeMatch = wantedStep ? (pt === wantedStep || step === wantedStep) : false;

  const hits = new Set();
  for (const b of ben) for (const k of toks) if (b.includes(k)) hits.add(k);
  for (const c of con) for (const k of toks) if (c.includes(k)) hits.add(k);
  const concernHitCount = Math.min(3, hits.size);

  const audienceMatch = constraints.flags?.sensitive
    ? (ben.concat(con).some(s => s.includes("sensitive")) || !hasEO(ing))
    : false;

  const ageBoost = constraints.age && constraints.age >= 55
    ? (ben.concat(con).some(s => /(firm|elastic|retinol|vitamin c|peptide|wrinkle|photo|sun)/.test(s)) ? 0.2 : 0)
    : 0;

  let score = 0;
  if (typeMatch) score += 0.45;
  score += concernHitCount * 0.15;
  if (audienceMatch) score += 0.15;
  score += ageBoost;
  if (score > 1) score = 1;
  if (score < 0) score = 0;
  return score;
}

// ─── Cache (7d TTL; version + epoch invalidation) ────────────────────────────
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = "concierge-v2-kb";

function cacheKey(storeId, concernNorm) {
  return crypto.createHash("sha1").update(`${storeId}::${concernNorm}`).digest("hex");
}
async function readCache(storeId, key, epoch) {
  const ref = db.collection("conciergeCache").doc(storeId).collection("queries").doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const c = snap.data();
  const fresh = Date.now() - (c.ts || 0) < CACHE_TTL_MS;
  const versionOk = c.version === CACHE_VERSION;
  const epochOk = !epoch || c.epoch === epoch;
  return fresh && versionOk && epochOk ? c.payload : null;
}
async function writeCache(storeId, key, payload, epoch) {
  const ref = db.collection("conciergeCache").doc(storeId).collection("queries").doc(key);
  await ref.set(
    { ts: Date.now(), version: CACHE_VERSION, epoch: epoch || null, payload },
    { merge: true }
  );
}

// ─────────────────────────────────────────────────────────────
// Phase 3A: Facts micro-cache + gating
// ─────────────────────────────────────────────────────────────
const FACTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const factsCache = new Map(); // key -> { value, expiresAt }

function factsCacheGet(key) {
  const hit = factsCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    factsCache.delete(key);
    return null;
  }
  return hit.value || null;
}

function factsCacheSet(key, value) {
  factsCache.set(key, { value, expiresAt: Date.now() + FACTS_CACHE_TTL_MS });
}

function shouldFetchIngredientFacts({ constraints, category }) {
  // Only pay the facts tax when it materially matters (Phase 3A scope).
  if (String(category || "") !== "Beauty") return false;

  const age = typeof constraints?.age === "number" ? constraints.age : null;
  const flags = constraints?.flags || {};
  const step = String(constraints?.step || "").trim();

  return Boolean(
    step ||
      (age != null && age >= 55) ||
      flags.sensitive ||
      flags.avoidEO ||
      flags.rosacea ||
      flags.redness ||
      flags.photoaging ||
      flags.pigmentation ||
      flags.acne ||
      flags.dry ||
      flags.oily
  );
}

// ─── PDP FAST PATHS (GET) ────────────────────────────────────────────────────
const router = express.Router();

/**
 * GET /apps/refina/v1/recommend?mode=verdict|peek&storeId=...&productId=...
 * Lightweight, deterministic, cache-friendly.
 * - verdict: returns { verdict: "Yes|No|Maybe", chips: [], alts: [] }
 * - peek:    returns { candidates: [] }   // safe to be empty initially
 */
router.get("/recommend", async (req, res) => {
  try {
    const mode = String(req.query.mode || "verdict").toLowerCase();
    const storeId = String(req.query.storeId || "").trim();
    if (!storeId) return res.status(400).json({ error: "storeId required" });

    if (mode === "peek") {
      // Minimal seed (hydrate later via embeddings/KB); safe to be empty
      return res.json({ candidates: [] });
    }

    // verdict
    const productId = String(req.query.productId || "").trim();
    const available = String(req.query.available || "").toLowerCase() === "true";
    const price = Number(req.query.price || 0);
    const compareAt = Number(req.query.compareAtPrice || 0);
    const priceCap = Number(req.query.priceCap || 0);

    let verdict = "Maybe";
    if (available) verdict = "Yes";
    const chips = [];

    if (available) chips.push("In stock");
    if (compareAt && price && compareAt > price) chips.push("On sale");
    if (priceCap && price && price <= priceCap * 100) chips.push(`Under $${priceCap}`);
    // Try to add a sensitivity hint if product looks EO-safe
    if (productId) {
      try {
        const snap = await db.collection("products").doc(storeId).collection("items").doc(productId).get();
        if (snap.exists) {
          const p = snap.data() || {};
          const ingNorm =
            (Array.isArray(p.ingredientsNormalized) && p.ingredientsNormalized) ||
            (Array.isArray(p.ingredients_norm) && p.ingredients_norm) || [];
          const eoFree = !hasEO(ingNorm);
          if (eoFree) chips.push("Fragrance/EO-free");
        }
      } catch {}
    }

    return res.json({ verdict, chips: chips.slice(0, 3), alts: [] });
  } catch (e) {
    return res.json({ verdict: "Maybe", chips: [], alts: [] });
  }
});

// ─── Admin: GET /apps/refina/v1/admin/ai-ping ────────────────────────────────
router.get("/admin/ai-ping", async (req, res) => {
  try {
    const need = process.env.ADMIN_PROBE_TOKEN;
    if (need && req.header("x-probe-token") !== need) return res.status(404).end();
    const t0 = Date.now();
    const raw = await callGemini('Return {"ok": true} exactly.', {
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      maxOutputTokens: 16,
      responseSchema: PingSchema,
    });
    return res.json({
      ok: true,
      tookMs: Date.now() - t0,
      rawHead: typeof raw === "string" ? raw.slice(0, 80) : null,
      __debug: { model: process.env.GEMINI_MODEL || "gemini-2.5-flash" },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, err: String(e?.message || e) });
  }
});

// ─── Main concierge: POST /apps/refina/v1/recommend (unchanged core) ────────
router.post("/recommend", async (req, res) => {
  const started = Date.now();
  const LLM_BUDGET_MS = 12000;
  let raced = false;
  let llmMs = 0;
  const attempts = [];

  // Timing buckets for latency profiling (non-functional)
const timings = {
  embedMs: 0,      // concern → embedding
  embLoadMs: 0,    // load product embeddings from Firestore
  docScoreMs: 0,   // load top-30 skinny docs
  scoreMs: 0,      // ruleScore / constraints / finalists
  factsMs: 0,      // KB ingredient facts assembly (should shrink in v1.5)
  docEnrichMs: 0,  // final loadProductsByIds for display
};

let promptChars = 0;

  try {
    const { storeId, concern } = req.body || {};
    if (!storeId || !concern) {
      return res.status(400).json({ error: "storeId and concern are required." });
    }

    // Store settings
    const settingsSnap = await db.collection("storeSettings").doc(storeId).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const category = settings?.category || "Beauty";
    const tone = settings?.tone || "Helpful, expert, friendly";
    const strictness = settings?.aiControls?.promptStrictness || "balanced";
    const cacheEpoch = settings?.cacheEpoch || null;

        // Deterministic catalogue fallback (plan-off / limited / guard error)
    async function deterministicFallback(guard) {
      const concernNormLocal = normConcern(concern);

      const [qVec, allEmb] = await Promise.all([
        embedText(concern),
        loadEmbeddings(storeId, cacheEpoch),
      ]);

      if (!allEmb.length || !qVec.length) {
        return res.json({
          productIds: [],
          products: [],
          explanation: guard?.message || "AI is currently unavailable for your plan.",
          followUps: [],
          awesome: null,
          source: guard?.state === "off" ? "ai-off" : "limit-exceeded",
          tookMs: Date.now() - started,
          limitMessage: guard?.message || null,
        });
      }

      const qNorm = normFromSq(normSq(qVec));

      // Top-30 by cosine (Top-K; avoids sorting the whole embedding list)
const K = 30;
const scoredEmb = [];
let minIdx = -1;
let minSim = Infinity;

for (const e of allEmb) {
  const sim = cosineWithQueryNorm(qVec, qNorm, e.vector || [], e.docNorm);
  if (scoredEmb.length < K) {
    scoredEmb.push({ id: e.id, sim });
    if (sim < minSim) {
      minSim = sim;
      minIdx = scoredEmb.length - 1;
    }
    continue;
  }

  if (sim <= minSim) continue;

  scoredEmb[minIdx] = { id: e.id, sim };

  // Recompute current minimum (K is tiny; this is cheap and stable)
  minSim = Infinity;
  minIdx = -1;
  for (let i = 0; i < scoredEmb.length; i++) {
    const s = scoredEmb[i].sim;
    if (s < minSim) {
      minSim = s;
      minIdx = i;
    }
  }
}

// Sort only the Top-K
scoredEmb.sort((a, b) => b.sim - a.sim || String(a.id).localeCompare(String(b.id)));


      const topDocs = await loadProductsForScoring(storeId, topIds);
      const byId = new Map(scoredEmb.map((s) => [String(s.id), s.sim]));
      const constraints = detectConstraints(concernNormLocal);

      const filtered = [];
      for (const p of topDocs) {
        const ingNorm =
          (Array.isArray(p.ingredientsNormalized) && p.ingredientsNormalized) ||
          (Array.isArray(p.ingredients_norm) && p.ingredients_norm) ||
          [];

        if (constraints.flags?.avoidEO && hasEO(ingNorm)) continue;

        const sim = byId.get(String(p.id)) || 0;
        const rs = ruleScore(p, constraints, concernNormLocal);
        if (rs === -Infinity) continue;

        const finalScore = 0.7 * sim + 0.3 * rs;
        filtered.push({ p, sim, rs, finalScore });
      }

      filtered.sort((a, b) => b.finalScore - a.finalScore);

      const capN = Math.min(guard?.trim?.maxProducts || 12, 12);
      const finalists = filtered.slice(0, capN).map((x) => x.p);
      const outIds = finalists.slice(0, 6).map((p) => String(p.id));
      const enriched = await loadProductsByIds(storeId, outIds);

      const products = enriched.map((p) => {
        const title = p.title || p.name || "";
        const price = p.price != null ? p.price : undefined;
        const price_formatted =
          p.price_formatted || p.priceFormatted || undefined;

        let urlCandidate = p.url || (p.handle ? `/products/${p.handle}` : "");
        if (!urlCandidate && p.path) urlCandidate = p.path;

        const url = ensureAbsolute(urlCandidate, storeId);
        const image = pickPrimaryImage(p, storeId);
        const description = p.description || p.body_html || "";

        return {
          id: p.id,
          title,
          price,
          ...(price_formatted ? { price_formatted } : {}),
          image,
          image_url: image,
          url,
          description,
        };
      });

      return res.json({
        productIds: outIds,
        products,
        explanation:
          guard?.message || "Here are strong matches from your catalogue.",
        followUps: [],
        awesome: null,
        source: guard?.state === "off" ? "ai-off" : "limit-exceeded",
        tookMs: Date.now() - started,
        limitMessage: guard?.message || null,
      });
    }

    // Cache (EARLY) — avoid paying aiGuard on hits
const concernNorm = normConcern(concern);
const constraints = detectConstraints(concernNorm);
const ck = cacheKey(storeId, concernNorm);
const cached = await readCache(storeId, ck, cacheEpoch);
if (cached) {
  // No guard yet — keep cached payload intact and fast.
  let shaped = clampCachedPayload(cached, null);
  shaped = transformToBasicIfNeeded(shaped, null);

  return res.json({
    ...shaped,
    source: "cache",
    cacheHit: true,
    limitMessage: null,
    tookMs: Date.now() - started,
    __debug: {
      cacheKey: ck,
      cacheEpoch,
      cacheHit: true,
      promptChars: 0,
      timings,
      capsuleCount: 0,
      capsuleChars: 0,
    },
  });
}

// Billing & Limits Gate
let guard = null;
try {
  guard = await aiGuard({
    storeId,
    intent: "recommend",
    longForm: false,
    expectedPromptChars: 12000,
  });
} catch (e) {
  console.error("[recommend] aiGuard error, serving fallback:", e?.message || e);
  const pseudoGuard = {
    state: "limited",
    message: "The assistant is warming up. Here are strong matches from your catalogue.",
    trim: { maxProducts: 12, charBudget: 28000 },
  };
  return await deterministicFallback(pseudoGuard);
}

if (guard?.state === "off" || guard?.state === "limited") {
  return await deterministicFallback(guard);
}

    // Embedding retrieval (measure concern embedding vs catalogue embeddings separately)
    const tEmbedStart = Date.now();
    const qVecPromise = embedText(concern).then((v) => {
      timings.embedMs = Date.now() - tEmbedStart;
      return v;
    });

    const tEmbLoadStart = Date.now();
    const allEmbPromise = loadEmbeddings(storeId, cacheEpoch).then((v) => {
      timings.embLoadMs = Date.now() - tEmbLoadStart;
      return v;
    });

    const [qVec, allEmb] = await Promise.all([qVecPromise, allEmbPromise]);

    if (!allEmb.length || !qVec.length) {
      const tookMs = Date.now() - started;
      try {
        console.warn("[Refina][recommend] timings (no-vectors)", {
          storeId,
          tookMs,
          ...timings,
          llmMs,
          stage: "no-vectors",
          cacheHit: false,
        });
      } catch (_) {}

      return res.json({
        productIds: [],
        products: [],
        explanation: "Your product knowledge is still building for this store. Try again shortly.",
        followUps: [],
        awesome: null,
        source: "no-vectors",
        tookMs,
      });
    }

    // Top-60 by cosine - changed to 30 (Top-K; avoids sorting the whole embedding list)
const K = 30;
const qNorm = normFromSq(normSq(qVec));
const scored = [];
let minIdx = -1;
let minSim = Infinity;

for (const e of allEmb) {
  const sim = cosineWithQueryNorm(qVec, qNorm, e.vector || [], e.docNorm);
  if (scored.length < K) {
    scored.push({ id: e.id, sim });
    if (sim < minSim) {
      minSim = sim;
      minIdx = scored.length - 1;
    }
    continue;
  }

  if (sim <= minSim) continue;

  scored[minIdx] = { id: e.id, sim };

  // Recompute current minimum (K is tiny; this is cheap and stable)
  minSim = Infinity;
  minIdx = -1;
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i].sim;
    if (s < minSim) {
      minSim = s;
      minIdx = i;
    }
  }
}

// Sort only the Top-K
scored.sort((a, b) => b.sim - a.sim || String(a.id).localeCompare(String(b.id)));


        const topIds = scored.map(s => s.id);

    const tDocScoreStart = Date.now();
    const topDocs = await loadProductsForScoring(storeId, topIds);
    timings.docScoreMs = Date.now() - tDocScoreStart;

        const tScoreStart = Date.now();

    // Map id → doc + cosine
    const byId = new Map();
    for (const s of scored) byId.set(String(s.id), s.sim);

    // Hard allergen filter (EO) when asked to avoid fragrance/EO/sensitive
    const filtered = [];
    for (const p of topDocs) {
      const ingNorm =
        (Array.isArray(p.ingredientsNormalized) && p.ingredientsNormalized) ||
        (Array.isArray(p.ingredients_norm) && p.ingredients_norm) ||
        [];
      if (constraints.flags?.avoidEO && hasEO(ingNorm)) continue; // HARD exclude
      const sim = byId.get(String(p.id)) || 0;
      const rs = ruleScore(p, constraints, concernNorm); // [-Inf, 1]
      if (rs === -Infinity) continue;
      const finalScore = 0.7 * sim + 0.3 * rs;
      filtered.push({ p, sim, rs, finalScore });
    }

    // Finalists (plan-capped)
    filtered.sort((a, b) => b.finalScore - a.finalScore);
    timings.scoreMs = Date.now() - tScoreStart;

    const maxByPlan = Math.max(3, Math.min(guard?.trim?.maxProducts ?? 12, 12));
    const finalists = filtered.slice(0, maxByPlan).map(x => x.p);
    const finalistsSet = new Set(finalists.map(p => String(p.id)));
    
    // Phase 2 — Convert finalists to Capsules (in-memory)
    const capsules = (finalists || []).map(buildCapsuleFromProduct);


    // Compact shape for prompt
    function compactForPrompt(p) {
      const ben = Array.isArray(p.benefitsNormalized) ? p.benefitsNormalized : (Array.isArray(p.benefits) ? p.benefits : []);
      const con = Array.isArray(p.concernsNormalized) ? p.concernsNormalized : (Array.isArray(p.concerns) ? p.concerns : []);
      const ing = Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized : (Array.isArray(p.ingredients) ? p.ingredients : []);
      const pt = p.productType_norm || p.productTypeNormalized || p.productType || "";
      const step = p.usageStep || p.step || "";

      const stripHtmlLocal = (s = "") => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      const capLocal = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

      const rs = ruleScore(p, constraints, concernNorm);
      const typeMatch = constraints.step
        ? ([pt, step].map(String).map(s => s.toLowerCase()).includes(String(constraints.step).toLowerCase()))
        : false;

      const audienceMatch = !!(constraints.flags?.sensitive && (
        ben.concat(con).some(s => /sensitive/i.test(String(s))) || !hasEO(ing)
      ));

      const toks = Array.from(concernTokens(concernNorm));
      const lowerBen = ben.map(s => String(s).toLowerCase());
      const lowerCon = con.map(s => String(s).toLowerCase());
      const hits = [];
      for (const k of toks) {
        if (lowerBen.some(s => s.includes(k)) || lowerCon.some(s => s.includes(k))) hits.push(k);
      }

      return {
        id: p.id,
        name: p.title || p.name || "",
        descriptionShort: capLocal(stripHtmlLocal(p.description || p.body_html || "")),
        productType: p.productType || "",
        productType_norm: pt,
        usageStep: step,
        category: p.categoryNormalized || p.category || "",
        benefitsNormalized: ben.slice(0, 10),
        concernsNormalized: con.slice(0, 10),
        ingredientsNormalized: ing.slice(0, 10),
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 8)
          : (typeof p.tags === "string" ? p.tags.split(",").map(t => t.trim()).slice(0, 12) : []),
        keywords: Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized.slice(0, 12)
          : (Array.isArray(p.keywords) ? p.keywords.slice(0, 8) : []),
        ruleScore: Number((Number.isFinite(rs) ? rs : 0).toFixed(3)),
        typeMatch,
        audienceMatch,
        concernHits: hits.slice(0, 6),
      };
    }

    const stage1Count = Math.min(8, finalists.length);
    const needWiden =
      constraints.flags?.sensitive || constraints.flags?.avoidEO || !!constraints.step ||
      (constraints.age && constraints.age >= 55);

    const forStage1 = finalists.slice(0, stage1Count).map(compactForPrompt);
    const forStage2Base = (needWiden ? finalists : finalists.slice(0, stage1Count)).map(compactForPrompt);

    function estimateChars(productsArr) {
      try { return JSON.stringify(productsArr).length + String(concern).length + 512; }
      catch { return 999999; }
    }
    const charBudget = guard?.trim?.charBudget || 28000;
    let forStage2 = forStage2Base;
    while (estimateChars(forStage2) > charBudget && forStage2.length > stage1Count) {
      forStage2 = forStage2.slice(0, forStage2.length - 1);
    }

// Phase 1.5 + Phase 3A: conditional Knowledge Pack facts + micro-cache
let ingredientFacts = {};
const wantFacts = shouldFetchIngredientFacts({
  constraints,
  category,
  concernNorm,
});

if (wantFacts) {
  const finalistIdsForFacts = finalists.slice(0, 3).map((p) => String(p.id || ""));
  const factsKeyParts = [
    storeId,
    cacheEpoch || "none",
    category || "",
    constraints.step || "",
    constraints.flags?.sensitive ? "sens" : "",
    constraints.flags?.avoidEO ? "avoidEO" : "",
    String(constraints.age || ""),
    finalistIdsForFacts.join(","),
    concernNorm,
  ];
  const factsKey = factsKeyParts.join("|");

  const cachedFacts = factsCacheGet(factsKey);
  if (cachedFacts) {
    ingredientFacts = cachedFacts;
    timings.factsMs = 1;
  } else {
    const tFactsStart = Date.now();
    try {
      // Expand concern + top finalists into ingredient slugs
      const hints = await expandConcernToIngredients(concernNorm, finalists.slice(0, 3));
      const rawSlugs =
        Array.isArray(hints?.slugs)
          ? hints.slugs
          : Array.isArray(hints?.fromConcern?.slugs)
          ? hints.fromConcern.slugs
          : [];

      const slugs = Array.from(
        new Set(
          rawSlugs
            .map((s) => String(s || "").trim().toLowerCase())
            .filter(Boolean),
        ),
      );

      if (slugs.length) {
        // NOTE: getIngredientFacts returns the object format expected by buildGeminiPrompt.formatIngredientFacts
        ingredientFacts = (await getIngredientFacts(storeId, slugs.slice(0, 12))) || {};
      } else {
        ingredientFacts = {};
      }

      factsCacheSet(factsKey, ingredientFacts);
    } catch (e) {
      ingredientFacts = {};
      try {
        console.warn("[recommend] ingredient facts skipped (error)", {
          storeId,
          msg: String(e?.message || e),
        });
      } catch (_) {}
    } finally {
      timings.factsMs = Date.now() - tFactsStart;
    }
  }
} else {
  // Explicit: skipped facts
  timings.factsMs = 0;
}

// Phase 2 — Capsules-first prompt build
const capsulesStage1 = (forStage1 || []).map(buildCapsuleFromProduct);
const capsulesStage2 = (forStage2 || []).map(buildCapsuleFromProduct);

const prompt1 = buildGeminiPrompt({
  concern,
  normalizedConcern: concernNorm,
  category,
  tone,

  // IMPORTANT: keep key name `products` to avoid prompt-builder churn
  products: capsulesStage1,

  ingredientFacts,
});

// Track prompt size for debug
try { promptChars = String(prompt1 || "").length; } catch {}

const prompt2 = needWiden
  ? buildGeminiPrompt({
      concern,
      normalizedConcern: concernNorm,
      category,
      tone,

      // Phase 2 — widened capsules
      products: capsulesStage2,

      ingredientFacts,
    })
  : null;

// Capsule debug (Phase 2)
try {
  debugCapsuleCount = capsulesStage1.length;
  debugCapsuleChars = capsuleCharCount(capsulesStage1);
} catch {}


    // Single call (gemini.js handles JSON mode/retries)
    let raw = null, rawHead = null, vr = { ok: false };
    try {
      try { await incrementOnInvoke(storeId, { count: 1 }); } catch (_) {}
      const t0_llm = Date.now();
      raw = await callGemini(prompt1, {
        model: process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash",
        temperature: 0.3,
        topP: 0.8,
      });
      llmMs = Date.now() - t0_llm;

      vr = validateConciergeResponse(raw);
      if (typeof raw === "string") rawHead = raw.slice(0, 220);
      attempts.push({ stage: 1, ok: vr.ok, ms: llmMs, err: vr.ok ? undefined : (raw ? "validation_failed" : "llm_returned_null") });
    } catch (e) {
      console.error("[recommend] Unexpected error during callGemini:", e);
      attempts.push({ stage: 1, ok: false, err: String(e?.message || e) });
    }

    if (!vr.ok) {
      const fallbackIds = finalists.slice(0, 6).map((p) => String(p.id));
      const enrichedFallback = await loadProductsByIds(storeId, fallbackIds);
      const products = enrichedFallback.map((p) => {
        const title = p.title || p.name || "";
        const price = p.price != null ? p.price : undefined;
        const price_formatted = p.price_formatted || p.priceFormatted || undefined;
        let urlCandidate = p.url || (p.handle ? `/products/${p.handle}` : "");
        if (!urlCandidate && p.path) urlCandidate = p.path;
        const url = ensureAbsolute(urlCandidate, storeId);
        const image = pickPrimaryImage(p, storeId);
        const description = p.description || p.body_html || "";
        return {
          id: p.id, title, price, ...(price_formatted ? { price_formatted } : {}),
          image, image_url: image, url, description,
        };
      });

            const tookMs = Date.now() - started;

      try {
        console.warn("[Refina][recommend] timings", {
          storeId,
          tookMs,
          ...timings,
          llmMs,
          candidateCount: finalists.length,
          cacheHit: false,
          source: "gemini-fallback",
        });
      } catch (_) {}

      return res.json({
        productIds: fallbackIds,
        products,
        explanation: guard?.message || "Here are the strongest matches from the catalogue while the assistant warms up.",
        followUps: [],
        awesome: null,
        source: "gemini-fallback",
        tookMs,
        limitMessage: guard?.message || null,
        __debug: {
          raced,
          llmMs,
          budgetMs: LLM_BUDGET_MS,
          candidateCount: finalists.length,
          validator: "fail",
          rawHead,
          attempts,
          timings,
          cacheKey: ck,
          cacheEpoch,
          promptChars,
          capsuleCount: capsulesStage1?.length ?? 0,
          capsuleChars: capsuleCharCount(capsulesStage1),
        },
      });
    }

    const allow = finalistsSet;
    let outIds = vr.value.productIds.filter((id) => allow.has(String(id)));
    if (!outIds.length) outIds = finalists.slice(0, 3).map((p) => String(p.id));

        const tEnrichStart = Date.now();
    const enrichedDocs = await loadProductsByIds(storeId, outIds);
    timings.docEnrichMs = Date.now() - tEnrichStart;

    const products = enrichedDocs.map((p) => {
      const title = p.title || p.name || "";
      const price = p.price != null ? p.price : undefined;
      const price_formatted = p.price_formatted || p.priceFormatted || undefined;
      let urlCandidate = p.url || (p.handle ? `/products/${p.handle}` : "");
      if (!urlCandidate && p.path) urlCandidate = p.path;
      const url = ensureAbsolute(urlCandidate, storeId);
      const image = pickPrimaryImage(p, storeId);
      const description = p.description || p.body_html || "";
      return {
        id: p.id, title, price, ...(price_formatted ? { price_formatted } : {}),
        image, image_url: image, url, description,
      };
    });

    const reasonsById = {};
    if (vr.value?.primary?.id && Array.isArray(vr.value?.primary?.reasons)) {
      reasonsById[vr.value.primary.id] = vr.value.primary.reasons.join(" ");
    }
    if (Array.isArray(vr.value?.alternatives)) {
      for (const alt of vr.value.alternatives) {
        if (alt?.id && Array.isArray(alt.reasons)) {
          reasonsById[alt.id] = alt.reasons.join(" ");
        }
      }
    }

        const tookMs = Date.now() - started;

        // Canonical explanation text (prevents duplicated paragraphs in UI when multiple fields overlap)
function dedupeConsecutiveParagraphs(s) {
  const parts = String(s || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    if (!out.length || out[out.length - 1] !== p) out.push(p);
  }
  return out.join("\n\n");
}

const friendlyParagraph = dedupeConsecutiveParagraphs(
  vr.value?.explanation?.friendlyParagraph || ""
).trim();

const oneLiner = String(vr.value?.explanation?.oneLiner || "").trim();

const explanationText = (
  friendlyParagraph ||
  oneLiner ||
  "Here are the strongest matches for your concern."
).trim();

// Hard-disable copy fields to avoid UI double-rendering overlapping text blocks
const safeCopy = { why: "", rationale: "", extras: "" };


    const payload = {
      productIds: outIds,
      products,
      explanation: explanationText,
      followUps: [],
      awesome: {
        primary: vr.value.primary,
        alternatives: vr.value.alternatives,
        explanation: vr.value.explanation,
        copy: safeCopy,
        productIds: outIds,
      },
      copy: safeCopy,
      reasonsById,
      tookMs,
      source: "gemini",
      limitMessage: guard?.message || null,
      __debug: {
        raced,
        llmMs,
        budgetMs: LLM_BUDGET_MS,
        candidateCount: finalists.length,
        validator: "ok",
        rawHead,
        attempts,
        timings,
        cacheKey: ck,
        cacheEpoch,
        promptChars,
        capsuleCount: capsulesStage1?.length ?? 0,
        capsuleChars: capsuleCharCount(capsulesStage1),
      },
    };

    try { await writeCache(storeId, ck, payload, cacheEpoch); } catch (_) {}

    // Single summary log line for profiling
    try {
      console.warn("[Refina][recommend] timings", {
        storeId,
        tookMs,
        ...timings,
        llmMs,
        candidateCount: finalists.length,
        cacheHit: false,
        source: "gemini",
      });
    } catch (_) {}

    const responsePayload = transformToBasicIfNeeded(payload, guard);
    return res.json(responsePayload);

  } catch (err) {
    console.error("❌ /apps/refina/v1/recommend error:", err);
    return res.json({
      productIds: [],
      products: [],
      explanation: "",
      followUps: [],
      awesome: null,
      source: "error",
      tookMs: Date.now() - started,
    });
  }

  // —— helpers inside POST scope (keep shapes consistent) ——

// Read only the tiny set of fields needed for ruleScore/constraints.
// Uses chunks of 10 to stay within Firestore "in" limits.
// Skinny scorer fetch: vector-friendly field mask, no "where ... in".
// Falls back to full-doc fetch if fieldMask isn't supported.
// Read only the tiny set of fields needed for ruleScore/constraints.
// Skinny scorer fetch: vector-friendly field mask.
// Falls back to full-doc fetch if fieldMask isn't supported.
async function loadProductsForScoring(storeId, ids = []) {
  if (!ids.length) return [];
  const col = db.collection("products").doc(storeId).collection("items");

  // Only the fields needed for ruleScore/constraints/compactForPrompt
  const fieldMask = [
    "productType_norm",
    "productType",
    "usageStep",
    "step",
    "benefitsNormalized",
    "benefits",
    "concernsNormalized",
    "concerns",
    "ingredientsNormalized",
    "ingredients",
    "title",
    "name",
    "description",
    "body_html",
    "categoryNormalized",
    "category",
    "tags",
    "keywordsNormalized",
    "keywords",
  ];

  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  const refs = ids.map((id) => col.doc(String(id)));
  const out = [];

  try {
    for (const batch of chunk(refs, 50)) {
      // eslint-disable-next-line no-await-in-loop
      const snaps = await db.getAll(...batch, { fieldMask });
      for (const s of snaps) {
        if (s.exists) out.push({ id: s.id, ...s.data() });
      }
    }
    return out;
  } catch {
    const fallback = [];
    for (const batch of chunk(refs, 50)) {
      // eslint-disable-next-line no-await-in-loop
      const snaps = await db.getAll(...batch);
      for (const s of snaps) {
        if (s.exists) fallback.push({ id: s.id, ...s.data() });
      }
    }
    return fallback;
  }
}

  function clampCachedPayload(payload, guard) {
    try {
      if (!payload || typeof payload !== "object") return payload;
      const maxItems = Math.max(1, Number(guard?.trim?.maxProducts || 12));

      const products = Array.isArray(payload.products) ? payload.products.slice(0, maxItems) : [];
      const keepIds = new Set(products.map(p => String(p.id)));
      const productIds = Array.isArray(payload.productIds)
        ? payload.productIds.filter(id => keepIds.has(String(id))).slice(0, maxItems)
        : Array.from(keepIds);

      let awesome = payload.awesome || null;
      if (awesome && typeof awesome === "object") {
        const primaryOk = awesome.primary && keepIds.has(String(awesome.primary.id)) ? awesome.primary : null;
        const alternatives = Array.isArray(awesome.alternatives)
          ? awesome.alternatives.filter(a => a && keepIds.has(String(a.id))).slice(0, Math.max(0, maxItems - (primaryOk ? 1 : 0)))
          : [];
        awesome = { ...awesome, primary: primaryOk, alternatives, productIds };
      }

      const reasonsById = payload.reasonsById && typeof payload.reasonsById === "object" ? Object.fromEntries(
        Object.entries(payload.reasonsById).filter(([k]) => keepIds.has(String(k)))
      ) : {};

      const charBudget = Number(guard?.trim?.charBudget || 28000);
      const expCap = charBudget <= 20000 ? 280 : 480;
      let explanation = typeof payload.explanation === "string" ? payload.explanation : "";
      if (explanation.length > expCap) explanation = explanation.slice(0, expCap - 1) + "…";

      return { ...payload, productIds, products, awesome, reasonsById, explanation };
    } catch {
      return payload;
    }
  }

  function transformToBasicIfNeeded(payload, guard) {
    try {
      if (!payload || typeof payload !== "object") return payload;

      const lvlA = (guard?.plan?.level || "").toString().toLowerCase();
      const lvlB = (guard?.level || "").toString().toLowerCase();
      const longFormOff = guard?.features && guard.features.longForm === false;
      const trims = guard?.trim || {};
      const proLikeTrims =
        Number(trims.maxProducts || 999) <= 14 &&
        Number(trims.charBudget || 999999) <= 20000;

      const isPro = (lvlA === "pro" || lvlB === "pro" || lvlA === "growth" || lvlB === "growth" || lvlA === "lite" || lvlB === "lite" || longFormOff || proLikeTrims);
      if (!isPro) return payload;

      const products = Array.isArray(payload.products) ? payload.products : [];
      const productIds = Array.isArray(payload.productIds) ? payload.productIds : products.map((p) => String(p.id));

      const primaryId =
        (payload?.awesome?.primary?.id && String(payload.awesome.primary.id)) ||
        (productIds.length ? String(productIds[0]) : null);

      const maxReasonLen = 90;
      const fromReasonsById = primaryId && payload.reasonsById && payload.reasonsById[primaryId]
        ? String(payload.reasonsById[primaryId]) : "";
      const fromAwesomeReasons = Array.isArray(payload?.awesome?.primary?.reasons)
        ? payload.awesome.primary.reasons.join(" ") : "";
      const fromCopy = payload?.copy?.why || payload?.copy?.rationale || "";

      function cleanTrim(s, cap) {
        const str = String(s || "");
        if (str.length <= cap) return str;
        const slice = str.slice(0, cap - 1);
        const cut = slice.lastIndexOf(" ");
        return (cut > 40 ? slice.slice(0, cut) : slice) + "…";
      }

      let primaryReason = (fromReasonsById || fromAwesomeReasons || fromCopy || "Top match for your concern.").trim();
      primaryReason = cleanTrim(primaryReason, maxReasonLen);

      const expCap = 220;
      let explanation =
        typeof payload.explanation === "string" && payload.explanation.trim()
          ? payload.explanation.trim()
          : "Here are the strongest matches for your concern.";
      explanation = cleanTrim(explanation, expCap);

      const reasonsById = primaryId ? { [primaryId]: primaryReason } : {};

      return { ...payload, awesome: null, explanation, reasonsById, copy: undefined };
    } catch { return payload; }
  }
});

export default router;
