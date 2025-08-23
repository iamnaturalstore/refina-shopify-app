/* Category-agnostic retriever + scorer.
   Avoids irrelevant items by weighted text relevance across fields.
*/
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function scoreOne(p, terms, packs) {
  const w = {
    title: 3.0,
    tags: 2.2,
    keywords: 2.0,
    description: 1.6,
    productType: 1.0
  };

  // base scores
  const hay = {
    title: tokenize(p.title),
    tags: (Array.isArray(p.tags) ? p.tags : []).flatMap(tokenize),
    keywords: (Array.isArray(p.keywords) ? p.keywords : []).flatMap(tokenize),
    description: tokenize((p.description || "").slice(0, 800)),
    productType: tokenize(p.productType)
  };

  let score = 0;
  for (const term of terms) {
    if (hay.title.includes(term)) score += w.title;
    if (hay.tags.includes(term)) score += w.tags;
    if (hay.keywords.includes(term)) score += w.keywords;
    if (hay.description.includes(term)) score += w.description;
    if (hay.productType.includes(term)) score += w.productType;
  }

  // optional pack boosts (safe if none)
  if (packs?.boosts?.length) {
    for (const b of packs.boosts) {
      const fieldVal = p[b.field];
      if (Array.isArray(fieldVal)) {
        if (fieldVal.map(v => String(v).toLowerCase()).includes(String(b.value).toLowerCase())) {
          score += Number(b.weight || 0);
        }
      } else if (typeof fieldVal === "string") {
        if (String(fieldVal).toLowerCase() === String(b.value).toLowerCase()) {
          score += Number(b.weight || 0);
        }
      }
    }
  }

  // basic quality checks (prefer buyable products)
  if (p.handle && p.image) score += 0.3;

  return score;
}

function expandTerms(concern, packs) {
  const base = tokenize(concern);
  const add = [];
  if (packs?.synonyms?.length) {
    for (const syn of packs.synonyms) {
      if (base.includes(syn.from)) add.push(...(syn.alts || []));
    }
  }
  return Array.from(new Set([...base, ...add.map(s => s.toLowerCase())]));
}

function rankProductsAgainstConcern({ products, concern, packs }) {
  const terms = expandTerms(concern, packs);
  const scored = [];
  for (const p of products) {
    // filter obvious irrelevancies: no title, no description, or totally missing fields
    if (!p || !p.id || !p.title) continue;
    const s = scoreOne(p, terms, packs);
    if (s <= 0) continue;
    scored.push({ ...p, _score: s });
  }
  scored.sort((a, b) => b._score - a._score || (a.title || "").localeCompare(b.title || ""));
  return scored;
}

/** Deterministic copy from product descriptions when AI is inactive/unavailable */
function shapeCopyFromDescription({ products, concern, category, tone }) {
  const first = products[0] || {};
  const name = first.title || "this pick";
  const concernTxt = concern;
  const why = tone === "bestie"
    ? `I picked ${name} because it lines up nicely with what you mentioned about "${concernTxt}". It’s a solid, no-nonsense match from this store’s range.`
    : `Recommended: ${name}. It aligns strongly with "${concernTxt}" based on the store’s catalogue signals.`;
  const rationale = `Relevance is based on product description, tags, and related keywords that map to "${concernTxt}".`;
  const extras = first.description
    ? `Helpful tip: check the product page for usage guidance and any added benefits mentioned in the description.`
    : `Helpful tip: start low and adjust as needed; always follow the product’s usage directions on the store page.`;

  return { why, rationale, extras };
}

module.exports = { rankProductsAgainstConcern, shapeCopyFromDescription };
