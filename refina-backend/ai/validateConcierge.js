// refina-backend/ai/validateConcierge.js
// Tiny helper: parse raw model text and validate against ConciergeResponseSchema.
// Returns { ok, value, errors? }. `value` is a minimal normalized object.

import { ConciergeResponseSchema } from "./jsonSchemas.js";

function extractJson(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/```json([\s\S]*?)```/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
    return null;
  }
}

function isStringArray(a) {
  return Array.isArray(a) && a.every((x) => typeof x === "string");
}

export function validateConciergeResponse(raw) {
  const json = extractJson(raw);
  if (!json || typeof json !== "object") {
    return { ok: false, errors: ["not_json"] };
  }

  // Minimal checks aligned to ConciergeResponseSchema requirements
  // required: primary (with id), productIds (array of strings)
  const primary = json.primary;
  const productIds = json.productIds;

  const errs = [];
  if (!primary || typeof primary !== "object") errs.push("primary missing/object");
  if (!primary?.id || typeof primary.id !== "string" || !primary.id.trim()) errs.push("primary.id missing");

  if (!isStringArray(productIds) || productIds.length === 0) errs.push("productIds missing/empty");

  // Optional copy/explanation are free-form; we won't hard fail if absent.
  const explanation =
    json?.explanation?.friendlyParagraph ||
    json?.copy?.why ||
    json?.explanation?.oneLiner ||
    "";

  if (errs.length) return { ok: false, errors: errs };

  // Normalize to consistent shape for the route
  const normalized = {
    primary: { id: String(primary.id).trim() },
    productIds: productIds.map((s) => String(s).trim()).filter(Boolean),
    explanation: String(explanation || "").trim(),
    // pass-through optional fields if present
    alternatives: Array.isArray(json.alternatives) ? json.alternatives : [],
  };

  return { ok: true, value: normalized };
}

export default { validateConciergeResponse };
