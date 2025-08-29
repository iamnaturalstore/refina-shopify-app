// refina-backend/bff/ai/gemini.js
// Pure ESM. Server-side call to Google Generative Language API (Gemini)
// Returns the **raw model text** (expected to be STRICT JSON per your prompt).
// BFF parses/normalizes downstream via extractJson() + coerceToContract().

import { setTimeout as sleep } from "timers/promises";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Low-level caller. Returns model **text** (string) or null on failure.
 *
 * @param {Object} args
 * @param {string} args.prompt
 * @param {string} [args.model] - e.g. "gemini-1.5-flash"
 * @param {number} [args.timeoutMs=8000]
 * @param {number} [args.temperature]
 * @param {number} [args.topP]
 * @param {number} [args.maxOutputTokens]
 */
export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 8000,
  temperature,
  topP,
  maxOutputTokens
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    console.warn("[Gemini] GEMINI_API_KEY missing — skipping AI path");
    return null;
  }

  const mdl = String(model || process.env.GEMINI_MODEL || "gemini-1.5-flash").trim();
  const url = `${API_BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Build body. We **do not** set response_mime_type to avoid REST casing pitfalls.
  const body = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }],
    generationConfig: {}
  };
  if (Number.isFinite(temperature)) body.generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) body.generationConfig.topP = topP;
  if (Number.isFinite(maxOutputTokens)) body.generationConfig.maxOutputTokens = maxOutputTokens;

  const attempt = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(t);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.warn("[Gemini] HTTP", resp.status, txt.slice(0, 300));
        return null;
      }

      const data = await resp.json();

      // Extract concatenated text from parts
      const parts = data?.candidates?.[0]?.content?.parts;
      let out = "";
      if (Array.isArray(parts)) {
        out = parts
          .map((p) => (typeof p?.text === "string" ? p.text : ""))
          .join("")
          .trim();
      } else if (typeof data?.candidates?.[0]?.content?.parts?.[0]?.text === "string") {
        out = String(data.candidates[0].content.parts[0].text || "").trim();
      }

      return out || null;
    } catch (e) {
      clearTimeout(t);
      // AbortError, network, etc.
      const msg = e?.name ? `${e.name}: ${e.message || ""}` : String(e || "");
      console.warn("[Gemini] request error:", msg);
      return null;
    }
  };

  // One retry with jitter
  let text = await attempt();
  if (!text) {
    await sleep(200 + Math.random() * 250);
    text = await attempt();
  }
  return text;
}

/**
 * Thin wrapper used by bff/server.js:
 *   const modelText = await callGemini(prompt, genConfig)
 * where genConfig may contain { model, temperature, topP, maxOutputTokens, timeoutMs }.
 */
export function callGemini(prompt, genConfig = {}) {
  return callGeminiStructured({
    prompt,
    model: genConfig?.model,
    temperature: genConfig?.temperature,
    topP: genConfig?.topP,
    maxOutputTokens: genConfig?.maxOutputTokens,
    timeoutMs: genConfig?.timeoutMs ?? 8000
  });
}

export default { callGeminiStructured, callGemini };
