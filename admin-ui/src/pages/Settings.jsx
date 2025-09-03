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
  Spinner,
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
  // Deeply merge properties from current into the default structure
  const deepMerge = (target, source) => {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  };
  deepMerge(out, current);
  return out;
}

function normalizeLevel(v) {
  const s = String(v || "").toLowerCase().trim();
  if (/\bpremium\b/.test(s) || /\bpro\s*\+|\bpro\W*plus\b/.test(s)) return "premium";
  if (/\bpro\b/.test(s)) return "pro";
  return "free";
}

// Correctly use the new api client methods
async function getSettings() {
  try {
    const { data: json } = await api.get("/api/admin/store-settings");
    console.log("[Settings] Fetched data:", json);
    return json || {}; // Return the full payload
  } catch (e) {
    throw new Error(e?.message || "Failed to load settings");
  }
}

async function saveSettings(settingsToSave) {
  try {
    const { data: json } = await api.put("/api/admin/store-settings", {
      settings: settingsToSave
    });
    return json;
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
        const rawPayload = await getSettings();
        // The actual settings are nested inside the 'settings' key
        const fetchedSettings = rawPayload.settings || {};
        if (fetchedSettings?.plan?.level) {
          setPlanBadge(normalizeLevel(fetchedSettings.plan.level));
        }
        const merged = mergeDefaults(fetchedSettings);
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
      setInitial(payload); // Set the new baseline for "dirty" checking
      setSettings(payload); // Ensure UI reflects the exact saved state
      setOk("Settings saved successfully.");
      setTimeout(() => setOk(""), 3000); // Clear success message after 3s
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

  const set = (path, value) => {
    setSettings((prev) => {
      const copy = structuredClone(prev);
      const parts = path.split(".");
      let obj = copy;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]] = obj[parts[i]] || {};
      }
      obj[parts.at(-1)] = value;
      return copy;
    });
  };

  if (loading) {
    return (
      <Box padding="400"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="p">Loading settings...</Text></InlineStack></Box>
    );
  }

  return (
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Settings</Text>
            {planBadge && (
              <Text as="span" tone="subdued" variant="bodySm">
                Plan: <b>{planBadge}</b>
              </Text>
            )}
          </InlineStack>

          {error && <Banner tone="critical" title="Error" onDismiss={() => setError("")}><p>{error}</p></Banner>}
          {ok && <Banner tone="success" title="Success" onDismiss={() => setOk("")}><p>{ok}</p></Banner>}

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">General</Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="280px" width="100%">
                  <TextField label="Store category" value={settings.category} onChange={(v) => set("category", v)} autoComplete="off" placeholder="e.g. Beauty, Fishing Gear" />
                </Box>
                <Box minWidth="280px" width="100%">
                  <Select label="AI tone" options={[{ label: "Professional", value: "professional" }, { label: "Friendly", value: "friendly" }, { label: "Playful", value: "playful" }, { label: "Scientific", value: "scientific" },]} onChange={(v) => set("aiTone", v)} value={settings.aiTone} />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Frontend Theme</Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="240px" width="100%">
                  <Text as="span" variant="bodySm">Primary color</Text>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <input type="color" value={settings.theme.primaryColor} onChange={(e) => set("theme.primaryColor", e.target.value)} style={{ width: 36, height: 36, border: "1px solid #E5E7EB", borderRadius: 6 }} />
                    <TextField label="Hex" labelHidden value={settings.theme.primaryColor} onChange={(v) => set("theme.primaryColor", v)} autoComplete="off" />
                  </div>
                </Box>
                <Box minWidth="240px" width="100%">
                  <Text as="span" variant="bodySm">Accent color</Text>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <input type="color" value={settings.theme.accentColor} onChange={(e) => set("theme.accentColor", e.target.value)} style={{ width: 36, height: 36, border: "1px solid #E5E7EB", borderRadius: 6 }} />
                    <TextField label="Hex" labelHidden value={settings.theme.accentColor} onChange={(v) => set("theme.accentColor", v)} autoComplete="off" />
                  </div>
                </Box>
                <Box minWidth="240px" width="100%">
                  <Select label="Border radius" options={[{ label: "Small", value: "sm" }, { label: "Medium", value: "md" }, { label: "Large", value: "lg" }, { label: "2XL", value: "2xl" }]} onChange={(v) => set("theme.borderRadius", v)} value={settings.theme.borderRadius} />
                </Box>
                <Box minWidth="240px" width="100%">
                  <Select label="Grid columns" options={[{ label: "2", value: "2" }, { label: "3", value: "3" }, { label: "4", value: "4" }]} onChange={(v) => set("theme.gridColumns", Number(v))} value={String(settings.theme.gridColumns)} />
                </Box>
                <Box minWidth="240px" width="100%">
                  <Select label="Button style" options={[{ label: "Solid", value: "solid" }, { label: "Outline", value: "outline" }]} onChange={(v) => set("theme.buttonStyle", v)} value={settings.theme.buttonStyle} />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">UI Options</Text>
              <InlineStack gap="400" wrap>
                <Checkbox label="Show product badges" checked={!!settings.ui.showBadges} onChange={(v) => set("ui.showBadges", v)} />
                <Checkbox label="Show prices" checked={!!settings.ui.showPrices} onChange={(v) => set("ui.showPrices", v)} />
                <Checkbox label="Enable product modal" checked={!!settings.ui.enableModal} onChange={(v) => set("ui.enableModal", v)} />
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Copy</Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="280px" width="100%">
                  <TextField label="Heading" value={settings.copy.heading} onChange={(v) => set("copy.heading", v)} autoComplete="off" />
                </Box>
                <Box minWidth="280px" width="100%">
                  <TextField label="Subheading" value={settings.copy.subheading} onChange={(v) => set("copy.subheading", v)} autoComplete="off" />
                </Box>
                <Box minWidth="280px" width="100%">
                  <TextField label="CTA text" value={settings.copy.ctaText} onChange={(v) => set("copy.ctaText", v)} autoComplete="off" />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          <Divider />

          <InlineStack align="space-between">
            <Button onClick={handleResetDefaults} disabled={busy || loading}>Reset to defaults</Button>
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

