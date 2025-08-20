// scripts/mapConcernsToProducts.js

import dotenv from "dotenv";
dotenv.config({ path: path.resolve("../.env") });

import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "../refina-backend/utils/firebaseAdmin.js";
import { fileURLToPath } from "url";

// 🔐 Load service account
const serviceAccountPath = path.resolve("./service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

// 🧠 Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = "gemini-1.5-flash"; // ✅ Stable, fast, accurate

// 🧯 Init Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const storeId = "iamnaturalstore"; // 🔁 Can be dynamic later

const CONCERNS = [
  "dry skin",
  "acne",
  "eczema",
  "wrinkles",
  "sun damage",
];

async function fetchProducts() {
  const snapshot = await db
  .collection("products")
  .doc(storeId)
  .collection("items")
  .limit(50)
  .get();


  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));
}

async function mapProductsToConcerns() {
  console.log(`🔁 AI mapping products to concerns for store: ${storeId}`);

  const products = await fetchProducts();
  if (!products.length) {
    console.log("❌ No products found.");
    return;
  }

  const productSummaries = products.map(p => {
    return `Product: ${p.name}\nTags: ${p.tags?.join(", ") || "None"}\nDescription: ${p.description || "N/A"}\nID: ${p.id}`;
  }).join("\n\n");

  const prompt = `
You are an expert product recommender for a Shopify store.

Here is a list of products with their tags and descriptions:

${productSummaries}

For each of the following concerns:

${CONCERNS.join(", ")}

List the product IDs that would be suitable for each concern. 
Use this structured format:
{
  "dry skin": ["productId1", "productId2"],
  "acne": ["productId3"]
  ...
}
Only include product IDs that are a good match based on the tags and descriptions.
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

    const batch = db.batch();
    const targetPath = db.collection(`mappings/${storeId}/concernToProducts`);

    for (const concern of Object.keys(mapping)) {
      batch.set(targetPath.doc(concern), {
        concern,
        productIds: mapping[concern],
        updatedAt: new Date(),
      });
      console.log(`✅ ${concern}: ${mapping[concern].length} matched`);
    }

    await batch.commit();
    console.log("🎉 Concern-to-product mapping complete.");
  } catch (err) {
    console.error("🔥 Gemini error:", err);
  }
}

mapProductsToConcerns();
