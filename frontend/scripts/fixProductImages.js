// scripts/fixProductImages.js

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  updateDoc,
  doc,
} from "firebase/firestore";
import dotenv from "dotenv";

// Load env variables
dotenv.config({ path: "../.env" });

// Firebase config
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Strip trailing `/` or fix redirects
function fixImageUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.replace(/^http:/, "https:").replace(/\/$/, "");
}

async function runFix() {
  const productsCol = collection(db, "products");
  const snapshot = await getDocs(productsCol);
  let count = 0;

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const imageUrl = fixImageUrl(data.image);

    if (imageUrl !== data.image) {
      await updateDoc(doc(productsCol, docSnap.id), { image: imageUrl });
      console.log(`✅ Fixed: ${docSnap.id} — ${imageUrl}`);
      count++;
    }
  }

  console.log(`\n🎉 Done! ${count} image URLs updated.`);
}

runFix().catch((err) => {
  console.error("❌ Error fixing product images:", err);
});
