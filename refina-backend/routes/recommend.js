// refina-backend/routes/recommend.js
// Thin adapter with embeddings via REST (vectors) and generation via SDK (strict JSON).
// Adds: two-stage generation (fast), hard latency cap, and a 7d cache.

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


// ─── Utils ───────────────────────────────────────────────────────────────────
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

// ─── Embeddings (REST) ───────────────────────────────────────────────────────
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
  const cap = strictness === "strict" ? 60 : strictness === "relaxed" ? 200 : 120;
  return scored.slice(0, cap);
}

// ─── Cache (7d TTL; version + epoch invalidation) ────────────────────────────
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

// ─── Router ──────────────────────────────────────────────────────────────────
const router = express.Router();
// --- Admin probe (safe, optional token) --------------------------------------
// GET /apps/refina/v1/admin/ai-ping
router.get("/admin/ai-ping", async (req, res) => {
  try {
    // Optional lightweight guard: require header if ADMIN_PROBE_TOKEN is set
    const need = process.env.ADMIN_PROBE_TOKEN;
    if (need && req.header("x-probe-token") !== need) {
      // Don’t reveal it exists
      return res.status(404).end();
    }

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

    // Keep prompt tight: top 8 for stage 1
    const candidates = shortlistCandidates(allEmb, qVec, strictness).slice(0, 6);
    const candidateIds = candidates.map((c) => c.id);
    const candidateDocs = await loadProductsByIds(storeId, candidateIds);

    const stripHtml = (s = "") => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const cap = (s, n = 220) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

    const promptProducts = candidateDocs.map((p) =>
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
          category: p.categoryNormalized || p.category || "",
          keywords: Array.isArray(p.keywords) ? p.keywords : [],
          keywordsNormalized: Array.isArray(p.keywordsNormalized) ? p.keywordsNormalized : [],
        },
        [
          "id",
          "name",
          "description",
          "tags",
          "productType",
          "productType_norm",
          "category",
          "keywords",
          "keywordsNormalized",
        ]
      )
    );

    const ingSlugs = await expandConcernToIngredients(concernNorm);
    const ingredientFacts = await getIngredientFacts(ingSlugs);

    const prompt = buildGeminiPrompt({
      concern,
      normalizedConcern: concernNorm,
      category,
      tone,
      products: promptProducts,
      ingredientFacts,
    });

    // ── Two-stage generation within 12s budget ───────────────────────────────
    let raw = null;
    let rawHead = null;

    // Stage 1: flash, 7s, 8 products, ~320 toks
    try {
      raced = true;
      const stage1Budget = 9000;
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

    // If invalid or absent, Stage 2: tiny retry, remaining budget, 4 products, 256 toks
    let vr = validateConciergeResponse(raw);
    if (!vr.ok) {
      try {
        const remaining = Math.max(0, LLM_BUDGET_MS - llmMs);
        if (remaining > 600) {
          const promptProductsTiny = promptProducts.slice(0, 3);
          const promptTiny = buildGeminiPrompt({
            concern,
            normalizedConcern: concernNorm,
            category,
            tone,
            products: promptProductsTiny,
            ingredientFacts,
          });
          const t1 = Date.now();
          const p2 = callGemini(promptTiny, {
            model: "gemini-2.5-flash",
            temperature: 0.3,
            topP: 0.8,
            maxOutputTokens: 192,
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

    // ── Validation & fallback ────────────────────────────────────────────────
    if (!vr.ok) {
      const fallbackIds = candidateDocs.slice(0, 6).map((p) => String(p.id));
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
          candidateCount: candidateDocs.length,
          validator: "fail",
          rawHead,
          attempts,
        },
      });
    }

    // Enforce candidate allowlist
    const allow = new Set(candidateDocs.map((p) => String(p.id)));
    const productIds = vr.value.productIds.filter((id) => allow.has(String(id)));
    if (!productIds.length) {
      const fallbackIds = candidateDocs.slice(0, 6).map((p) => String(p.id));
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
        explanation: "Here are the strongest matches from the catalogue.",
        followUps: [],
        awesome: null,
        source: "no-allowed-ids-fallback",
        tookMs: Date.now() - started,
        __debug: {
          raced,
          llmMs,
          budgetMs: LLM_BUDGET_MS,
          candidateCount: candidateDocs.length,
          validator: "ok-but-out-of-corpus",
          attempts,
        },
      });
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
        candidateCount: candidateDocs.length,
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
