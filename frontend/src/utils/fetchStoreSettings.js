// frontend/src/utils/fetchStoreSettings.js
import * as React from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

// ---- Defaults (match Admin Settings page) ----
export const DEFAULT_SETTINGS = {
  category: "Beauty",
  aiTone: "professional", // new normalized key (we still return `tone` too)
  theme: {
    primaryColor: "#111827",
    accentColor: "#10B981",
    borderRadius: "lg",   // sm | md | lg | 2xl
    gridColumns: 3,       // 2 | 3 | 4
    buttonStyle: "solid", // solid | outline
  },
  ui: {
    showBadges: true,
    showPrices: true,
    enableModal: true,
  },
  copy: {
    heading: "Find the perfect routine",
    subheading: "Tell Refina your concern and we’ll match expert picks.",
    ctaText: "Ask Refina",
  },
};

const RADIUS_MAP = { sm: 6, md: 10, lg: 14, "2xl": 20 };
const TONE_MAP = {
  helpful: "friendly",
  expert: "professional",
  professional: "professional",
  friendly: "friendly",
  playful: "playful",
  scientific: "scientific",
};

function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  }
  return out;
}

// Adapt Firestore doc → widget schema
function adaptFromBackend(raw = {}) {
  const tokens = raw.theme?.tokens || raw.themeDraft?.tokens || {};
  // radius can be token string or px number
  let borderRadius = "lg";
  const r = tokens.radius;
  if (typeof r === "string" && RADIUS_MAP[r]) borderRadius = r;
  else if (typeof r === "number") {
    if (r < 8) borderRadius = "sm";
    else if (r < 12) borderRadius = "md";
    else if (r < 18) borderRadius = "lg";
    else borderRadius = "2xl";
  }

  const aiTone = TONE_MAP[String(raw.tone || "").toLowerCase()] || DEFAULT_SETTINGS.aiTone;

  return deepMerge(DEFAULT_SETTINGS, {
    category: raw.category || DEFAULT_SETTINGS.category,
    aiTone,
    tone: raw.tone ?? "helpful",           // keep original for back-compat
    plan: raw.plan ?? "free",
    theme: {
      primaryColor: tokens.primary || DEFAULT_SETTINGS.theme.primaryColor,
      accentColor: tokens.accent || DEFAULT_SETTINGS.theme.accentColor,
      borderRadius,
      // gridColumns/buttonStyle remain defaults unless stored later
    },
    ui: typeof raw.ui === "object" ? deepMerge(DEFAULT_SETTINGS.ui, raw.ui) : DEFAULT_SETTINGS.ui,
    copy: typeof raw.copy === "object" ? deepMerge(DEFAULT_SETTINGS.copy, raw.copy) : DEFAULT_SETTINGS.copy,
  });
}

export async function fetchStoreSettings(storeId = "demo") {
  if (!storeId || storeId === "undefined") {
    return adaptFromBackend({ plan: "free", category: "Beauty", tone: "helpful" });
  }

  try {
    const ref = doc(db, "storeSettings", storeId); // ✅ must include storeId
    const snap = await getDoc(ref);
    return snap.exists()
      ? adaptFromBackend(snap.data())
      : adaptFromBackend({ plan: "free", category: "Beauty", tone: "helpful" });
  } catch (error) {
    console.error("❌ Failed to fetch store settings:", error);
    return adaptFromBackend({ plan: "free", category: "Beauty", tone: "helpful" });
  }
}

// Optional: hook + CSS vars for painless theming in the widget
export function useStoreSettings(storeId) {
  const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true); setError("");
      try {
        const s = await fetchStoreSettings(storeId);
        if (mounted) setSettings(s);
      } catch (e) {
        if (mounted) setError(e?.message || "Failed to load settings");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [storeId]);
  return { settings, loading, error };
}

export function themeVarsFromSettings(theme = DEFAULT_SETTINGS.theme) {
  const px = RADIUS_MAP[theme.borderRadius] ?? 12;
  return {
    "--refina-primary": theme.primaryColor,
    "--refina-accent": theme.accentColor,
    "--refina-radius": `${px}px`,
    "--refina-grid-cols": String(theme.gridColumns || 3),
    "--refina-btn-style": theme.buttonStyle || "solid",
  };
}
