// refina-backend/routes/recommend.js
// Thin adapter with embeddings via REST (vectors) and generation via SDK (strict JSON).
// Adds: broader retrieval (Top-60), KB filtering/scoring, EO hard filter,
// two-stage generation (8→12), hard latency cap, 7d cache, and ID-mapping safety.

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
} from "../bff/lib/knowledge.js";
import { callGemini } from "../bff/ai/gemini.js";

// ─────────────────────────────────────────────────────────────
// Admin ping schema (keep SDK JSON-mode honest)
// ─────────────────────────────────────────────────────────────
const PingSchema = {
  type: "OBJECT",
  properties: { ok: { type: "BOOLEAN" } },
  required: ["ok"],
};

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────
function dot(a, b) { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); }
function cosine(a, b) { const na = norm(a), nb = norm(b); if (!na || !nb) return 0; return dot(a, b) / (na * nb); }
function pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return o; }

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

// ─────────────────────────────────────────────────────────────
// Embeddings (REST)
// ─────────────────────────────────────────────────────────────
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

function shortlistCandidates(embeds, qVec, strictness) {
  const scored = embeds
    .map((e) => ({ ...e, sim: cosine(qVec, e.vector || []) }))
    .sort((a, b) => b.sim - a.sim);
  // Note: we’ll take Top-60 from this downstream regardless of strictness.
  const cap = strictness === "strict" ? 60 : strictness === "relaxed" ? 200 : 120;
  return scored.slice(0, cap);
}

// ─────────────────────────────────────────────────────────────
// Cache (7d TTL; version + epoch invalidation)
// ─────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = "concierge-v1";

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
// Constraint detection + EO denylist + rule scoring
// ─────────────────────────────────────────────────────────────
const EO_SLUGS = [
  // common essentials (normalized slugs you store in ingredientsNormalized)
  "lavandula", "citrus", "citrus-limon", "citrus-aurantium", "mentha",
  "eucalyptus", "melaleuca", "tea-tree", "cinnamomum", "rosmarinus",
  "salvia", "pelargonium", "ylang", "ylang-ylang", "cedrus", "pinus",
  "cananga", "bergamot", "lemongrass", "citral", "citronellol", "linalool",
];

function detectConstraints(normalizedConcern = "") {
  const s = String(normalizedConcern || "").toLowerCase();
  const constraints = {
    avoidEO: /avoid(ing)? essential oils|no essential oils|fragrance[-\s]?free|scent[-\s]?free/.test(s),
    sensitive: /sensitive|reactive|redness|rosacea|irritat/.test(s),
    step: null,
    age: null,
  };
  // step / type hints
  if (/(moisturizer|moisturiser|face[-\s]?cream|night[-\s]?cream|day[-\s]?cream)/.test(s)) constraints.step = "moisturizer";
  else if (/(cleanser|face[-\s]?wash)/.test(s)) constraints.step = "cleanser";
  else if (/(serum|treatment)/.test(s)) constraints.step = "serum";
  else if (/(sunscreen|spf)/.test(s)) constraints.step = "spf";

  // age (simple pickup)
  const ageMatch = s.match(/\b(1[6-9]|[2-9]\d|1\d{2})\b/);
  if (ageMatch) constraints.age = Number(ageMatch[0]);

  return constraints;
}

function hasEOAllergen(prod) {
  const ings = Array.isArray(prod?.ingredientsNormalized)
    ? prod.ingredientsNormalized.map(x => String(x || "").toLowerCase())
    : [];
  return ings.some(slug => EO_SLUGS.includes(slug));
}

function overlapCount(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a.map(x => String(x).toLowerCase()));
  let n = 0;
  for (const y of b) if (A.has(String(y).toLowerCase())) n++;
  return n;
}

function ruleScore(prod, constraints, concernTokens) {
  let score = 0;

  // type/step match
  const typeNorm = (prod.productType_norm || prod.productTypeNormalized || "").toLowerCase();
  const step = (prod.usageStep || "").toLowerCase();
  if (constraints.step) {
    if (typeNorm.includes(constraints.step)) score += 1.0;
    else if (step.includes(constraints.step)) score += 0.8;
  }

  // concern/benefit overlap
  const benefits = Array.isArray(prod.benefitsNormalized) ? prod.benefitsNormalized : (Array.isArray(prod.benefits) ? prod.benefits : []);
  const concerns = Array.isArray(prod.concernsNormalized) ? prod.concernsNormalized : (Array.isArray(prod.concerns) ? prod.concerns : []);
  const cbHits = overlapCount(benefits, concernTokens) + overlapCount(concerns, concernTokens);
  score += Math.min(2.0, cbHits * 0.5);

  // audience fit (sensitive skin etc.)
  if (constraints.sensitive) {
    const aud = prod.audience || {};
    const skinType = String(aud.skinType || aud.skintype || "").toLowerCase();
    if (skinType.includes("sensitive") || overlapCount(concerns, ["sensitive", "redness"]) > 0) score += 0.5;
  }

  // EO penalty (hard filter is applied elsewhere when avoidEO=true; here a soft penalty for general asks)
  if (!constraints.avoidEO && hasEOAllergen(prod)) score -= 0.2;

  // normalize to 0..1-ish clamp
  return Math.max(0, Math.min(1, score / 3.5));
}

// ─────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────
const router = express.Router();

// Admin probe (safe, optional token)
// GET /apps/refina/v1/admin/ai-ping
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

router.post("/recommend", async (req, res) => {
  const started = Date.now();
  const LLM_BUDGET_MS = 12000; // hard cap so UI never stalls
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
    const cacheEpoch = settings?.cacheEpoch || null; // bump to invalidate cache

    // CACHE CHECK
    const concernNorm = normConcern(concern);
    const ck = cacheKey(storeId, concernNorm);
    const cached = await readCache(storeId, ck, cacheEpoch);
    if (cached) {
      return res.json({
        ...cached,
        source: "cache",
        cacheHit: true,
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

    // ─────────────────────────────────────────────────────────
    // Broader retrieval: Top-60 by cosine
    // ─────────────────────────────────────────────────────────
    const vectorRanked = allEmb
      .map(e => ({ id: e.id, sim: cosine(qVec, e.vector || []) }))
      .sort((a, b) => b.sim - a.sim);
    const top60 = vectorRanked.slice(0, 60);
    const top60Ids = top60.map(x => x.id);
    const top60Docs = await loadProductsByIds(storeId, top60Ids);

    // Constraint detection
    const constraints = detectConstraints(concernNorm);

    // Tokenize normalized concern for overlap checks
    const concernTokens = String(concernNorm || "")
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter(Boolean);

    // Hard filter allergens if avoidEO
    const filtered = constraints.avoidEO
      ? top60Docs.filter(p => !hasEOAllergen(p))
      : top60Docs.slice();

    // Score by KB rules + cosine
    const simMap = new Map(top60.map(x => [String(x.id), x.sim]));
    const scored = filtered.map(p => {
      const rs = ruleScore(p, constraints, concernTokens);
      const sim = simMap.get(String(p.id)) || 0;
      const finalScore = 0.7 * sim + 0.3 * rs;
      return { p, rs, sim, finalScore };
    }).sort((a, b) => b.finalScore - a.finalScore);

    // Finalists: Top-12 (Stage-1 sees 8; Stage-2 may widen to 12)
    const finalists = scored.slice(0, 12).map(x => x.p);
    const finalistsIds = finalists.map(p => String(p.id));

    if (!finalists.length) {
      // Nothing after filters → quick vector fallback (top 6 by sim)
      const fallbackIds = vectorRanked.slice(0, 6).map(x => String(x.id));
      const enrichedFallback = await loadProductsByIds(storeId, fallbackIds);
      const products = enrichedFallback.map((p) => {
        const title = p.title || p.name || "";
        const price = p.price != null ? p.price : undefined;
        const price_formatted = p.price_formatted || p.priceFormatted || undefined;
        let urlCandidate = p.url || (p.handle ? `/products/${p.handle}` : "");
        if (!urlCandidate && p.path) urlCandidate = p.path;
        const url = ensureAbsolute(urlCandidate, storeId);
        const image = pickPrimaryImage(p, storeId);
        return {
          id: p.id,
          title,
          price,
          ...(price_formatted ? { price_formatted } : {}),
          image,
          image_url: image,
          url,
        };
      });
      return res.json({
        productIds: fallbackIds,
        products,
        explanation: "Here are the strongest matches from the catalogue while the assistant warms up.",
        followUps: [],
        awesome: null,
        source: "gemini-fallback",
        tookMs: Date.now() - started,
        __debug: {
          raced: false, llmMs: 0, budgetMs: LLM_BUDGET_MS,
          candidateCount: 0, validator: "no-finalists",
          attempts: [],
        },
      });
    }

    // Prompt compaction helpers
    const stripHtml = (s = "") => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const cap = (s, n = 220) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

    const compactProducts = (docs) => docs.map((p) =>
      pick(
        {
          id: p.id || p.name,
          name: p.title || p.name,
          description: cap(stripHtml(p.description || p.body_html || "")),
          tags: Array.isArray(p.tags)
            ? p.tags
            : typeof p.tags === "string"
              ? p.tags.split(",").map((t) => t.trim())
              : [],
          productType: p.productType || "",
          productType_norm: p.productType_norm || p.productTypeNormalized || "",
          usageStep: p.usageStep || p.step || "",
          category: p.categoryNormalized || p.category || "",
          keywords: Array.isArray(p.keywords) ? p.keywords : [],
          keywordsNormalized: Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized : [],
          benefitsNormalized: Array.isArray(p.benefitsNormalized) ? p.benefitsNormalized : [],
          concernsNormalized: Array.isArray(p.concernsNormalized) ? p.concernsNormalized : [],
          ingredientsNormalized: Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized : [],
        },
        [
          "id","name","description","tags","productType","productType_norm","usageStep",
          "category","keywords","keywordsNormalized","benefitsNormalized",
          "concernsNormalized","ingredientsNormalized"
        ]
      )
    );

    // Stage-1 set: top 8; Stage-2 may widen to 12 if needed/constraints present
    const stage1Docs = finalists.slice(0, 8);
    const stage2Docs = finalists.slice(0, 12);

    const promptProductsStage1 = compactProducts(stage1Docs);
    const promptProductsStage2 = compactProducts(stage2Docs);

    const ingSlugs = await expandConcernToIngredients(concernNorm);
    const ingredientFacts = await getIngredientFacts(ingSlugs);

    const prompt = buildGeminiPrompt({
      concern,
      normalizedConcern: concernNorm,
      category,
      tone,
      products: promptProductsStage1,
      ingredientFacts,
    });

    // ─────────────────────────────────────────────────────────
    // Two-stage generation within 12s budget
    // ─────────────────────────────────────────────────────────
    let raw = null;
    let rawHead = null;

    // Stage 1: flash
    try {
      raced = true;
      const stage1Budget = 7000; // leave room for stage-2
      const t0 = Date.now();
      const p1 = callGemini(prompt, {
        model: process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash",
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 256,
        responseSchema: ConciergeResponseSchema,
      });
      raw = await Promise.race([
        p1,
        new Promise((_, rej) => setTimeout(() => rej(new Error("llm_timeout_stage1")), stage1Budget)),
      ]);
      const ms = Date.now() - t0;
      llmMs += ms;
      attempts.push({ stage: 1, ok: !!raw, ms });
    } catch (e1) {
      attempts.push({ stage: 1, ok: false, err: String(e1?.message || e1) });
      raw = null;
    }

    // Validate; if invalid, Stage 2: widen to 12 (especially if constraints)
    let vr = validateConciergeResponse(raw);
    if (!vr.ok) {
      try {
        const remaining = Math.max(0, LLM_BUDGET_MS - llmMs);
        if (remaining > 600) {
          const t1 = Date.now();
          const promptWider = buildGeminiPrompt({
            concern,
            normalizedConcern: concernNorm,
            category,
            tone,
            products: promptProductsStage2,
            ingredientFacts,
          });
          const p2 = callGemini(promptWider, {
            model: "gemini-2.5-flash",
            temperature: 0.3,
            topP: 0.8,
            maxOutputTokens: 256,
            responseSchema: ConciergeResponseSchema,
          });
          const raw2 = await Promise.race([
            p2,
            new Promise((_, rej) => setTimeout(() => rej(new Error("llm_timeout_stage2")), remaining)),
          ]);
          const ms2 = Date.now() - t1;
          llmMs += ms2;
          attempts.push({ stage: 2, ok: !!raw2, ms: ms2 });
          if (raw2) {
            raw = raw2;
            vr = validateConciergeResponse(raw2);
          }
        }
      } catch (e2) {
        attempts.push({ stage: 2, ok: false, err: String(e2?.message || e2) });
      }
    }

    if (typeof raw === "string") rawHead = raw.slice(0, 220);

    // ─────────────────────────────────────────────────────────
    // Validation & fallbacks (incl. ID-mapping safety)
    // ─────────────────────────────────────────────────────────
    if (!vr.ok) {
      // Useful fallback based on finalists (top 6)
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
        return {
          id: p.id,
          title,
          price,
          ...(price_formatted ? { price_formatted } : {}),
          image,
          image_url: image,
          url,
        };
      });
      return res.json({
        productIds: fallbackIds,
        products,
        explanation: "Here are the strongest matches from the catalogue while the assistant warms up.",
        followUps: [],
        awesome: null,
        source: "gemini-fallback",
        tookMs: Date.now() - started,
        __debug: {
          raced,
          llmMs,
          budgetMs: LLM_BUDGET_MS,
          candidateCount: finalists.length,
          validator: "fail",
          rawHead,
          attempts,
        },
      });
    }

    // Enforce candidate allowlist; if Gemini picked out-of-set IDs, map prose to our finalists
    const finalistsSet = new Set(finalistsIds);
    let productIds = vr.value.productIds.filter((id) => finalistsSet.has(String(id)));

    if (!productIds.length) {
      // ID-mapping safety: remap prose onto our top finalists
      productIds = finalistsIds.slice(0, 3);
      // Mutate vr.value primary/alternatives IDs to match our finalists (keep prose)
      if (vr.value.primary) vr.value.primary.id = productIds[0] || vr.value.primary.id;
      if (Array.isArray(vr.value.alternatives)) {
        for (let i = 0; i < vr.value.alternatives.length; i++) {
          if (productIds[i + 1]) vr.value.alternatives[i].id = productIds[i + 1];
        }
      }
    }

    // Enrich product docs for UI
    const enrichedDocs = await loadProductsByIds(storeId, productIds);
    const products = enrichedDocs.map((p) => {
      const title = p.title || p.name || "";
      const price = p.price != null ? p.price : undefined;
      const price_formatted = p.price_formatted || p.priceFormatted || undefined;
      let urlCandidate = p.url || (p.handle ? `/products/${p.handle}` : "");
      if (!urlCandidate && p.path) urlCandidate = p.path;
      const url = ensureAbsolute(urlCandidate, storeId);
      const image = pickPrimaryImage(p, storeId);
      return {
        id: p.id,
        title,
        price,
        ...(price_formatted ? { price_formatted } : {}),
        image,
        image_url: image,
        url,
      };
    });

    // Success: full Awesome + legacy explainer
    const payload = {
      productIds,
      products,
      explanation:
        (vr.value?.explanation?.oneLiner || vr.value?.copy?.why || "Here are the strongest matches for your concern.").trim(),
      followUps: [],
      awesome: {
        primary: vr.value.primary,
        alternatives: vr.value.alternatives,
        explanation: vr.value.explanation,
        copy: vr.value.copy,
        productIds,
      },
      tookMs: Date.now() - started,
      source: "gemini",
      __debug: {
        raced,
        llmMs,
        budgetMs: LLM_BUDGET_MS,
        candidateCount: finalists.length,
        validator: "ok",
        rawHead,
        attempts,
      },
    };

    // Write-through cache on success (don’t cache fallbacks)
    try { await writeCache(storeId, ck, payload, cacheEpoch); } catch (_) {}

    return res.json(payload);
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
});

export default router;
