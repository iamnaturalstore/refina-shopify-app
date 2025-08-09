// utils/fallbackProductMatch.js

/**
 * Smart fallback filter when Gemini or mappings fail.
 * Prioritizes productType → tags → description → category.
 *
 * @param {Array} products - All products loaded from Firestore.
 * @param {string} concern - User input concern (natural language).
 * @param {string} storeCategory - Store category, e.g. "Beauty" (optional).
 * @returns {Array} top 6 matched products.
 */
export function smartFallbackFilter(products, concern, storeCategory = "") {
  const normalized = concern.toLowerCase();
  const keywords = normalized.split(/\s+/).filter(word => word.length > 2);

  // Step 1: ProductType match — hardcoded boost for now
  const typeMatches = products.filter(p =>
    p.productType?.toLowerCase().includes("face oil")
  );

  // Step 2: Tag match
  const tagMatches = products.filter(p =>
    p.tags?.some(tag =>
      keywords.some(kw => tag.toLowerCase().includes(kw))
    )
  );

  // Step 3: Description match
  const descMatches = products.filter(p =>
    keywords.some(kw =>
      p.description?.toLowerCase().includes(kw)
    )
  );

  // Step 4: Category match
  const categoryMatches = products.filter(p =>
    storeCategory &&
    p.category?.toLowerCase() === storeCategory.toLowerCase()
  );

  // Combine results and deduplicate by product ID
  const all = [...typeMatches, ...tagMatches, ...descMatches, ...categoryMatches];
  const unique = [...new Map(all.map(item => [item.id, item])).values()];

  // Sort by relevance: face oil and vitamin C in description
  const sorted = unique.sort((a, b) => {
    const score = (product) => {
      let s = 0;
      if (product.productType?.toLowerCase().includes("face oil")) s += 2;
      if (product.description?.toLowerCase().includes("vitamin c")) s += 1;
      return s;
    };
    return score(b) - score(a);
  });

  return sorted.slice(0, 6);
}
