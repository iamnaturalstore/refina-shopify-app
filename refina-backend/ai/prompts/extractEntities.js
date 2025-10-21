export function buildExtractEntitiesPrompt({ product }) {
  const compact = {
    id: String(product.id || ""),
    title: String(product.title || product.name || ""),
    description: String(stripHtml(product.description || product.body_html || "")).slice(0, 4000),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 32) : [],
  };

  return `
You are an expert system that extracts structured data from product text and enriches it with general knowledge.
You MUST return STRICT JSON only. Do not add any text, markdown, or backticks outside of the single JSON object.

Rules:
- Extract at most 7 entities total, prioritizing in this order: ingredient/material/component → benefit/concern/solution → feature/skinType/safetyFlag.
- Only extract entities explicitly present in the PRODUCT INPUT text (title/description/tags). Do not infer entities that aren’t stated.
- Allowed type values: ingredient, material, component, benefit, concern, solution, feature, skinType, safetyFlag. Do not invent new types.
- Canonicalize and merge near-duplicates: output one entity with a canonical name; put alternates in synonyms. Do not split inflections or close synonyms into separate entities (e.g., "brighten"/"illuminate"; "vitamin c"/"vitamin-c").
- Skip vague adjectives (e.g., "creamy", "easy-to-blend", "youthful", "high-pigmented") unless that exact phrase is central to the product and appears verbatim with clear context.
- For each entity, provide one evidence item: the shortest exact quote from PRODUCT INPUT that contains the entity phrase (or an unambiguous synonym).
- Do not reuse the same sentence/quote as evidence across entities unless the quote contains all entity phrases being evidenced.
- Provide fact only for ingredient, material, or component. Omit fact for benefit, concern, solution, feature, skinType, safetyFlag.
- Include confidence (0–1) and sourceField ("title" | "description" | "tags") for each entity. Favor outputs with confidence ≥ 0.5.
- If no entities are found, return empty arrays.
- STRICT JSON only; no extra text/markdown/backticks.

PRODUCT INPUT:
${JSON.stringify(compact, null, 2)}

EXPECTED JSON SCHEMA:
${JSON.stringify({
  "product": { "id": compact.id },
  "entities": [
    {
      "name": "Cordura Fabric",
      "type": "material",
      "synonyms": ["ballistic nylon"],
      "evidence": ["Constructed from highly durable Cordura fabric."],
      "fact": "Cordura is a family of high-tenacity nylon fabrics known for exceptional abrasion and tear resistance.",
      "cautions": "Water-resistant but not fully waterproof.",
      "confidence": 0.92,
      "sourceField": "description"
    }
  ],
  "specs": [],
  "flags": []
}, null, 2)}
`.trim();
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
