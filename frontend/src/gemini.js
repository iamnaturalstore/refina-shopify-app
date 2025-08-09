// src/gemini.js

import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildGeminiPrompt } from "./utils/buildGeminiPrompt";

// Load environment config
const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
const modelName = import.meta.env.VITE_GEMINI_MODEL || "gemini-1.5-flash-lite";

const genAI = new GoogleGenerativeAI(apiKey);

// 🧠 Extract potential productType from concern
function extractProductType(concern, products) {
  const productTypes = new Set(products.map((p) => p.productType?.toLowerCase()));
  for (const word of concern.toLowerCase().split(/\s+/)) {
    if (productTypes.has(word)) return word;
  }
  return null;
}

export async function getGeminiResponse({ concern, category, tone, products }) {
  try {
    // 🧠 Filter products based on productType match from concern
    const requestedType = extractProductType(concern, products);
    let filteredProducts = products;

    if (requestedType) {
      filteredProducts = products.filter((p) =>
        p.productType?.toLowerCase() === requestedType
      );

      console.log(`🔎 Filtering for productType: "${requestedType}" → ${filteredProducts.length} products`);
    } else {
      console.log("⚠️ No specific productType detected in concern — using all products.");
    }

    const prompt = buildGeminiPrompt({
      concern,
      category,
      tone,
      products: filteredProducts,
    });

    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    console.log("📨 Gemini raw response:", text);

    const jsonText = extractJsonBlock(text);
    const parsed = JSON.parse(jsonText);

    if (!Array.isArray(parsed.productIds) || typeof parsed.explanation !== "string") {
      throw new Error("Gemini returned malformed JSON");
    }

    return parsed;
  } catch (err) {
    console.error("❌ Gemini AI Error:", err.message || err);

    if (err.message?.includes("redirect") || err.message?.includes("403")) {
      console.warn("⚠️ Check your VITE_GEMINI_API_KEY and ensure it's valid for the selected model.");
    }

    return {
      productIds: [],
      explanation: "Sorry, I couldn’t generate expert suggestions right now.",
    };
  }
}

function extractJsonBlock(text) {
  const jsonMatch = text.match(/```json([\s\S]*?)```/i);
  if (jsonMatch) return jsonMatch[1].trim();

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1).trim();
  }

  throw new Error("No valid JSON block found in Gemini response.");
}
