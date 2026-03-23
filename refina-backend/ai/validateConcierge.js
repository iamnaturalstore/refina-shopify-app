// refina-backend/ai/validateConcierge.js
// Runtime validator/coercer for the Concierge response (rich Awesome).

function s(x) { return typeof x === "string" ? x.trim() : ""; }
function arr(x) { return Array.isArray(x) ? x : []; }
function shortStr(x, n = 600) { const v = s(x); return v.length > n ? v.slice(0, n - 1).trimEnd() + "…" : v; }

function ok(value) { return { ok: true, value }; }
function bad(msg, value) { return { ok: false, errors: [msg], value }; }

export function validateConciergeResponse(raw) {
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

  // ── Primary ────────────────────────────────────────────────────────────────
  const primary = {};
  primary.id = s(obj?.primary?.id);
  if (primary.id && typeof obj?.primary?.id !== "string") primary.id = String(obj.primary.id).trim();

  const scoreNum = Number(obj?.primary?.score);
  primary.score = Number.isFinite(scoreNum)
    ? Math.max(0, Math.min(1, scoreNum))
    : undefined;

  primary.reasons    = arr(obj?.primary?.reasons).map(s).filter(Boolean).slice(0, 8);
  primary.howToUse   = arr(obj?.primary?.howToUse).map(s).filter(Boolean).slice(0, 8);
  primary.tagsMatched= arr(obj?.primary?.tagsMatched).map(s).filter(Boolean).slice(0, 12);

  // ── Alternatives ───────────────────────────────────────────────────────────
  const alternatives = arr(obj?.alternatives)
    .map(a => ({
      id: s(a?.id),
      when: shortStr(a?.when || "", 120),
      reasons: arr(a?.reasons).map(s).filter(Boolean).slice(0, 4),
    }))
    .filter(a => a.id)
    .slice(0, 4);

  // ── Explanation (object form) ──────────────────────────────────────────────
const explanation = {
  oneLiner:          shortStr(obj?.explanation?.oneLiner || "", 220),
  friendlyParagraph: shortStr(obj?.explanation?.friendlyParagraph || "", 800),
  expertBullets:     arr(obj?.explanation?.expertBullets).map(x => shortStr(x, 200)).slice(0, 8),
};

// ── Copy (back-compat mirrors) ─────────────────────────────────────────────
const copy = {
  why:       shortStr(obj?.copy?.why || explanation.oneLiner || explanation.friendlyParagraph || "", 800),
  rationale: shortStr(obj?.copy?.rationale || arr(explanation.expertBullets).join(" • "), 800),
  extras: shortStr(
  obj?.copy?.extras ||
  arr(explanation.expertBullets).join(" • ") ||
  explanation.friendlyParagraph ||
  explanation.oneLiner ||
  "",
  600
),
};

  // ── Build productIds robustly ──────────────────────────────────────────────
  const modelIds = arr(obj?.productIds).map(s).filter(Boolean);

  // If the model forgot productIds, synthesize them from primary + alternatives
  let productIds;
  if (modelIds.length === 0) {
    // ensure primary.id exists if model only returned productIds/alternatives
    if (!primary.id) {
      const firstAlt = alternatives.length ? alternatives[0].id : "";
      primary.id = s(firstAlt);
    }
    // ── Follow Ups ─────────────────────────────────────────────────────────────
    const followUps = arr(obj?.followUps).map(s).filter(Boolean).slice(0, 3);

    const union = [s(primary.id), ...alternatives.map(a => a.id)].filter(Boolean);
    productIds = Array.from(new Set(union));
  } else {
    // Merge primary + alternatives + modelIds (primary-first order), de-duped
    const merged = [s(primary.id), ...alternatives.map(a => a.id), ...modelIds].filter(Boolean);
    productIds = Array.from(new Set(merged));
  }

  // Cap for downstream fetch/UX
  productIds = productIds.slice(0, 3);

  if (!productIds.length) {
    return bad("no productIds derivable from model output", {
      primary, alternatives, explanation, copy, productIds
    });
  }

  // If primary.id still missing, lift from productIds[0]
  if (!primary.id) primary.id = productIds[0] || "";

  if (!primary.id) {
    return bad("no primary.id", { primary, alternatives, explanation, copy, productIds });
  }

  return ok({ primary, alternatives, explanation, copy, productIds, followUps });
}

export default { validateConciergeResponse };
