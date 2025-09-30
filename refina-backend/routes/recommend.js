// refina-backend/routes/recommend.js
// Thin adapter with embeddings via SDK (lazy-init; no module-scope client).

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
function lc(x) { return String(x || "").toLowerCase().trim(); }
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
// Lazy-init embeddings client at call time to avoid env timing issues
async function embedText(text) {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";
  if (!apiKey) {
    console.warn("[Embeddings] API Key is missing. Skipping embedding.");
    return []; 
  }

  // Manually construct the correct, stable v1 URL. This bypasses any SDK defaults.
  const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${apiKey}`;

  const body = {
    model: "models/text-embedding-004",
    content: {
      parts: [{ text: String(text || "") }],
    },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("[Embeddings] HTTP Error:", resp.status, errorText);
      return [];
    }

    const data = await resp.json();
    return data?.embedding?.values || [];

  } catch (e) {
    console.error("[Embeddings] Fetch Error:", e.message);
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

// ─── Router ──────────────────────────────────────────────────────────────────
const router = express.Router();

router.post("/recommend", async (req, res) => {
  const started = Date.now();
  try {
    const LLM_BUDGET_MS = 12000; // cap concierge latency so UI never stalls
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
      });
    }

    const candidates = shortlistCandidates(allEmb, qVec, strictness).slice(0, 16); // keep prompt small
    const candidateIds = candidates.map((c) => c.id);
    const candidateDocs = await loadProductsByIds(storeId, candidateIds);

    // keep fields minimal & strip HTML/long text
    const stripHtml = (s="") => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const cap = (s, n=400) => (s.length > n ? s.slice(0, n-1) + "…" : s);
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
          // Keep the rest minimal to reduce tokens; the concierge schema doesn't need HTML or pricing here
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

// Call Gemini via SDK with strict JSON contract + schema, and a tight budget
    // Hard-cap the LLM call via Promise.race (don’t rely on SDK timeout)
    let raw = null;
    try {
      const llmPromise = callGemini(prompt, {
        model: process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash",
        temperature: 0.7,
        topP: 0.95,
        maxOutputTokens: 512,
        responseSchema: ConciergeResponseSchema, // strict shape
        // NOTE: do NOT pass a timeout here; race will enforce the 12s cap
      });
      raw = await Promise.race([
        llmPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("llm_timeout")), LLM_BUDGET_MS)),
      ]);
    } catch {
      raw = null; // fall back below
    }

// Validate & coerce to Awesome
const vr = validateConciergeResponse(raw);
if (!vr.ok) {
  // Soft failure: return useful fallback based on retrieval
    const fallbackIds = candidateDocs.slice(0, 6).map(p => String(p.id));
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
    });
   }

// Enforce candidate allowlist (IDs must be within candidateDocs)
const allow = new Set(candidateDocs.map((p) => String(p.id)));
const productIds = vr.value.productIds.filter((id) => allow.has(String(id)));
if (!productIds.length) {
  // Fallback to top retrieved if the LLM picked out-of-corpus IDs
    const fallbackIds = candidateDocs.slice(0, 6).map(p => String(p.id));
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

// Return FULL awesome payload + legacy fields the UI already reads
return res.json({
  productIds,
  products,
  // Legacy single-string explanation for old UI; prefer awesome.explanation in new UI
  explanation: (vr.value?.explanation?.oneLiner || vr.value?.copy?.why || "Here are the strongest matches for your concern.").trim(),
  followUps: [],

  // The Awesome block (use these on the UI for the full experience)
  awesome: {
    primary: vr.value.primary,
    alternatives: vr.value.alternatives,
    explanation: vr.value.explanation,
    copy: vr.value.copy,
    productIds
  },

  tookMs: Date.now() - started,
  source: "gemini"
});

  } catch (err) {
    console.error("❌ /api/recommend error:", err);
    return res.json({
      productIds: [],
      products: [],
      explanation: "",
      followUps: [],
      source: "error",
    });
  }
});

export default router;
