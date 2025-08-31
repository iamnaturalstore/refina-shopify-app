// refina-backend/ai/jsonSchemas.js
// Lightweight validators (no extra deps). Each returns { ok, value, errors? }.

export function validateExtractionOutput(obj) {
  const errors = [];
  const out = { product: { id: "" }, entities: [], specs: [], flags: [] };

  if (!obj || typeof obj !== "object") return bad("root not object");

  // product
  if (!obj.product || typeof obj.product !== "object") errors.push("product missing/object");
  const pid = safeString(obj?.product?.id);
  if (!pid) errors.push("product.id missing");
  out.product.id = pid;

  // entities
  if (Array.isArray(obj.entities)) {
    out.entities = obj.entities.slice(0, 64).map((e, i) => {
      const name = safeString(e?.name);
      const type = safeString(e?.type);
      const synonyms = Array.isArray(e?.synonyms) ? e.synonyms.slice(0, 8).map(safeString).filter(Boolean) : [];
      const evidence = Array.isArray(e?.evidence) ? e.evidence.slice(0, 2).map(limitLen(safeString, 240)).filter(Boolean) : [];
      const fact = limitLen(safeString, 240)(e?.fact || "");
      const cautions = limitLen(safeString, 160)(e?.cautions || "");
      if (!name || !type) errors.push(`entities[${i}] missing name/type`);
      return { name, type, synonyms, evidence, fact, cautions };
    }).filter(e => e.name && e.type);
  } else if (obj.entities != null) {
    errors.push("entities not array");
  }

  // specs
  if (Array.isArray(obj.specs)) {
    out.specs = obj.specs.slice(0, 32).map((s, i) => ({
      name: safeString(s?.name),
      value: typeof s?.value === "number" ? s.value : safeNumber(s?.value),
      unit: safeString(s?.unit)
    })).filter(s => s.name);
  } else if (obj.specs != null) {
    errors.push("specs not array");
  }

  // flags
  if (Array.isArray(obj.flags)) {
    out.flags = obj.flags.slice(0, 16).map(safeString).filter(Boolean);
  } else if (obj.flags != null) {
    errors.push("flags not array");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export function validateQueryToEntitiesOutput(obj) {
  if (!obj || typeof obj !== "object") return bad("root not object");
  const entities = Array.isArray(obj.entities) ? obj.entities.slice(0, 12).map(safeString).filter(Boolean) : [];
  if (!entities.length) return bad("entities empty");
  return { ok: true, value: { entities } };
}

function safeString(x) { return typeof x === "string" ? x.trim() : ""; }
function safeNumber(x) { const n = Number(x); return Number.isFinite(n) ? n : undefined; }
function limitLen(fn, max) { return (x) => { const s = fn(x); if (!s) return ""; return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s; }; }
function bad(msg) { return { ok: false, errors: [msg] }; }
