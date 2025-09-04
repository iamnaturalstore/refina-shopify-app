// refina-backend/bff/ai/buildGeminiPrompt.js - upgraded concierge prompt
// ESM module. Builds a single prompt string for Gemini in JSON mode.
// Supports Knowledge Pack facts, rank/routine modes, and back-compat fields.

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
  const audience = p.audience || {};

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
    price: p.price ?? p.minPrice ?? undefined,
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
  return lines.join("\n").slice(0, 1800); // hard cap
}

export function buildGeminiPrompt({
  concern,
  category,
  tone,
  products,
  normalizedConcern = "",
  constraints = {},
  rankMode = "relevant",
  routineMode = false,
  ingredientFacts = {},
}) {
  const compact = (Array.isArray(products) ? products : []).slice(0, 120).map(productToCompact);
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
  if (constraints.vegan) constraintLines.push("- Prefer vegan options when alternatives exist.");
  if (constraints.glutenFree) constraintLines.push("- Prefer gluten-free when relevant.");
  if (constraints.crueltyFree) constraintLines.push("- Prefer cruelty-free when relevant.");
  if (constraints.budgetMin != null || constraints.budgetMax != null) {
    const min = constraints.budgetMin != null ? `$${constraints.budgetMin}` : "";
    const max = constraints.budgetMax != null ? `$${constraints.budgetMax}` : "";
    constraintLines.push(`- Consider budget range ${min}${min && max ? "–" : ""}${max}.`);
  }
  if (constraints.notes) constraintLines.push(`- Notes: ${String(constraints.notes)}`);

  return `
You are Refina, a thoughtful, precise shopping concierge for a ${String(category || "retail")} Shopify store.
Language: Australian English.
Be specific, ingredient-aware, and concise. Avoid medical claims or diagnoses.

CUSTOMER CONCERN (raw): ${String(concern || "").trim()}
${normalizedConcern ? `CUSTOMER CONCERN (normalized): ${normalizedConcern}` : ""}

${constraintLines.length ? `CONSTRAINTS:\n${constraintLines.join("\n")}` : ""}

You have a candidate set of store products (JSON array).
Consider **only** these:
${JSON.stringify(compact, null, 2)}

Selection rubric (in priority order):
1) Match the requested **type / routine step** when present (productType_norm or usageStep).
2) Address the customer’s **concern(s)** and relevant **audience** (e.g., skin/hair type, age if mentioned).
3) Support your picks with concrete ${middleWord}/benefits; corroborate with tags/keywords/description.
4) Prefer fewer, higher-confidence picks; do not force weak matches. Do not invent products.

- If nothing is a strong fit, choose the closest 1–3 items and say they are “closest matches” for the concern. Do not say there are no products.
- Never recommend searching outside this catalogue and do not apologise. Keep a helpful, neutral tone when confidence is low.
- Write original, benefit-led phrasing (do not quote product text). Speak in second person (“you”). Include concise, actionable how-to steps for the top pick or per routine step.

Rules:
- ${toneHint}
- Base all statements only on provided product fields. No fabrication.
- Avoid irrelevant categories (e.g., hair/body items for facial concerns unless explicitly relevant).
- Return **STRICT JSON only** (no markdown/backticks, no commentary).

Rank mode: ${rankLabel}
Routine mode: ${routineMode ? "yes (AM/PM guidance expected)" : "no (single-pick acceptable)"}

Ingredient facts (curated; brief):
${formatIngredientFacts(ingredientFacts)}

RESPONSE JSON SCHEMA (STRICT):
{
  "primary": {
    "id": "<productId-from-candidates>",
    "score": 0.0,
    "reasons": ["short, specific reason 1", "reason 2"],
    "howToUse": ["short step 1", "short step 2"],
    "tagsMatched": ["match1", "match2"]
  },
  "alternatives": [
    {
      "id": "<altId-from-candidates>",
      "when": "budget | sensitive | premium | lighter texture",
      "reasons": ["short, concrete reason"]
    }
  ],
  "explanation": {
    "oneLiner": "Warm, friendly one-sentence summary tailored to the concern.",
    "friendlyParagraph": "3–4 sentences in our concierge voice explaining *why this fits you*.",
    "expertBullets": ["Ingredient rationale 1", "Rationale 2"],
    "usageTips": ["AM/PM tip", "Layering tip"]
  },

  "productIds": ["<primary.id>", "<alt1.id>", "<alt2.id>"],
  "copy": {
    "why": "Use explanation.friendlyParagraph or oneLiner.",
    "rationale": "Join expertBullets into a compact rationale.",
    "extras": "Join usageTips or provide sensible usage guidance."
  }
}
`.trim();
}