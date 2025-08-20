// scripts/mapConcernsInBatches.js

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import fs from "fs";
import path from "path";
import { db } from "../refina-backend/utils/firebaseAdmin.js";
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
const MODEL = "gemini-1.5-flash"; // ✅ Works for batch processing

const storeId = "iamnaturalstore"; // Changeable if needed
const BATCH_SIZE = 200;

async function fetchAllProducts() {
  const snapshot = await db
    .collection("products")
    .doc(storeId)
    .collection("items")
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

async function mapAutoConcerns(productsChunk, batchIndex) {
  const productSummaries = productsChunk
    .map((p) => `Product: ${p.name}\nTags: ${p.tags?.join(", ") || "None"}\nDescription: ${p.description || "N/A"}\nID: ${p.id}`)
    .join("\n\n");

  const prompt = `
You are a skincare expert analyzing a batch of Shopify product listings.

Each product includes its name, tags, and a description. Your task is to read the content and determine what customer concerns each product might help with (e.g., "dry skin", "redness", "anti-aging", etc.).

Please return a JSON object in this format:
{
  "concern 1": ["productId1", "productId2"],
  "concern 2": ["productId3"]
}

Important:
- Only include concerns that are clearly implied by the tags or descriptions.
- Use real-world concerns customers might search for.
- Limit to 10 concerns max per batch.
- Do not invent products or hallucinate IDs.

Here is the product data:

${productSummaries}
`;

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = await response.text();

    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}") + 1;
    const json = text.slice(jsonStart, jsonEnd);
    const mapping = JSON.parse(json);

    const targetPath = db.collection(`mappings/${storeId}/concernToProductsAuto`);
    let writeCount = 0;

    for (const concern of Object.keys(mapping)) {
      const concernDoc = targetPath.doc(concern);
      const existing = await concernDoc.get();

      const newIds = new Set(mapping[concern]);
      let finalIds = Array.from(newIds);

      if (existing.exists) {
        const prev = existing.data().productIds || [];
        finalIds = Array.from(new Set([...prev, ...mapping[concern]]));
      }

      await concernDoc.set({
        concern,
        productIds: finalIds,
        updatedAt: new Date(),
      });

      writeCount++;
      console.log(`✅ ${concern} (batch ${batchIndex}): ${mapping[concern].length} matched`);
    }

    return writeCount;
  } catch (err) {
    console.error(`🔥 Gemini error (batch ${batchIndex}):`, err);
  }
}

async function run() {
  const allProducts = await fetchAllProducts();
  const chunks = chunkArray(allProducts, BATCH_SIZE);

  for (let i = 0; i < chunks.length; i++) {
    await mapAutoConcerns(chunks[i], i + 1);
  }

  console.log("🎉 Auto concern mapping complete.");
}

run();
