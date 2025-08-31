// refina-backend/bff/ai/buildGeminiPrompt.js
// ESM module. Builds a single prompt string for Gemini in JSON mode.
// No-bullets edition: requires plain sentences only.

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function shorten(text = "", max = 280) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
function productToCompact(p) {
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

  const ingNorm =
    (Array.isArray(p.ingredientsNormalized) && p.ingredientsNormalized) ||
    (Array.isArray(p.ingredients_norm) && p.ingredients_norm) ||
    null;

  const kwNorm =
    (Array.isArray(p.keywordsNormalized) && p.keywordsNormalized) ||
    (Array.isArray(p.keywords_norm) && p.keywords_norm) ||
    null;

  return {
    id: p.id,
    name,
    descriptionShort: shorten(stripHtml(p.description || p.body_html || ""), 280),
    tags: Array.isArray(p.tags)
      ? p.tags.slice(0, 12)
      : (typeof p.tags === "string" ? p.tags.split(",").map((t) => t.trim()).slice(0, 12) : []),
    keywords: (kwNorm || (Array.isArray(p.keywords) ? p.keywords : [])).slice(0, 12),
    ingredients: (ingNorm || (Array.isArray(p.ingredients) ? p.ingredients : [])).slice(0, 12),
    productType: p.productType || "",
    productType_norm: productTypeNormalized,
    usageStep,
    benefits,
    concerns,
    audience,
    category: p.categoryNormalized || p.category || "",
    price: p.price ?? p.minPrice ?? undefined
  };
}

export function formatIngredientFacts(factsObj = {}) {
  const lines = [];
  for (const [slug, f] of Object.entries(factsObj)) {
    if (!f) continue;
    const synonyms = (f.synonyms || []).join(", ");
    const syn = synonyms ? ` (aka: ${synonyms})` : "";
    const benefits = f.benefits ? ` — benefits: ${f.benefits}` : "";
    const cautions = f.cautions ? ` — cautions: ${f.cautions}` : "";
    lines.push(`- ${f.name || slug}${syn}${benefits}${cautions}`);
  }
  return lines.join("\n").slice(0, 1800);
}

/**
 * Build the Gemini prompt used by the BFF.
 * Caller API unchanged: { concern, category, tone, products, normalizedConcern?, constraints?, rankMode?, routineMode?, ingredientFacts? }
 */
export function buildGeminiPrompt({
  concern,
  category,
  tone,
  products,
  normalizedConcern = "",
  constraints = {},      // { avoidFragrance?, vegan?, glutenFree?, crueltyFree?, budgetMin?, budgetMax?, notes? }
  rankMode = "relevant", // "relevant" | "rated" | "popular"
  routineMode = false,   // AM/PM guidance if true
  ingredientFacts = {}
}) {
  const compact = (Array.isArray(products) ? products : [])
    .slice(0, 120)
    .map(productToCompact);

  const middleWord = /beauty|skin|hair|cosmetic/i.test(String(category || ""))
    ? "ingredients"
    : "features";

  const toneText = String(tone || "confident expert");
  const toneHint = /bestie/i.test(toneText)
    ? "Use a warm, friendly 'smart bestie' tone while staying precise."
    : "Use a confident, compact expert tone—friendly but no fluff.";

  const rankLabel =
    rankMode === "rated" ? "highest rated"
    : rankMode === "popular" ? "most popular"
    : "most relevant";

  const constraintLines = [];
  if (constraints.avoidFragrance) constraintLines.push("- Prefer fragrance-free when sensitivity/irritation is implied.");
  if (constraints.vegan)          constraintLines.push("- Prefer vegan options when alternatives exist.");
  if (constraints.glutenFree)     constraintLines.push("- Prefer gluten-free when relevant.");
  if (constraints.crueltyFree)    constraintLines.push("- Prefer cruelty-free when relevant.");
  if (constraints.budgetMin != null || constraints.budgetMax != null) {
    const min = constraints.budgetMin != null ? `$${constraints.budgetMin}` : "";
    const max = constraints.budgetMax != null ? `$${constraints.budgetMax}` : "";
    constraintLines.push(`- Consider budget range ${min}${min && max ? "–" : ""}${max}.`);
  }
  if (constraints.notes) constraintLines.push(`- Notes: ${String(constraints.notes)}`);

  return `
You are Refina, a thoughtful, precise shopping concierge for a ${String(category || "retail")} Shopify store.
Language: Australian English. No hedging or hype. Plain sentences only. Do not use bullet points, numbered lists, dashes, or emojis anywhere.

CUSTOMER CONCERN (raw): ${String(concern || "").trim()}
${normalizedConcern ? `CUSTOMER CONCERN (normalized): ${normalizedConcern}` : ""}

${constraintLines.length ? `CONSTRAINTS:\n${constraintLines.join("\n")}` : ""}

You have a candidate set of store products (JSON array). Consider only these:
${JSON.stringify(compact, null, 2)}

Selection rubric (priority order):
1) Match the requested type/routine step when present (productType_norm or usageStep).
2) Address the customer’s concern(s) and relevant audience (e.g., skin/hair type, sensitivity, age if provided).
3) Support picks with concrete ${middleWord}/benefits; corroborate with tags/keywords/description.
4) Prefer fewer, higher-confidence picks; do not force weak matches. Do not invent products or facts.

Behaviour rules:
- ${toneHint}
- Speak directly to “you”. Original phrasing only (do not quote product text).
- If nothing is a strong fit, return the closest 1–3 items and state they are “closest matches” in the explanation (neutral tone; no apologies).
- Avoid irrelevant categories (e.g., hair/body items for facial concerns unless explicitly relevant).
- Only mention “free-from” or ingredient absence if the product data supports it.
- Output STRICT JSON only (no markdown/backticks, no commentary). No list characters in any field.

Rank mode: ${rankLabel}
Routine mode: ${routineMode ? "yes — include AM/PM usage guidance" : "no — single-pick acceptable"}

Ingredient facts (compact):
${formatIngredientFacts(ingredientFacts)}

RESPONSE JSON SCHEMA (STRICT):
{
  "primary": {
    "id": "<productId-from-candidates>",
    "score": 0.0,
    "rationale": "One sentence explaining why this specific product fits the concern (no bullets).",
    "howToUse": "One short sentence with a practical tip (AM/PM, water temp, amount).",
    "tagsMatched": ["match1", "match2"]
  },
  "alternatives": [
    {
      "id": "<altId-from-candidates>",
      "when": "budget | sensitive | premium | lighter texture",
      "rationale": "One sentence explaining when you’d pick this instead (no bullets)."
    }
  ],
  "explanation": {
    "oneLiner": "A single sentence opener tailored to the concern (no bullets).",
    "conciergeBlurb": "A short paragraph (2–4 sentences) explaining why these picks suit the concern, linking ${middleWord} or format → benefit → outcome. Mention exclusions only if grounded.",
    "usageNote": "A short paragraph (1–2 sentences) with simple usage advice (e.g., lukewarm water, massage 20–30 seconds, pat dry)."
  },

  "productIds": ["<primary.id>", "<alt1.id>", "<alt2.id>"],

  "reasonsById": { "<productId>": "One-sentence product-specific rationale, plain text.", "...": "..." },

  "copy": {
    "why": "<explanation.oneLiner>",
    "rationale": "<explanation.conciergeBlurb>",
    "extras": "<explanation.usageNote>"
  },

  "scoresById":  { "<productId>": 0.0 }
}
`.trim();
}
