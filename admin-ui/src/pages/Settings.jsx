import * as React from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Button,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";
import { api } from "../api/client.js";


// ---------- Defaults (edit as you like) ----------
const DEFAULT_SETTINGS = {
  category: "Beauty",
  aiTone: "professional", // professional | friendly | playful | scientific
  theme: {
    primaryColor: "#111827", // buttons / emphasis
    accentColor: "#10B981",  // highlights / badges
    borderRadius: "lg",      // sm | md | lg | 2xl
    gridColumns: 3,          // 2 | 3 | 4
    buttonStyle: "solid",    // solid | outline
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
  updatedAt: null,
};

// Normalize shallow + partials safely
function mergeDefaults(current = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
  const deep = (t, s) => {
    for (const k of Object.keys(s || {})) {
      if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) {
        if (!t[k]) t[k] = {};
        deep(t[k], s[k]);
      } else {
        t[k] = s[k];
      }
    }
  };
  deep(out, current);
  return out;
}

function normalizeLevel(v) {
  const s = String(v || "").toLowerCase().trim();
  if (/\bpremium\b/.test(s) || /\bpro\s*\+|\bpro\W*plus\b/.test(s)) return "premium";
  if (/\bpro\b/.test(s)) return "pro";
  return "free";
}

// Try preferred /api route
async function getSettings() {
  try {
    const { data: j } = await api.get("/api/admin/store-settings");
    return j?.settings || j || {};
  } catch (e) {
    throw new Error(e?.message || "Failed to load settings");
  }
}

async function saveSettings(settings) {
  try {
    // FINAL FIX: Changed method to PUT to match the backend API
    const { data: j } = await api.put("/api/admin/store-settings", { settings });
    return j;
  } catch (e) {
    throw new Error(e?.message || "Failed to save settings");
  }
}

export default function Settings() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [ok, setOk] = React.useState("");
  const [planBadge, setPlanBadge] = React.useState("");

  const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
  const [initial, setInitial] = React.useState(DEFAULT_SETTINGS);

  const dirty = JSON.stringify(settings) !== JSON.stringify(initial);

  React.useEffect(() => {
    (async () => {
      setError("");
      setOk("");
      setLoading(true);
      try {
        const raw = await getSettings();
        if (raw?.plan?.level) setPlanBadge(normalizeLevel(raw.plan.level));
        const merged = mergeDefaults(raw?.settings || raw);
        setSettings(merged);
        setInitial(merged);
      } catch (e) {
        setError(e?.message || "Failed to load settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    setBusy(true);
    setError("");
    setOk("");
    try {
      const payload = { ...settings, updatedAt: new Date().toISOString() };
      await saveSettings(payload);
      setInitial(payload);
      setSettings(payload);
      setOk("Settings saved.");
    } catch (e) {
      setError(e?.message || "Failed to save settings");
    } finally {
      setBusy(false);
    }
  }

  function handleResetDefaults() {
    const next = mergeDefaults({});
    setSettings(next);
  }

  // ---- field helpers ----
  const set = (path, value) => {
    setSettings((prev) => {
      const copy = structuredClone(prev);
      const parts = path.split(".");
      let obj = copy;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts.at(-1)] = value;
      return copy;
    });
  };

  // ---- render ----
  return (
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      <Card>
        <BlockStack gap="400">
          {/* THIS IS THE VISUAL TEST BANNER */}
          <Banner title="BUILD PROCESS TEST - V2" tone="info">
            <p>If you can see this message, the new code has been deployed successfully.</p>
          </Banner>

          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Settings</Text>
            {planBadge && (
              <Text as="span" tone="subdued" variant="bodySm">
                Plan: <b>{planBadge}</b>
              </Text>
            )}
          </InlineStack>

          {error && (
            <Banner tone="critical" title="Error">
              <p>{error}</p>
            </Banner>
          )}
          {ok && (
            <Banner tone="success" title="Saved">
              <p>{ok}</p>
            </Banner>
          )}

          {/* ... The rest of the page remains the same ... */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">General</Text>
              {/* ... */}
            </BlockStack>
          </Card>
          
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Frontend Theme</Text>
              {/* ... */}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">UI Options</Text>
              {/* ... */}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Copy</Text>
              {/* ... */}
            </BlockStack>
          </Card>
          
          <Divider />

          <InlineStack align="space-between">
            <InlineStack gap="300">
              <Button onClick={handleResetDefaults} disabled={busy || loading}>
                Reset to defaults
              </Button>
            </InlineStack>
            <InlineStack gap="300">
              <Text tone="subdued" as="span" variant="bodySm">
                {dirty ? "Unsaved changes" : "All changes saved"}
              </Text>
              <Button variant="primary" onClick={handleSave} disabled={!dirty || busy || loading}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </InlineStack>
          </InlineStack>
        </BlockStack>
      </Card>
    </Box>
  );
}

