// refina-backend/bff/ai/getIngredientFacts.js
// ESM. Lightweight reader for ingredient/feature fact sheets.
// Prefers store-scoped overrides, then falls back to global sheets.
// Returns a compact map suitable for buildGeminiPrompt's `ingredientFacts` block.

import { db } from "../lib/firestore.js";

function slugify(s = "") {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, "-");
}

/**
 * @param {string[]} namesOrSlugs - ingredients/features (any case)
 * @param {string} storeId - myshopify domain (store-scoped overrides)
 * @returns {Promise<Record<string, {name:string, synonyms:string[], benefits:string, cautions:string}>>}
 */
export async function getIngredientFacts(namesOrSlugs = [], storeId = "") {
  const out = {};
  const slugs = Array.from(
    new Set(
      (Array.isArray(namesOrSlugs) ? namesOrSlugs : [])
        .map((x) => slugify(x))
        .filter(Boolean)
        .slice(0, 50)
    )
  );
  if (!slugs.length) return out;

  // 1) Try store-scoped overrides first
  if (storeId) {
    const col = db.collection(`knowledge/${storeId}/ingredients`);
    const snap = await col.where("__name__", "in", slugs.slice(0, 10)).get().catch(() => null);
    // Firestore IN queries cap at 10; chunk if needed
    const chunks = [];
    for (let i = 0; i < slugs.length; i += 10) chunks.push(slugs.slice(i, i + 10));
    if (snap === null) {
      for (const chunk of chunks) {
        // eslint-disable-next-line no-await-in-loop
        const s = await col.where("__name__", "in", chunk).get().catch(() => null);
        if (s && !s.empty) {
          s.forEach((d) => {
            const v = d.data() || {};
            out[d.id] = {
              name: v.name || d.id,
              synonyms: Array.isArray(v.synonyms) ? v.synonyms.slice(0, 12) : [],
              benefits: String(v.benefits || "").slice(0, 600),
              cautions: String(v.cautions || "").slice(0, 400),
            };
          });
        }
      }
    } else if (!snap.empty) {
      snap.forEach((d) => {
        const v = d.data() || {};
        out[d.id] = {
          name: v.name || d.id,
          synonyms: Array.isArray(v.synonyms) ? v.synonyms.slice(0, 12) : [],
          benefits: String(v.benefits || "").slice(0, 600),
          cautions: String(v.cautions || "").slice(0, 400),
        };
      });
    }
  }

  // 2) Fill misses from global knowledge pack
  const missing = slugs.filter((s) => !out[s]);
  if (missing.length) {
    const col = db.collection("knowledge/global/ingredients");
    const chunks = [];
    for (let i = 0; i < missing.length; i += 10) chunks.push(missing.slice(i, i + 10));
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await col.where("__name__", "in", chunk).get().catch(() => null);
      if (snap && !snap.empty) {
        snap.forEach((d) => {
          const v = d.data() || {};
          out[d.id] = {
            name: v.name || d.id,
            synonyms: Array.isArray(v.synonyms) ? v.synonyms.slice(0, 12) : [],
            benefits: String(v.benefits || "").slice(0, 600),
            cautions: String(v.cautions || "").slice(0, 400),
          };
        });
      }
    }
  }

  return out;
}

export default { getIngredientFacts };
