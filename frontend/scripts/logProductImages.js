// scripts/logProductImages.js

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load .env config
dotenv.config({ path: path.resolve("../.env") });

const serviceKey = JSON.parse(process.env.FIREBASE_SERVICE_KEY);

initializeApp({
  credential: cert(serviceKey),
});

const db = getFirestore();

async function run() {
  const snapshot = await db.collection("products").get(); // ← removed .limit(50)
  let count = 0;
  snapshot.forEach((doc) => {
    const { name, image } = doc.data();
    console.log(`🛍️ ${name}\n📸 ${image}\n`);
    count++;
  });
  console.log(`✅ Done. Total products: ${count}`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error running script:", err);
    process.exit(1);
  });
