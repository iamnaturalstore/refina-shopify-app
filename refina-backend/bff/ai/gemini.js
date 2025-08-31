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
 * @param {string} [args.responseMimeType="application/json"]  // ← JSON mode by default
 * @param {object} [args.responseSchema]                       // optional JSON schema
 * @param {string} [args.system]                               // optional system instruction text
 */
export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 8000,
  temperature,
  topP,
  maxOutputTokens,
  responseMimeType = "application/json",
  responseSchema,
  system
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    console.warn("[Gemini] GEMINI_API_KEY missing — skipping AI path");
    return null;
  }

  const mdl = String(model || process.env.GEMINI_MODEL || "gemini-1.5-flash").trim();
  const url = `${API_BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Build request body with JSON mode + optional schema.
  const generationConfig = {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(topP) ? { topP } : {}),
    ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
    ...(responseMimeType ? { responseMimeType } : {}),
    ...(responseSchema ? { responseSchema } : {})
  };

  const body = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }],
    generationConfig
  };

  // Optional system instruction (kept minimal/compact)
  if (system && String(system).trim()) {
    body.systemInstruction = { role: "system", parts: [{ text: String(system) }] };
  }

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.warn("[Gemini] HTTP", resp.status, txt.slice(0, 300));
        return null;
      }

      const data = await resp.json();

      // Extract concatenated text from parts
      // (When responseMimeType=application/json, the JSON is still returned in parts[].text)
      const parts = data?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        const out = parts.map(p => (typeof p?.text === "string" ? p.text : "")).join("").trim();
        return out || null;
      }
      const fallback = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
    } catch (e) {
      clearTimeout(timer);
      const msg = e?.name ? `${e.name}: ${e.message || ""}` : String(e || "");
      console.warn("[Gemini] request error:", msg);
      return null;
    }
  };

  // One retry with small jitter for transient issues
  let text = await attempt();
  if (!text) {
    await sleep(200 + Math.random() * 250);
    text = await attempt();
  }
  return text;
}

/**
 * Thin wrapper used by bff/server.js and workers:
 *   const modelText = await callGemini(prompt, genConfig)
 * where genConfig may contain:
 *   { model, temperature, topP, maxOutputTokens, timeoutMs, responseMimeType, responseSchema, system }
 */
export function callGemini(prompt, genConfig = {}) {
  return callGeminiStructured({
    prompt,
    model: genConfig?.model,
    temperature: genConfig?.temperature,
    topP: genConfig?.topP,
    maxOutputTokens: genConfig?.maxOutputTokens,
    timeoutMs: genConfig?.timeoutMs ?? 8000,
    responseMimeType: genConfig?.responseMimeType ?? "application/json",
    responseSchema: genConfig?.responseSchema,
    system: genConfig?.system
  });
}

export default { callGeminiStructured, callGemini };
