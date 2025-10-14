// refina-backend/routes/enrichment.js
// ESM. Orchestrates on-demand enrichment runs for a store.
// - Triggers your existing indexer.mjs to (re)write KB docs
// - (Optional) kicks off knowledge-pack + mappings steps (hooks included)
// Mount behind admin auth, e.g. app.use("/admin/enrichment", requireAdminAuth, enrichmentRouter)

import express from "express";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { spawn } from "child_process";
import { db } from "../bff/lib/firestore.js";

export const enrichmentRouter = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to your indexer worker
const INDEXER_PATH = resolve(__dirname, "../workers/indexer.mjs");

// --- utilities ---------------------------------------------------------------

function runNode(scriptAbsPath, args = [], env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptAbsPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));

    child.on("close", (code) => {
      // indexer prints a single JSON summary line to stdout at the end—parse it if present
      let parsed = null;
      try {
        const trimmed = out.trim();
        const lastBrace = trimmed.lastIndexOf("}");
        if (lastBrace !== -1) {
          const startBrace = trimmed.lastIndexOf("{", lastBrace);
          if (startBrace !== -1) parsed = JSON.parse(trimmed.slice(startBrace, lastBrace + 1));
        }
      } catch (_) {}
      if (code === 0) return resolveRun({ ok: true, code, stdout: out, stderr: err, parsed });
      return rejectRun(new Error(`[enrich] child exit ${code}\n${err || out}`));
    });
  });
}

function toMyshopifyDomain(id = "") {
  const s = String(id || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

// --- core enrichment steps ---------------------------------------------------

async function enrichProductsBootstrap({ storeId, limit = 5000, commit = true }) {
  const args = ["bootstrap", "--store", storeId, "--limit", String(limit)];
  if (commit) args.push("--commit");
  return runNode(INDEXER_PATH, args, { INDEXER_VERBOSE: "1", INDEXER_LOG_ERRORS: "1" });
}

async function enrichProductsSubset({ storeId, productIds = [], commit = true }) {
  const results = [];
  for (const pid of productIds) {
    const args = ["index", "--store", storeId, "--product", String(pid)];
    if (commit) args.push("--commit");
    // run sequentially to avoid hammering quotas for ad-hoc re-enrich
    // (indexer has its own concurrency when bootstrapping)
    // eslint-disable-next-line no-await-in-loop
    const r = await runNode(INDEXER_PATH, args, { INDEXER_VERBOSE: "1", INDEXER_LOG_ERRORS: "1" });
    results.push({ productId: pid, ok: true, parsed: r.parsed });
  }
  return { ok: true, results };
}

// OPTIONAL hook: rebuild concern→product mappings from KB
// Implement if/when you add the worker; safe no-op otherwise.
async function rebuildMappingsForStore(_storeId) {
  return { ok: true, skipped: true, reason: "not_implemented" };
}

// OPTIONAL hook: backfill knowledge pack for ingredient slugs
// (Global or store-scoped). Safe no-op if not wired yet.
async function backfillKnowledgePack(_storeId) {
  return { ok: true, skipped: true, reason: "not_implemented" };
}

// --- route -------------------------------------------------------------------

/**
 * POST /admin/enrichment/run
 * Body:
 * {
 *   "storeId": "mystore.myshopify.com" | "mystore",
 *   "productIds": ["gid..", "123"] (optional),
 *   "rebuildMissingOnly": true,     (hint for future worker optimization)
 *   "forceModelVersion": "",        (hint; current indexer pins model via env)
 *   "recomputeMappings": false      (optional: run mapping batch at end)
 * }
 */
enrichmentRouter.post("/run", async (req, res) => {
  const started = Date.now();
  try {
    const storeIdRaw = String(req.body?.storeId || "").trim();
    if (!storeIdRaw) return res.status(400).json({ ok: false, error: "storeId required" });

    const storeId = toMyshopifyDomain(storeIdRaw);

    // Optional subset enrichment
    const subset = Array.isArray(req.body?.productIds) ? req.body.productIds.filter(Boolean) : [];
    const recomputeMappings = !!req.body?.recomputeMappings;

    // Sanity: ensure the store exists in our products collection
    const anyProduct = await db.collection(`products/${storeId}/items`).limit(1).get();
    if (anyProduct.empty) {
      return res.status(404).json({ ok: false, error: "no_products_for_store" });
    }

    const steps = {};

    if (subset.length) {
      steps.products = await enrichProductsSubset({ storeId, productIds: subset, commit: true });
    } else {
      // Full/semi-full bootstrap enrichment
      steps.products = await enrichProductsBootstrap({ storeId, limit: Number(req.body?.limit || 5000), commit: true });
    }

    // Knowledge pack (optional, safe no-op if not implemented)
    steps.knowledge = await backfillKnowledgePack(storeId);

    // Mappings (optional, safe no-op if not implemented)
    steps.mappings = recomputeMappings ? await rebuildMappingsForStore(storeId) : { ok: true, skipped: true };

    const payload = {
      ok: true,
      storeId,
      steps,
      totalMs: Date.now() - started,
    };
    return res.json(payload);
  } catch (e) {
    console.error("[enrichment/run] error", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

 /**
  * POST /trigger-enrichment?shop=<storeId>
  * Alias for the worker’s call site. Accepts the shop via query string.
  * Returns 202 immediately and runs enrichment fire-and-forget.
  */
 enrichmentRouter.post("/trigger-enrichment", async (req, res) => {
   try {
     const q = String(req.query?.shop || "").trim();
     const storeId = toMyshopifyDomain(q);
     if (!storeId) return res.status(400).json({ ok: false, error: "shop required" });
 
     // Sanity: ensure the store has products so we don't spin on empties
     const anyProduct = await db.collection(`products/${storeId}/items`).limit(1).get();
     if (anyProduct.empty) {
       return res.status(404).json({ ok: false, error: "no_products_for_store" });
     }
 
     // Fire-and-forget bootstrap enrichment (indexer handles batching/concurrency)
     // Don’t await the child; return 202 so the caller isn’t held up.
     enrichProductsBootstrap({ storeId, limit: 5000, commit: true })
       .then(r => console.log(`[enrich/alias] DONE shop=${storeId} parsed=${!!r.parsed}`))
       .catch(e => console.error(`[enrich/alias] FAIL shop=${storeId}`, e?.message || e));
 
     return res.status(202).json({ ok: true, shop: storeId, queued: true });
   } catch (e) {
     console.error("[enrich/alias] error", e);
     return res.status(500).json({ ok: false, error: "internal_error" });
   }
 });