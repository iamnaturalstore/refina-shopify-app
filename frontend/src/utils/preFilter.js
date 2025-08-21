// src/utils/preFilter.js
import { collection, getDocs } from "firebase/firestore";

/**
 * Load the normalized catalog (built by normalizeProducts.js) into a Map keyed
 * by lowercased id/name so we can enrich products during pre-filtering.
 */
export async function loadNormalizedCatalog(db, storeId) {
  const tryPaths = [
    ["artifacts", storeId, "productsNormalized", "items"],
    ["artifacts", storeId, "productsNormalized", "items1"],
    ["artifacts", "productsNormalized", storeId, "items"],
    ["productsNormalized", storeId, "items"],
  ];

  for (const parts of tryPaths) {
    try {
      const col = collection(db, ...parts);
      const snap = await getDocs(col);
      if (!snap.empty) {
        const out = new Map();
        snap.docs.forEach((d) => {
          const v = d.data() || {};
          const id = String(v.id || v.productId || d.id || "").toLowerCase().trim();
          const name = String(v.name || "").toLowerCase().trim();
          const key = id || name;
          if (!key) return;
          out.set(key, {
            id: v.id || v.productId || d.id,
            name: v.name || "",
            canonicalType: (v.canonicalType || v.typeNormalized || "").toString(),
            superCategory: (v.superCategory || v.domain || "").toString(),
            categoryNormalized: (v.categoryNormalized || v.category || "").toString(),
            keywordsNormalized: Array.isArray(v.keywordsNormalized) ? v.keywordsNormalized : [],
            ingredientsNormalized: Array.isArray(v.ingredientsNormalized) ? v.ingredientsNormalized : [],
          });
        });
        return out;
      }
    } catch {
      /* try next path */
    }
  }
  return new Map();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const H = {
  lc: (s) => String(s || "").toLowerCase(),
  hasAny(hay, arr) {
    const h = H.lc(hay);
    return arr.some((a) => h.includes(a));
  },
};

const TYPE_HINTS = new Set([
  "cleanser","wash","toner","essence","serum","treatment","exfoliator","exfoliant",
  "moisturiser","moisturizer","moisturize","moisturise","cream","lotion","butter","balm",
  "mask","sunscreen","spf","oil","shampoo","conditioner","spray","hairspray","gel","mousse","leave-in",
  "lipstick","mascara","concealer","blush","eyeliner","eyeshadow",
]);

function extractTypeToken(concern, products) {
  const tokens = H.lc(concern).split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const found = tokens.find(
    (w) =>
      TYPE_HINTS.has(w) ||
      products.some((p) => H.lc(p.productTypeNormalized || p.productType || "").includes(w))
  );
  return found || null;
}

function detectDomain(concern) {
  const s = H.lc(concern);
  const isHair = /\bhair|scalp|shampoo|conditioner|frizz|curl|hairspray|leave-?in\b/.test(s);
  const isMakeup = /\bmake(?:up)?\b|\blip(?:stick| colour| color| tint| stain| whip)\b|\bmascara\b|\bconcealer\b|\bblush\b|\beyeliner\b|\beyeshadow\b/.test(s);
  const isBody = /\bbody\b|\bhand\b|\bfoot\b|\bleg\b|\bshower\b|\bkp\b|\bkeratosis\b|\bdeodorant\b/.test(s);
  const isAroma = /\bessential oil|aromatherapy|diffuser|lavender oil\b/.test(s);
  const isSupp = /\bsupplement|vitamin|nootropic|omega|probiotic|capsule|tablet\b/.test(s);
  return { isHair, isMakeup, isBody, isAroma, isSupp };
}

function isOilType(p) {
  const t = H.lc(p.productTypeNormalized || p.productType);
  return t.includes("oil");
}

function isCreamyMoisturizerType(p) {
  const t = H.lc(p.productTypeNormalized || p.productType);
  return /(moisturis|moisturiz|cream|lotion|butter|balm)/.test(t);
}

/**
 * Pre-filter & shortlist products before sending to Gemini to:
 *  - remove store owner exclusions
 *  - restrict to relevant domain (hair/makeup/body/aromatherapy/supplement) when possible
 *  - apply type-token hints
 *  - nudge against obvious mismatches (e.g., pure oils when user asked for "moisturiser")
 */
export function prefilterShortlist(concern, storeProducts, normalizedMap, opts = {}) {
  const capStrict = opts.capStrict ?? 120;
  const capRelaxed = opts.capRelaxed ?? 200;
  const exclusions = (opts.exclusions || []).map((s) => H.lc(s)).filter(Boolean);

  const c = H.lc(concern);
  const tok = extractTypeToken(concern, storeProducts);
  const dom = detectDomain(concern);

  const wantMoisturizer =
    tok && /(moisturis|moisturiz|cream|lotion|butter|balm)/.test(tok);
  const userMentionedOil = /\boil(s)?\b/.test(c);

  const candidates = [];

  for (const p of storeProducts) {
    // 0) Store owner exclusions
    if (exclusions.length) {
      const haystack = [
        p.name, p.description, p.productType, p.category,
        ...(Array.isArray(p.tags) ? p.tags : []),
        ...(Array.isArray(p.keywords) ? p.keywords : []),
        ...(Array.isArray(p.ingredients) ? p.ingredients : []),
      ].join(" ");
      if (H.hasAny(haystack, exclusions)) continue;
    }

    // 1) Normalize
    const key = H.lc(p.id || p.name);
    const n = normalizedMap.get(key) || {};
    const name = H.lc(p.name);
    const desc = H.lc(p.description);
    const typeN = H.lc(n.canonicalType || n.typeNormalized || p.productType);
    const catN = H.lc(n.categoryNormalized || p.category);
    const superN = H.lc(n.superCategory || "");
    const kws = (n.keywordsNormalized || p.keywords || []).map(H.lc);
    const ings = (n.ingredientsNormalized || p.ingredients || []).map(H.lc);
    const tags = (p.tags || []).map(H.lc);

    // 2) Domain gating (soft allow)
    let domainOk = true;
    if (dom.isHair) domainOk = superN.includes("hair") || catN.includes("hair") || /hair|scalp|shampoo|conditioner/.test(typeN + " " + desc);
    if (dom.isMakeup) domainOk = superN.includes("makeup") || catN.includes("makeup") || /lipstick|mascara|concealer|blush|liner|lip colour|lip color/.test(typeN + " " + desc + " " + name);
    if (dom.isBody) domainOk = superN.includes("body") || catN.includes("body") || /body|lotion|butter|hand|foot|deodorant/.test(typeN + " " + desc);
    if (dom.isAroma) domainOk = /essential oil|aroma|blend|diffuser/.test(typeN + " " + desc + " " + name);
    if (dom.isSupp) domainOk = superN.includes("supplement") || catN.includes("supplement") || /supplement|capsule|tablet|powder|vitamin|omega|collagen|probiotic/.test(typeN + " " + desc);
    if (!domainOk) continue;

    // 3) Type token hint (soft)
    if (tok) {
      const inType = typeN.includes(tok) || name.includes(tok) || desc.includes(tok);
      if (!inType) {
        // keep if we still have strong signals later, but apply a small penalty
      }
    }

    // 4) Score
    let score = 0;

    // direct type match
    if (tok && (typeN.includes(tok) || name.includes(tok))) score += 4;

    // moisturizer vs oil nudging
    if (wantMoisturizer && !userMentionedOil) {
      if (isCreamyMoisturizerType({ productTypeNormalized: typeN })) score += 2;
      if (isOilType({ productTypeNormalized: typeN }) && !isCreamyMoisturizerType({ productTypeNormalized: typeN })) score -= 3;
    }

    // concern tokens appear in metadata
    const tokens = c.split(/\s+/).filter(Boolean);
    const hay = [name, desc, typeN, catN, superN, ...kws, ...ings, ...tags].join(" ");
    tokens.forEach((tkn) => {
      if (tkn.length < 3) return;
      if (hay.includes(tkn)) score += 1;
    });

    // ingredient / keyword boosts
    const boostWords = ["niacinamide","vitamin c","retinol","retinal","ceramide","hyaluronic","spf","zinc","titanium","salicylic","bha","aha","glycolic","lactic","shea","squalane","peptide","probiotic","lavender","magnesium"];
    if (H.hasAny(hay, boostWords)) score += 1;

    // domain alignment boost
    if (dom.isMakeup && /lipstick|lip colour|lip color/.test(hay)) score += 3;
    if (dom.isAroma && /essential oil|blend|lavender/.test(hay)) score += 2;
    if (dom.isSupp && /supplement|capsule|tablet|powder/.test(hay)) score += 2;

    // retain reasonable candidates only
    if (score > -2) {
      candidates.push({ p, score });
    }
  }

  // Sort & cap
  candidates.sort((a, b) => b.score - a.score);

  // If we asked for moisturizer and filtered out too many oils, make sure we still have enough
  let shortlist = candidates.map((x) => x.p);
  const cap = shortlist.length > capStrict ? capRelaxed : capStrict;
  shortlist = shortlist.slice(0, cap);

  // If moisturizer intent and the shortlist has < 3 creamy types, try to add a few creamy items back in
  if (wantMoisturizer) {
    const creamy = shortlist.filter(isCreamyMoisturizerType);
    if (creamy.length < 3) {
      const moreCreamy = candidates
        .map((x) => x.p)
        .filter(isCreamyMoisturizerType)
        .slice(0, 6);
      const merged = new Map();
      [...shortlist, ...moreCreamy].forEach((p) => {
        merged.set(H.lc(p.id || p.name), p);
      });
      shortlist = Array.from(merged.values()).slice(0, cap);
    }
  }

  return shortlist;
}
