#!/usr/bin/env node
// refina-backend/workers/indexer.mjs
// Builds/maintains a store-native entity graph by extracting entities from product text.
// Modes:
//   bootstrap: node workers/indexer.mjs bootstrap --store <storeId> [--limit 5000] [--commit] [--verbose]
//   index:     node workers/indexer.mjs index --store <storeId> --product <productId> [--commit]

import { db, nowTs } from "../bff/lib/firestore.js";
import { callGeminiIndex as callGemini } from "../bff/ai/gemini.js";
import { buildExtractEntitiesPrompt } from "../ai/prompts/extractEntities.js";
import { validateExtractionOutput } from "../ai/jsonSchemas.js";
// NEW: EO denylist for the product-level EO flag
import { EO_DENYLIST } from "../bff/lib/knowledge.js";

// ─────────────────────────────────────────────────────────────
// Progress status (UI reads: indexerStatus/<shop>)
// ─────────────────────────────────────────────────────────────
const STATUS_THROTTLE_MS = 2000; // only write if pct changes or >= 2s passed
const statusState = {
  shop: null,
  total: 0,
  done: 0,
  phase: "preparing",
  lastPct: -1,
  lastWrite: 0,
};


// ─────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────
const ARGS = parseArgs(process.argv.slice(2));
const MODE = ARGS._[0]; // 'bootstrap' | 'index'
const VERBOSE = !!ARGS.verbose;
const STORE = ARGS.store || ARGS.s || "";
const LIMIT = Number(ARGS.limit || 5000);
const COMMIT = !!ARGS.commit;
if (!MODE || !STORE) {
  console.log(
    "Usage:\n" +
      "  node workers/indexer.mjs bootstrap --store <storeId> [--limit 5000] [--commit] [--verbose]\n" +
      "  node workers/indexer.mjs index --store <storeId> --product <productId> [--commit]"
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
const FULL_SCHEMA = { 
  type: "OBJECT",
  properties: {
    product: {
      type: "OBJECT",
      properties: { id: { type: "STRING" } },
      required: ["id"],
    },
    entities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          type: { type: "STRING" },
          synonyms: { type: "ARRAY", items: { type: "STRING" } },
          evidence: { type: "ARRAY", items: { type: "STRING" } }, // <-- THE FIX
          fact: { type: "STRING" },
          cautions: { type: "STRING" },
        },
        required: ["name", "type"],
      },
    },
    specs: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          value: { type: "NUMBER" },
          unit: { type: "STRING" },
        },
        required: ["name"],
      },
    },
    flags: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["product", "entities", "specs", "flags"],
};

// Use the full schema for all attempts
const MIN_SCHEMA = FULL_SCHEMA;
const TINY_SCHEMA = FULL_SCHEMA;


// ─────────────────────────────────────────────────────────────
// Tunables & guards
// ─────────────────────────────────────────────────────────────
const MAX_CONCURRENCY = Number(process.env.REFINA_INDEXER_CONCURRENCY || 6);
const GENCFG = {
  temperature: Number(process.env.REFINA_INDEXER_TEMP ?? 0.2),
  topP: Number(process.env.REFINA_INDEXER_TOPP ?? 0.8),
  maxOutputTokens: Number(process.env.REFINA_INDEXER_MAXTOK_OUT || 2048),
  model: process.env.REFINA_INDEXER_MODEL || "gemini-1.5-flash-001",
};
const LLM_TIMEOUT_MS = Number(process.env.REFINA_INDEXER_TIMEOUT_MS || 30000);
const BATCH_SIZE = 400;

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
    new Promise((_, rej) => setTimeout(() => rej(new Error(tag)), ms)),
  ]);
}

// Light retry helper for transient LLM hiccups
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function callGeminiWithRetry(prompt, cfg, timeoutMs) {
  const backoffs = [0, 250, 500];
  let lastErr;
  for (let i = 0; i < backoffs.length; i++) {
    if (backoffs[i] > 0) await sleep(backoffs[i]);
    try {
      return await withTimeout(callGemini(prompt, cfg), timeoutMs, "timeout");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("llm_failed");
}

// Build canonical text for embeddings (title + short desc + tags)
function productEmbedText(p, descCap = 900) {
  const title = String(p.title || p.name || "").trim();
  const raw = stripHtml(p.description || p.body_html || "");
  const desc = raw.length > descCap ? raw.slice(0, descCap) + "…" : raw;
  const tags = Array.isArray(p.tags)
    ? p.tags
    : typeof p.tags === "string"
      ? p.tags.split(",").map(s => s.trim()).filter(Boolean)
      : [];
  return [title, desc, tags.slice(0, 16).join(", ")].filter(Boolean).join("\n\n");
}

// Pure REST embedding call (no SDK)
async function embedText(text) {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY || "";
  if (!key) return [];

  const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${encodeURIComponent(key)}`;
  const body = {
    model: "models/text-embedding-004",
    content: { parts: [{ text: String(text || "") }] },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.REFINA_EMBED_TIMEOUT_MS || 8000));
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.embedding?.values) ? data.embedding.values.map(Number) : [];
  } catch {
    clearTimeout(timer);
    return [];
  }
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
    specs: p.specs || p.metafields || {},
  };
}

// Read products from Firestore
async function fetchProductsFromFirestore(storeId, limit = 5000) {
  const snap = await db.collection(`products/${storeId}/items`).limit(limit).get();
  const out = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    out.push({
      id: doc.id,
      title: d.title || d.name || "",
      name: d.name || d.title || "",
      description: d.description || d.body_html || "",
      body_html: d.body_html || "",
      tags: d.tags || [],
      productType: d.productType || d.product_type || "",
      productType_norm: d.productType_norm || d.productTypeNormalized || "",
      specs: d.specs || d.metafields || {},
      usageStep: d.usageStep || d.step || "",
      image: d.image || d.images?.[0]?.src || "",
      handle: d.handle || d.url || "",
    });
  });
  return out;
}

async function triggerEnrichment(storeId) {
  const origin = process.env.PUBLIC_BACKEND_ORIGIN || process.env.BACKEND_ORIGIN || "";
  const secret = process.env.ADMIN_SHARED_SECRET || "";
  if (!origin || !secret) return;
  try {
    await fetch(`${origin.replace(/\/+$/,"")}/api/admin/trigger-enrichment?shop=${encodeURIComponent(storeId)}`, {
      method: "POST",
      headers: { "x-admin-secret": secret },
      keepalive: true,
    }).catch(() => {});
    console.log(`[Indexer] enrichment trigger POST ok shop=${storeId}`);
  } catch (e) {
    console.log(`[Indexer] enrichment trigger failed shop=${storeId} err=${e?.message||e}`);
  }
}

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
      if (name) entities.push({ name, type: "ingredient", synonyms: [], evidence: [], fact: "", cautions: "" });
    }
  }
  const mBattery = text.match(/(\d{2,4})\s*(Wh|W|mAh)\b/i);
  if (mBattery) {
    const val = Number(mBattery[1]); const unit = mBattery[2];
    specs.push({ name: "battery", value: val, unit });
    entities.push({ name: unit.toUpperCase() === "WH" ? "Battery (Wh)" : "Power", type: "spec", synonyms: [], evidence: [], fact: "", cautions: "" });
  }
  return { entities: dedupeEntities(entities).slice(0, 24), specs, flags: [] };
}
function dedupeEntities(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) { const key = slugify(e.name); if (key && !seen.has(key)) { seen.add(key); out.push(e); } }
  return out;
}

// Salvage minimal entities from a broken JSON/text blob (LLM fallback)
function salvageEntities(raw = "") {
  const text = String(raw || "").slice(0, 1200);
  const names = new Set();

  // 1) Grab JSON-ish lists like ["alpha","beta"]
  const listMatches = text.match(/\[([^\]]+)\]/g) || [];
  for (const lst of listMatches) {
    lst
      .replace(/[\[\]"]/g, "")
      .split(/[,|•;\/\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3 && s.length <= 40)
      .forEach((s) => names.add(s));
  }

  // 2) Look for “ingredients: …” or “components: …”
  const nearIng = text.match(/(?:ingredients?|components?|actives?)\s*[:\-]\s*([\s\S]{0,300})/i);
  if (nearIng) {
    nearIng[1]
      .split(/[,|•;\/\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3 && s.length <= 40)
      .forEach((s) => names.add(s));
  }

  // 3) Fallback: some capitalized tokens
  const caps = text.match(/\b([A-Z][a-z][A-Za-z\-]{1,30})\b/g) || [];
  caps.slice(0, 20).forEach((s) => names.add(s));

  // Return up to 24 lightweight entities
  return Array.from(names)
    .slice(0, 24)
    .map((n) => ({ name: n, type: "ingredient" }));
}

// ─────────────────────────────────────────────────────────────
// Indexer status helpers (throttled Firestore writes)
// ─────────────────────────────────────────────────────────────
function setStatusShop(shop) {
  statusState.shop = String(shop || "").toLowerCase().trim();
}
function setStatusTotal(n) {
  const v = Math.max(0, Number(n || 0));
  statusState.total = v;
}
function setStatusDone(n) {
  const v = Math.max(0, Number(n || 0));
  statusState.done = v;
}
function setStatusPhase(ph) {
  statusState.phase = ph;
}

async function writeStatus({ force = false, finish = false, error = "" } = {}) {
  if (!statusState.shop) return;
  const total = Math.max(0, statusState.total);
  const done = Math.max(0, statusState.done);
  const pct = total > 0 ? Math.min(100, Math.floor((100 * done) / total)) : 0;
  const now = Date.now();

  const phase = error ? "error" : finish ? "complete" : statusState.phase || "preparing";
  const phaseChanged = phase !== statusState.phase;
  const pctChanged = pct !== statusState.lastPct;
  const timeOk = now - statusState.lastWrite >= STATUS_THROTTLE_MS;

  if (!force && !phaseChanged && !pctChanged && !timeOk) return;

  // assemble doc
  const base = {
    phase,
    total,
    done,
    pct,
    updatedAt: nowTs(),
  };
  if (phase === "preparing" && statusState.lastWrite === 0) {
    base.startedAt = nowTs();
  }
  if (finish || error) {
    base.finishedAt = nowTs();
  }
  if (error) {
    base.error = String(error).slice(0, 300);
  }
  // soft debug fields, harmless in prod
  try { base.workerPid = Number(process.pid); } catch {}
  base.version = 1;

  await db.doc(`indexerStatus/${statusState.shop}`).set(base, { merge: true }).catch(() => {});
  statusState.lastPct = pct;
  statusState.lastWrite = now;
  statusState.phase = phase; // keep local in sync
}

function bumpDone(delta = 1) {
  setStatusDone(statusState.done + Math.max(0, Number(delta || 0)));
  // schedule a best-effort write (throttled)
  return writeStatus();
}


// ─────────────────────────────────────────────────────────────
// KB derivation + write
// ─────────────────────────────────────────────────────────────
function deriveKbFromExtraction(product, extraction) {
  const ents = Array.isArray(extraction?.entities) ? extraction.entities : [];
  const getByType = (t) =>
    ents
      .filter((e) => String(e.type || "").toLowerCase().includes(t))
      .map((e) => e.name) // CORRECTED
      .filter(Boolean);
  
  // Separate ingredients / benefits / concerns when possible
  const ingredients = uniq(getByType("ingredient")).slice(0, 48);
  const benefits = uniq(
    getByType("benefit")
      .concat(getByType("purpose"))
      .concat(getByType("effect"))
  ).slice(0, 32);
  const concerns = uniq(
    getByType("concern")
      .concat(getByType("condition"))
      .concat(getByType("issue"))
  ).slice(0, 32);
  const tags = Array.isArray(product.tags)
    ? product.tags
    : typeof product.tags === "string"
      ? product.tags.split(",").map((s) => s.trim())
      : [];

  const keywords = uniq([...tags.slice(0, 16), ...ents.map((e) => e.name)]).slice(0, 32); // CORRECTED
  const productType = product.productType || "";
  const productType_norm =
    product.productType_norm || product.productTypeNormalized || productType.toLowerCase();
  const usageStep = product.usageStep || product.step || "";

  return {
    productType,
    productType_norm,
    // keep original names
    ingredients,
    benefits,
    concerns,
    keywords,
    usageStep,
    // normalized/sluggy forms used by recommender filters
    ingredientsNormalized: ingredients.map((n) => slugify(n)),
    benefitsNormalized: benefits.map((n) => slugify(n)),
    concernsNormalized: concerns.map((n) => slugify(n)),
  };
}

// NEW: write normalized fields back to the product doc
async function upsertProductNormalizedFields({ storeId, productId, kb }) {
  // EO flag (broad substring match on normalized slugs)
  const hasEO = Array.isArray(kb.ingredientsNormalized)
    ? kb.ingredientsNormalized.some((slug) =>
        EO_DENYLIST.some((ban) => String(slug).includes(ban))
      )
    : false;

  const ref = db.doc(`products/${storeId}/items/${productId}`);
  await ref.set(
    {
      productType_norm: kb.productType_norm || "",
      usageStep: kb.usageStep || "",
      // arrays
      ingredientsNormalized: kb.ingredientsNormalized || [],
      ingredients_norm: kb.ingredientsNormalized || [], // back-compat
      benefitsNormalized: kb.benefitsNormalized || [],
      concernsNormalized: kb.concernsNormalized || [],
      // optional flags container
      ingredientFlags: {
        containsEssentialOil: hasEO,
      },
      // soft breadcrumb for debugging
      kbLastEnrichedAt: nowTs(),
    },
    { merge: true }
  );
}

async function upsertKbProduct({ storeId, product, extraction }) {
  const kb = deriveKbFromExtraction(product, extraction);

  // Write KB doc (unchanged)
  const ref = db.doc(`kb/${storeId}/products/${product.id}`);
  await ref.set(
    {
      ...kb,
      modelVersion: String(GENCFG.model || "").trim() || "unknown",
      schemaVersion: 1,
      lastEnrichedAt: nowTs(),
    },
    { merge: true }
  );

  // NEW: ensure product doc carries normalized fields immediately
  await upsertProductNormalizedFields({
    storeId,
    productId: product.id,
    kb,
  });
}

// ─────────────────────────────────────────────────────────────
// Firestore writes (idempotent + batched)
// ─────────────────────────────────────────────────────────────
async function upsertEntitiesAndLinks({ storeId, productId, extraction, product }) {
  const batch = db.batch();

  // Canonical embedding doc path
  const linkRef = db.doc(`productEmbeddings/${storeId}/items/${productId}`);

  // Correctly map entities to their full names first, then slugify for links
  const entities = Array.isArray(extraction.entities) ? extraction.entities : [];
  const slugs = uniq(entities.map(e => slugify(e.name)));

  // Ensure evidence is properly structured
const evidence = entities
  .filter(e => Array.isArray(e.evidence) && e.evidence.length > 0)
  .map(e => ({
    slug: slugify(e.name),
    evidence: e.evidence.slice(0, 2),
}));

  // Compute & store embedding vector
  const textForEmb = productEmbedText(product);
  const vector = await embedText(textForEmb); // [] if embed call fails

  batch.set(linkRef, {
    productId,
    entities: slugs.slice(0, 64),
    evidence,
    ...(vector.length ? { vector } : {}),
    updatedAt: nowTs(),
    schemaVersion: 1,
  }, { merge: true });

  // Per-product entity facts path (unchanged)
  for (const ent of extraction.entities) {
    const slug = slugify(ent.name);
    if (!slug) continue;
    const ref = db.doc(`products/${storeId}/items/${productId}/entities/${slug}`);
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
      schemaVersion: 1,
    }, { merge: true });
  }

  await batch.commit().catch(async (e) => {
    if (/arrayUnion/i.test(String(e?.message || ""))) {
      const batch2 = db.batch();
      for (const ent of extraction.entities) {
        const slug = slugify(ent.name);
        if (!slug) continue;
        const ref = db.doc(`products/${storeId}/items/${productId}/entities/${slug}`);
        batch2.set(ref, {
          name: ent.name,
          type: ent.type,
          synonyms: uniq(ent.synonyms || []).slice(0, 12),
          fact: String(ent.fact || ""),
          cautions: String(ent.cautions || ""),
          status: String(ent.fact ? "llm" : "stub"),
          confidence: 0.8,
          updatedAt: nowTs(),
          schemaVersion: 1,
        }, { merge: true });
      }
      await batch2.commit();
    } else {
      throw e;
    }
  });
}

// ─────────────────────────────────────────────────────────────
async function extractForProduct({ storeId, product }) {
  async function tryOnce(cap, schema, systemHint) {
    const started = Date.now();
    const prompt = buildExtractEntitiesPrompt({ product: productToPromptInput(product, cap) });
    const cfg = { ...GENCFG, ...(schema ? { responseSchema: schema } : {}), ...(systemHint ? { system: systemHint } : {}) };
    let text;
    try {
      text = await callGeminiWithRetry(prompt, cfg, LLM_TIMEOUT_MS);
    } catch (e) {
      const reason = /timeout/i.test(String(e?.message)) ? "timeout" : "error";
      return { ok: false, reason, ms: Date.now() - started, raw: "" };
    }
    let parsed;
    try { 
      console.log("--- RAW GEMINI OUTPUT FOR EVIDENCE ---:\n", JSON.stringify(text, null, 2))
      parsed = extractJson(text); }
    catch { return { ok: false, reason: "invalid_json", ms: Date.now() - started, raw: String(text || "").slice(0, 400) }; }
    const v = validateExtractionOutput(parsed);
    if (!v.ok) return { ok: false, reason: "schema_invalid", errors: v.errors, ms: Date.now() - started, raw: "" };
    if (v.value.product.id !== String(product.id)) v.value.product.id = String(product.id);
    v.value.specs = Array.isArray(v.value.specs) ? v.value.specs : [];
    v.value.flags = Array.isArray(v.value.flags) ? v.value.flags : [];
    return { ok: true, value: v.value, ms: Date.now() - started };
  }
  let r = await tryOnce(900, null, null);
  if (r.ok) return r;
  if (["invalid_json","timeout","error","schema_invalid"].includes(r.reason)) {
    await new Promise(res => setTimeout(res, 400));
    const r2 = await tryOnce(600, MIN_SCHEMA, 'Output STRICT JSON matching the provided schema. Use double quotes, no comments, no trailing commas.');
    if (r2.ok) return r2;
    await new Promise(res => setTimeout(res, 400));
    const r3 = await tryOnce(450, TINY_SCHEMA, 'Output STRICT JSON matching the schema only. No extra fields.');
    if (r3.ok) return r3;
    const raw = r3.raw || r2.raw || r.raw || "";
    const ents = salvageEntities(raw);
    if (ents.length) {
      return {
        ok: true,
        value: { product: { id: String(product.id) }, entities: ents, specs: [], flags: [] },
        ms: (r3.ms || r2.ms || r.ms || 0),
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
      const products = await fetchProductsFromFirestore(STORE, LIMIT);
      if (!products.length) {
        console.log(JSON.stringify({ ok: true, commit: COMMIT, processed: 0, reason: "no_products" }, null, 2));
        return;
      }
      // ── Progress: prepare status doc ─────────────────────────
      setStatusShop(STORE);
      setStatusTotal(products.length);
      setStatusDone(0);
      setStatusPhase("preparing");

      await writeStatus({ force: true }); // first write
      const limit = pLimit(MAX_CONCURRENCY);
      let processed = 0, wrote = 0, failures = 0, llmMsSum = 0;
      setStatusPhase("indexing");
      await writeStatus({ force: true }); // visible flip from preparing → indexing
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
              raw: r.raw ? String(r.raw).replace(/\s+/g, " ").slice(0, 120) : undefined,
            });
          }
          if (COMMIT) {
            const base = baselineExtractFromText(productToPromptInput(p));
            if (base.entities.length || base.specs.length) {
              await upsertEntitiesAndLinks({
                storeId: STORE,
                productId: p.id,
                extraction: { product: { id: String(p.id) }, ...base },
                product: p,
              });
              await upsertKbProduct({ storeId: STORE, product: p, extraction: base });
              processed++; wrote++;
              // progress: one more embedded/link write completed
              await bumpDone(1);
            } else {
              processed++;
            }
          } else {
            processed++;
          }
          return;
        }
        processed++;
        if (COMMIT) {
          await upsertEntitiesAndLinks({ storeId: STORE, productId: p.id, extraction: r.value, product: p });
          await upsertKbProduct({ storeId: STORE, product: p, extraction: r.value });
          // progress: one more embedded/link write completed
          await bumpDone(1);
          wrote++;
        }
      }));
      await Promise.all(tasks);
      const ms = Date.now() - t0;
      // Ensure we mark completion with 100% if we reached total
      setStatusDone(Math.max(statusState.done, statusState.total));
      await writeStatus({ finish: true, force: true });
      console.log(JSON.stringify({
        ok: true, mode: MODE, commit: COMMIT,
        processed, wrote, failures,
        reasons: reasonCounts,
        samples: VERBOSE ? failedSamples : undefined,
        avgLlmMs: processed ? Math.round(llmMsSum / processed) : 0,
        totalMs: ms,
      }, null, 2));
      if (COMMIT && wrote > 0) {
        await triggerEnrichment(STORE);
      }
    } else if (MODE === "index") {
      const pid = ARGS.product || ARGS.p;
      if (!pid) throw new Error("product id required for index mode");
      const doc = await db.doc(`products/${STORE}/items/${pid}`).get();
      if (!doc.exists) throw new Error(`product not found: ${pid}`);
      const product = { id: doc.id, ...doc.data() };
      // ── Progress for single-product index ───────────────────
      setStatusShop(STORE);
      setStatusTotal(1);
      setStatusDone(0);
      setStatusPhase("preparing");
      await writeStatus({ force: true });
      setStatusPhase("indexing");
      await writeStatus({ force: true });
      const r = await extractForProduct({ storeId: STORE, product });
      if (!r.ok) {
        const base = baselineExtractFromText(productToPromptInput(product));
        if (COMMIT && (base.entities.length || base.specs.length)) {
          await upsertEntitiesAndLinks({
            storeId: STORE,
            productId: product.id,
            extraction: { product: { id: String(product.id) }, ...base },
            product,
          });
          await upsertKbProduct({ storeId: STORE, product, extraction: base });
          await bumpDone(1);
          await writeStatus({ finish: true, force: true });
          console.log(JSON.stringify({ ok: true, mode: MODE, commit: COMMIT, productId: product.id, llmMs: r.ms || 0, fallback: true, reason: r.reason }, null, 2));
          process.exit(0);
        }
        // Keep KB in sync even when not committing entity/link writes
        await upsertKbProduct({ storeId: STORE, product, extraction: base });
        console.log(JSON.stringify({ ok: false, mode: MODE, reason: r.reason, errors: r.errors || [], llmMs: r.ms }, null, 2));
        await writeStatus({ force: true, error: r.reason || "index_failed" });
        process.exit(2);
      }
      if (COMMIT) {
        await upsertEntitiesAndLinks({ storeId: STORE, productId: product.id, extraction: r.value, product });
        await upsertKbProduct({ storeId: STORE, product, extraction: r.value });
        await bumpDone(1);
        await writeStatus({ finish: true, force: true });
      }
      console.log(JSON.stringify({ ok: true, mode: MODE, commit: COMMIT, productId: product.id, llmMs: r.ms }, null, 2));
    } else {
      throw new Error(`unknown mode: ${MODE}`);
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
    try {
      // best-effort: surface the error in UI
      await writeStatus({ force: true, error: e?.message || "indexer_crash" });
    } catch {}
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

// ─────────────────────────────────────────────────────────────
// JSON extractor (kept local to avoid import churn)
// ─────────────────────────────────────────────────────────────
function extractJson(text) {
  // find first {...} or [...] block
  const s = String(text || "");
  const start = s.search(/[\{\[]/);
  if (start < 0) throw new Error("no_json");
  // naive balance parse
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error("unbalanced_json");
  return JSON.parse(s.slice(start, end));
}
