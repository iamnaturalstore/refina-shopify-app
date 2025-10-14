export function buildExtractEntitiesPrompt({ product }) {
  const compact = {
    id: String(product.id || ""),
    title: String(product.title || product.name || ""),
    description: String(stripHtml(product.description || product.body_html || "")).slice(0, 2000),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 32) : [],
  };

  return `
You are an expert system that extracts structured data from product text and enriches it with general knowledge.
You MUST return STRICT JSON only. Do not add any text, markdown, or backticks outside of the single JSON object.

Rules:
- For 'entities', only extract ingredients and features explicitly mentioned in the PRODUCT INPUT.
- For 'evidence', find the 2 most descriptive sentences from the PRODUCT INPUT that prove the entity exists.
- For 'fact', use your global knowledge to provide a rich, insightful, one-sentence fact about the entity. Do not reference the specific product.
- If no entities are found, return empty arrays.

PRODUCT INPUT:
${JSON.stringify(compact, null, 2)}

EXPECTED JSON SCHEMA:
${JSON.stringify({
  "product": { "id": compact.id },
  "entities": [
    {
      "name": "Kakadu Plum",
      "type": "ingredient",
      "synonyms": ["Terminalia ferdinandiana"],
      "evidence": [
        "Infused with native Australian Kakadu Plum.",
        "A powerful source of antioxidants to protect your skin."
      ],
      "fact": "The Kakadu Plum is an Australian superfruit known to have the highest recorded natural concentration of Vitamin C in the world.",
      "cautions": "Always patch test new ingredients."
    }
  ],
  "specs": [],
  "flags": ["organic", "vegan"]
}, null, 2)}
`.trim();
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}