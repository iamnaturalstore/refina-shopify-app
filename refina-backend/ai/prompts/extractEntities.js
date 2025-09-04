// refina-backend/ai/prompts/queryToEntities.js
// Maps a user's free-text query to a subset of the store's entity vocabulary.

/**
 * Builds the prompt to map a user query to a list of entity slugs.
 * @param {{ query: string, vocab: { slug: string, name: string, synonyms: string[] }[] }} params
 * @returns {string} The complete prompt string.
 */
export function buildQueryToEntitiesPrompt({ query, vocab }) {
  const prunedVocab = (Array.isArray(vocab) ? vocab : []).slice(0, 2000).map(v => ({
    slug: String(v.slug || ""),
    name: String(v.name || ""),
    synonyms: Array.isArray(v.synonyms) ? v.synonyms.slice(0, 8) : []
  }));

  return `
You are **Refina Router**. Select the most relevant entities from the store's own vocabulary for this user query.

Constraints:
- Use only the provided vocabulary. Do not invent entities.
- Return 3–8 slugs when possible; fewer is OK if the query is very narrow.
- If nothing matches strongly, choose the closest matches (still from the vocabulary).
- STRICT JSON only.

User query: "${String(query)}"

Store entity vocabulary (names + synonyms only):
${JSON.stringify(prunedVocab, null, 2)}

Return JSON:
{ "entities": ["slug-1","slug-2","slug-3"] }
`.trim();
}
