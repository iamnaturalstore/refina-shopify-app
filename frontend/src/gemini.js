// src/gemini.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildGeminiPrompt } from "./utils/buildGeminiPrompt";

const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
const modelName = import.meta.env.VITE_GEMINI_MODEL || "gemini-1.5-flash-lite";
const genAI = new GoogleGenerativeAI(apiKey);

// ───────────────────────────
// Domain intents (normalized)
// ───────────────────────────
function detectHairIntent(text = "") {
  const s = String(text || "").toLowerCase();
  return /\bhair|scalp|shampoo|conditioner|styling|frizz|curly|curl\b/.test(s);
}
function detectMakeupIntent(text = "") {
  const s = String(text || "").toLowerCase();
  return (
    /\bmake(?:up)?\b/.test(s) ||
    /\blip(?:stick| oil| tint| stain| whip)?\b/.test(s) ||
    /\bmascara\b|\bconcealer\b|\bblush\b|\beyeliner\b|\beyeshadow\b/.test(s)
  );
}
function detectBodyIntent(text = "") {
  const s = String(text || "").toLowerCase();
  return /\bbody\b|\bhand\b|\bfoot\b|\bleg\b|\bshower\b|\bkp\b|\bkeratosis\b/.test(s);
}

// Hair product check (kept)
function isHairProduct(p = {}) {
  const t = String(p.productType || "").toLowerCase();
  const tags = (p.tags || []).map((x) => String(x).toLowerCase());
  const kw = (p.keywords || []).map((x) => String(x).toLowerCase());
  const hay = [t, (p.category || "").toLowerCase(), (p.description || "").toLowerCase(), ...tags, ...kw].join(" ");
  return /\bhair|scalp|shampoo|conditioner|spray|hairspray|styling|frizz|curl\b/.test(hay);
}

// Type token filter (uses normalized fields when present)
function filterByTypeToken(concern, products) {
  const tokens = String(concern || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return products;
  const TYPE_HINTS = new Set([
    "cleanser","wash","toner","essence","serum","treatment","exfoliator","exfoliant",
    "moisturiser","moisturizer","mask","sunscreen","spf","oil","shampoo","conditioner",
    "spray","hairspray","gel","mousse","leave-in","lotion","butter","cream"
  ]);
  const typeToken = tokens.find((w) =>
    TYPE_HINTS.has(w) ||
    products.some((p) =>
      String(p.productTypeNormalized || p.productType || "")
        .toLowerCase()
        .includes(w)
    )
  );
  if (!typeToken) return products;
  const filtered = products.filter((p) =>
    String(p.productTypeNormalized || p.productType || "")
      .toLowerCase()
      .includes(typeToken)
  );
  return filtered.length >= 3 ? filtered : products;
}

// ───────────────────────────
// Track A helpers
// ───────────────────────────
function formatSessionContext(context) {
  if (!context || typeof context !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(context)) {
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const val = Array.isArray(v) ? v.join(", ") : String(v);
    parts.push(`${k}: ${val}`);
  }
  return parts.length
    ? `SESSION CONTEXT (use to refine picks & follow-ups):\n${parts.map((p) => `- ${p}`).join("\n")}\n`
    : "";
}

function heuristicFollowUps(concern = "") {
  const ups = [];
  if (detectHairIntent(concern)) {
    ups.push("Oil or serum for your hair?", "Focus on scalp or lengths?", "Frizz control or curl definition?");
  } else if (detectMakeupIntent(concern)) {
    ups.push("Lip oil or lipstick?", "Matte or dewy finish?", "Do you prefer clean/vegan formulas?");
  } else if (detectBodyIntent(concern)) {
    ups.push("Lotion or body butter?", "Scented or unscented?", "Target KP/bumps specifically?");
  } else {
    ups.push("Any sensitivities or allergies?", "Preferred texture: gel, oil, or cream?", "Budget under $50?");
  }
  return ups.slice(0, 3);
}

export async function getGeminiResponse({
  concern,
  category,
  tone,
  products,
  context = null,   // optional session context (e.g., { age: 59, skin: "sensitive", budget: "<$60", prefer: "oil" })
  maxPicks = 3      // keep UI snappy
}) {
  try {
    // 1) Pre-filter catalog by intent (use normalized fields when present)
    let filteredProducts = Array.isArray(products) ? products : [];
    if (detectHairIntent(concern)) {
      const hair = filteredProducts.filter(isHairProduct);
      if (hair.length >= 3) filteredProducts = hair;
    }
    if (detectMakeupIntent(concern)) {
      const mk = filteredProducts.filter((p) => {
        const cat = String(p.categoryNormalized || p.category || "").toLowerCase();
        const type = String(p.productTypeNormalized || p.productType || "").toLowerCase();
        const hay = [cat, type, String(p.description || "").toLowerCase()].join(" ");
        return cat.includes("makeup") || /\blipstick|lip oil|tint|stain|mascara|concealer|blush|liner\b/.test(hay);
      });
      if (mk.length >= 3) filteredProducts = mk;
    }
    if (detectBodyIntent(concern)) {
      const body = filteredProducts.filter((p) => {
        const cat = String(p.categoryNormalized || p.category || "").toLowerCase();
        const hay = [cat, String(p.description || "").toLowerCase()].join(" ");
        return cat.includes("body") || /\bbody|lotion|butter|hand|foot|shower\b/.test(hay);
      });
      if (body.length >= 3) filteredProducts = body;
    }
    filteredProducts = filterByTypeToken(concern, filteredProducts);

    // 2) Build prompt + strict JSON contract (concierge bullets + tone) + session context
    const promptBody = buildGeminiPrompt({
      concern,
      category,
      tone,
      products: filteredProducts
    });

    const toneHint =
      String(tone || "").toLowerCase().includes("bestie")
        ? "Use a warm, friendly 'smart bestie' tone while staying precise."
        : "Use a confident, compact expert tone—friendly but no fluff.";

    const contextText = formatSessionContext(context);

    const contract = `
Return ONLY JSON with this exact schema and no extra text:
{
  "scoredMatches": [
    { "id": "<id-or-exact-name-from-products>", "score": 0.0-1.0, "reason": "string with 2–4 bullets prefixed by • " }
  ],
  "explanation": "1–2 sentences summarizing the picks",
  "followUps": ["<2–3 short follow-up chips that refine intent>"]
}
Rules:
- ${toneHint}
- Use the product fields provided—do not invent data.
- 2–4 bullets per match in a warm, expert concierge voice:
  • Bullet 1: speak directly to the user's concern (e.g., "For <concern>…").
  • Bullet 2: key ingredient(s)/features → plain-English benefit.
  • Bullet 3: a short, practical "Use tip".
  • If ingestible or strong actives are implied, add a final "Heads-up:" safety bullet.
- 12–18 words per bullet. No emojis. No medical claims.
- Pick up to ${Math.max(1, Number(maxPicks) || 3)} items from the provided "products" list ONLY.
- "id" MUST be from product "id" or exact "name".
- If nothing fits, return an empty array for "scoredMatches".
- Always propose 2–3 helpful "followUps" that would clarify type, sensitivity, budget, or routine step.
`.trim();

    const fullPrompt = `${contextText}${promptBody}\n\n${contract}`.trim();

    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json" },
    });

    const result = await model.generateContent(fullPrompt);
    const raw = String(result?.response?.text?.() ?? "").trim();
    const jsonText = extractJsonBlock(raw);
    const parsed = JSON.parse(jsonText);

    if (!Array.isArray(parsed.scoredMatches) && !Array.isArray(parsed.productIds)) {
      throw new Error("Gemini returned malformed JSON");
    }

    // 3) allow-list normalization (map name/id variants back to canonical ids)
    const allow = new Map();
    for (const p of filteredProducts) {
      const canonical = String(p.id ?? p.name ?? "").trim();
      if (!canonical) continue;
      allow.set(canonical.toLowerCase(), canonical);
      if (p.name) allow.set(String(p.name).toLowerCase(), canonical);
    }

    const picked = (parsed.scoredMatches || [])
      .map((m) => ({
        id: String(m.id ?? "").trim(),
        score: Number(m.score ?? 0),
        reason: String(m.reason ?? "").trim(),
      }))
      .filter((m) => m.id);

    const normalizedIds = (picked.length ? picked.map((m) => m.id) : (parsed.productIds || []))
      .map((x) => String(x || "").toLowerCase().trim())
      .filter(Boolean)
      .map((k) => allow.get(k))
      .filter(Boolean);

    // maps for UI
    const reasonsById = {};
    const scoresById = {};
    for (const m of picked) {
      const canon = allow.get(String(m.id).toLowerCase());
      if (canon) {
        if (!reasonsById[canon] && m.reason) reasonsById[canon] = m.reason;
        if (!scoresById[canon]) scoresById[canon] = Math.max(0, Math.min(1, m.score || 0));
      }
    }

    // Ensure we have actionable follow-ups even if the model omits them
    const followUps =
      Array.isArray(parsed.followUps) && parsed.followUps.length
        ? parsed.followUps.slice(0, 3)
        : heuristicFollowUps(concern);

    return {
      productIds: Array.from(new Set(normalizedIds)).slice(0, Number(maxPicks) || 3),
      explanation: String(parsed.explanation || ""),
      followUps,
      reasonsById,
      scoresById,
    };
  } catch (err) {
    console.error("❌ Gemini AI Error:", err?.message || err);
    if (err?.message?.includes("redirect") || err?.message?.includes("403")) {
      console.warn("⚠️ Check your VITE_GEMINI_API_KEY and ensure it's valid for the selected model.");
    }
    return {
      productIds: [],
      explanation: "Sorry, I couldn’t generate expert suggestions right now.",
      followUps: heuristicFollowUps(concern),
      reasonsById: {},
      scoresById: {},
    };
  }
}

function extractJsonBlock(text) {
  try {
    JSON.parse(text);
    return text;
  } catch {}
  const jsonMatch = String(text || "").match(/```json([\s\S]*?)```/i);
  if (jsonMatch) return jsonMatch[1].trim();
  const firstBrace = String(text || "").indexOf("{");
  const lastBrace = String(text || "").lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1).trim();
  }
  throw new Error("No valid JSON block found in Gemini response.");
}
