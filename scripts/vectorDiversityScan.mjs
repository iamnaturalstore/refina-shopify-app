// scripts/vectorDiversityScan.mjs
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function l2(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}
function cosine(a, b) {
  const na = l2(a), nb = l2(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
  return s[idx];
}

const storeId = process.argv[2];
if (!storeId) {
  console.error("Usage: node scripts/vectorDiversityScan.mjs <storeId>");
  process.exit(1);
}

const COL = `productEmbeddings/${storeId}/items`;

const sampleN = Number(process.env.SAMPLE || 220);     // docs to sample
const pairN = Number(process.env.PAIRS || 2500);       // random pairs
const nnK = Number(process.env.NN || 40);              // brute-force NN within sample

console.log("\n=== Vector Diversity Scan ===");
console.log("storeId:", storeId);
console.log("collection:", COL);

const snap = await db.collection(COL).limit(sampleN).get();
const vecs = [];
snap.forEach((d) => {
  const v = d.data()?.vector;
  if (Array.isArray(v) && v.length) vecs.push({ id: d.id, v });
});
console.log("sampledDocs:", snap.size);
console.log("withVectorInSample:", vecs.length);

if (vecs.length < 10) {
  console.log("Not enough vectors to analyze.");
  process.exit(0);
}

// Random pair cosine sims
const sims = [];
for (let i = 0; i < pairN; i++) {
  const a = vecs[(Math.random() * vecs.length) | 0].v;
  const b = vecs[(Math.random() * vecs.length) | 0].v;
  sims.push(cosine(a, b));
}

console.log("\nRandom-pair cosine similarity:");
console.log("  min:", Math.min(...sims).toFixed(6));
console.log("  p50:", pct(sims, 50).toFixed(6));
console.log("  p90:", pct(sims, 90).toFixed(6));
console.log("  p99:", pct(sims, 99).toFixed(6));
console.log("  max:", Math.max(...sims).toFixed(6));

// Nearest-neighbor within sample (rough signal)
const nnSims = [];
for (let i = 0; i < Math.min(nnK, vecs.length); i++) {
  const base = vecs[i].v;
  let best = -1;
  for (let j = 0; j < vecs.length; j++) {
    if (i === j) continue;
    const s = cosine(base, vecs[j].v);
    if (s > best) best = s;
  }
  nnSims.push(best);
}

console.log("\nNearest-neighbor cosine (within sample):");
console.log("  p50:", pct(nnSims, 50).toFixed(6));
console.log("  p90:", pct(nnSims, 90).toFixed(6));
console.log("  max:", Math.max(...nnSims).toFixed(6));
