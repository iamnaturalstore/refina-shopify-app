// refina-backend/bff/ai/buildGeminiPrompt.js
// ESM module (matches BFF `import { buildGeminiPrompt } from "./ai/buildGeminiPrompt.js";`)
function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function productToCompact(p) {
  // Normalize common field variations so prompt stays store-agnostic
  const name = p.title || p.name || "";
  const productTypeNormalized =
    p.productType_norm || p.productTypeNormalized || p.productType || "";
  const usageStep = p.usageStep || p.step || "";
  const benefits =
    (Array.isArray(p.benefitsNormalized) && p.benefitsNormalized) ||
    (Array.isArray(p.benefits) && p.benefits) ||
    [];
  const concerns =
    (Array.isArray(p.concernsNormalized) && p.concernsNormalized) ||
    (Array.isArray(p.concerns) && p.concerns) ||
    [];
  const audience = p.audience || {}; // { skinType?, hairType? }

  return {
    id: p.id,
    name,
    description: stripHtml(p.description).slice(0, 700),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 12) : [],
    keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 12) : [],
    ingredients: Array.isArray(p.ingredients) ? p.ingredients.slice(0, 12) : [],
    productType: p.productType || "",
    // normalized facets (preferred when present)
    productType_norm: productTypeNormalized,
    usageStep,
    benefits,
    concerns,
    audience, // { skinType?, hairType? }
    category: p.categoryNormalized || p.category || "",
  };
}

/**
 * Build the Gemini prompt used by the BFF.
 * Returns a single string with:
 *  - store context (category, tone)
 *  - the customer's concern
 *  - compact candidate products (JSON)
 *  - clear selection rubric
 *  - strict JSON response contract (productIds + copy{ why, rationale, extras })
 */
export function buildGeminiPrompt({ concern, category, tone, products }) {
  const compact = products.map(productToCompact);

  // For beauty-like catalogs, call out "ingredients"; otherwise "features"
  const middleWord = /beauty|skin|hair|cosmetic/i.test(String(category || ""))
    ? "ingredients"
    : "features";

  // Bestie vs Expert voice hint (from your original client logic)
  const toneHint = /bestie/i.test(String(tone || ""))
    ? "Use a warm, friendly 'smart bestie' tone while staying precise."
    : "Use a confident, compact expert tone—friendly but no fluff.";

  return `
You are a thoughtful, precise product concierge for a Shopify store.
Category: "${category}"
Tone: "${tone}"

The customer asked for help with:
"${concern}"

You have a small candidate set of store products (JSON array). Consider only these:
${JSON.stringify(compact, null, 2)}

Selection rubric (in priority order):
1) Match the requested **type / routine step** when present (productType_norm or usageStep).
2) Address the customer’s **concern(s)** and relevant **audience** (e.g., skin/hair type, age if mentioned).
3) Support your picks with concrete ${middleWord}/benefits; corroborate with tags/keywords/description.
4) Prefer fewer, higher-confidence picks; do not force weak matches.

Rules:
- ${toneHint}
- Base all statements on the provided product fields only. Do not invent new data.
- Avoid irrelevant categories; if nothing fits, return fewer items or none.
- Return STRICT JSON only (no markdown, no backticks).
- Then generate three short texts for the overall recommendation (store-wide, not per-item):
  1) "why": a friendly-bestie/expert 2–3 sentence reason this selection fits the user's concern.
  2) "rationale": a crisp explanation tying ${middleWord}/evidence to the concern.
  3) "extras": usage tips or added benefits inferred from descriptions; if none, give sensible usage guidance.

Response JSON schema (STRICT):
{
  "productIds": ["id1","id2","..."],   // choose up to 8 ids from the candidates above
  "copy": {
    "why": "string",
    "rationale": "string",
    "extras": "string"
  }
}
`.trim();
}
