// refina-backend/bff/ai/gemini.js
// REST-only generateContent helper (no @google/generative-ai SDK).
// Returns model text (STRICT JSON per your prompt) or null.

const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const API_BASE = (process.env.GEMINI_API_ENDPOINT || "https://generativelanguage.googleapis.com/v1").replace(/\/+$/, "");
const MODEL_PRIMARY = (process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash").trim();
const MODEL_FALLBACKS = [
  MODEL_PRIMARY,
  "gemini-2.0-flash",
  "gemini-2.5-pro",
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function callGeminiStructured({
  prompt,
  model,
  timeoutMs = 30000,
  temperature,
  topP,
  maxOutputTokens,
  responseMimeType = "application/json",
  system,
}) {
  if (!API_KEY) return null;

  const candidates = Array.from(new Set([String(model || MODEL_PRIMARY).trim(), ...MODEL_FALLBACKS])).filter(Boolean);

  const generationConfig = {};
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (Number.isFinite(maxOutputTokens)) generationConfig.maxOutputTokens = maxOutputTokens;

  const bodyBase = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }],
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
  if (system && String(system).trim()) {
    bodyBase.systemInstruction = { role: "system", parts: [{ text: String(system) }] };
  }

  // try each model with retries on 503/429
  for (const mdl of candidates) {
    const url = `${API_BASE}/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
    const body = { ...bodyBase };

    const attempts = 3;                   // 1 try + 2 retries
    let delay = 250;                      // backoff base
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          // retry on overloaded / rate-limited
          if (resp.status === 503 || resp.status === 429) {
            console.warn(`[Gemini REST] ${mdl} -> ${resp.status}. Retrying in ${delay}ms…`);
            await sleep(delay);
            delay = Math.min(delay * 2, 2000);
            continue;
          }
          console.warn(`[Gemini REST] HTTP ${resp.status} ${resp.statusText}: ${txt.slice(0, 400)}`);
          break; // non-retryable for this model → try next model
        }

        const data = await resp.json();
        const parts = data?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          const out = parts.map(p => (typeof p?.text === "string" ? p.text : "")).join("").trim();
          if (out) return out;
        }
        const fallback = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
        // empty (but OK) → try next model
        break;
      } catch (err) {
        clearTimeout(timer);
        // Abort or transient network: retry this model
        const transient = err?.name === "AbortError";
        console.warn(`[Gemini REST] ${mdl} error: ${err?.name || ""} ${err?.message || String(err)}`);
        if (transient && i < attempts - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 2000);
          continue;
        }
        // non-transient → try next model
        break;
      }
    }
    // next model
    console.warn(`[Gemini REST] switching model from ${mdl} → next fallback`);
  }

  return null;
}

export function callGemini(prompt, genConfig = {}) {
  return callGeminiStructured({
    prompt,
    model: genConfig?.model,               // you can still force one
    temperature: genConfig?.temperature,
    topP: genConfig?.topP,
    maxOutputTokens: genConfig?.maxOutputTokens,
    timeoutMs: genConfig?.timeoutMs ?? 30000,
    system: genConfig?.system,
  });
}


export default { callGeminiStructured, callGemini };
