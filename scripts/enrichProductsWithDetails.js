// scripts/enrichProductsWithDetails.js

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { fileURLToPath } from "url";

// 🔐 Load service account
const serviceAccountPath = path.resolve("./service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

// 🧯 Init Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// 🧠 Gemini setup
const genAI = new GoogleGenerativeAI(process.env.VITE_GEMINI_API_KEY);
const MODEL = "gemini-1.5-flash"; // ✅ Fast & good for structured prompts

const storeId = "iamnaturalstore"; // Change as needed
const BATCH_SIZE = 10;

// ✅ Skip products already enriched
function productNeedsEnrichment(product) {
  return (
    !product.category ||
    !product.keywords || !Array.isArray(product.keywords) || product.keywords.length < 2 ||
    !product.ingredients || !Array.isArray(product.ingredients) || product.ingredients.length < 1
  );
}

async function fetchProductsNeedingEnrichment() {
  const snapshot = await db
    .collection("products")
    .doc(storeId)
    .collection("items")
    .get();

  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter(productNeedsEnrichment);
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

async function enrichBatch(products, batchIndex) {
  const summaries = products
    .map(
      (p) =>
        `Product: ${p.name}\nTags: ${p.tags?.join(", ") || "None"}\nDescription: ${p.description || "N/A"}\nID: ${p.id}`
    )
    .join("\n\n");

  const prompt = `
You are a product data analyst for a Shopify store.

For each product listed below, extract:
- category: the general category it belongs to (e.g. skin-care, body-care, makeup, supplements, home, etc.)
- keywords: 3 to 5 customer-friendly search terms (e.g. "hydrating", "sensitive skin", "gentle exfoliator")
- ingredients: only if they are clearly mentioned in the description or tags

Return only a JSON object like this:
{
  "PRODUCT_ID": {
    "category": "skin-care",
    "keywords": ["hydrating", "anti-aging", "vitamin C"],
    "ingredients": ["aloe vera", "niacinamide"]
  },
  "PRODUCT_ID_2": { ... }
}

If any value is missing, leave it out. Don’t guess.
Here is the product batch:
${summaries}
`;

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = await response.text();

    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}") + 1;
    const json = text.slice(jsonStart, jsonEnd);
    const enrichmentMap = JSON.parse(json);

    let updatedCount = 0;

    for (const [productId, enrichment] of Object.entries(enrichmentMap)) {
      const ref = db
        .collection("products")
        .doc(storeId)
        .collection("items")
        .doc(productId);

      await ref.update({
        ...(enrichment.category && { category: enrichment.category }),
        ...(Array.isArray(enrichment.keywords) && enrichment.keywords.length && { keywords: enrichment.keywords }),
        ...(Array.isArray(enrichment.ingredients) && enrichment.ingredients.length && {
          ingredients: enrichment.ingredients,
        }),
        enrichedAt: new Date(),
      });

      updatedCount++;
      console.log(`✅ Enriched ${productId}: ${enrichment.category || "no category"}`);
    }

    console.log(`🎉 Batch enrichment saved to Firestore.`);
    return updatedCount;
  } catch (err) {
    console.error(`🔥 Gemini error in batch ${batchIndex}:`, err);
    return 0;
  }
}

async function run() {
  const toEnrich = await fetchProductsNeedingEnrichment();

  if (toEnrich.length === 0) {
    console.log("✅ No products found needing enrichment.");
    return;
  }

  console.log(`🔍 Found ${toEnrich.length} products to enrich...`);
  const batches = chunkArray(toEnrich, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    console.log(`🚀 Processing batch ${i + 1}...`);
    await enrichBatch(batches[i], i + 1);
  }

  console.log("✨ All enrichment complete.");
}

run();
