// refina-backend/bff/lib/knowledge.js
// Minimal, cache-aware helpers for Ingredient Knowledge Pack + Concern->Ingredients map.
import { db } from "./firestore.js";

// Naive in-memory cache (process lifetime). You can swap for LRU later.
const cache = new Map();
const now = () => Date.now();
// 10 minutes default TTL
const TTL_MS = Number(process.env.REFINA_KNOWLEDGE_TTL_MS || 10 * 60 * 1000);

function getCached(key) {
  const hit = cache.get(key);
  if (hit && hit.exp > now()) return hit.val;
  cache.delete(key);
  return null;
}
function setCached(key, val, ttl = TTL_MS) {
  cache.set(key, { val, exp: now() + ttl });
}

// Normalize a concern key (very light)
export function normConcern(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// Expand a concern to ingredient slugs via global mapping
export async function expandConcernToIngredients(concern) {
  const key = `concern2ing:${normConcern(concern)}`;
  const cached = getCached(key);
  if (cached) return cached;

  try {
    const docRef = db
      .collection("concernToIngredients")
      .doc("global")
      .collection("items")
      .doc(normConcern(concern));
    const snap = await docRef.get();
    const list = snap.exists && Array.isArray(snap.data()?.ingredients)
      ? snap.data().ingredients.map((x) => String(x).toLowerCase().trim()).filter(Boolean)
      : [];
    setCached(key, list);
    return list;
  } catch {
    setCached(key, []);
    return [];
  }
}

// Fetch brief facts for a set of ingredient slugs (keep it short!)
export async function getIngredientFacts(slugs = []) {
  const need = Array.from(new Set(slugs.map((s) => String(s).toLowerCase().trim()).filter(Boolean)));
  if (!need.length) return {};

  // Try cache first
  const result = {};
  const missing = [];
  for (const slug of need) {
    const hit = getCached(`if:${slug}`);
    if (hit) result[slug] = hit;
    else missing.push(slug);
  }
  if (!missing.length) return result;

  // Load missing in parallel
  const reads = missing.map((slug) =>
    db
      .collection("ingredientFacts")
      .doc("global")
      .collection("items")
      .doc(slug)
      .get()
      .then((snap) => {
        if (!snap.exists) return [slug, null];
        const data = snap.data() || {};
        // Only keep tight, safe fields the prompt needs
        const trimmed = {
          name: data.name || slug,
          synonyms: Array.isArray(data.synonyms) ? data.synonyms.slice(0, 6) : [],
          benefits: String(data.benefits || "").slice(0, 400), // cap length
          cautions: String(data.cautions || "").slice(0, 200),
        };
        return [slug, trimmed];
      })
      .catch(() => [slug, null])
  );

  const pairs = await Promise.all(reads);
  for (const [slug, val] of pairs) {
    if (val) {
      setCached(`if:${slug}`, val);
      result[slug] = val;
    }
  }
  return result;
}