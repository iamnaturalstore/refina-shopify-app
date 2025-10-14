// refina-backend/ai/prompts/extractEntities.js
// Prompt used by the Indexer worker to extract store-native entities from product text.
// Domain-agnostic: works for skincare, bikes, coffee, supplements, etc.

export function buildExtractEntitiesPrompt({ product }) {
  // product: { id, title, description, tags[], specs?{} }
  const compact = {
    id: String(product.id || ""),
    title: String(product.title || product.name || ""),
    description: String(stripHtml(product.description || product.body_html || "")).slice(0, 2000),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 32) : [],
    specs: product.specs && typeof product.specs === "object" ? product.specs : {}
  };

  return `
You are **Refina Indexer**, extracting factual, catalog-native entities from a product.
Use only the product text provided.
Do not use outside knowledge or web sources.

Return **STRICT JSON only** (no markdown, no backticks).
Extract:
- entities[]: list of things explicitly present in text/specs, each with:
  - name (normalized common term)
  - type: one of ["ingredient","material","feature","spec","nutrient","component","standard","care"]
  - synonyms[] (only if present in the text; keep short)
  - evidence[]: up to 2 short text snippets copied from this product that justify the entity
- specs[]: structured key/values from obvious specifications. Use numeric value where sensible.
  - { "name": "<e.g. battery>", "value": 504, "unit": "Wh" }
- flags[]: short boolean-ish labels present in text (e.g. "vegan","spf","fragrance-free","hydraulic-disc-brakes").
For each entity, also provide:
- fact: one short, neutral sentence true in general (no medical claims). If uncertain, leave empty string.
- cautions: optional very short general caution (empty if none).

Rules:
- Do not invent. Only extract what is directly suggested by the text/specs/tags.
- For 'evidence', find the most descriptive sentences that prove the entity exists.
- For 'fact', provide a rich, insightful sentence that adds value.
- Keep facts non-technical and safe (no dosages/medical promises unless the text states them).
- Keep everything concise; trim long wording.
- If nothing is present, return empty arrays.

PRODUCT INPUT:
${JSON.stringify(compact, null, 2)}

EXPECTED JSON SCHEMA:
{
  "product": { "id": "${compact.id}" },
  "entities": [
    {
      "name": "Hyaluronic Acid",
      "type": "ingredient",
      "synonyms": ["HA", "sodium hyaluronate"],
      "evidence": [
        "Formulated with multi-molecular weight Hyaluronic Acid to hydrate multiple layers of the skin.",
        "Our serum draws and holds water for long-lasting hydration."
      ],
      "fact": "A powerful humectant that can hold up to 1000 times its weight in water, making it exceptional for moisturizing and plumping the skin.",
      "cautions": "Most effective when applied to damp skin."
    }
  ],
  "specs": [
    { "name": "pH", "value": 5.5 }
  ],
  "flags": ["vegan", "fragrance-free"]
}
`.trim();
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
