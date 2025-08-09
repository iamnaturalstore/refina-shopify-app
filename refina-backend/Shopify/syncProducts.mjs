// refina/server/shopify/syncProducts.mjs
import fetch from "node-fetch"
import admin from "firebase-admin"
import dotenv from "dotenv"
dotenv.config()

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_KEY)
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })
}
const db = admin.firestore()

const store = process.env.SHOPIFY_STORE_DOMAIN
const token = process.env.SHOPIFY_ADMIN_API_TOKEN
const storeId = store.replace(".myshopify.com", "") // 🔥 Used for filtering in app

const fetchAllProducts = async () => {
  let allProducts = []
  let lastId = null
  let hasMore = true

  while (hasMore) {
    const url = new URL(`https://${store}/admin/api/2024-04/products.json`)
    url.searchParams.set("limit", "250")
    if (lastId) {
      url.searchParams.set("since_id", lastId)
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`❌ Failed to fetch products: ${error}`)
    }

    const data = await response.json()
    const products = data.products
    allProducts = allProducts.concat(products)
    hasMore = products.length === 250
    lastId = hasMore ? products[products.length - 1].id : null
  }

  return allProducts
}

const saveToFirestore = async (products) => {
  const ref = db.collection("products")

  for (const product of products) {
    const docRef = ref.doc(product.id.toString())
    const cleanDoc = {
      shopifyId: product.id,
      storeId: storeId, // ✅ ADDED: Store filter
      name: product.title || "",
      image: product.images?.[0]?.src || "",
      tags: product.tags?.split(",").map((t) => t.trim().toLowerCase()) || [],
      description: product.body_html || "",
      vendor: product.vendor || "",
    }

    await docRef.set(cleanDoc, { merge: true })
  }

  console.log(`✅ Synced ${products.length} products to Firestore with storeId: ${storeId}`)
}

;(async () => {
  try {
    const products = await fetchAllProducts()
    await saveToFirestore(products)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
})()
