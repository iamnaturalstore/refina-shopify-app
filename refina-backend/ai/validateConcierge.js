// refina-backend/ai/validateConcierge.js
// Runtime validator/coercer for the Concierge response (rich Awesome).

function s(x) { return typeof x === "string" ? x.trim() : ""; }
function arr(x) { return Array.isArray(x) ? x : []; }
function shortStr(x, n = 600) { const v = s(x); return v.length > n ? v.slice(0, n - 1).trimEnd() + "…" : v; }

export function validateConciergeResponse(raw) {
  const errors = [];
  if (!raw || !s(raw)) return bad("empty model text");

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    // handle ```json fences if present
    const m = raw.match(/```json([\s\S]*?)```/i);
    if (m) {
      try { obj = JSON.parse(m[1]); } catch {}
    }
  }
  if (!obj || typeof obj !== "object") return bad("non-JSON response");

  // Primary
  const primary = {};
  primary.id = s(obj?.primary?.id);
  primary.score = Number.isFinite(Number(obj?.primary?.score)) ? Number(obj.primary.score) : undefined;
  primary.reasons = arr(obj?.primary?.reasons).map(s).filter(Boolean).slice(0, 8);
  primary.howToUse = arr(obj?.primary?.howToUse).map(s).filter(Boolean).slice(0, 8);
  primary.tagsMatched = arr(obj?.primary?.tagsMatched).map(s).filter(Boolean).slice(0, 12);
  if (!primary.id) errors.push("primary.id missing");

  // Alts
  const alternatives = arr(obj?.alternatives)
    .map(a => ({
      id: s(a?.id),
      when: shortStr(a?.when || "", 120),
      reasons: arr(a?.reasons).map(s).filter(Boolean).slice(0, 4),
    }))
    .filter(a => a.id)
    .slice(0, 4);

  // Explanation (object form)
  const explanation = {
    oneLiner: shortStr(obj?.explanation?.oneLiner || "", 220),
    friendlyParagraph: shortStr(obj?.explanation?.friendlyParagraph || "", 800),
    expertBullets: arr(obj?.explanation?.expertBullets).map(x => shortStr(x, 200)).slice(0, 8),
    usageTips: arr(obj?.explanation?.usageTips).map(x => shortStr(x, 160)).slice(0, 8),
  };

  // Copy (back-compat text mirrors)
  const copy = {
    why: shortStr(obj?.copy?.why || explanation.oneLiner || explanation.friendlyParagraph || "", 800),
    rationale: shortStr(obj?.copy?.rationale || arr(explanation.expertBullets).join(" • "), 800),
    extras: shortStr(obj?.copy?.extras || arr(explanation.usageTips).join(" • "), 600),
  };

  /// Ensure primary.id exists if model only returned productIds/alternatives
if (!primary.id) {
  const firstFromProductIds = Array.isArray(obj?.productIds) && obj.productIds.length ? String(obj.productIds[0] || "").trim() : "";
  const firstAlt = alternatives.find(a => a && a.id)?.id || "";
  primary.id = (firstFromProductIds || firstAlt || "").trim();
}

// Build productIds as a unique, ordered union (primary → alternatives → model.productIds)
const altIds = alternatives.map(a => String(a.id || "").trim()).filter(Boolean);
const modelIds = (Array.isArray(obj?.productIds) ? obj.productIds : []).map(x => String(x || "").trim()).filter(Boolean);

const ordered = [primary.id, ...altIds, ...modelIds].filter(Boolean);
const uniq = Array.from(new Set(ordered));

// Final, capped list (keep it small for UI + downstream fetches)
const productIds = uniq.slice(0, 3);

// If we still have nothing, fail validation gracefully
if (!productIds.length) {
  return { ok: false, errors: ["no productIds derivable from model output"] };
}

// Expose back
out.primary = primary;
out.alternatives = alternatives;
out.productIds = productIds;

  // de-dupe & cap
  productIds = Array.from(new Set(productIds)).slice(0, 5);

  if (!primary.id) return bad("no primary.id", { primary, alternatives, explanation, copy, productIds });

  return ok({ primary, alternatives, explanation, copy, productIds });
}

function ok(value) { return { ok: true, value }; }
function bad(msg, value) { return { ok: false, errors: [msg], value }; }

export default { validateConciergeResponse };
