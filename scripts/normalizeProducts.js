// scripts/normalizeProducts.js
// Usage: node scripts/normalizeProducts.js <storeId>
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function lc(x) { return String(x || "").toLowerCase().trim(); }
function hash(obj) { return crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex"); }

function ensureFirebase() {
  if (admin.apps.length) return admin.app();
  const credsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, "..", "refina-backend", "secure", "service-account.json");
  const json = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(json) });
  return admin.app();
}

function canonicalType(pt) {
  const t = lc(pt);
  if (!t) return "";
  if (t.includes("moistur")) return "moisturiser";
  if (t.includes("cleanser") || t.includes("wash")) return "cleanser";
  if (t.includes("serum")) return "serum";
  if (t.includes("toner")) return "toner";
  if (t.includes("essence")) return "essence";
  if (t.includes("mask")) return "mask";
  if (t.includes("sunscreen") || t.includes("spf")) return "sunscreen";
  if (t.includes("oil")) return "oil";
  if (t.includes("shampoo")) return "shampoo";
  if (t.includes("conditioner")) return "conditioner";
  if (t.includes("spray") || t.includes("hairspray")) return "hair-spray";
  if (t.includes("lipstick")) return "lipstick";
  return t;
}

function inferDomain(p) {
  const hay = [lc(p.category), lc(p.productType), ...(p.tags || []).map(lc)].join(" ");
  if (/\bhair|scalp|shampoo|conditioner|curl|frizz|spray\b/.test(hay)) return "haircare";
  if (/\b(body|bath|kp|keratosis|body\s?lotion|body\s?butter)\b/.test(hay)) return "body-bath";
  if (/\b(lipstick|mascara|foundation|primer|concealer|blush|tint)\b/.test(hay)) return "makeup";
  return "beauty";
}

async function run() {
  const storeId = process.argv[2];
  if (!storeId) {
    console.error("Usage: node scripts/normalizeProducts.js <storeId>");
    process.exit(1);
  }

  ensureFirebase();
  const db = getFirestore();

  const col = db.collection("products").doc(storeId).collection("items");
  const snap = await col.get();
  console.log(`Found ${snap.size} products to normalize for store ${storeId}`);

  let updated = 0;
  for (const doc of snap.docs) {
    const p = doc.data();
    const normalized = {
      nameLC: lc(p.name),
      descriptionLC: lc(p.description),
      tagsLC: (p.tags || []).map(lc),
      keywordsLC: (p.keywords || []).map(lc),
      ingredientsLC: (p.ingredients || []).map(lc),
      productTypeNorm: canonicalType(p.productType),
      domain: inferDomain(p),
    };

    const payload = {
      ...normalized,
      normalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      sourceHash: hash({
        name: p.name, description: p.description, tags: p.tags, keywords: p.keywords, ingredients: p.ingredients, productType: p.productType, category: p.category,
      }),
    };

    await doc.ref.set(payload, { merge: true });
    updated++;
    if (updated % 100 === 0) console.log(`…normalized ${updated}/${snap.size}`);
  }

  console.log(`✅ Normalized ${updated} products for ${storeId}`);
}

run().catch((e) => {
  console.error("normalizeProducts failed:", e);
  process.exit(1);
});
