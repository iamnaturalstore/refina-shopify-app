// scripts/cleanupFlatProducts.js

import { db } from "../refina-backend/utils/firebaseAdmin.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ✅ Load service account
const serviceAccountPath = path.resolve("./scripts/service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function deleteFlatProducts() {
  const flatProductsSnap = await db.collection("products").get();
  let deletedCount = 0;

  for (const doc of flatProductsSnap.docs) {
    // 🔒 Only delete flat products (not nested ones inside products/{storeId}/items)
    if (!doc.ref.path.includes("/items/")) {
      await doc.ref.delete();
      deletedCount++;
      console.log(`🗑️ Deleted flat product: ${doc.id}`);
    }
  }

  console.log(`✅ Deleted ${deletedCount} flat product documents.`);
}

deleteFlatProducts().catch((err) => {
  console.error("❌ Cleanup failed:", err);
});
