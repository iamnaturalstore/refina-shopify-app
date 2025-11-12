// refina-backend/routes/semantic.js
// Admin-only AI health probes and semantic helpers.
// - Embeddings via REST (v1) using text-embedding-004 (no SDK here).
// - Firestore via shared db wrapper (consistent with the rest of backend).
// - Includes a strict JSON-mode ping endpoint to verify SDK path for generation.

import express from "express";
import { callGemini } from "../bff/ai/gemini.js";
import { db } from "../bff/lib/firestore.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Admin AI ping (SDK JSON mode)
// ─────────────────────────────────────────────────────────────
const PingSchema = {
  type: "OBJECT",
  properties: { ok: { type: "BOOLEAN" } },
  required: ["ok"],
};

// GET /admin/ai-ping
// Verifies SDK JSON-mode + schema and measures end-to-end latency.
router.get("/admin/ai-ping", async (req, res) => {
  const t0 = Date.now();
  try {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const raw = await callGemini('Return {"ok": true} exactly.', {
      model,
      maxOutputTokens: 16,
      responseSchema: PingSchema,
    });
    const tookMs = Date.now() - t0;
    return res.json({
      ok: true,
      tookMs,
      rawHead: typeof raw === "string" ? raw.slice(0, 80) : null,
      __debug: { model },
    });
  } catch (e) {
    const tookMs = Date.now() - t0;
    return res.status(500).json({
      ok: false,
      tookMs,
      err: String(e?.message || e),
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Config (match the rest of the codebase)
// ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.VITE_GEMINI_API_KEY ||
  "";

const EMBED_MODEL = (process.env.GEMINI_EMBED_MODEL || "text-embedding-004").trim(); // e.g. "text-embedding-004"
const TOP_N = Number(process.env.SEMANTIC_TOPN || 200);
const TTL_MS = Number(process.env.SEMANTIC_CACHE_TTL_MS || 5 * 60 * 1000);

// Use v1 like workers/indexer.mjs and routes/recommend.js
const EMBED_BASE = "https://generativelanguage.googleapis.com/v1";

// ─────────────────────────────────────────────────────────────
// In-memory cache: storeId -> { ids: string[], vecs: Float32Array[], ts: number }
// ─────────────────────────────────────────────────────────────
const cache = new Map();
const now = () => Date.now();

function toFloat32(arr) {
  if (arr instanceof Float32Array) return arr;
  return new Float32Array(arr.map(Number));
}
function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1;
}
function normalize(v) {
  const out = toFloat32(v);
  const n = l2norm(out);
  for (let i = 0; i < out.length; i++) out[i] = out[i] / n;
  return out;
}
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // with unit vectors, dot = cosine
}

// ─────────────────────────────────────────────────────────────
// Embeddings via REST (v1) — consistent with the rest of backend
// ─────────────────────────────────────────────────────────────
async function getQueryEmbedding(text, { timeoutMs = 12000 } = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const url = `${EMBED_BASE}/models/${encodeURIComponent(EMBED_MODEL)}:embedContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const mask = k => (k && k.length >= 12 ? k.slice(0,4)+"…"+k.slice(-4) : String(k||"(none)"));
console.log("[GenAI][boot] GEMINI_API_KEY =", mask(process.env.GEMINI_API_KEY));
console.log("[GenAI][boot] GOOGLE_API_KEY =", mask(process.env.GOOGLE_API_KEY));

console.log("[GenAI][embed] using key =", mask(KEY), "model =", EMBED_MODEL || process.env.GEMINI_EMBED_MODEL || "text-embedding-004");

  const body = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: String(text || "") }] },
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`embeddings HTTP ${resp.status}: ${txt.slice(0, 300)}`);
    }

    const data = await resp.json();
    const v = data?.embedding?.values || data?.embedding?.embedding || [];
    if (!Array.isArray(v) || !v.length) throw new Error("Empty embedding from Gemini");
    return normalize(v);
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────────────────────────────────────
// Firestore vector loading (consistent db wrapper)
// ─────────────────────────────────────────────────────────────
async function loadStoreVectors(storeId) {
  const snap = await db.collection("productEmbeddings").doc(storeId).collection("items").get();
  const ids = [];
  const vecs = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const v = d?.vector || d?.v || d?.values; // tolerate prior shapes
    const id = (d?.id || doc.id || "").toString().trim();
    if (id && Array.isArray(v) && v.length) {
      ids.push(id);
      vecs.push(normalize(v));
    }
  });
  return { ids, vecs };
}

async function ensureCache(storeId, force = false) {
  const entry = cache.get(storeId);
  const expired = !entry || now() - entry.ts > TTL_MS;
  if (force || expired) {
    const { ids, vecs } = await loadStoreVectors(storeId);
    cache.set(storeId, { ids, vecs, ts: now() });
  }
  return cache.get(storeId);
}

// ─────────────────────────────────────────────────────────────
// GET /semantic  (mount under /api/search to match your docs)
// e.g. /api/search/semantic?storeId=...&q=...&topN=200&min=0.08&force=1
// ─────────────────────────────────────────────────────────────
router.get("/semantic", async (req, res) => {
  try {
    const storeId = String(req.query.storeId || "").trim();
    const q = String(req.query.q || "").trim();
    const topN = Math.max(1, Math.min(1000, Number(req.query.topN || TOP_N)));
    const min = Math.max(0, Math.min(1, Number(req.query.min || 0.08)));
    const force = String(req.query.force || "") === "1";

    if (!storeId) return res.status(400).json({ error: "storeId required" });
    if (!q) return res.status(400).json({ error: "q required" });

    // Load vectors (cached)
    const { ids, vecs } = await ensureCache(storeId, force);
    if (!ids.length) return res.json({ productIds: [], scores: {}, total: 0 });

    // Embed query
    const qv = await getQueryEmbedding(q);

    // Score and filter
    const scored = [];
    for (let i = 0; i < vecs.length; i++) {
      const score = cosine(qv, vecs[i]); // unit-normalized → dot = cosine
      if (score >= min) scored.push([score, ids[i]]);
    }

    // Sort desc by score
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, topN);
    const productIds = top.map(([, id]) => id);
    const scores = {};
    top.forEach(([s, id]) => (scores[id] = s));

    res.json({ productIds, scores, total: ids.length });
  } catch (err) {
    console.error("semantic error:", err);
    res.status(500).json({ error: "semantic search failed" });
  }
});

export default router;
