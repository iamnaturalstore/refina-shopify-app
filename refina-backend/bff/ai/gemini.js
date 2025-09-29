// refina-backend/bff/ai/gemini.js
// SDK-only implementation (no REST). Returns the **raw model text** (STRICT JSON per your prompt).
// Exported API surface stays the same: callGemini(prompt, genConfig)

import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

if (!API_KEY) {
  console.warn("[Gemini] Missing GEMINI_API_KEY — model calls will be skipped and return null.");
}

// Singleton SDK client
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

/**
 * Low-level structured caller. Returns model **text** (string) or null on failure.
 *
 * @param {Object} args
 * @param {string} args.prompt
 * @param {string} [args.model] - e.g. "gemini-1.5-flash-latest"
 * @param {number} [args.timeoutMs=15000]
 * @param {number} [args.temperature]
 * @param {number} [args.topP]
 * @param {number} [args.maxOutputTokens]
 * @param {string} [args.responseMimeType="application/json"]
 * @param {object} [args.responseSchema]
 * @param {string} [args.system]
 */
export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 15000,
  temperature,
  topP,
  maxOutputTokens,
  responseMimeType = "application/json",
  responseSchema,
  system,
}) {
  if (!genAI) return null;

  const mdl = String(model || process.env.GEMINI_MODEL || "gemini-1.5-flash-latest").trim();

  const generationConfig = {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(topP) ? { topP } : {}),
    ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
    ...(responseMimeType ? { responseMimeType } : {}),
    ...(responseSchema ? { responseSchema } : {}),
  };

  // Optional system instruction
  const systemInstruction =
    system && String(system).trim()
      ? { role: "system", parts: [{ text: String(system) }] }
      : undefined;

  const modelClient = genAI.getGenerativeModel({
    model: mdl,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig,
  });

  // Abort controller for timeout
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const result = await modelClient.generateContent(
      { contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }] },
      { signal: ac.signal }
    );
    clearTimeout(timer);

    // SDK returns text in parts even with JSON mode enabled
    const text = result?.response?.text?.();
    const out = typeof text === "string" ? text.trim() : "";
    return out || null;
  } catch (err) {
    clearTimeout(timer);
    const msg = err?.name ? `${err.name}: ${err.message || ""}` : String(err || "");
    console.warn("[Gemini] generateContent error:", msg);
    return null;
  }
}

/**
 * Thin wrapper used by routes and workers.
 * genConfig may include: { model, temperature, topP, maxOutputTokens, timeoutMs, responseMimeType, responseSchema, system }
 */
export function callGemini(prompt, genConfig = {}) {
  return callGeminiStructured({
    prompt,
    model: genConfig?.model,
    temperature: genConfig?.temperature,
    topP: genConfig?.topP,
    maxOutputTokens: genConfig?.maxOutputTokens,
    timeoutMs: genConfig?.timeoutMs ?? 15000,
    responseMimeType: genConfig?.responseMimeType ?? "application/json",
    responseSchema: genConfig?.responseSchema,
    system: genConfig?.system,
  });
}

export default { callGeminiStructured, callGemini };
