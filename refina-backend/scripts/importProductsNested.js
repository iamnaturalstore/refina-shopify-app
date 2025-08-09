import "dotenv/config";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs"; // ✅ load service account from file

// ✅ Environment variables
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const STORE_ID = "iamnaturalstore"; // static for now, dynamic later

// ✅ Load Firebase service account from file
const serviceKey = JSON.parse(fs.readFileSync("./service-account.json", "utf8"));

if (!SHOP_DOMAIN || !ACCESS_TOKEN || !serviceKey) {
  console.error("❌ Missing environment variables:");
  console.error({
    SHOP_DOMAIN,
    ACCESS_TOKEN: ACCESS_TOKEN ? "✅" : "❌",
    SERVICE_KEY: serviceKey ? "✅" : "❌",
  });
  process.exit(1);
}

// ✅ Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceKey),
  });
}

const db = admin.firestore();
const ADMIN_API_VERSION = "2023-10";

// 🔄 Fetch all products from Shopify
const fetchShopifyProducts = async () => {
  let allProducts = [];
  let endpoint = `https://${SHOP_DOMAIN}/admin/api/${ADMIN_API_VERSION}/products.json?limit=250`;

  while (endpoint) {
    const response = await fetch(endpoint, {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch products: ${response.statusText}`);
    }

    const data = await response.json();
    allProducts.push(...data.products);

    const linkHeader = response.headers.get("link");
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      endpoint = match ? match[1] : null;
    } else {
      endpoint = null;
    }
  }

  return allProducts;
};

// 🛠 Import into Firestore at products/{storeId}/items/{productId}
const importToFirestore = async () => {
  try {
    const products = await fetchShopifyProducts();
    console.log(`📦 Found ${products.length} products. Importing...\n`);

    const batch = db.batch();
    const nestedRef = db.collection("products").doc(STORE_ID).collection("items");

    products.forEach((product) => {
      const docRef = nestedRef.doc(product.id.toString());

      batch.set(docRef, {
        id: product.id.toString(),
        name: product.title,
        description: product.body_html || "",
        tags: product.tags ? product.tags.split(",").map((t) => t.trim()) : [],
        image: product.images?.[0]?.src || "",
        productType: product.product_type || "",
        link: `https://${SHOP_DOMAIN}/products/${product.handle}`,
        storeId: STORE_ID,
      });

      console.log(`→ Prepared: ${product.title}`);
    });

    await batch.commit();
    console.log(`\n✅ Products imported successfully to products/${STORE_ID}/items`);
  } catch (err) {
    console.error("❌ Import failed:", err);
  }
};

importToFirestore();
