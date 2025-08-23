// Server-side Gemini call via REST (avoids ESM import issues).
// Falls back gracefully when GEMINI_API_KEY is missing or on timeout.

const { setTimeout: sleep } = require("timers/promises");

async function ensureFetch() {
  if (typeof fetch !== "function") {
    // Node <18 fallback
    try { global.fetch = (await import("node-fetch")).default; }
    catch (e) { throw new Error("No fetch available; install node-fetch or use Node 18+"); }
  }
}

async function callGeminiStructured({ prompt, model, timeoutMs = 4000 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[Gemini] GEMINI_API_KEY missing — skipping AI path");
    return null;
  }

  await ensureFetch();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 800
    }
  };

  // Simple timeout guard + one retry
  const attempt = async () => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(id);
      if (!resp.ok) {
        const text = await resp.text();
        console.warn("[Gemini] non-200:", resp.status, text.slice(0, 300));
        return null;
      }
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) return null;

      // Expect strict JSON; try parse; if markdown fences slipped in, strip them
      const jsonText = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonText);
      const productIds = Array.isArray(parsed.productIds) ? parsed.productIds : [];
      const copy = parsed.copy || {};
      if (!productIds.length || !copy.why || !copy.rationale || !copy.extras) return null;
      return { productIds, copy };
    } catch (e) {
      console.warn("[Gemini] error:", e?.name || e?.message || e);
      return null;
    }
  };

  let result = await attempt();
  if (!result) {
    await sleep(200 + Math.random() * 250);
    result = await attempt();
  }
  return result;
}

module.exports = { callGeminiStructured };
