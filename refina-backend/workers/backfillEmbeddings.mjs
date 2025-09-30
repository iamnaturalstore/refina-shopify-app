#!/usr/bin/env node
// One-off embedding backfill: writes { vector } into productEmbeddings/{store}/items/{productId}
import { db } from "../bff/lib/firestore.js";

// REST embed (same as indexer)
async function embed(text) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${encodeURIComponent(key)}`;
  const body = { model: "models/text-embedding-004", content: { parts: [{ text: String(text || "") }] } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.embedding?.values) ? j.embedding.values.map(Number) : [];
}

function stripHtml(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function buildText(p) {
  const title = String(p.title || p.name || "").trim();
  const raw = stripHtml(p.description || p.body_html || "");
  const desc = raw.length > 900 ? raw.slice(0, 900) + "…" : raw;
  const tags = Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" ? p.tags.split(",").map(t=>t.trim()).filter(Boolean) : [];
  return [title, desc, tags.slice(0,16).join(", ")].filter(Boolean).join("\n\n");
}

async function main() {
  const store = process.argv[2];
  if (!store) {
    console.log("Usage: node workers/backfillEmbeddings.mjs <storeId>");
    process.exit(1);
  }
  const productsSnap = await db.collection(`products/${store}/items`).get();
  let wrote = 0, skipped = 0, errs = 0;
  for (const doc of productsSnap.docs) {
    const p = { id: doc.id, ...doc.data() };
    const linkRef = db.doc(`productEmbeddings/${store}/items/${p.id}`);
    const linkDoc = await linkRef.get();
    const hasVector = Array.isArray(linkDoc.data()?.vector) && linkDoc.data().vector.length;
    if (hasVector) { skipped++; continue; }

    try {
      const vec = await embed(buildText(p));
      if (vec.length) {
        await linkRef.set({ productId: p.id, vector: vec, updatedAt: new Date(), schemaVersion: 1 }, { merge: true });
        wrote++;
      } else {
        skipped++;
      }
    } catch {
      errs++;
    }
    // light throttle
    await new Promise(r => setTimeout(r, 80));
  }
  console.log(JSON.stringify({ ok: true, store, wrote, skipped, errs, total: productsSnap.size }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
