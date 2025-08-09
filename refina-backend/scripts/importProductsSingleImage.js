import "dotenv/config";
import fetch from "node-fetch";
import admin from "firebase-admin";

// ✅ Load correct environment variables
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SERVICE_KEY = process.env.FIREBASE_SERVICE_KEY;

if (!SHOP_DOMAIN || !ACCESS_TOKEN || !SERVICE_KEY) {
  console.error("❌ Missing environment variables:");
  console.error({
    SHOP_DOMAIN,
    ACCESS_TOKEN: ACCESS_TOKEN ? "✅" : "❌",
    SERVICE_KEY: SERVICE_KEY ? "✅" : "❌",
  });
  process.exit(1);
}

const serviceKey = JSON.parse(SERVICE_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceKey),
  });
}

const db = admin.firestore();
const ADMIN_API_VERSION = "2023-10";
const STORE_ID = "iamnaturalstore"; // hardcoded for now — later dynamic

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

const importToFirestore = async () => {
  try {
    const products = await fetchShopifyProducts();
    console.log(`📦 Found ${products.length} products. Importing...`);

    const batch = db.batch();
    const productsRef = db.collection("products");

    products.forEach((product) => {
      const docRef = productsRef.doc(product.id.toString());
      const mainImage = product.images?.[0]?.src || "";

      batch.set(docRef, {
        name: product.title,
        description: product.body_html || "",
        tags: product.tags ? product.tags.split(",").map((t) => t.trim()) : [],
        image: mainImage,
        storeId: STORE_ID,
      });
    });

    await batch.commit();
    console.log("✅ Products imported successfully with only one image each.");
  } catch (err) {
    console.error("❌ Import failed:", err);
  }
};

importToFirestore();
