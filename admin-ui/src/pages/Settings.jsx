// admin-ui/src/pages/Settings.jsx
import * as React from "react";
import {
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  Spinner,
  InlineStack,
} from "@shopify/polaris";
import api from "../api/client";

// A simple page header that doesn't conflict with legacy title bars.
function PageHeader({ title, primaryAction }) {
  return (
    <div style={{ marginBottom: "1.6rem" }}>
      <InlineStack align="space-between" blockAlign="center">
        <Text variant="headingXl" as="h1">
          {title}
        </Text>
        {primaryAction && (
          <Button
            variant="primary"
            onClick={primaryAction.onAction}
            disabled={primaryAction.disabled}
            loading={primaryAction.loading}
          >
            {primaryAction.content}
          </Button>
        )}
      </InlineStack>
    </div>
  );
}

export default function Settings() {
  // --- State Management ---
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [successBanner, setSuccessBanner] = React.useState(null);

  // normalize helper for case-insensitive category handling
  const normalize = (s) => String(s || "").trim().toLowerCase();

  // --- Form Fields ---
  const [brandName, setBrandName] = React.useState("");
  const [category, setCategory] = React.useState("generic");
  const [tone, setTone] = React.useState("expert");

  // Track initial snapshot to determine "dirty"
  const [initialState, setInitialState] = React.useState(null);
  const isDirty = React.useMemo(() => {
    if (!initialState) return false;
    return (
      initialState.brandName !== brandName ||
      initialState.category !== category || // both normalized to lowercase
      initialState.tone !== tone
    );
  }, [initialState, brandName, category, tone]);

  // --- Data Fetching and Saving ---

  const normalizeLoaded = (json) => {
    // Support both {settings:{...}} and flat {...}
    const s = json?.settings && typeof json.settings === "object" ? json.settings : json || {};
    return {
      brandName: s.brandName || "",
      category: normalize(s.category || "generic"), // persist & compare lowercase
      tone: s.tone || "expert",
    };
  };

  const loadSettings = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccessBanner(null);
    try {
      // Prefer canonical route; fall back if a different router is mounted
      let json;
      try {
        const { data } = await api.get("/api/admin/store-settings");
        json = data;
      } catch (e) {
        // Fallback to legacy if store-settings isn't mounted
        const { data } = await api.get("/api/admin/settings");
        json = data;
      }
      const loaded = normalizeLoaded(json);
      setBrandName(loaded.brandName);
      setCategory(loaded.category);
      setTone(loaded.tone);
      setInitialState(loaded);
    } catch (e) {
      console.error("Settings load failed", e);
      setError("Failed to load your settings. Please try reloading the page.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = React.useCallback(async () => {
    if (!isDirty) return;
    setSaving(true);
    setError(null);
    setSuccessBanner(null);
    try {
      // persist lowercase category
      const payload = { brandName, category: normalize(category), tone };
      // Server alias accepts POST /api/admin/store-settings and merges fields
      const { data } = await api.post("/api/admin/store-settings", payload);
      const saved = normalizeLoaded(data);
      setInitialState(saved);
      setBrandName(saved.brandName);
      setCategory(saved.category);
      setTone(saved.tone);
      setSuccessBanner("Your settings have been saved successfully!");
    } catch (e) {
      console.error("Settings save failed", e);
      setError("Failed to save your settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [isDirty, brandName, category, tone]);

  // --- Render ---

  if (loading) {
    return (
      <Card>
        <div style={{ padding: "10rem" }}>
          <BlockStack gap="400" inlineAlign="center" blockAlign="center">
            <Spinner />
            <Text as="p">Loading settings...</Text>
          </BlockStack>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ padding: "1rem 1.6rem" }}>
      <PageHeader
        title="Settings"
        primaryAction={{
          content: "Save changes",
          onAction: saveSettings,
          disabled: !isDirty || saving,
          loading: saving,
        }}
      />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" onDismiss={() => setError(null)}>
                <p>{error}</p>
              </Banner>
            )}
            {successBanner && (
              <Banner tone="success" onDismiss={() => setSuccessBanner(null)}>
                <p>{successBanner}</p>
              </Banner>
            )}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Store & AI Configuration
                </Text>
                <TextField
                  label="Brand name"
                  value={brandName}
                  onChange={setBrandName}
                  autoComplete="off"
                  helpText="Used by the AI to refer to your store in a personalized way."
                />
                <Select
                  label="Primary product category"
                  options={[
                    { label: "General E-commerce", value: "generic" },
                    { label: "Beauty & Skincare", value: "beauty" },
                    { label: "Fashion & Apparel", value: "fashion" },
                    { label: "Home Goods", value: "home" },
                    { label: "Outdoors & Sporting Goods", value: "outdoors" },
                  ]}
                  value={category}
                  onChange={(v) => setCategory(normalize(v))}
                  helpText="Helps the AI use the correct terminology (e.g., 'ingredients' vs. 'materials')."
                />
                <Select
                  label="AI tone of voice"
                  options={[
                    { label: "Expert & Concise", value: "expert" },
                    { label: "Friendly & Helpful (Bestie)", value: "bestie" },
                    { label: "Professional & Formal", value: "professional" },
                  ]}
                  value={tone}
                  onChange={setTone}
                  helpText="Defines the personality of the AI's responses to shoppers."
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </div>
  );
}
