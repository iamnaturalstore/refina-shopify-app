// refina-backend/bff/ai/buildGeminiPrompt.js - upgraded concierge prompt
// ESM module. Builds a single prompt string for Gemini in JSON mode.
// Supports Knowledge Pack facts, rank/routine modes, and back-compat fields.

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function shorten(text = "", max = 200) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function tokensFrom(norm = "") {
  return String(norm || "")
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}

function overlapCount(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a.map(x => String(x).toLowerCase()));
  let n = 0;
  for (const y of b) if (A.has(String(y).toLowerCase())) n++;
  return n;
}

function computeTinyFacts(p, constraints = {}, concernTokens = []) {
  const typeNorm = (p.productType_norm || p.productTypeNormalized || p.productType || "").toLowerCase();
  const step = (p.usageStep || p.step || "").toLowerCase();
  const benefitsNorm = Array.isArray(p.benefitsNormalized) ? p.benefitsNormalized : (Array.isArray(p.benefits) ? p.benefits : []);
  const concernsNorm = Array.isArray(p.concernsNormalized) ? p.concernsNormalized : (Array.isArray(p.concerns) ? p.concerns : []);
  const aud = p.audience || {};
  const skinType = String(aud.skinType || aud.skintype || "").toLowerCase();

  const typeMatch = constraints?.step
    ? (typeNorm.includes(constraints.step) || step.includes(constraints.step))
    : false;

  const audienceMatch = constraints?.sensitive
    ? (skinType.includes("sensitive") || overlapCount(concernsNorm, ["sensitive", "redness"]) > 0)
    : false;

  const concernHits = overlapCount(benefitsNorm, concernTokens) + overlapCount(concernsNorm, concernTokens);

  // Prefer server-provided ruleScore if present; otherwise a light local estimate
  let ruleScore = typeof p.ruleScore === "number" ? p.ruleScore : undefined;
  if (ruleScore == null) {
    let s = 0;
    if (typeMatch) s += 1.0;
    if (audienceMatch) s += 0.5;
    s += Math.min(2.0, concernHits * 0.25);
    ruleScore = Math.max(0, Math.min(1, s / 2.5));
  }

  return { typeMatch, audienceMatch, concernHits, ruleScore };
}

function productToCompact(p, constraints = {}, concernTokens = []) {
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

  const tinyFacts = computeTinyFacts(p, constraints, concernTokens);

  return {
    id: p.id,
    name,
    descriptionShort: shorten(stripHtml(p.description || p.body_html || ""), 200),
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
    // normalized faceting fields explicitly present for the model:
    benefitsNormalized: Array.isArray(p.benefitsNormalized) ? p.benefitsNormalized.slice(0, 16) : [],
    concernsNormalized: Array.isArray(p.concernsNormalized) ? p.concernsNormalized.slice(0, 16) : [],
    ingredientsNormalized: Array.isArray(p.ingredientsNormalized) ? p.ingredientsNormalized.slice(0, 16) : [],
    category: p.categoryNormalized || p.category || "",
    price: p.price ?? p.minPrice ?? undefined,

    // compact guidance for the model; these are hints, not hard rules:
    tinyFacts,
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
  const concernTokens = tokensFrom(normalizedConcern);
  const compact = (Array.isArray(products) ? products : [])
    .slice(0, 24)
    .map((p) => productToCompact(p, constraints, concernTokens));

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

    // Optional facts block (kept out of the prompt when empty to save tokens)
  const factsText = formatIngredientFacts(ingredientFacts);
  const factsBlock = factsText
    ? `\nINGREDIENT FACTS (optional; may be empty):\n${factsText}\n`
    : "";

      return `
You are Refina, a thoughtful, precise shopping concierge for a ${String(category || "retail")} Shopify store.
Language: Australian English.
Be specific, ingredient-aware when grounded in candidate fields, and concise. Avoid medical claims or diagnoses.

CUSTOMER CONCERN (raw): ${String(concern || "").trim()}
${normalizedConcern ? `CUSTOMER CONCERN (normalized): ${normalizedConcern}` : ""}

${constraintLines.length ? `CONSTRAINTS:\n${constraintLines.join("\n")}` : ""}

You have a candidate set of store products (JSON array).
Consider ONLY these candidates. Do not invent products, specs, ingredients, claims, reviews, prices, or availability.
${JSON.stringify(compact)}

Selection rubric (in priority order):
1) Match the requested type / routine step when present (productType, usage).
2) Address the customer’s concern(s) and relevant audience (e.g., skin/hair type, age if mentioned).
3) Support your picks with concrete benefits/features from candidate fields (keywords/benefits/ingredients/avoidFlags/usage/productType/tags).
4) Prefer fewer, higher-confidence picks; do not force weak matches.

Behaviour rules:
- ${toneHint}
- Warm, expert, Refina voice. Second person (“you”).
- It is OK to mention product names in the explanation if it improves clarity. Do not overdo it.
- If nothing is a strong fit, choose the closest 1–3 items and label them as “closest matches” for the concern. Do not say there are no products.
- Write original, benefit-led phrasing (do not quote product text).
- Ingredient grounding: Only name a specific ingredient if it is explicitly present in the candidate fields. If not explicit, describe the benefit without naming an ingredient.
- Avoid irrelevant categories unless explicitly requested (e.g., hair/body items for facial concerns).
- Do NOT repeat the same idea twice. No duplicated sentences or paragraphs.

Optional ingredient facts (may be empty):
${factsBlock ? factsBlock.trim() : "(none)"}

OUTPUT REQUIREMENTS:
- Return STRICT JSON only (no markdown/backticks, no commentary).
- Choose EXACTLY 3 product IDs from candidates: primary + 2 alternatives.
- Ensure productIds is ordered: [primary, alt1, alt2].
- Keep reasons short, concrete, and grounded in candidate fields.
- copy.why is REQUIRED and must be the canonical long-form narrative used by the UI.

Rank mode: ${rankLabel}
Routine mode: ${routineMode ? "yes (AM/PM guidance expected where relevant)" : "no (single-pick acceptable)"}

RESPONSE JSON SHAPE (STRICT KEYS):
{
  "primary": {
    "id": "<productId-from-candidates>",
    "score": 0.0,
    "reasons": ["short, specific reason 1", "reason 2"],
    "tagsMatched": ["match1", "match2"]
  },
  "alternatives": [
    { "id": "<altId-1>", "when": "sensitive | budget | premium | lighter texture | family-size | colour/material match", "reasons": ["short, concrete reason"] },
    { "id": "<altId-2>", "when": "sensitive | budget | premium | lighter texture | family-size | colour/material match", "reasons": ["short, concrete reason"] }
  ],
  "explanation": {
    "oneLiner": "<ONE sentence only. Optional. If unsure, return empty string.>",
    "expertBullets": ["Short evidence chip 1", "Evidence chip 2", "Optional: How-to tip chip"]
  },
  "productIds": ["<primary.id>", "<alt1.id>", "<alt2.id>"],
  "copy": {
    "why": "<REQUIRED. Exactly 2 paragraphs separated by ONE blank line. Paragraph 1: warm overview of how you approached the concern and why these 3 were chosen (problem→solution framing, grounded in candidate fields). Paragraph 2: why the Top Pick is #1 (grounded), then position alt1 in 1 sentence and alt2 in 1 sentence; include a brief how-to tip as a short clause (not a third paragraph).>",
    "rationale": "<Optional. If provided, keep it short (1–2 sentences) and do not repeat copy.why. Otherwise empty string.>",
    "extras": "<Optional. Only if truly helpful. Otherwise empty string.>"
  }
}
`.trim();
}
