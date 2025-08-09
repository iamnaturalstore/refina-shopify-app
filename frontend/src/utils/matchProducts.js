// src/utils/matchProducts.js

export function matchProductsToConcern(products, concernTerms) {
  const normalizedTerms = Array.isArray(concernTerms)
    ? concernTerms.map((t) => t.toLowerCase())
    : [concernTerms.toLowerCase()];

  return products.filter((product) => {
    const tags = (product.tags || []).map((tag) => tag.toLowerCase());
    const description = (product.description || "").toLowerCase();

    return normalizedTerms.some((term) =>
      // ✅ Match if tag contains term, or description contains term
      tags.some(tag => tag.includes(term)) || description.includes(term)
    );
  });
}
