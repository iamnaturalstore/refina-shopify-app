// admin-ui/src/pages/Settings.jsx
import * as React from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  Text,
  TextField,
  Select,
  Banner,
  Box,
  Spinner,
  PageActions,
} from "@shopify/polaris";
import styles from "./Analytics.module.css";
import { api } from "../api/client.js";

// ---------- Defaults and Helpers (Unchanged) ----------
const DEFAULT_SETTINGS = {
  category: "Beauty",
  aiTone: "professional",
  aiConstraints: "Prefer vegan products. Avoid products containing fragrance.",
  productExclusions: "",
  updatedAt: null,
};

function mergeDefaults(current = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
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

async function getSettings() {
  try {
    const { data: json } = await api.get("/api/admin/store-settings");
    return json || {};
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
  const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
  const [initial, setInitial] = React.useState(DEFAULT_SETTINGS);

  const dirty = JSON.stringify(settings) !== JSON.stringify(initial);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const rawPayload = await getSettings();
        const fetchedSettings = rawPayload.settings || {};
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
      setInitial(payload);
      setSettings(payload);
      setOk("Settings saved successfully.");
      setTimeout(() => setOk(""), 3000);
    } catch (e) {
      setError(e?.message || "Failed to save settings");
    } finally {
      setBusy(false);
    }
  }

  function handleResetDefaults() {
    setSettings(mergeDefaults({}));
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

  const pageContent = loading ? (
    <div className={styles.spinnerContainer}>
      <Spinner accessibilityLabel="Loading settings" size="large" />
    </div>
  ) : (
    <BlockStack gap="400">
      {error && <Banner tone="critical" title="Error" onDismiss={() => setError("")}><p>{error}</p></Banner>}
      {ok && <Banner tone="success" title="Success" onDismiss={() => setOk("")}><p>{ok}</p></Banner>}
      <Layout>
        <Layout.Section>
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
        </Layout.Section>
        <Layout.Section>
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
        </Layout.Section>
      </Layout>
    </BlockStack>
  );

  return (
    <Page>
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg" className={styles.pageTitle}>
          Settings
        </Text>
        <Text as="p" tone="subdued">
          Control the core intelligence and behavior of your AI concierge.
        </Text>
        {pageContent}
      </BlockStack>

      <PageActions
        primaryAction={{
          content: "Save changes",
          loading: busy,
          disabled: !dirty || busy,
          onAction: handleSave,
        }}
        secondaryActions={[
          {
            content: "Reset to defaults",
            disabled: busy || loading,
            onAction: handleResetDefaults,
          },
        ]}
      />
    </Page>
  );
}