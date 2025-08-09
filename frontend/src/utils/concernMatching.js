// src/utils/concernMatching.js

// Basic synonym dictionary
const synonyms = {
  "dry skin": ["dehydrated skin", "flaky skin", "tight skin"],
  "eczema": ["atopic dermatitis", "itchy skin", "inflamed skin", "rash"],
  "acne": ["pimples", "breakouts", "zits"],
  "wrinkles": ["fine lines", "aging skin", "crow’s feet"],
  "oily skin": ["greasy", "shiny t-zone"],
  "dark spots": ["hyperpigmentation", "melasma", "sun spots"]
};

// Normalize + expand concern
export function extractConcernVariants(input) {
  const base = input.toLowerCase().trim().replace(/[^\w\s]/gi, "");

  const variants = new Set([base]);

  for (const [canonical, alts] of Object.entries(synonyms)) {
    if (base.includes(canonical)) {
      alts.forEach((alt) => variants.add(alt));
    }
    alts.forEach((alt) => {
      if (base.includes(alt)) {
        variants.add(canonical);
        alts.forEach((alt2) => variants.add(alt2));
      }
    });
  }

  return Array.from(variants);
}
