// refina-backend/bff/ai/gemini.js
// SDK-only, forced to v1 endpoint. No REST. Returns STRICT-JSON text or null.

import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const API_ENDPOINT =
  process.env.GEMINI_API_ENDPOINT || "https://generativelanguage.googleapis.com/v1";

if (!API_KEY) {
  console.warn("[Gemini] Missing GEMINI_API_KEY — model calls will be skipped and return null.");
}

// Build a singleton SDK client, preferring the { apiKey, apiEndpoint } signature if supported.
let genAI = null;
try {
  // Newer SDKs accept an options object with apiEndpoint; this forces v1 (not v1beta).
  genAI = new GoogleGenerativeAI({ apiKey: API_KEY, apiEndpoint: API_ENDPOINT });
  console.log("[Gemini] SDK initialized with explicit apiEndpoint:", API_ENDPOINT);
} catch {
  // Older SDKs only accept the API key string; constructor will pick its internal default.
  // We still proceed, but you should upgrade the SDK to ensure v1 endpoint usage.
  genAI = new GoogleGenerativeAI(API_KEY);
  console.warn("[Gemini] SDK initialized without apiEndpoint (old SDK). Please upgrade @google/generative-ai.");
}

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

  // Note: Some SDK versions accept generationConfig in the model ctor, others merge at call time.
  const modelClient = genAI.getGenerativeModel({
    model: mdl,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const result = await modelClient.generateContent(
      { contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }] },
      { signal: ac.signal }
    );
    clearTimeout(timer);

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
