// addStoreIdToProducts.js
import { initializeApp } from "firebase/app"
import {
  getFirestore,
  collection,
  getDocs,
  updateDoc,
  doc,
} from "firebase/firestore"

// ✅ Replace with your actual Firebase config (from frontend/firebase.js)
const firebaseConfig = {
  apiKey: "AIzaSyBwBcccisGjDHFW_6SVS4W56BfvrpJBVzk",
  authDomain: "productrecommenderapp.firebaseapp.com",
  projectId: "productrecommenderapp",
  storageBucket: "productrecommenderapp.appspot.com",
  messagingSenderId: "745719652132",
  appId: "1:745719652132:web:xxxxxxxxxx", // optional
}

// 🔥 Init Firebase
const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

// 🛠️ Script to update all products with storeId = "iamnaturalstore"
const TARGET_STORE_ID = "iamnaturalstore"

async function updateProductsWithStoreId() {
  const productsRef = collection(db, "products")
  const snapshot = await getDocs(productsRef)

  console.log(`🔍 Found ${snapshot.size} products`)

  let updatedCount = 0

  for (const docSnap of snapshot.docs) {
    const product = docSnap.data()

    // Skip if already has correct storeId
    if (product.storeId === TARGET_STORE_ID) continue

    const docRef = doc(db, "products", docSnap.id)

    try {
      await updateDoc(docRef, { storeId: TARGET_STORE_ID })
      console.log(`✅ Updated product: ${product.title || docSnap.id}`)
      updatedCount++
    } catch (error) {
      console.error(`❌ Failed to update product ${docSnap.id}`, error)
    }
  }

  console.log(`🎉 Update complete: ${updatedCount} products updated.`)
}

updateProductsWithStoreId()
