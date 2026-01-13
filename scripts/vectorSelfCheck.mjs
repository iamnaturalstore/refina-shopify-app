import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
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

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function l2(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); }
function cosine(a, b) {
  const na = l2(a), nb = l2(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

// IMPORTANT: set this to whatever /recommend actually uses.
// If /recommend uses Vertex, swap this embedText() implementation to that exact call.
async function embedText(text) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!key) throw new Error("Missing GEMINI_API_KEY/GOOGLE_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(key)}`;
  const body = {
    model: "models/gemini-embedding-001",
    content: { parts: [{ text: String(text || "") }] },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`embedContent failed: ${r.status} ${await r.text()}`);

  const j = await r.json();
  const v = j?.embedding?.values;
  return Array.isArray(v) ? v : [];
}

const storeId = process.argv[2];
const productId = process.argv[3];
if (!storeId || !productId) {
  console.error("Usage: node scripts/vectorSelfCheck.mjs <storeId> <productId>");
  process.exit(1);
}

const prodRef = db.doc(`products/${storeId}/items/${productId}`);
const embRef = db.doc(`productEmbeddings/${storeId}/items/${productId}`);

const [prodSnap, embSnap] = await Promise.all([prodRef.get(), embRef.get()]);
if (!prodSnap.exists) throw new Error(`Missing product doc: ${prodRef.path}`);
if (!embSnap.exists) throw new Error(`Missing embedding doc: ${embRef.path}`);

const product = prodSnap.data() || {};
const stored = embSnap.data() || {};
const storedVec = stored.vector;

if (!Array.isArray(storedVec) || !storedVec.length) throw new Error("Stored vector missing/empty");

const text = productEmbedText(product);
const freshVec = await embedText(text);
if (!freshVec.length) throw new Error("Fresh embed returned empty vector");

const sim = cosine(storedVec, freshVec);

console.log("\n=== Vector Self Check ===");
console.log("storeId:", storeId);
console.log("productId:", productId);
console.log("storedDim:", storedVec.length);
console.log("freshDim:", freshVec.length);
console.log("cosine(stored, fresh):", sim.toFixed(6));
console.log("title:", String(product.title || product.name || "").slice(0, 120));
console.log("textChars:", text.length);
