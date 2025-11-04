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
async function embedText(text) {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";
  if (!apiKey) {
    console.warn("[Embeddings] API Key missing; returning empty vector.");
    return [];
  }
  const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    model: "models/text-embedding-004",
    content: { parts: [{ text: String(text || "") }] },
  };
  try {
    const resp = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
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

async function loadEmbeddings(storeId) {
  const snap = await db.collection("productEmbeddings").doc(storeId).collection("items").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadProductsByIds(storeId, ids) {
  if (!ids.length) return [];
  const col = db.collection("products").doc(storeId).collection("items");
  const out = [];
  for (const id of ids) {
    /* eslint no-await-in-loop: 0 */
    const s = await col.doc(String(id)).get();
    if (s.exists) out.push({ id: s.id, ...s.data() });
  }
  return out;
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

      const [qVec, allEmb] = await Promise.all([embedText(concern), loadEmbeddings(storeId)]);
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

      const scored = allEmb
        .map(e => ({ id: e.id, sim: cosine(qVec, (e.vector || [])) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 60);
      const top60Ids = scored.map(s => s.id);
      const top60Docs = await loadProductsByIds(storeId, top60Ids);
      const byId = new Map(scored.map(s => [String(s.id), s.sim]));
      const constraints = detectConstraints(concernNormLocal);

      const filtered = [];
      for (const p of top60Docs) {
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
      const finalists = filtered.slice(0, capN).map(x => x.p);
      const outIds = finalists.slice(0, 6).map(p => String(p.id));
      const enriched = await loadProductsByIds(storeId, outIds);

      const products = enriched.map((p) => {
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

      return res.json({
        productIds: outIds,
        products,
        explanation: guard?.message || "Here are strong matches from your catalogue.",
        followUps: [],
        awesome: null,
        source: guard?.state === "off" ? "ai-off" : "limit-exceeded",
        tookMs: Date.now() - started,
        limitMessage: guard?.message || null,
      });
    }

    // Billing & Limits Gate (before cache/model)
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

    // Cache
    const concernNorm = normConcern(concern);
    const ck = cacheKey(storeId, concernNorm);
    const cached = await readCache(storeId, ck, cacheEpoch);
    if (cached) {
      let shaped = clampCachedPayload(cached, guard);
      shaped = transformToBasicIfNeeded(shaped, guard);
      return res.json({
        ...shaped,
        source: "cache",
        cacheHit: true,
        limitMessage: guard?.message || null,
        tookMs: Date.now() - started,
      });
    }

    // Embedding retrieval
    const [qVec, allEmb] = await Promise.all([embedText(concern), loadEmbeddings(storeId)]);
    if (!allEmb.length || !qVec.length) {
      return res.json({
        productIds: [],
        products: [],
        explanation: "Your product knowledge is still building for this store. Try again shortly.",
        followUps: [],
        awesome: null,
        source: "no-vectors",
        tookMs: Date.now() - started,
      });
    }

    // Top-60 by cosine
    const scored = allEmb
      .map(e => ({ id: e.id, sim: cosine(qVec, e.vector || []) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 60);

    const top60Ids = scored.map(s => s.id);
    const top60Docs = await loadProductsByIds(storeId, top60Ids);

    // Map id → doc + cosine
    const byId = new Map();
    for (const s of scored) byId.set(String(s.id), s.sim);
    const constraints = detectConstraints(concernNorm);

    // Hard allergen filter (EO) when asked to avoid fragrance/EO/sensitive
    const filtered = [];
    for (const p of top60Docs) {
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
    const maxByPlan = Math.max(3, Math.min(guard?.trim?.maxProducts ?? 12, 40));
    const finalists = filtered.slice(0, maxByPlan).map(x => x.p);
    const finalistsSet = new Set(finalists.map(p => String(p.id)));

    // Compact shape for prompt
    function compactForPrompt(p) {
      const ben = Array.isArray(p.benefitsNormalized) ? p.benefitsNormalized : (Array.isArray(p.benefits) ? p.benefits : []);
      const con = Array.isArray(p.concernsNormalized) ? p.concernsNormalized : (Array.isArray(p.concerns) ? p.concerns : []);
      const ing = Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized : (Array.isArray(p.ingredients) ? p.ingredients : []);
      const pt = p.productType_norm || p.productTypeNormalized || p.productType || "";
      const step = p.usageStep || p.step || "";

      const stripHtmlLocal = (s = "") => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      const capLocal = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

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
        benefitsNormalized: ben.slice(0, 12),
        concernsNormalized: con.slice(0, 12),
        ingredientsNormalized: ing.slice(0, 12),
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 12)
          : (typeof p.tags === "string" ? p.tags.split(",").map(t => t.trim()).slice(0, 12) : []),
        keywords: Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized.slice(0, 12)
          : (Array.isArray(p.keywords) ? p.keywords.slice(0, 12) : []),
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

    const ingSlugs = await expandConcernToIngredients(concernNorm);
    const ingredientFacts = await getIngredientFacts(ingSlugs);

    const prompt1 = buildGeminiPrompt({
      concern,
      normalizedConcern: concernNorm,
      category,
      tone,
      products: forStage1,
      ingredientFacts,
    });

    const prompt2 = needWiden
      ? buildGeminiPrompt({ concern, normalizedConcern: concernNorm, category, tone, products: forStage2, ingredientFacts })
      : null;

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

      return res.json({
        productIds: fallbackIds,
        products,
        explanation: guard?.message || "Here are the strongest matches from the catalogue while the assistant warms up.",
        followUps: [],
        awesome: null,
        source: "gemini-fallback",
        tookMs: Date.now() - started,
        limitMessage: guard?.message || null,
        __debug: { raced, llmMs, budgetMs: LLM_BUDGET_MS, candidateCount: finalists.length, validator: "fail", rawHead, attempts },
      });
    }

    const allow = finalistsSet;
    let outIds = vr.value.productIds.filter((id) => allow.has(String(id)));
    if (!outIds.length) outIds = finalists.slice(0, 3).map((p) => String(p.id));

    const enrichedDocs = await loadProductsByIds(storeId, outIds);
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

    const payload = {
      productIds: outIds,
      products,
      explanation:
        (vr.value?.explanation?.oneLiner || vr.value?.copy?.why || "Here are the strongest matches for your concern.").trim(),
      followUps: [],
      awesome: {
        primary: vr.value.primary,
        alternatives: vr.value.alternatives,
        explanation: vr.value.explanation,
        copy: vr.value.copy,
        productIds: outIds,
      },
      copy: vr.value.copy || { why: "", rationale: "", extras: "" },
      reasonsById,
      tookMs: Date.now() - started,
      source: "gemini",
      limitMessage: guard?.message || null,
      __debug: { raced, llmMs, budgetMs: LLM_BUDGET_MS, candidateCount: finalists.length, validator: "ok", rawHead, attempts },
    };

    try { await writeCache(storeId, ck, payload, cacheEpoch); } catch (_) {}

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

      const isPro = lvlA === "pro" || lvlB === "pro" || longFormOff || proLikeTrims;
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
