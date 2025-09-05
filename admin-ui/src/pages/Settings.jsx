//admin-ui/src/pages/Settings.jsx
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
  aiTone: "professional",
  // New "Intelligence" settings
  aiConstraints: "Prefer vegan products. Avoid products containing fragrance.",
  productExclusions: "", // e.g. "tag:clearance, id:12345"
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
              <Text as="h3" variant="headingSm">AI Behavior</Text>
              <TextField
                label="AI Constraints"
                value={settings.aiConstraints}
                onChange={(v) => set("aiConstraints", v)}
                multiline={4}
                autoComplete="off"
                helpText="Add store-wide rules for the AI to follow. For example: 'Only recommend products under $50'."
              />
              <TextField
                label="Product Exclusions"
                value={settings.productExclusions}
                onChange={(v) => set("productExclusions", v)}
                autoComplete="off"
                helpText="Enter product tags or IDs to exclude from all recommendations, separated by commas."
              />
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