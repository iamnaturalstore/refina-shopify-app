// refina-backend/routes/semantic.js
import express from "express";
import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "text-embedding-004"; // or 3-large
const TOP_N = Number(process.env.SEMANTIC_TOPN || 200);
const TTL_MS = Number(process.env.SEMANTIC_CACHE_TTL_MS || 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Lazy clients
// ─────────────────────────────────────────────────────────────
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// storeId -> { ids: string[], vecs: Float32Array[], ts: number }
const cache = new Map();

function now() {
  return Date.now();
}

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
  return s;
}

async function getQueryEmbedding(text) {
  if (!genAI) throw new Error("GEMINI_API_KEY not configured");
  const model = genAI.getGenerativeModel({ model: EMBED_MODEL });
  // @google/generative-ai v2 style: model.embedContent({ content: text })
  const res = await model.embedContent(text);
  const v = res?.embedding?.values || res?.embedding?.embedding || [];
  if (!v || !v.length) throw new Error("Empty embedding from Gemini");
  return normalize(v);
}

async function loadStoreVectors(storeId) {
  const db = admin.firestore();
  const snap = await db.collection("productEmbeddings").doc(storeId).collection("items").get();
  const ids = [];
  const vecs = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const v = d?.v || d?.vector || d?.values;
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

// GET /api/search/semantic?storeId=...&q=...&topN=200&min=0.08&force=1
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
    if (!ids.length) return res.json({ productIds: [], scores: {} });

    // Embed query
    const qv = await getQueryEmbedding(q);

    // Score
    const scored = [];
    for (let i = 0; i < vecs.length; i++) {
      const score = cosine(qv, vecs[i]); // vectors are unit-normalized → cosine
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
