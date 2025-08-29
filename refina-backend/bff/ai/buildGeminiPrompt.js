// refina-backend/bff/lib/buildGeminiPrompt.js
// Builds a compact, high-signal prompt for Gemini that returns an enriched, human-friendly recommendation.
// No external deps. Plain JS. ESM-compatible.

function toCompactCandidateTable(candidates = []) {
  // Expect each candidate to have:
  // id, name, productType, ingredients[], keywords[], tags[], descriptionShort, price (optional)
  const lines = candidates.map(c => {
    const id = c.id ?? "";
    const name = (c.name ?? "").replace(/\s+/g, " ").trim();
    const type = c.productType ?? "";
    const ingredients = Array.isArray(c.ingredients) ? c.ingredients.slice(0, 8).join(", ") : "";
    const keywords = Array.isArray(c.keywords) ? c.keywords.slice(0, 8).join(", ") : "";
    const tags = Array.isArray(c.tags) ? c.tags.slice(0, 8).join(", ") : "";
    const desc = (c.descriptionShort ?? "").replace(/\s+/g, " ").trim();
    const price = (c.price ?? "") ? ` | $${c.price}` : "";
    return `${id} | ${name}${price} | ${type} | [${ingredients}] | [${keywords}] | [${tags}] | ${desc}`;
  });

  if (lines.length === 0) return "NONE";
  return [
    "id | name | price | type | ingredients | keywords | tags | descShort",
    ...lines,
  ].join("\n");
}

/**
 * Build the complete Gemini prompt.
 * @param {Object} params
 * @param {string} params.concern - User's original concern text.
 * @param {string} [params.normalizedConcern] - Normalized/cleaned version (optional).
 * @param {string} [params.category="Beauty"] - Store category (e.g., "Beauty", "Outdoors").
 * @param {string} [params.tone="warm, friendly, expert with a wink"] - Voice/style.
 * @param {Object} [params.constraints] - Optional store/user constraints (e.g., { avoidFragrance: true, vegan: true, budgetMin: 0, budgetMax: 60 }).
 * @param {Array}  [params.candidates=[]] - Condensed products (fields defined above).
 * @returns {string} prompt
 */
export function buildGeminiPrompt({
  concern,
  normalizedConcern = "",
  category = "Beauty",
  tone = "warm, friendly, expert with a wink",
  constraints = {},
  candidates = [],
} = {}) {
  const constraintLines = [];
  if (constraints) {
    if (constraints.avoidFragrance) constraintLines.push("- Prefer fragrance-free.");
    if (constraints.vegan)          constraintLines.push("- Prefer vegan.");
    if (constraints.glutenFree)     constraintLines.push("- Prefer gluten-free.");
    if (constraints.crueltyFree)    constraintLines.push("- Prefer cruelty-free.");
    if (constraints.budgetMin != null || constraints.budgetMax != null) {
      const min = constraints.budgetMin != null ? `$${constraints.budgetMin}` : "";
      const max = constraints.budgetMax != null ? `$${constraints.budgetMax}` : "";
      constraintLines.push(`- Consider budget range ${min}${min && max ? "–" : ""}${max}.`);
    }
    if (constraints.notes) constraintLines.push(`- Notes: ${String(constraints.notes)}`); // free-form
  }

  const candidateTable = toCompactCandidateTable(candidates);

  // === PROMPT ===
  // IMPORTANT: we ask for *JSON only* (no markdown, no commentary).
  return [
`You are **Refina**, an expert, friendly shopping concierge for a ${category} Shopify store.`,
`Voice: ${tone}; Australian English. Be specific, ingredient-aware, and concise. Avoid medical claims or diagnoses.`,
`Choose exactly ONE primary product and up to TWO strong alternatives **only from the provided CANDIDATES**.`,
`Favor product-type relevance (e.g., for facial concerns prefer cleanser/serum/moisturizer over unrelated types).`,
`When concern implies sensitivity/irritation, prefer gentle/fragrance-free options. Do not invent products.`,

`CUSTOMER CONCERN (raw): ${concern}`,
normalizedConcern ? `CUSTOMER CONCERN (normalized): ${normalizedConcern}` : null,
constraintLines.length ? `CONSTRAINTS:\n${constraintLines.join("\n")}` : null,

`CANDIDATES (id | name | price | type | ingredients | keywords | tags | descShort):`,
candidateTable,

`OUTPUT REQUIREMENTS (return JSON only, no markdown, no extra text):`,
`{
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
  }
}`,
`Rules:
- Choose from candidates only; never fabricate IDs.
- Keep reasons ingredient- and benefit-specific to the concern.
- If information is insufficient, provide a conservative primary pick, leave alternatives empty, and still return valid JSON.
`
  ].filter(Boolean).join("\n");
}
