// refina-backend/ai/prompts/extractEntities.js
// Prompt used by the Indexer worker to extract store-native entities from product text.
// Domain-agnostic: works for skincare, bikes, coffee, supplements, etc.

export function buildExtractEntitiesPrompt({ product }) {
  const compact = {
    id: String(product.id || ""),
    title: String(product.title || product.name || ""),
    description: String(stripHtml(product.description || product.body_html || "")).slice(0, 2000),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 32) : [],
  };

  return `
You are an expert system that extracts structured data from product text.
Use ONLY the information in the provided PRODUCT INPUT. Do not use outside knowledge.
You MUST return STRICT JSON only. Do not add any text, markdown, or backticks outside of the single JSON object.

Rules:
- For 'evidence', find the 2 most descriptive sentences proving the entity exists.
- For 'fact', provide a rich, insightful sentence that adds value.
- If no entities, specs, or flags are found, return empty arrays.

PRODUCT INPUT:
${JSON.stringify(compact, null, 2)}

EXPECTED JSON SCHEMA:
${JSON.stringify({
  "product": { "id": compact.id },
  "entities": [
    {
      "name": "Hyaluronic Acid",
      "type": "ingredient",
      "synonyms": ["HA", "sodium hyaluronate"],
      "evidence": [
        "Formulated with multi-molecular weight Hyaluronic Acid to hydrate multiple layers of the skin.",
        "Our serum draws and holds water for long-lasting hydration."
      ],
      "fact": "A powerful humactant that can hold up to 1000 times its weight in water, making it exceptional for moisturizing and plumping the skin.",
      "cautions": "Most effective when applied to damp skin."
    }
  ],
  "specs": [ { "name": "pH", "value": 5.5 } ],
  "flags": ["vegan", "fragrance-free"]
}, null, 2)}
`.trim();
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
