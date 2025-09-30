// refina-backend/bff/ai/gemini.js
// REST-only generateContent helper (no @google/generative-ai SDK).
// Returns model text (STRICT JSON per your prompt) or null.

const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const API_BASE = (process.env.GEMINI_API_ENDPOINT || "https://generativelanguage.googleapis.com/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = (process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-pro").trim();

const DEFAULT_MAX_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 1024);

if (!API_KEY) {
  console.warn("[Gemini REST] Missing GEMINI_API_KEY — model calls will be skipped and return null.");
}

/**
 * Low-level structured caller via REST. Returns model **text** (string) or null on failure.
 * Supported gen params: temperature, topP, maxOutputTokens. No response schema/mime here.
 */
// In refina-backend/bff/ai/gemini.js

// REPLACE your existing callGeminiStructured function with this one

export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 25000, // Generous total timeout for the entire operation
  temperature,
  topP,
  maxOutputTokens,
  responseMimeType = "application/json",
  responseSchema,
  system,
}) {
  if (!genAI) return null;

  const mdl = String(model || process.env.GEMINI_MODEL_NAME || "gemini-pro").trim();

  const generationConfig = {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(topP) ? { topP } : {}),
    ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
    ...(responseMimeType ? { response_mime_type: responseMimeType } : {}),
  };

  const systemInstruction =
    system && String(system).trim()
      ? { role: "system", parts: [{ text: String(system) }] }
      : undefined;

  const modelClient = genAI.getGenerativeModel({
    model: mdl,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig,
  });

  // --- RESILIENCE LOGIC: EXPONENTIAL BACKOFF & RETRIES ---
  const maxRetries = 2; // Total of 3 attempts (initial + 2 retries)
  let lastError = null;

  for (let i = 0; i <= maxRetries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);

    try {
      const result = await modelClient.generateContent(
        { contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }] },
        { signal: ac.signal }
      );
      clearTimeout(timer);

      const text = result?.response?.text?.();
      const out = typeof text === "string" ? text.trim() : "";
      return out || null; // Success!

    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const msg = err?.name ? `${err.name}: ${err.message || ""}` : String(err || "");
      console.warn(`[Gemini] Attempt ${i + 1}/${maxRetries + 1} failed:`, msg);

      // Only retry on specific, temporary errors (like 503) and if it's not the last attempt.
      if (i < maxRetries && /503|UNAVAILABLE|overloaded|timeout/i.test(msg)) {
        const delay = Math.pow(2, i) * 1000 + Math.random() * 500; // 1s, 2s, 4s... + jitter
        console.log(`[Gemini] Retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        // Not a retryable error or we've run out of retries, so we fail.
        break;
      }
    }
  }

  console.error("[Gemini] All retry attempts failed. Last error:", lastError?.message || lastError);
  return null; // Return null to signal a definitive failure.
}

// If we *do* have a candidate but no text parts, surface the finish reason
if (!Array.isArray(c?.content?.parts) || !c.content.parts.length) {
  const fr = c?.finishReason || "unspecified";
  console.warn("[Gemini REST] candidate has no text parts; finishReason=", fr);
  return null;
}

/** Thin wrapper */
export function callGemini(prompt, genConfig = {}) {
  return callGeminiStructured({
    prompt,
    model: genConfig?.model,
    temperature: genConfig?.temperature,
    topP: genConfig?.topP,
    maxOutputTokens: genConfig?.maxOutputTokens,
    timeoutMs: genConfig?.timeoutMs ?? 30000, // keep aligned with above
    system: genConfig?.system,
  });
}

export default { callGeminiStructured, callGemini };
