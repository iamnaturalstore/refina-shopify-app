// refina-backend/bff/lib/knowledge.js
// Minimal, cache-aware helpers for Ingredient Knowledge Pack + Concern->Ingredients map.
// Now includes constraint detection, an essential-oil denylist, and an optional rule scorer.

import { db } from "./firestore.js";

// ─────────────────────────────────────────────────────────────
// Naive in-memory cache (process lifetime). You can swap for LRU later.
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Normalizers
// ─────────────────────────────────────────────────────────────
export function normConcern(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Concern → Ingredients mapping + facts
// ─────────────────────────────────────────────────────────────
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
    const list =
      snap.exists && Array.isArray(snap.data()?.ingredients)
        ? snap
            .data()
            .ingredients.map((x) => String(x).toLowerCase().trim())
            .filter(Boolean)
        : [];
    setCached(key, list);
    return list;
  } catch {
    setCached(key, []);
    return [];
  }
}

export async function getIngredientFacts(slugs = []) {
  const need = Array.from(
    new Set(slugs.map((s) => String(s).toLowerCase().trim()).filter(Boolean))
  );
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

// ─────────────────────────────────────────────────────────────
// Essential-oil denylist (ingredient slugs)
// Keep broad botanical/genus names commonly used for EOs.
// Slugs should match your products.ingredientsNormalized entries.
// ─────────────────────────────────────────────────────────────
export const EO_DENYLIST = [
  // Common EO botanicals
  "lavandula",       // lavender
  "citrus",          // citrus (generic)
  "citrus-limon",    // lemon
  "citrus-aurantium",
  "citrus-paradisi", // grapefruit
  "mentha",          // mint family
  "mentha-piperita", // peppermint
  "eucalyptus",
  "melaleuca",       // tea tree
  "melaleuca-alternifolia",
  "cinnamomum",      // cinnamon
  "rosmarinus",      // rosemary (syn: salvia rosmarinus)
  "salvia",          // sage
  "pelargonium",     // geranium
  "pogostemon",      // patchouli
  "cananga-odorata", // ylang-ylang
  "juniperus",
  "cupressus",       // cypress
  "boswellia",       // frankincense
  "commiphora",      // myrrh
  "ocimum",          // basil
  "origanum",        // oregano
  "thymus",          // thyme
  "cymbopogon",      // lemongrass
  "aniba-rosaeodora",// rosewood
  "styrax",          // benzoin
  "anthemis",        // chamomile (EO form can irritate some)
  "matricaria",      // german chamomile
];

// ─────────────────────────────────────────────────────────────
// Constraint detection
// detectConstraints(normalizedConcern) → {
//   step?: "moisturizer" | "serum" | "cleanser" | "sunscreen" | "toner" | "mask" | "oil" | "exfoliant",
//   age?: number,
//   flags: {
//     sensitive?: boolean, avoidEO?: boolean, fragranceFree?: boolean, vegan?: boolean,
//     oily?: boolean, dry?: boolean, combination?: boolean,
//     acne?: boolean, redness?: boolean, rosacea?: boolean, photoaging?: boolean, pigmentation?: boolean
//   }
// }
// ─────────────────────────────────────────────────────────────
export function detectConstraints(normalizedConcern = "") {
  const s = normConcern(normalizedConcern);
  const flags = {};

  // Routine step / type
  let step = null;
  const stepMap = [
    ["moisturizer", /moisturi[sz]er|face\s*cream|night\s*cream|day\s*cream|cream\b/],
    ["serum", /\bserum\b/],
    ["cleanser", /cleanser|face\s*w(ash|ash)|face\s*clean/],
    ["sunscreen", /sunscreen|sun\s*screen|spf\b/],
    ["toner", /\btoner\b/],
    ["mask", /\bmask\b/],
    ["oil", /\bface\s*oil\b|\bfacial\s*oil\b|\bcleansing\s*oil\b/],
    ["exfoliant", /exfoli(ant|ator|ate)|aha|bha|pha|retinol|retinal/],
  ];
  for (const [lab, re] of stepMap) {
    if (re.test(s)) { step = lab; break; }
  }

  // Age
  let age = null;
  // patterns like "i'm 63", "age 63", "over 60", "in my 60s"
  const mExact = s.match(/\b(?:i['\s]*m|im|age)\s*(\d{2})\b/);
  if (mExact) {
    const n = Number(mExact[1]);
    if (n >= 10 && n <= 99) age = n;
  } else {
    const decade = s.match(/\b(?:in\s*my\s*)(\d{2})s\b/);
    if (decade) {
      const d = Number(decade[1]);
      if (d >= 20 && d <= 90) age = d + 2; // mid-decade heuristic
    } else if (/\bover\s*(\d{2})\b/.test(s)) {
      const n = Number(s.match(/\bover\s*(\d{2})\b/)[1]);
      if (n >= 20 && n <= 90) age = n + 5;
    }
  }

  // Skin type + conditions
  flags.oily = /\boily|oiliness|shine|shiny\b/.test(s);
  flags.dry = /\bdry|dehydrated\b/.test(s);
  flags.combination = /\bcombination\b/.test(s);
  flags.acne = /\bacne|pimples?|breakouts?\b/.test(s);
  flags.redness = /\bredness|red\b/.test(s);
  flags.rosacea = /\brosacea\b/.test(s);
  flags.photoaging = /\bphoto[-\s]*aging|sun[-\s]*damaged|sun[-\s]*damage|sunspots?\b/.test(s);
  flags.pigmentation = /\bpigmentation|dark\s*spots|melasma|hyperpigmentation\b/.test(s);
  flags.sensitive = /\bsensitive|reactive|easily\s*irritated\b/.test(s);

  // Preferences / exclusions
  const avoidEO =
    /\b(no|avoid|allergic\s*to)\s*(essential\s*oils?|eo?s?)\b/.test(s) ||
    /\bfragrance[-\s]*free\b/.test(s) ||
    /\bno\s*fragrance\b/.test(s);
  flags.avoidEO = !!avoidEO;
  flags.fragranceFree = /\bfragrance[-\s]*free\b/.test(s);
  flags.vegan = /\bvegan\b/.test(s);

  return { step: step || undefined, age: age || undefined, flags };
}

// ─────────────────────────────────────────────────────────────
// Optional: rule scorer used by retrieval to re-rank Top-N
// Returns a score in [0,1] using only KB fields (no model).
// Penalizes EO presence when avoidEO flag is set.
// ─────────────────────────────────────────────────────────────
export function scoreProduct(product = {}, constraints = {}) {
  const f = constraints?.flags || {};
  const step = constraints?.step || null;

  const typeNorm =
    (product.productType_norm || product.productTypeNormalized || product.productType || "").toLowerCase();
  const usageStep = (product.usageStep || product.step || "").toLowerCase();
  const benefits =
    (Array.isArray(product.benefitsNormalized) && product.benefitsNormalized) ||
    (Array.isArray(product.benefits) && product.benefits) ||
    [];
  const concerns =
    (Array.isArray(product.concernsNormalized) && product.concernsNormalized) ||
    (Array.isArray(product.concerns) && product.concerns) ||
    [];
  const audience = product.audience || {};
  const skinType = String(audience.skinType || audience.skintype || "").toLowerCase();
  const ingNorm =
    (Array.isArray(product.ingredientsNormalized) && product.ingredientsNormalized) ||
    (Array.isArray(product.ingredients_norm) && product.ingredients_norm) ||
    [];

  // Hard filter: EO when avoidEO
  if (f.avoidEO && ingNorm.some((slug) => EO_DENYLIST.some((ban) => String(slug).toLowerCase().includes(ban)))) {
    return 0;
  }

  let score = 0;

  // Type/step match
  if (step && (typeNorm.includes(step) || usageStep.includes(step))) score += 1.2;

  // Audience/skin-type alignment
  if (f.sensitive && (skinType.includes("sensitive") || concerns.includes("sensitive"))) score += 0.6;
  if (f.oily && (skinType.includes("oily") || concerns.includes("oily"))) score += 0.4;
  if (f.dry && (skinType.includes("dry") || concerns.includes("dry"))) score += 0.4;
  if (f.combination && (skinType.includes("combination") || concerns.includes("combination"))) score += 0.4;

  // Concern/benefit overlaps (light)
  const want = [];
  if (f.redness || f.rosacea || f.sensitive) want.push("redness", "sensitive", "barrier", "calm", "soothe");
  if (f.acne || f.oily) want.push("acne", "blemish", "sebum", "clog", "clarify", "oil-control");
  if (f.photoaging || f.pigmentation) want.push("pigmentation", "brighten", "dark spots", "photoaging", "spots");
  const uniqWant = Array.from(new Set(want.map((x) => x.toLowerCase())));
  const lower = (arr) => arr.map((x) => String(x).toLowerCase());
  const hits =
    uniqWant.filter(
      (w) => lower(benefits).includes(w) || lower(concerns).includes(w)
    ).length;
  score += Math.min(1.0, hits * 0.25);

  // Cap and scale to [0,1]
  return Math.max(0, Math.min(1, score / 2.2));
}
