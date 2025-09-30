// refina-backend/bff/ai/gemini.js
// REST-only generateContent helper (no @google/generative-ai SDK).
// Returns STRICT-JSON text (as string) or null on failure.

const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const API_BASE = (process.env.GEMINI_API_ENDPOINT || "https://generativelanguage.googleapis.com/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = (process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash-latest").trim();

if (!API_KEY) {
  console.warn("[Gemini REST] Missing GEMINI_API_KEY — model calls will be skipped and return null.");
}

/**
 * Low-level structured caller via REST. Returns model **text** (string) or null on failure.
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
  if (!API_KEY) return null;

  const mdl = String(model || DEFAULT_MODEL).trim();
  const url = `${API_BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(API_KEY)}`;

  const generationConfig = {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(topP) ? { topP } : {}),
    ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
    ...(responseMimeType ? { responseMimeType } : {}),
    ...(responseSchema ? { responseSchema } : {}),
  };

  const body = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }],
    generationConfig,
  };

  if (system && String(system).trim()) {
    body.systemInstruction = { role: "system", parts: [{ text: String(system) }] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.warn(`[Gemini REST] HTTP ${resp.status} ${resp.statusText}: ${txt.slice(0, 300)}`);
      return null;
    }

    const data = await resp.json();

    // Concatenate all text parts from the first candidate
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const out = parts.map(p => (typeof p?.text === "string" ? p.text : "")).join("").trim();
      return out || null;
    }
    const fallback = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
  } catch (err) {
    const msg = err?.name ? `${err.name}: ${err.message || ""}` : String(err || "");
    console.warn("[Gemini REST] generateContent error:", msg);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thin wrapper used by routes/workers:
 *   const text = await callGemini(prompt, genConfig)
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
