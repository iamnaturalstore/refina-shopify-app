// refina-backend/bff/lib/settings.js
import { db, setDocSafe, nowTs } from "./firestore.js";

const DEFAULTS = {
  tone: (process.env.BFF_DEFAULT_TONE || "bestie").toLowerCase(),       // change to "expert" if you prefer
  category: process.env.BFF_DEFAULT_CATEGORY || "Generic",
  enabledPacks: (process.env.BFF_ENABLED_PACKS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),
  domain: "",
};

export function normalizeTone(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return DEFAULTS.tone;
  if (/(bestie|friendly|warm|helpful)/.test(s)) return "bestie";
  if (/(expert|pro|concise|direct)/.test(s)) return "expert";
  return DEFAULTS.tone;
}

export async function getOrInitStoreSettings(storeId) {
  const ref = db.doc(`storeSettings/${storeId}`);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() || {};
    const tone = normalizeTone(data.tone);
    return { ...DEFAULTS, ...data, tone };
  }
  const seed = {
    ...DEFAULTS,
    tone: normalizeTone(DEFAULTS.tone),
    createdAt: nowTs(),
    settingsVersion: 1,
  };
  await setDocSafe(ref, seed);
  return seed;
}
