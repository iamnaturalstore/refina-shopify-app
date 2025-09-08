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
import { useAuthenticatedFetch } from "@shopify/app-bridge-react";

// A simple page header that doesn't conflict with legacy title bars.
function PageHeader({ title, primaryAction }) {
  return (
    <div style={{ marginBottom: '1.6rem' }}>
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
  const authedFetch = useAuthenticatedFetch();

  // --- State Management ---
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [successBanner, setSuccessBanner] = React.useState(null);

  // --- Form Fields ---
  const [brandName, setBrandName] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [tone, setTone] = React.useState("expert");

  // Track original values to enable/disable Save button
  const [initialState, setInitialState] = React.useState(null);
  const isDirty = React.useMemo(() => {
    if (!initialState) return false;
    return (
      initialState.brandName !== brandName ||
      initialState.category !== category ||
      initialState.tone !== tone
    );
  }, [initialState, brandName, category, tone]);

  // --- Data Fetching and Saving ---
  const loadSettings = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccessBanner(null);
    try {
      // Use admin endpoints you already mount server-side
      const response = await authedFetch("/api/admin/settings");
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const json = await response.json();
      const s = json?.settings || {};

      const loaded = {
        brandName: s.brandName || "",
        category: s.category || "Generic",
        tone: s.tone || "expert",
      };

      setBrandName(loaded.brandName);
      setCategory(loaded.category);
      setTone(loaded.tone);
      setInitialState(loaded);
    } catch (e) {
      console.error("Settings load failed", e);
      setError("Failed to load your settings. Please reload the page.");
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  React.useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = React.useCallback(async () => {
    if (!isDirty) return;
    setSaving(true);
    setError(null);
    setSuccessBanner(null);
    try {
      // Use the admin settings save route (POST or PUT per your router)
      const response = await authedFetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { brandName, category, tone } }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const json = await response.json();
      const s = json?.settings || {};

      const saved = {
        brandName: s.brandName || "",
        category: s.category || "Generic",
        tone: s.tone || "expert",
      };

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
  }, [authedFetch, isDirty, brandName, category, tone]);

  // --- Render ---
  if (loading) {
    return (
      <Card>
        <div style={{ padding: '10rem' }}>
          <BlockStack gap="400" inlineAlign="center" blockAlign="center">
            <Spinner />
            <Text as="p">Loading settings...</Text>
          </BlockStack>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ padding: '1rem 1.6rem' }}>
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
                    { label: "General E-commerce", value: "Generic" },
                    { label: "Beauty & Skincare", value: "beauty" },
                    { label: "Fashion & Apparel", value: "fashion" },
                    { label: "Home Goods", value: "home" },
                    { label: "Outdoors & Sporting Goods", value: "outdoors" },
                  ]}
                  value={category}
                  onChange={setCategory}
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
