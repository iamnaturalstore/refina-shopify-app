// refina-backend/bff/lib/knowledge.js
// Minimal, cache-aware helpers for the store-native Knowledge Graph.

import { db } from "./firestore.js";

const cache = new Map();
const now = () => Date.now();
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

/**
 * Fetches the entity vocabulary (slug, name, synonyms) for a given store.
 * @param {string} storeId The full myshopify.com domain of the store.
 * @returns {Promise<{slug: string, name: string, synonyms: string[]}[]>} The store's entity vocabulary.
 */
export async function getStoreEntityVocabulary(storeId) {
  const key = `vocab:${storeId}`;
  const cached = getCached(key);
  if (cached) return cached;

  const vocab = [];
  try {
    const snap = await db.collection(`stores/${storeId}/entities`).get();
    snap.forEach(doc => {
      const data = doc.data();
      vocab.push({
        slug: doc.id,
        name: data.name || doc.id,
        synonyms: data.synonyms || [],
      });
    });
    setCached(key, vocab);
    return vocab;
  } catch (e) {
    console.error(`[Knowledge] Failed to fetch vocabulary for ${storeId}:`, e.message);
    return [];
  }
}

/**
 * Fetches the detailed facts for a given list of entity slugs for a specific store.
 * @param {string[]} slugs The list of entity slugs to fetch.
 * @param {string} storeId The full myshopify.com domain of the store.
 * @returns {Promise<Object.<string, object>>} A map of entity facts.
 */
export async function getStoreEntityFacts(slugs = [], storeId) {
  const need = Array.from(new Set(slugs.map((s) => String(s).toLowerCase().trim()).filter(Boolean)));
  if (!need.length) return {};

  const result = {};
  const missing = [];
  for (const slug of need) {
    const hit = getCached(`fact:${storeId}:${slug}`);
    if (hit) result[slug] = hit;
    else missing.push(slug);
  }
  if (!missing.length) return result;

  const reads = missing.map((slug) =>
    db.doc(`stores/${storeId}/entities/${slug}`).get()
      .then((snap) => {
        if (!snap.exists) return [slug, null];
        const data = snap.data() || {};
        const trimmed = {
          name: data.name || slug,
          synonyms: Array.isArray(data.synonyms) ? data.synonyms.slice(0, 6) : [],
          fact: String(data.fact || "").slice(0, 400),
          cautions: String(data.cautions || "").slice(0, 200),
        };
        return [slug, trimmed];
      })
      .catch(() => [slug, null])
  );

  const pairs = await Promise.all(reads);
  for (const [slug, val] of pairs) {
    if (val) {
      setCached(`fact:${storeId}:${slug}`, val);
      result[slug] = val;
    }
  }
  return result;
}
