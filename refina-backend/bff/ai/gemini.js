// refina-backend/bff/ai/gemini.js
// SDK-only generateContent helper using @google/generative-ai.
// Returns model text (STRICT JSON per your prompt) or null.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { VertexAI } from '@google-cloud/vertexai';

// ─────────────────────────────────────────────────────────────
// Env & defaults
// ─────────────────────────────────────────────────────────────
const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const MODEL_PRIMARY = (process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash").trim();

const MODEL_FALLBACKS = [
  MODEL_PRIMARY,          // prefer flash for latency
  "gemini-2.5-pro",       // then pro if needed
  "gemini-2.0-flash",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────
// Core: SDK generateContent with contract + optional schema
// ─────────────────────────────────────────────────────────────
export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 30000,
  temperature,
  topP,
  maxOutputTokens,
  responseMimeType = "application/json",
  responseSchema, // optional JSON schema (SDK supports this)
  system,         // optional system instruction text
} = {}) {
  if (!API_KEY) return null;

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const vertex = new VertexAI({ project: process.env.GCP_PROJECT, location: process.env.GCP_LOCATION });


  // Candidate routing (primary → fallbacks)
  const candidates = Array.from(
    new Set([String(model || MODEL_PRIMARY).trim(), ...MODEL_FALLBACKS])
  ).filter(Boolean);

  // Prepare generationConfig (SDK expects camelCase + supports responseMimeType/Schema)
  const baseConfig = {
    responseMimeType, // <-- JSON contract enforced
  };
  if (Number.isFinite(temperature)) baseConfig.temperature = temperature;
  if (Number.isFinite(topP)) baseConfig.topP = topP;
  if (Number.isFinite(maxOutputTokens)) baseConfig.maxOutputTokens = maxOutputTokens;
  if (responseSchema) baseConfig.responseSchema = responseSchema;

  const userContents = [{ role: "user", parts: [{ text: String(prompt || "") }] }];
  const systemInstr = (system && String(system).trim())
    ? { role: "system", parts: [{ text: String(system).trim() }] }
    : null;

  for (const mdl of candidates) {
    try {
      const modelClient = genAI.getGenerativeModel({
        model: mdl,
        ...(systemInstr ? { systemInstruction: systemInstr } : {}),
      });

      let delay = 250;
      const attempts = 3; // 1 try + 2 retries
      for (let i = 0; i < attempts; i++) {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const tStart = Date.now();
          const res = await modelClient.generateContent({
            contents: userContents,
            generationConfig: baseConfig,
          });
          console.warn(`[Gemini SDK] ${mdl} ok in ${Date.now() - tStart}ms`);
          clearTimeout(to);

          const text = res?.response?.text?.();
          if (typeof text === "string" && text.trim()) return text.trim();
          // Empty output → try next model
          break;
        } catch (err) {
          clearTimeout(to);
          const name = err?.name || "";
          const msg = err?.message || "";
          const status = err?.status ?? err?.code ?? 0;
          const transient =
            name === "AbortError" ||
            status === 429 || status === 503 ||
            /deadline|timeout|temporar|overload|retry|unavailable/i.test(msg);
          if (transient && i < attempts - 1) {
            console.warn(`[Gemini SDK] ${mdl} transient: ${msg || name}; retrying in ${delay}ms`);
            await sleep(delay);
            delay = Math.min(delay * 2, 2000);
            continue;
          }
          // Non-transient: stop retrying this model, move to the next candidate.
          break;
        }
      }
    } catch {
      // If constructing/using the model fails immediately, fall through to next.
    }
  }

  return null;
}

// Thin convenience wrapper used by the rest of the codebase.
// Accepts the same fields you previously passed in genConfig.
export function callGemini(prompt, cfg = {}) {
  return callGeminiStructured({
    prompt,
    model: cfg?.model,
    timeoutMs: cfg?.timeoutMs ?? 30000,
    temperature: cfg?.temperature,
    topP: cfg?.topP,
    maxOutputTokens: cfg?.maxOutputTokens,
    responseMimeType: "application/json",
    responseSchema: cfg?.responseSchema,
    system: cfg?.system,
  });
}

// 2) Export two tiny helpers so callers don’t change
export const getStudioModel = (modelId) =>
  studio.getGenerativeModel({ model: modelId });

export const getVertexModel = (modelId) =>
  vertex.getGenerativeModel({ model: modelId });

export default { callGeminiStructured, callGemini };
