// refina-backend/routes/recommend.js
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import admin from "firebase-admin";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// --- Firebase Admin init (reuse app if already initialized) ---
function ensureFirebase() {
  if (admin.apps.length) return admin.app();
  // Prefer GOOGLE_APPLICATION_CREDENTIALS. Fallback to local service-account.
  const credsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "secure", "service-account.json");

  const json = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(json) });
  return admin.app();
}
ensureFirebase();
const db = getFirestore();

// --- Gemini init (server-side key) ---
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
if (!GEMINI_KEY) {
  console.warn("⚠️ GEMINI_API_KEY not set. /api/recommend will fall back to empty results.");
}
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- Lightweight prompt builder (server copy) ---
function buildGeminiPrompt({ concern, category, tone, products }) {
  return `
You are a smart, helpful product concierge for a Shopify store in the "${category}" category. Your tone is: ${tone}.

The customer has asked for help with:
"${concern}"

You have access to the following list of products, where each product includes:
{
  id: string,
  name: string,
  description: string,
  tags: string[],
  productType: string,
  category: string,
  keywords: string[],
  ingredients: string[]
}

👉 Prioritize selection using:
1) productType alignment (e.g., "lipstick", "cleanser")
2) the user's concern (e.g., "dry lips", "oily skin")
3) supporting keywords
4) effective ingredients
5) confirm via description or tags

Select up to 5 of the most relevant products from the list below:
${JSON.stringify(products)}
`.trim();
}

// --- JSON contract (Option B: scored matches) ---
const CONTRACT = `
Return ONLY JSON with this exact schema and no extra text:
{
  "scoredMatches": [
    { "id": "<id-or-exact-name-from-products>", "score": 0.0-1.0, "reason": "short, specific justification" }
  ],
  "explanation": "1–2 sentences summarizing the picks",
  "followUps": ["<optional short follow-up prompts>"]
}
Rules:
- Pick 1–3 items MAX from the provided "products" list ONLY.
- "id" MUST be taken from the provided products' "id" or exact "name".
- "score" must be between 0.0 and 1.0. Higher = better fit for the concern.
- "reason" should reference type/benefits/ingredients/concerns (store inventory only).
- If nothing fits, return an empty array for "scoredMatches".
`.trim();

// --- Helpers ---
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}
function cosine(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}
function lc(x) {
  return String(x || "").toLowerCase().trim();
}
function pick(obj, keys) {
  const o = {};
  keys.forEach((k) => (o[k] = obj[k]));
  return o;
}

// --- Core retrieval ---
async function embedText(text) {
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const res = await model.embedContent(text);
  return res.embedding.values;
}

async function loadEmbeddings(storeId) {
  const snap = await db.collection("productEmbeddings").doc(storeId).collection("items").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadProductsByIds(storeId, ids) {
  if (!ids.length) return [];
  const col = db.collection("products").doc(storeId).collection("items");
  const out = [];
  // Firestore can't query by an array of arbitrary IDs efficiently; fetch individually (N is small after topK)
  for (const id of ids) {
    const ref = col.doc(id);
    const snap = await ref.get();
    if (snap.exists) out.push({ id: snap.id, ...snap.data() });
  }
  return out;
}

// --- Domain/type bias using normalized metadata stored with embeddings (meta.*) ---
function biasAndFilter(candidates, concernLC) {
  const wantsBody = /\b(body|bath|kp|keratosis)\b/.test(concernLC);
  const wantsHair = /\bhair|scalp|shampoo|conditioner|frizz|curl\b/.test(concernLC);
  const wantsLipstick = /\blipstick\b/.test(concernLC);
  const wantsMoisturizer = /\bmoisturi[sz]er|moisturi[sz]e|cream|lotion\b/.test(concernLC);

  // First: optional domain bias
  let pool = candidates;
  if (wantsHair) {
    const hair = candidates.filter((c) => lc(c.meta?.domain) === "haircare");
    if (hair.length >= 3) pool = hair;
  } else if (wantsBody) {
    const body = candidates.filter((c) => lc(c.meta?.domain) === "body-bath");
    if (body.length >= 3) pool = body;
  }

  // Second: productType narrowing (only if we still have options)
  const narrowed = pool.filter((c) => {
    const t = lc(c.meta?.productTypeNorm);
    if (wantsLipstick) return t.includes("lipstick");
    if (wantsMoisturizer) return t.includes("moistur");
    return true;
  });

  return narrowed.length >= 3 ? narrowed : pool;
}

// --- Router ---
const router = express.Router();

/**
 * POST /api/recommend
 * body: { storeId, concern, userContext? }
 */
router.post("/recommend", async (req, res) => {
  try {
    if (!genAI) return res.json({ productIds: [], explanation: "", followUps: [], reasonsById: {}, scoresById: {}, matches: [] });

    const { storeId, concern } = req.body || {};
    if (!storeId || !concern) {
      return res.status(400).json({ error: "storeId and concern are required." });
    }

    // Load settings for category/tone
    const settingsSnap = await db.collection("storeSettings").doc(storeId).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const category = settings?.category || "Beauty";
    const tone = settings?.tone || "Helpful, expert, friendly";
    const strictness = settings?.aiControls?.promptStrictness || "balanced";

    // 1) Vector retrieval
    const [qVec, allEmb] = await Promise.all([embedText(concern), loadEmbeddings(storeId)]);
    const scored = allEmb
      .map((e) => ({ ...e, sim: cosine(qVec, e.vector || []) }))
      .sort((a, b) => b.sim - a.sim);

    // Cap by strictness (60/120/200)
    const cap = strictness === "strict" ? 60 : strictness === "relaxed" ? 200 : 120;

    // Optional domain/type bias
    const biased = biasAndFilter(scored, lc(concern)).slice(0, cap);

    // Load product docs for these candidates
    const productIds = biased.map((b) => b.id);
    const products = await loadProductsByIds(storeId, productIds);

    // Shape down for prompt (id, name, description, tags, productType, category, keywords, ingredients)
    const promptProducts = products.map((p) =>
      pick(
        {
          id: p.id || p.name,
          name: p.name,
          description: p.description || "",
          tags: p.tags || [],
          productType: p.productType || "",
          category: p.category || "",
          keywords: p.keywords || [],
          ingredients: p.ingredients || [],
        },
        ["id", "name", "description", "tags", "productType", "category", "keywords", "ingredients"]
      )
    );

    // 2) Gemini ranking
    const promptBody = buildGeminiPrompt({ concern, category, tone, products: promptProducts });
    const finalPrompt = `${promptBody}\n\n${CONTRACT}`.trim();
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-1.5-flash-lite", generationConfig: { responseMimeType: "application/json" } });
    const result = await model.generateContent(finalPrompt);
    const raw = result.response.text().trim();

    // Parse JSON (sometimes models return fences, sometimes not)
    const json = (() => {
      try { return JSON.parse(raw); } catch {}
      const m = raw.match(/```json([\s\S]*?)```/i);
      if (m) return JSON.parse(m[1]);
      throw new Error("Gemini returned non-JSON");
    })();

    // 3) Normalize results to {productIds, reasonsById, scoresById, matches}
    const allow = new Map();
    for (const p of promptProducts) {
      const canon = String(p.id || p.name || "").trim();
      if (!canon) continue;
      allow.set(lc(canon), canon);
      if (p.name) allow.set(lc(p.name), canon);
    }

    const picked = Array.isArray(json.scoredMatches)
      ? json.scoredMatches
          .map((m) => ({
            id: String(m.id || "").trim(),
            score: Math.max(0, Math.min(1, Number(m.score || 0))),
            reason: String(m.reason || "").trim(),
          }))
          .filter((m) => m.id)
      : [];

    const normalizedIds = (picked.length ? picked.map((m) => m.id) : (json.productIds || []))
      .map((x) => allow.get(lc(x)))
      .filter(Boolean);

    const reasonsById = {};
    const scoresById = {};
    for (const m of picked) {
      const canon = allow.get(lc(m.id));
      if (canon) {
        if (!reasonsById[canon] && m.reason) reasonsById[canon] = m.reason;
        if (scoresById[canon] == null) scoresById[canon] = m.score;
      }
    }

    // Final shape
    const uniqueIds = Array.from(new Set(normalizedIds)).slice(0, 3);
    const matches = uniqueIds.map((id) => ({
      id,
      score: scoresById[id] ?? 0,
      reason: reasonsById[id] || "",
    }));

    return res.json({
      productIds: uniqueIds,
      explanation: String(json.explanation || ""),
      followUps: Array.isArray(json.followUps) ? json.followUps.slice(0, 3) : [],
      reasonsById,
      scoresById,
      matches,
    });
  } catch (err) {
    console.error("❌ /api/recommend error:", err);
    return res.json({
      productIds: [],
      explanation: "",
      followUps: [],
      reasonsById: {},
      scoresById: {},
      matches: [],
      error: "recommend-failed",
    });
  }
});

export default router;
