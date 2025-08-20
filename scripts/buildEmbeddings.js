// scripts/buildEmbeddings.js
// Usage: node scripts/buildEmbeddings.js <storeId>
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureFirebase() {
  if (admin.apps.length) return admin.app();
  const credsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, "..", "refina-backend", "secure", "service-account.json");
  const json = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(json) });
  return admin.app();
}

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
if (!GEMINI_KEY) {
  console.error("GEMINI_API_KEY is required");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

function lc(x) { return String(x || "").toLowerCase().trim(); }

function buildProductText(p) {
  const bits = [
    p.name || "",
    p.productTypeNorm || p.productType || "",
    ...(p.tagsLC || p.tags || []),
    ...(p.keywordsLC || p.keywords || []),
    ...(p.ingredientsLC || p.ingredients || []),
    (p.descriptionLC || p.description || "").slice(0, 600),
  ];
  return bits.filter(Boolean).join(" • ");
}

async function embed(text) {
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const res = await model.embedContent(text);
  return res.embedding.values;
}

async function run() {
  const storeId = process.argv[2];
  if (!storeId) {
    console.error("Usage: node scripts/buildEmbeddings.js <storeId>");
    process.exit(1);
  }

  ensureFirebase();
  const db = getFirestore();

  const prodCol = db.collection("products").doc(storeId).collection("items");
  const snap = await prodCol.get();
  console.log(`Embedding ${snap.size} products for ${storeId}`);

  const embCol = db.collection("productEmbeddings").doc(storeId).collection("items");
  let done = 0;
  for (const d of snap.docs) {
    const p = d.data();
    const text = buildProductText(p);
    if (!text) continue;

    const vec = await embed(text);
    await embCol.doc(d.id).set({
      vector: vec,
      dim: vec.length,
      textPreview: text.slice(0, 200),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: {
        productTypeNorm: p.productTypeNorm || "",
        domain: p.domain || "",
        price: p.price ?? null,
        tags: p.tagsLC || p.tags || [],
      },
    }, { merge: true });

    done++;
    if (done % 50 === 0) console.log(`…embedded ${done}/${snap.size}`);
  }

  console.log(`✅ Embedded ${done} products for ${storeId}`);
}

run().catch((e) => {
  console.error("buildEmbeddings failed:", e);
  process.exit(1);
});
