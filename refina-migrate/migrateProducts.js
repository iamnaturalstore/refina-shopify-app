import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { JSDOM } from "jsdom";
import fs from "fs";

// ✅ Correct service account file
const serviceAccount = JSON.parse(fs.readFileSync("./service-account.json", "utf8"));

// ✅ Correct Firebase Admin initialization
initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// 🧼 Utility: Strip HTML for Gemini compatibility
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
  console.log(`🧪 Found ${flatProductsSnap.size} flat products to migrate...\n`);

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
    console.log(`→ Migrated to products/${storeId}/items/${productId}`);
    migrated++;

    // Optional: Delete the old flat product
    // await doc.ref.delete();
  }

  console.log(`\n✅ Migrated ${migrated} products to nested structure.`);
}

migrateProducts().catch((err) => {
  console.error("❌ Migration failed:", err);
});
