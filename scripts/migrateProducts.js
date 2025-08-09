import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { JSDOM } from "jsdom"; // optional HTML cleanup
import fs from "fs";

// Optional: use serviceAccount instead of applicationDefault()
const serviceAccount = JSON.parse(fs.readFileSync("./serviceAccount.json", "utf8"));
initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

// Utility: Strip HTML for Gemini
function cleanHtml(rawHtml = "") {
  try {
    const dom = new JSDOM(rawHtml);
    return dom.window.document.body.textContent.trim();
  } catch {
    return rawHtml;
  }
}

async function migrateProducts() {
  const flatProductsSnap = await db.collection("products").get();
  console.log(`🧪 Found ${flatProductsSnap.size} flat products to migrate...`);

  let migrated = 0;

  for (const doc of flatProductsSnap.docs) {
    const data = doc.data();
    const productId = doc.id;
    const storeId = data.storeId;

    if (!storeId || !productId) {
      console.warn(`⚠️ Skipping ${productId}: missing storeId or productId`);
      continue;
    }

    const cleaned = {
      id: productId,
      name: data.name || "Unnamed Product",
      description: cleanHtml(data.description),
      tags: data.tags || [],
      image: data.image || "",
      productType: data.productType || "",
      link: data.link || "",
      storeId,
    };

    const targetRef = db
      .collection("products")
      .doc(storeId)
      .collection("items")
      .doc(productId);

    await targetRef.set(cleaned);
    migrated++;

    // ❌ Optional: delete original flat doc
    // await doc.ref.delete();
  }

  console.log(`✅ Migrated ${migrated} products to nested structure.`);
}

migrateProducts().catch((err) => {
  console.error("❌ Migration failed:", err);
});
