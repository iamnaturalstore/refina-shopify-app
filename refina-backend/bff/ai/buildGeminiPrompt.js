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
  const tinyFacts = computeTinyFacts(p, constraints, concernTokens);

  // Helper to flatten arrays into compact strings
  const formatList = (arr, max = 12) => 
    Array.isArray(arr) ? arr.slice(0, max).join(", ") : "";

  return {
    id: p.id,
    name: p.title || p.name || "",
    // The "Pürblack" Buffer: 400 chars keeps the Huberman/Gold/Himalaya signals
    descriptionShort: shorten(stripHtml(p.description || p.body_html || ""), 400),
    // Flattened to strings to save ~1,200 tokens across 24 products
    tags: formatList(p.tags, 15),
    keywords: formatList(p.keywordsNormalized || p.keywords, 10),
    productType: p.productType || "",
    productType_norm: p.productType_norm || p.productTypeNormalized || "",
    usageStep: p.usageStep || p.step || "",
    benefitsNormalized: formatList(p.benefitsNormalized, 10),
    ingredientsNormalized: formatList(p.ingredientsNormalized, 15),
    price: p.price ?? p.minPrice ?? undefined,
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
- Keep ALL text fields concise and grounded in candidate fields.
- oneLiner is REQUIRED (1 sentence).
- friendlyParagraph is REQUIRED. Exactly 2 paragraphs separated by a single blank line. Paragraph 1: Provide expert insight (2-3 sentences max) explaining the science or botanical benefits — do NOT name specific products. Paragraph 2: Start with the Top Pick [Product Name] in BOLD CAPS; explain in 1 sentence why it is #1, then 1 short sentence for each alternative explaining when to choose them.
- expertBullets are OPTIONAL. If included, provide 2–3 short evidence chips, each grounded in candidate fields, each max ~12 words. Must be distinct from friendlyParagraph content.

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
  "oneLiner": "One sentence summary tailored to the concern (required).",
  "friendlyParagraph": "2 paragraphs: Expert 'Why' insight (no names) + Top Pick explanation and alternatives (with names)."
  "expertBullets": ["Optional short evidence chip (max 2)"]
},
  "copy": { "why": "", "rationale": "", "extras": "" }
}
`.trim();
}
