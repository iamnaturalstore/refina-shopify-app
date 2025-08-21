// scripts/mapConcernsAutoInBatches.js

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import fs from "fs";
import path from "path";
import { db } from "../refina-backend/utils/firebaseAdmin.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// 🧠 Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = "gemini-1.5-flash"; // Fast & cheaper model

// 🗂️ Firebase admin init
const serviceAccountPath = path.resolve("./service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// 🔁 Store-specific config
const storeId = "iamnaturalstore";
const productCollection = db.collection(`products/${storeId}/items`);
const mappingCollection = db.collection(`mappings/${storeId}/concernToProductsAuto`);

const CONCERNS = [
  "Dry skin",
  "Eczema",
  "Acne and blemishes",
  "Fine lines and wrinkles",
  "Sensitive skin",
  "Hair loss",
  "Redness and inflammation",
  "Dry, damaged hair",
  "Immunity",
  "Improved sleep",
];

const BATCH_SIZE = 200;

async function fetchUnmappedProducts(limit) {
  const snapshot = await productCollection
    .where("autoMapped", "==", false)
    .limit(limit)
    .get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ref: doc.ref,
    ...doc.data(),
  }));
}

async function markProductsAsMapped(products) {
  const batch = db.batch();
  products.forEach(p => {
    batch.update(p.ref, { autoMapped: true });
  });
  await batch.commit();
}

async function run() {
  console.log(`🚀 Auto-mapping concerns for store: ${storeId}`);

  const products = await fetchUnmappedProducts(BATCH_SIZE);
  if (products.length === 0) {
    console.log("✅ All products have been mapped.");
    return;
  }

  const productText = products.map(p => {
    return `Product: ${p.name}\nTags: ${p.tags?.join(", ") || "None"}\nDescription: ${p.description || "N/A"}\nID: ${p.id}`;
  }).join("\n\n");

  const prompt = `
You are an expert product advisor for a Shopify store.

Each product includes a name, tags, and description. Identify the concerns that each product may help address from this list:

${CONCERNS.join(", ")}

Return your response using this structured JSON format:

{
  "Dry skin": ["productId1", "productId2"],
  "Eczema": ["productId3"]
}

Only include product IDs that are clearly a good match based on the description or tags.
Here are the products:

${productText}
`;

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = await response.text();

    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}") + 1;
    const json = text.slice(jsonStart, jsonEnd);
    const parsed = JSON.parse(json);

    const batch = db.batch();

    for (const concern of Object.keys(parsed)) {
      const productIds = parsed[concern];

      if (productIds.length > 0) {
        const ref = mappingCollection.doc(concern);
        batch.set(ref, {
          concern,
          productIds: admin.firestore.FieldValue.arrayUnion(...productIds),
          updatedAt: new Date(),
        }, { merge: true });
        console.log(`✅ ${concern} (batch): ${productIds.length} matched`);
      }
    }

    await batch.commit();
    await markProductsAsMapped(products);
    console.log("🎉 Concern-to-product auto-mapping complete.");
  } catch (err) {
    console.error("🔥 Gemini error:", err);
  }
}

run();
