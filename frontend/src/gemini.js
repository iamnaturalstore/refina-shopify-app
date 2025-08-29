// src/gemini.js
// Production-safe client wrapper: NO direct LLM calls from the browser.
// Delegates to BFF at /proxy/refina/v1/recommend and adapts the response
// to the legacy shape expected by callers of getGeminiResponse().

//
// ───────────────────────────
// Domain intents (normalized)
// ───────────────────────────
function detectHairIntent(text = "") {
  const s = String(text || "").toLowerCase();
  return /\bhair|scalp|shampoo|conditioner|styling|frizz|curly|curl\b/.test(s);
}
function detectMakeupIntent(text = "") {
  const s = String(text || "").toLowerCase();
  return (
    /\bmake(?:up)?\b/.test(s) ||
    /\blip(?:stick| oil| tint| stain| whip)?\b/.test(s) ||
    /\bmascara\b|\bconcealer\b|\bblush\b|\beyeliner\b|\beyeshadow\b/.test(s)
  );
}
function detectBodyIntent(text = "") {
  const s = String(text || "").toLowerCase();
  return /\bbody\b|\bhand\b|\bfoot\b|\bleg\b|\bshower\b|\bkp\b|\bkeratosis\b/.test(s);
}

// Hair product check (kept for potential client-side hints only)
function isHairProduct(p = {}) {
  const t = String(p.productType || "").toLowerCase();
  const tags = (p.tags || []).map((x) => String(x).toLowerCase());
  const kw = (p.keywords || []).map((x) => String(x).toLowerCase());
  const hay = [t, (p.category || "").toLowerCase(), (p.description || "").toLowerCase(), ...tags, ...kw].join(" ");
  return /\bhair|scalp|shampoo|conditioner|spray|hairspray|styling|frizz|curl\b/.test(hay);
}

// Optional, light client-side type token bias (not sent to BFF; BFF does the heavy lifting)
function filterByTypeToken(concern, products) {
  const tokens = String(concern || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return products;
  const TYPE_HINTS = new Set([
    "cleanser","wash","toner","essence","serum","treatment","exfoliator","exfoliant",
    "moisturiser","moisturizer","mask","sunscreen","spf","oil","shampoo","conditioner",
    "spray","hairspray","gel","mousse","leave-in","lotion","butter","cream"
  ]);
  const typeToken = tokens.find((w) =>
    TYPE_HINTS.has(w) ||
    products.some((p) =>
      String(p.productTypeNormalized || p.productType || "")
        .toLowerCase()
        .includes(w)
    )
  );
  if (!typeToken) return products;
  const filtered = products.filter((p) =>
    String(p.productTypeNormalized || p.productType || "")
      .toLowerCase()
      .includes(typeToken)
  );
  return filtered.length >= 3 ? filtered : products;
}

//
// ───────────────────────────
// Follow-up heuristics (UI chips)
// ───────────────────────────
function heuristicFollowUps(concern = "") {
  const ups = [];
  if (detectHairIntent(concern)) {
    ups.push("Oil or serum for your hair?", "Focus on scalp or lengths?", "Frizz control or curl definition?");
  } else if (detectMakeupIntent(concern)) {
    ups.push("Lip oil or lipstick?", "Matte or dewy finish?", "Do you prefer clean/vegan formulas?");
  } else if (detectBodyIntent(concern)) {
    ups.push("Lotion or body butter?", "Scented or unscented?", "Target KP/bumps specifically?");
  } else {
    ups.push("Any sensitivities or allergies?", "Preferred texture: gel, oil, or cream?", "Budget under $50?");
  }
  return ups.slice(0, 3);
}

//
// ───────────────────────────
// Response mapping helpers
// ───────────────────────────
function buildReasonsByIdFromEnriched(enriched) {
  const reasonsById = {};
  if (!enriched || typeof enriched !== "object") return reasonsById;

  const pri = enriched.primary || {};
  if (pri.id && Array.isArray(pri.reasons) && pri.reasons.length) {
    reasonsById[pri.id] = "• " + pri.reasons.join("\n• ");
  }

  const alts = Array.isArray(enriched.alternatives) ? enriched.alternatives : [];
  for (const a of alts) {
    if (a.id && Array.isArray(a.reasons) && a.reasons.length) {
      reasonsById[a.id] = "• " + a.reasons.join("\n• ");
    }
  }
  return reasonsById;
}

function buildScoresByIdFromEnriched(enriched) {
  const scoresById = {};
  if (!enriched || typeof enriched !== "object") return scoresById;

  const pri = enriched.primary || {};
  if (pri.id && typeof pri.score === "number") scoresById[pri.id] = Math.max(0, Math.min(1, pri.score));

  // You can add alt scores later if your BFF provides them.
  return scoresById;
}

//
// ───────────────────────────
// Public API (browser)
// ───────────────────────────
/**
 * Calls the BFF to get concierge picks. No API keys on the client.
 *
 * @param {Object} args
 * @param {string} args.concern - user concern text
 * @param {string} [args.category] - optional, for local hints only
 * @param {string} [args.tone] - optional, for local hints only
 * @param {Array}  [args.products] - optional client-side list (used only for minor UI hints)
 * @param {Object} [args.context] - optional session context (not sent to BFF)
 * @param {number} [args.maxPicks=3] - desired number of picks
 * @returns {Promise<{productIds: string[], explanation: string, followUps: string[], reasonsById: Record<string,string>, scoresById: Record<string,number>, enriched?: any, meta?: any}>}
 */
export async function getGeminiResponse({
  concern,
  category,
  tone,
  products = [],
  context = null,
  maxPicks = 3
}) {
  // Optional local hints (do not affect BFF; purely for future UI affordances)
  let hinted = Array.isArray(products) ? products : [];
  if (detectHairIntent(concern)) {
    const hair = hinted.filter(isHairProduct);
    if (hair.length >= 3) hinted = hair;
  }
  hinted = filterByTypeToken(concern, hinted);

  try {
    // Call your BFF (Shopify App Proxy path). The BFF derives storeId from HMAC.
    const res = await fetch("/proxy/refina/v1/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Keep payload minimal: the BFF fetches catalog + settings and handles plan gating.
      body: JSON.stringify({ concern: String(concern || "").trim() })
    });

    if (!res.ok) throw new Error(`BFF HTTP ${res.status}`);
    const payload = await res.json();

    // Expecting: { productIds, products[], copy{why,rationale,extras}, enriched?, meta? }
    const productIds = Array.isArray(payload.productIds) ? payload.productIds.slice(0, Number(maxPicks) || 3) : [];
    const enriched = payload.enriched || null;

    // Prefer enriched concierge paragraph; fall back to legacy copy.why or explanation
    const friendly =
      (enriched && enriched.explanation && (enriched.explanation.friendlyParagraph || enriched.explanation.oneLiner)) ||
      (payload.explanation || "") ||
      (payload.copy && payload.copy.why) ||
      "";

    // Build reasons/scores maps if enriched is present
    const reasonsById = buildReasonsByIdFromEnriched(enriched);
    const scoresById  = buildScoresByIdFromEnriched(enriched);

    // Follow-ups: if you later add followUps server-side, prefer them; else heuristic
    const followUps = Array.isArray(payload.followUps) && payload.followUps.length
      ? payload.followUps.slice(0, 3)
      : heuristicFollowUps(concern);

    return {
      productIds,
      explanation: String(friendly || "").trim(),
      followUps,
      reasonsById,
      scoresById,
      enriched,
      meta: payload.meta || {}
    };
  } catch (err) {
    // Network or server error — keep UI responsive with a graceful fallback
    console.error("❌ Concierge error:", err?.message || err);
    return {
      productIds: [],
      explanation: "Sorry, I couldn’t fetch expert suggestions right now.",
      followUps: heuristicFollowUps(concern),
      reasonsById: {},
      scoresById: {},
      enriched: null,
      meta: { source: "client-fallback" }
    };
  }
}
