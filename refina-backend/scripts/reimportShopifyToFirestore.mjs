// refina-backend/scripts/reimportShopifyToFirestore.mjs
// Re-imports Shopify products into Firestore:
//   products/<STORE_ID>/items/<productId>
// Uses Node 18+ global fetch and your existing Firebase Admin util.
// No mappings here; 1 main image only.

import { db } from "../utils/firebaseAdmin.js";

// ── Env
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;      // e.g. refina-demo.myshopify.com
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;  // shpat_***
const STORE_ID = process.env.STORE_ID || SHOP_DOMAIN;      // MUST be refina-demo.myshopify.com
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const STORE_FRONT_DOMAIN = (process.env.STORE_FRONT_DOMAIN || SHOP_DOMAIN || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");

function assertEnv() {
  const miss = [];
  if (!SHOP_DOMAIN) miss.push("SHOPIFY_STORE_DOMAIN");
  if (!ACCESS_TOKEN) miss.push("SHOPIFY_ADMIN_API_TOKEN");
  if (!STORE_ID) miss.push("STORE_ID (or SHOPIFY_STORE_DOMAIN)");
  if (miss.length) {
    console.error("❌ Missing env:", miss.join(", "));
    process.exit(1);
  }
}
assertEnv();

// ── Helpers
function mainImageFor(p) {
  return p?.image?.src || p?.images?.[0]?.src || "";
}
function minVariantPrice(p) {
  const vals = (p?.variants || []).map(v => Number.parseFloat(v?.price)).filter(Number.isFinite);
  return vals.length ? Math.min(...vals) : null;
}
function normalizeTags(ts) {
  if (!ts) return [];
  return ts.split(",").map(t => t.trim()).filter(Boolean);
}
function productUrl(handle) {
  if (!handle || !STORE_FRONT_DOMAIN) return "";
  return `https://${STORE_FRONT_DOMAIN}/products/${handle}`;
}

// ── Shopify pagination (REST)
async function* paginateShopifyProducts() {
  let url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/products.json?limit=250`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Shopify fetch failed: ${res.status} ${res.statusText} — ${text}`);
    }
    const { products = [] } = await res.json();
    yield products;

    const link = res.headers.get("link");
    const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
}

// ── Importer
async function run() {
  console.log(`\n🏁 Importing products for STORE_ID=${STORE_ID}`);
  console.log(`   Source shop: ${SHOP_DOMAIN} (API ${API_VERSION})`);
  console.log(`   Public links: ${STORE_FRONT_DOMAIN}\n`);

  const writer = db.bulkWriter();
  writer.onWriteError(err => {
    if (err.failedAttempts < 5) {
      console.warn("⚠️  Retry:", err.message);
      return true;
    }
    console.error("❌ Permanent write error:", err.message);
    return false;
  });

  let total = 0;

  for await (const page of paginateShopifyProducts()) {
    for (const p of page) {
      const id = String(p.id);
      const ref = db.collection("products").doc(STORE_ID).collection("items").doc(id);
      const doc = {
        id,
        name: p.title || "",
        description: p.body_html || "",
        tags: normalizeTags(p.tags),
        image: mainImageFor(p),            // single main image
        productType: p.product_type || "",
        handle: p.handle || "",
        price: minVariantPrice(p),
        link: productUrl(p.handle),
        storeId: STORE_ID,
      };
      writer.set(ref, doc, { merge: false });
      total++;
      if (total % 200 === 0) process.stdout.write(`Imported ${total}...\r`);
    }
  }

  await writer.close();
  console.log(`\n✅ Done. Imported ${total} → products/${STORE_ID}/items`);
}

run().catch(e => {
  console.error("\n❌ Import failed:", e);
  process.exit(1);
});
