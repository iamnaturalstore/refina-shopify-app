// refina-backend/utils/prefilter.js

/**
 * Load normalized catalog into a Map keyed by lower-id.
 * Path: normalizedProducts/{storeId}/items/*
 * Each item should already be in the "display shape" (id, name, description, tags, productType, category, ...)
 */
export async function loadNormalizedCatalog(dbAdmin, storeId) {
  const snap = await dbAdmin.collection(`normalizedProducts/${storeId}/items`).get();
  const map = new Map();
  for (const d of snap.docs) {
    const p = d.data() || {};
    const k = String(p.id || p.name || p.handle || d.id || "").toLowerCase().trim();
    if (k) map.set(k, p);
  }
  return map;
}

/**
 * Prefilter shortlist:
 * - quick keyword hit on name/tags/type/category/description
 * - light heuristics: bump exact word hits, preferred types
 * - cap to `limit` (default 200)
 */
export function prefilterShortlist(concern, normMap, storeSettings = {}, limit = 200) {
  const q = String(concern || "").toLowerCase();
  const tokens = q.split(/\s+/g).filter(Boolean);

  const items = [];
  for (const [, p] of normMap.entries()) {
    const hay = [
      p.name,
      p.description,
      (p.tags || []).join(" "),
      p.productType,
      p.category,
      (p.ingredients || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();

    let s = 0;
    for (const t of tokens) {
      const re = new RegExp(`\\b${escapeReg(t)}\\b`, "g");
      const m = hay.match(re);
      if (m) s += m.length * 3;
    }
    if (/\bserum\b/i.test(p.productType || "")) s += 1;
    if (/\bcleanser\b/i.test(p.productType || "")) s += 1;
    if (/\bsunscreen|spf\b/i.test(p.productType || "")) s += 2;

    if (s > 0) {
      items.push({ p, s });
    }
  }

  return items
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ p }) => ({
      id: p.id || p.name,
      name: p.name,
      description: p.description || "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      productType: p.productType || "",
      category: p.category || "",
      ingredients: Array.isArray(p.ingredients) ? p.ingredients : [],
    }));
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
