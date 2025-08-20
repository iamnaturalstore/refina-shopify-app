import "dotenv/config";
import { db } from "../refina-backend/utils/firebaseAdmin.js";

// Parse service key from environment variable

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceKey),
  });
}

const db = admin.firestore();

// Replace this with your actual storeId if needed
const STORE_ID = "iamnaturalstore"; // or dynamically read it

async function deleteAllProducts() {
  const productsRef = db.collection("products");
  const snapshot = await productsRef.where("storeId", "==", STORE_ID).get();

  if (snapshot.empty) {
    console.log("No products found to delete.");
    return;
  }

  console.log(`Found ${snapshot.size} products. Deleting...`);

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));

  await batch.commit();
  console.log("✅ All products deleted.");
}

deleteAllProducts().catch((err) => {
  console.error("❌ Error deleting products:", err);
});
