#!/usr/bin/env node
// refina-backend/workers/indexer.mjs
// Builds/maintains a store-native entity graph by extracting entities from product text.
// Modes:
//   bootstrap: node workers/indexer.mjs bootstrap --store <storeId> [--limit 1000] [--commit] [--verbose]
//   index:     node workers/indexer.mjs index --store <storeId> --product <productId> [--commit]

import { db, nowTs } from "../bff/lib/firestore.js";
import { callGemini } from "../bff/ai/gemini.js";
import { buildExtractEntitiesPrompt } from "../ai/prompts/extractEntities.js";
import { validateExtractionOutput } from "../ai/jsonSchemas.js";

// ─────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────
const ARGS = parseArgs(process.argv.slice(2));
const MODE = ARGS._[0]; // 'bootstrap' | 'index'
const VERBOSE = !!ARGS.verbose;
const STORE = ARGS.store || ARGS.s || "";
const LIMIT = Number(ARGS.limit || 1000);
const COMMIT = !!ARGS.commit;
if (!MODE || !STORE) {
  console.log(
    "Usage:\n" +
      "  node workers/indexer.mjs bootstrap --store <storeId> [--limit 1000] [--commit] [--verbose]\n" +
      "  node workers/indexer.mjs index --store <storeId> --product <productId> [--commit]"
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Minimal response schemas (Gemini REST subset)
// ─────────────────────────────────────────────────────────────
const MIN_SCHEMA = {
  type: "OBJECT",
  properties: {
    product: {
      type: "OBJECT",
      properties: { id: { type: "STRING" } },
      required: ["id"]
    },
    entities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          type: { type: "STRING" },
          synonyms: { type: "ARRAY", items: { type: "STRING" } },
          fact: { type: "STRING" },
          cautions: { type: "STRING" }
        },
        required: ["name", "type"]
      }
    },
    specs: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          value: { type: "NUMBER" },
          unit: { type: "STRING" }
        },
        required: ["name"]
      }
    },
    flags: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["product", "entities", "specs", "flags"]
};

const TINY_SCHEMA = {
  type: "OBJECT",
  properties: {
    product: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] },
    entities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, type: { type: "STRING" } },
        required: ["name", "type"]
      }
    }
  },
  required: ["product", "entities"]
};

// ─────────────────────────────────────────────────────────────
// Tunables & guards
// ─────────────────────────────────────────────────────────────
const MAX_CONCURRENCY = Number(process.env.REFINA_INDEXER_CONCURRENCY || 6);
const GENCFG = {
  temperature: Number(process.env.REFINA_INDEXER_TEMP ?? 0),
  topP: Number(process.env.REFINA_INDEXER_TOPP ?? 0.3),
  maxOutputTokens: Number(process.env.REFINA_INDEXER_MAXTOK_OUT || 1024), // ↑ default to avoid truncation
  model: process.env.REFINA_INDEXER_MODEL || "gemini-1.5-flash",
  responseMimeType: "application/json"
};
const LLM_TIMEOUT_MS = Number(process.env.REFINA_INDEXER_TIMEOUT_MS || 14000);
const BATCH_SIZE = 400; // Firestore batch cap

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function stripHtml(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function slugify(s) {
  return String(s || "")
    .toLowerCase().normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, "-");
}
function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }
function withTimeout(promise, ms, tag = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(tag)), ms))
  ]);
}

// Tolerant JSON repair
function repairJson(text = "") {
  let s = String(text || "");
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  s = m ? m[1] : s;
  s = s
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/^\uFEFF/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*(\}|\])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_all, inner) => `"${inner.replace(/"/g, '\\"')}"`)
    .replace(/:\s+/g, ": ");
  return s.trim();
}

function extractJson(text = "") {
  const raw = String(text).trim();
  try { return JSON.parse(raw); } catch {}
  const a = raw.indexOf("{"); const b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) {
    const body = raw.slice(a, b + 1);
    try { return JSON.parse(body); } catch {
      const repaired = repairJson(body);
      try { return JSON.parse(repaired); } catch {}
    }
  }
  const repairedAll = repairJson(raw);
  try { return JSON.parse(repairedAll); } catch {}
  throw new Error("invalid_json");
}

// FINAL RESORT: salvage truncated entity list from partial text
function salvageEntities(raw = "") {
  const out = [];
  const seen = new Set();
  const s = String(raw);
  const re = /"name"\s*:\s*"([^"]{2,80})"\s*,\s*"type"\s*:\s*"([^"]{3,30})"/gi;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].trim();
    const type = m[2].trim().toLowerCase();
    if (!name || !type) continue;
    const key = slugify(name) + "|" + type;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, type, synonyms: [], fact: "", cautions: "" });
    if (out.length >= 24) break;
  }
  return out;
}

async function fetchProducts(storeId, limit = 1000) {
  const out = [];
  const snap = await db.collection(`products/${storeId}/items`).limit(limit).get();
  snap.forEach(d => out.push({ id: d.id, ...d.data(), storeId }));
  return out;
}

function productToPromptInput(p, cap = 900) {
  const raw = stripHtml(p.description || p.body_html || "");
  const desc = raw.length > cap ? raw.slice(0, cap) + "…" : raw;
  const tags = Array.isArray(p.tags)
    ? p.tags
    : typeof p.tags === "string"
    ? p.tags.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  return {
    id: p.id,
    title: p.title || p.name || "",
    description: desc,
    tags: tags.slice(0, 16),
    specs: p.specs || p.metafields || {}
  };
}

// Heuristic baseline extractor (used only if LLM fails with no salvage)
function baselineExtractFromText(product) {
  const text = [String(product.description || ""), (product.tags || []).join(", ")].join("\n");
  const entities = [];
  const specs = [];
  const ing = text.match(/(?:ingredients?|components?|specs?)\s*[:\-]\s*([\s\S]{0,300})/i);
  if (ing) {
    const chunk = ing[1];
    const parts = chunk.split(/[,•|;/\n]+/).map(s => s.trim()).filter(s => s.length >= 3 && s.length <= 40);
    for (const part of parts.slice(0, 20)) {
      if (/^\d/.test(part)) continue;
      const name = part.replace(/\s{2,}/g," ").trim();
      if (name) entities.push({ name, type: "ingredient", synonyms: [], fact: "", cautions: "" });
    }
  }
  const mBattery = text.match(/(\d{2,4})\s*(Wh|W|mAh)\b/i);
  if (mBattery) {
    const val = Number(mBattery[1]); const unit = mBattery[2];
    specs.push({ name: "battery", value: val, unit });
    entities.push({ name: unit.toUpperCase() === "WH" ? "Battery (Wh)" : "Power", type: "spec", synonyms: [], fact: "", cautions: "" });
  }
  return { entities: dedupeEntities(entities).slice(0, 24), specs, flags: [] };
}
function dedupeEntities(list) {
  const seen = new Set(); const out = [];
  for (const e of list) { const key = slugify(e.name); if (key && !seen.has(key)) { seen.add(key); out.push(e); } }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Firestore writes (idempotent + batched)
// ─────────────────────────────────────────────────────────────
async function upsertEntitiesAndLinks({ storeId, productId, extraction }) {
  const batch = db.batch();

  // Link doc (product → entity slugs + optional evidence)
  const linkRef = db.doc(`stores/${storeId}/entityIndex/${productId}`);
  const slugs = uniq(extraction.entities.map(e => slugify(e.name)));
  const evidence = (extraction.entities || []).map(e => ({
    slug: slugify(e.name),
    evidence: (Array.isArray(e.evidence) ? e.evidence : []).slice(0, 2)
  }));
  batch.set(linkRef, {
    productId,
    entities: slugs.slice(0, 64),
    evidence,
    updatedAt: nowTs(),
    schemaVersion: 1
  }, { merge: true });

  // Entity docs (store-scoped)
  for (const ent of extraction.entities) {
    const slug = slugify(ent.name);
    if (!slug) continue;
    const ref = db.doc(`stores/${storeId}/entities/${slug}`);
    batch.set(ref, {
      name: ent.name,
      type: ent.type,
      synonyms: uniq(ent.synonyms || []).slice(0, 12),
      fact: String(ent.fact || ""),
      cautions: String(ent.cautions || ""),
      status: String(ent.fact ? "llm" : "stub"),
      confidence: 0.8,
      examples: db.FieldValue?.arrayUnion?.(productId) ?? productId,
      updatedAt: nowTs(),
      schemaVersion: 1
    }, { merge: true });
  }

  // Commit with chunking safeguard
  await batch.commit().catch(async (e) => {
    if (/arrayUnion/i.test(String(e?.message || ""))) {
      const batch2 = db.batch();
      for (const ent of extraction.entities) {
        const slug = slugify(ent.name);
        if (!slug) continue;
        const ref = db.doc(`stores/${storeId}/entities/${slug}`);
        batch2.set(ref, {
          name: ent.name,
          type: ent.type,
          synonyms: uniq(ent.synonyms || []).slice(0, 12),
          fact: String(ent.fact || ""),
          cautions: String(ent.cautions || ""),
          status: String(ent.fact ? "llm" : "stub"),
          confidence: 0.8,
          updatedAt: nowTs(),
          schemaVersion: 1
        }, { merge: true });
      }
      await batch2.commit();
    } else {
      throw e;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// LLM extraction per product (3 attempts, then salvage)
// ─────────────────────────────────────────────────────────────
async function extractForProduct({ storeId, product }) {
  async function tryOnce(cap, schema, systemHint) {
    const started = Date.now();
    const prompt = buildExtractEntitiesPrompt({ product: productToPromptInput(product, cap) });
    const cfg = { ...GENCFG, ...(schema ? { responseSchema: schema } : {}), ...(systemHint ? { system: systemHint } : {}) };

    let text;
    try {
      text = await withTimeout(callGemini(prompt, cfg), LLM_TIMEOUT_MS, "timeout");
    } catch (e) {
      const reason = /timeout/i.test(String(e?.message)) ? "timeout" : "error";
      return { ok: false, reason, ms: Date.now() - started, raw: "" };
    }

    let parsed;
    try { parsed = extractJson(text); }
    catch { return { ok: false, reason: "invalid_json", ms: Date.now() - started, raw: String(text || "").slice(0, 400) }; }

    const v = validateExtractionOutput(parsed);
    if (!v.ok) return { ok: false, reason: "schema_invalid", errors: v.errors, ms: Date.now() - started, raw: "" };

    if (v.value.product.id !== String(product.id)) v.value.product.id = String(product.id);
    v.value.specs = Array.isArray(v.value.specs) ? v.value.specs : [];
    v.value.flags = Array.isArray(v.value.flags) ? v.value.flags : [];
    return { ok: true, value: v.value, ms: Date.now() - started };
  }

  // A) No schema
  let r = await tryOnce(900, null, null);
  if (r.ok) return r;

  // B) Minimal schema
  if (["invalid_json","timeout","error","schema_invalid"].includes(r.reason)) {
    await new Promise(res => setTimeout(res, 400));
    const r2 = await tryOnce(600, MIN_SCHEMA, 'Output STRICT JSON matching the provided schema. Use double quotes, no comments, no trailing commas.');
    if (r2.ok) return r2;

    // C) Tiny schema
    await new Promise(res => setTimeout(res, 400));
    const r3 = await tryOnce(450, TINY_SCHEMA, 'Output STRICT JSON matching the schema only. No extra fields.');
    if (r3.ok) return r3;

    // D) Salvage from any partial raw text
    const raw = r3.raw || r2.raw || r.raw || "";
    const ents = salvageEntities(raw);
    if (ents.length) {
      return {
        ok: true,
        value: { product: { id: String(product.id) }, entities: ents, specs: [], flags: [] },
        ms: (r3.ms || r2.ms || r.ms || 0)
      };
    }
    return r3.ms ? r3 : r2.ms ? r2 : r;
  }
  return r;
}

// ─────────────────────────────────────────────────────────────
// Concurrency control
// ─────────────────────────────────────────────────────────────
function pLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (!queue.length || active >= n) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then((v) => { active--; resolve(v); next(); })
        .catch((e) => { active--; reject(e); next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
(async function main() {
  console.log(`[Indexer] start mode=${MODE} store=${STORE} commit=${COMMIT} limit=${LIMIT}`);
  const t0 = Date.now();

  try {
    if (MODE === "bootstrap") {
      const products = await fetchProducts(STORE, LIMIT);
      if (!products.length) {
        console.log(JSON.stringify({ ok: true, commit: COMMIT, processed: 0, reason: "no_products" }, null, 2));
        return;
      }
      const limit = pLimit(MAX_CONCURRENCY);
      let processed = 0, wrote = 0, failures = 0, llmMsSum = 0;
      const reasonCounts = {};
      const failedSamples = [];

      const tasks = products.map((p) => limit(async () => {
        const r = await extractForProduct({ storeId: STORE, product: p });
        llmMsSum += r.ms || 0;

        if (!r.ok) {
          failures++;
          reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
          if (failedSamples.length < 10) {
            failedSamples.push({
              id: p.id,
              reason: r.reason,
              raw: r.raw ? String(r.raw).replace(/\s+/g, " ").slice(0, 120) : undefined
            });
          }

          // Heuristic fallback
          if (COMMIT) {
            const base = baselineExtractFromText(productToPromptInput(p));
            if (base.entities.length || base.specs.length) {
              await upsertEntitiesAndLinks({
                storeId: STORE,
                productId: p.id,
                extraction: { product: { id: String(p.id) }, ...base }
              });
              processed++; wrote++;
            }
          }
          return;
        }

        processed++;
        if (COMMIT) {
          await upsertEntitiesAndLinks({ storeId: STORE, productId: p.id, extraction: r.value });
          wrote++;
        }
      }));

      await Promise.all(tasks);
      const ms = Date.now() - t0;
      console.log(JSON.stringify({
        ok: true, mode: MODE, commit: COMMIT,
        processed, wrote, failures,
        reasons: reasonCounts,
        samples: VERBOSE ? failedSamples : undefined,
        avgLlmMs: processed ? Math.round(llmMsSum / processed) : 0,
        totalMs: ms
      }, null, 2));
    } else if (MODE === "index") {
      const pid = ARGS.product || ARGS.p;
      if (!pid) throw new Error("product id required for index mode");
      const doc = await db.doc(`products/${STORE}/items/${pid}`).get();
      if (!doc.exists) throw new Error(`product not found: ${pid}`);
      const product = { id: doc.id, ...doc.data() };

      const r = await extractForProduct({ storeId: STORE, product });
      if (!r.ok) {
        if (COMMIT) {
          const base = baselineExtractFromText(productToPromptInput(product));
          if (base.entities.length || base.specs.length) {
            await upsertEntitiesAndLinks({
              storeId: STORE,
              productId: product.id,
              extraction: { product: { id: String(product.id) }, ...base }
            });
            console.log(JSON.stringify({ ok: true, mode: MODE, commit: COMMIT, productId: product.id, llmMs: r.ms || 0, fallback: true, reason: r.reason }, null, 2));
            process.exit(0);
          }
        }
        console.log(JSON.stringify({ ok: false, mode: MODE, reason: r.reason, errors: r.errors || [], llmMs: r.ms }, null, 2));
        process.exit(2);
      }

      if (COMMIT) await upsertEntitiesAndLinks({ storeId: STORE, productId: product.id, extraction: r.value });
      console.log(JSON.stringify({ ok: true, mode: MODE, commit: COMMIT, productId: product.id, llmMs: r.ms }, null, 2));
    } else {
      throw new Error(`unknown mode: ${MODE}`);
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
    process.exit(1);
  }
})();

// ─────────────────────────────────────────────────────────────
// mini arg parser (no deps)
// ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
      out[k] = v;
    } else if (a.startsWith("-")) {
      const k = a.slice(1);
      const v = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}
