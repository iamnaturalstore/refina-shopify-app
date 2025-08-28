// refina/server/shopify/syncProducts.mjs
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";
dotenv.config();

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const storeEnv = String(process.env.SHOPIFY_STORE_DOMAIN || "").toLowerCase().trim();
if (!storeEnv || !storeEnv.endsWith(".myshopify.com")) {
  throw new Error('SHOPIFY_STORE_DOMAIN must be a full "<shop>.myshopify.com" domain');
}
const shop = storeEnv;
const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
if (!token) throw new Error("SHOPIFY_ADMIN_API_TOKEN missing");

const fetchAllProducts = async () => {
  let allProducts = [];
  let lastId = null;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`https://${shop}/admin/api/2024-04/products.json`);
    url.searchParams.set("limit", "250");
    if (lastId) url.searchParams.set("since_id", lastId);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`❌ Failed to fetch products: ${error}`);
    }

    const data = await response.json();
    const products = data.products || [];
    allProducts = allProducts.concat(products);
    hasMore = products.length === 250;
    lastId = hasMore ? products[products.length - 1].id : null;
  }

  return allProducts;
};

const saveToFirestore = async (products) => {
  for (const product of products) {
    const docRef = db.doc(`products/${shop}/items/${product.id}`);
    const cleanDoc = {
      shopifyId: product.id,
      storeId: shop, // full domain
      title: product.title || product.name || "",
      name: product.title || product.name || "",
      image: product.images?.[0]?.src || "",
      tags: (String(product.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) || [],
      description: product.body_html || "",
      vendor: product.vendor || "",
      handle: product.handle || "",
      price: Number.isFinite(Number(product?.variants?.[0]?.price ?? NaN)) ? Number(product.variants[0].price) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set(cleanDoc, { merge: true });
  }

  console.log(`✅ Synced ${products.length} products to Firestore at products/${shop}/items/*`);
};

(async () => {
  try {
    const products = await fetchAllProducts();
    await saveToFirestore(products);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
