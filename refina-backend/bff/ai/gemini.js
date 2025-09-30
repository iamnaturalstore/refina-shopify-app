// refina-backend/bff/ai/gemini.js
// REST-only generateContent helper (no @google/generative-ai SDK).
// Returns model text (STRICT JSON per your prompt) or null.

const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const API_BASE = (process.env.GEMINI_API_ENDPOINT || "https://generativelanguage.googleapis.com/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = (process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash").trim();

if (!API_KEY) {
  console.warn("[Gemini REST] Missing GEMINI_API_KEY — model calls will be skipped and return null.");
}

/**
 * Low-level structured caller via REST. Returns model **text** (string) or null on failure.
 * Supported gen params: temperature, topP, maxOutputTokens. No response schema/mime here.
 */
export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 30000,          // ← give generation enough headroom
  temperature,
  topP,
  maxOutputTokens,
  system,
}) {
  if (!API_KEY) return null;

  const mdl = String(model || DEFAULT_MODEL).trim();
  const url = `${API_BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(API_KEY)}`;

  const generationConfig = {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(topP) ? { topP } : {}),
    ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
  };

  const body = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }],
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(system && String(system).trim()
      ? { systemInstruction: { role: "system", parts: [{ text: String(system) }] } }
      : {}),
  };

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
      console.warn(`[Gemini REST] HTTP ${resp.status} ${resp.statusText}: ${txt.slice(0, 400)}`);
      return null;
    }

    const data = await resp.json();
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
