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

const MODEL_PRIMARY = (process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-3-flash-preview").trim();

const MODEL_FALLBACKS = [
  MODEL_PRIMARY,          // prefer flash for latency
  "gemini-2.5-flash", // Better performance/intelligence than 2.0
  "gemini-1.5-flash", // The ultimate "reliable old truck" fallback,
];

// Prefer a dedicated indexer model if provided; otherwise fall back to current primary
const INDEXER_MODEL = (process.env.REFINA_INDEXER_MODEL || MODEL_PRIMARY).trim();

// Vertex client (indexer only; recommend stays on Studio)
const vertex = new VertexAI({
  project: process.env.GCP_PROJECT,
  location: process.env.GCP_LOCATION,
});

// ---- tiny util: ensure resp.response.text() exists (Vertex compatibility) ----
function shimTextAccessor(resp) {
  try {
    if (typeof resp?.response?.text === 'function') return resp;
    const nested = resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof nested === 'string') {
      Object.defineProperty(resp.response, 'text', {
        value: () => nested,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
  } catch (_) {}
  return resp;
}

// Minimal Vertex-backed helper for indexer (matches your current call shape)
// Replace the existing callGeminiIndex function with this one

export async function callGeminiIndex(prompt, cfg = {}) {
  const modelId = (cfg.model || INDEXER_MODEL);
  const model = vertex.getGenerativeModel({ model: modelId });
  const tStart = Date.now();

  try {
    // --- CHANGE: Default timeout is now 30000ms ---
    const timeoutMs = cfg.timeoutMs || 30000;

    const resp = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: String(prompt || "") }]}],
      generationConfig: {
        temperature: cfg.temperature ?? 0,
        topP: cfg.topP ?? 0.3,
        maxOutputTokens: cfg.maxOutputTokens ?? 8192,
        responseMimeType: cfg.responseMimeType ?? "application/json",
        ...(cfg.responseSchema ? { responseSchema: cfg.responseSchema } : {}),
      },
    },
    { timeout: timeoutMs });

    console.warn(`[Vertex AI] ${modelId} ok in ${Date.now() - tStart}ms`);

    // --- THIS IS THE FIX ---
    // Extract the text from the Vertex AI response and return ONLY the string.
    const text = resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    
    // If we get here, the response was empty or malformed
    return null;

  } catch (err) {
    console.error(`[Vertex AI] ${modelId} failed:`, err.message);
    return null;
  }
}

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

  // Candidate routing (primary → fallbacks)
  const candidates = Array.from(
    new Set([String(model || MODEL_PRIMARY).trim(), ...MODEL_FALLBACKS])
  ).filter(Boolean);

  // Prepare generationConfig (SDK expects camelCase + supports responseMimeType/Schema)
  // 1. Prepare base config
  const baseConfig = {
    responseMimeType,
  };

  // 2–4. Build generation config per candidate model.
// Important: this must use `mdl`, not the optional `model` argument,
// because production usually resolves the model from Render env via MODEL_PRIMARY.
const userContents = [{ role: "user", parts: [{ text: String(prompt || "") }] }];
const systemInstr = (system && String(system).trim())
  ? { role: "system", parts: [{ text: String(system).trim() }] }
  : null;

for (const mdl of candidates) {
  try {
    const isGemini3 = String(mdl || "").includes("gemini-3");

    const generationConfig = {
      responseMimeType,
    };

    // Gemini 3 Logic: Only apply thinkingConfig to models that support it.
    // This prevents 400 errors if the code falls back to a 1.5 or 2.5 model.
    if (isGemini3) {
      generationConfig.thinkingConfig = {
        includeThoughts: false, // Keeps your JSON output clean for parsing
        thinkingLevel: "low",   // Forces the low-latency Refina concierge path
      };
    }

    // Map standard params
    if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
    if (Number.isFinite(topP)) generationConfig.topP = topP;

    // Smart Max Tokens: Ensure enough room for the "Awesome" schema.
    // Gemini 3 uses a single budget for thoughts + output.
    // If set too low, the JSON can get truncated.
    generationConfig.maxOutputTokens = Number.isFinite(maxOutputTokens)
      ? maxOutputTokens
      : (isGemini3 ? 4096 : 2048);

    if (responseSchema) generationConfig.responseSchema = responseSchema;

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
          generationConfig,
        });

        console.warn(`[Gemini SDK] ${mdl} ok in ${Date.now() - tStart}ms`);
        clearTimeout(to);

        // ---- dual extractor: Studio .text() or Vertex-like nested shape ----
        let text;
        if (typeof res?.response?.text === "function") {
          // Google AI Studio response
          text = res.response.text();
        } else {
          // Vertex-like nested structure
          text = res?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        }

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
          status === 429 ||
          status === 503 ||
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

export default { callGeminiStructured, callGemini, callGeminiIndex };
