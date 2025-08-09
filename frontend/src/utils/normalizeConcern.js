// src/utils/normalizeConcern.js

const globalSynonymMap = {
  hyperpigmentation: ["dark spots", "discoloration", "melasma"],
  acne: ["breakouts", "zits", "blemishes"],
  eczema: ["rash", "itchy skin", "inflammation"],
  wrinkles: ["fine lines", "aging skin", "crow’s feet"],
  cleanser: ["face wash", "gel", "cleaning lotion"],
  moisturizer: ["hydrator", "cream", "lotion"],
  sensitivity: ["delicate", "reactive", "easily irritated"],
};

export function normalizeConcern(rawConcern, customSynonyms = {}) {
  if (!rawConcern) return [];

  const concernLower = rawConcern.toLowerCase();

  const tokens = concernLower
    .split(/\W+/)
    .filter((word) => word.length > 2);

  const expanded = new Set(tokens);

  // Combine global + custom synonyms
  const synonymMap = { ...globalSynonymMap, ...customSynonyms };

  for (const [key, synonyms] of Object.entries(synonymMap)) {
    if (tokens.includes(key) || synonyms.some((s) => tokens.includes(s))) {
      expanded.add(key);
      synonyms.forEach((s) => expanded.add(s));
    }
  }

  return Array.from(expanded);
}
