const fs = require("fs");
const path = require("path");

/** Load optional category pack config (beauty, fishing, supplements, etc.) */
async function loadPacksForStore(settings = {}) {
  const enabled = Array.isArray(settings.enabledPacks) ? settings.enabledPacks : [];
  if (!enabled.length) return null;

  const packs = {};
  for (const pack of enabled) {
    const file = path.join(__dirname, "..", "packs", pack, "config.json");
    try {
      const raw = fs.readFileSync(file, "utf8");
      packs[pack] = JSON.parse(raw);
    } catch (_e) {
      // missing pack is non-fatal
    }
  }

  // Flatten some commonly used combined hints
  return {
    chips: Object.values(packs).flatMap(p => p.chips || []),
    synonyms: Object.values(packs).flatMap(p => p.synonyms || []),
    boosts: Object.values(packs).flatMap(p => p.boosts || []),
    _all: packs,
  };
}

module.exports = { loadPacksForStore };
