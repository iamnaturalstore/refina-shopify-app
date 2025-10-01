// refina-backend/routes/recommend.js
// Thin adapter with embeddings via REST (for vectors) and generation via SDK (strict JSON).

import express from "express";
import { db } from "../bff/lib/firestore.js";
import { buildGeminiPrompt } from "../bff/ai/buildGeminiPrompt.js";
import { ConciergeResponseSchema } from "../ai/jsonSchemas.js";
import { validateConciergeResponse } from "../ai/validateConcierge.js";
import { normConcern, expandConcernToIngredients, getIngredientFacts } from "../bff/lib/knowledge.js";
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

// Embeddings via REST
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

const router = express.Router();

router.post("/recommend", async (req, res) => {
  const started = Date.now();
  const LLM_BUDGET_MS = 12000; // hard cap so UI never stalls
  let raced = false;
  let llmMs = 0;

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

    // Keep prompt tight (12–16) and descriptions small
    const candidates = shortlistCandidates(allEmb, qVec, strictness).slice(0, 12);
    const candidateIds = candidates.map((c) => c.id);
    const candidateDocs = await loadProductsByIds(storeId, candidateIds);

    const stripHtml = (s = "") => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const cap = (s, n = 300) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

    const promptProducts = candidateDocs.map((p) =>
      pick(
        {
          id: p.id || p.name,
          name: p.title || p.name,
          description: cap(stripHtml(p.description || p.body_html || "")),
          tags: Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" ? p.tags.split(",").map((t) => t.trim()) : [],
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

    const concernNorm = normConcern(concern);
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

    // SDK path with strict JSON schema; enforce hard cap via race
    let raw = null;
    try {
      const llmPromise = callGemini(prompt, {
        model: process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash",
        temperature: 0.6,
        topP: 0.9,
        maxOutputTokens: 384,
        responseSchema: ConciergeResponseSchema,
        // do not pass timeout; we enforce via race
      });
      raced = true;
      const t0 = Date.now();
      raw = await Promise.race([
        llmPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("llm_timeout")), LLM_BUDGET_MS)),
      ]);
      llmMs = Date.now() - t0;
    } catch (e) {
      raw = null;
    }

    // Validate & coerce to Awesome
    const vr = validateConciergeResponse(raw);
    if (!vr.ok) {
      // Fallback (useful, with debug so we know why)
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
      const payload = {
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
          rawHead: typeof raw === "string" ? raw.slice(0, 220) : null,
        },
      };
      return res.json(payload);
    }

    // Enforce candidate allowlist (IDs must be within candidateDocs)
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
      const payload = {
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
        },
      };
      return res.json(payload);
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
      explanation: (vr.value?.explanation?.oneLiner || vr.value?.copy?.why || "Here are the strongest matches for your concern.").trim(),
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
      },
    };
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
