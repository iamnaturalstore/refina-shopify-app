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

const API_VERSION = "2025-01";

const PRODUCTS_QUERY = `
  query ProductsPage($after: String) {
    products(first: 250, after: $after, sortKey: ID) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          id
          legacyResourceId
          title
          descriptionHtml
          productType
          tags
          handle
          vendor
          updatedAt
          featuredImage {
            url
          }
          variants(first: 1) {
            nodes {
              price
            }
          }
        }
      }
    }
  }
`;

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`❌ Failed Shopify GraphQL request: ${error}`);
  }

  const payload = await response.json();

  if (payload.errors) {
    throw new Error(`❌ Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

const fetchAllProducts = async () => {
  const allProducts = [];
  let after = null;
  let hasMore = true;

  while (hasMore) {
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { after });
    const conn = data?.products;
    const edges = conn?.edges || [];

    for (const edge of edges) {
      allProducts.push(edge.node);
    }

    hasMore = Boolean(conn?.pageInfo?.hasNextPage);
    after = hasMore && edges.length ? edges[edges.length - 1].cursor : null;
  }

  return allProducts;
};

const saveToFirestore = async (products) => {
  let batch = db.batch();
  let opCount = 0;

  for (const product of products) {
    const numericId = String(product.legacyResourceId || "").trim();
    if (!numericId) continue;

    const docRef = db.doc(`products/${shop}/items/${numericId}`);

    const priceRaw = product?.variants?.nodes?.[0]?.price;
    const price = Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;

    const cleanDoc = {
      shopifyId: numericId,
      storeId: shop,
      title: product.title || "",
      name: product.title || "",
      image: product.featuredImage?.url || "",
      tags: Array.isArray(product.tags)
        ? product.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : [],
      description: product.descriptionHtml || "",
      vendor: product.vendor || "",
      handle: product.handle || "",
      price,
      productType: product.productType || "",
      category: product.productType || "",
      shopifyUpdatedAt: product.updatedAt || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(docRef, cleanDoc, { merge: true });
    opCount++;

    if (opCount >= 400) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    await batch.commit();
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