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
import { useAppBridge } from "@shopify/app-bridge-react";
import { getSessionToken } from "@shopify/app-bridge-utils";

// This is the standard, secure way to make authenticated API calls from the frontend.
async function authenticatedFetch(app, url, options = {}) {
  const sessionToken = await getSessionToken(app);
  const headers = {
    ...options.headers,
    Authorization: `Bearer ${sessionToken}`,
    "Content-Type": "application/json",
  };
  return fetch(url, { ...options, headers });
}

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
  const app = useAppBridge();

  // --- State Management ---
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [successBanner, setSuccessBanner] = React.useState(null);

  // --- Form Fields ---
  const [brandName, setBrandName] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [tone, setTone] = React.useState("expert");

  // This state stores the initial data to check if any changes have been made.
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
      const response = await authenticatedFetch(app, "/api/settings");
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const json = await response.json();
      const { settings } = json;

      const loadedSettings = {
        brandName: settings.brandName || "",
        category: settings.category || "Generic",
        tone: settings.tone || "expert",
      };

      setBrandName(loadedSettings.brandName);
      setCategory(loadedSettings.category);
      setTone(loadedSettings.tone);
      setInitialState(loadedSettings);

    } catch (e) {
      console.error("Settings load failed", e);
      setError("Failed to load your settings. Please try reloading the page.");
    } finally {
      setLoading(false);
    }
  }, [app]);

  React.useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = React.useCallback(async () => {
    if (!isDirty) return;
    setSaving(true);
    setError(null);
    setSuccessBanner(null);
    try {
      const payload = { settings: { brandName, category, tone } };
      const response = await authenticatedFetch(app, "/api/settings", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const json = await response.json();
      const savedSettings = {
        brandName: json.settings.brandName || "",
        category: json.settings.category || "Generic",
        tone: json.settings.tone || "expert",
      };

      setInitialState(savedSettings); // Reset dirty state with new saved data
      setBrandName(savedSettings.brandName);
      setCategory(savedSettings.category);
      setTone(savedSettings.tone);
      setSuccessBanner("Your settings have been saved successfully!");

    } catch (e) {
      console.error("Settings save failed", e);
      setError("Failed to save your settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [app, isDirty, brandName, category, tone]);

  // --- Render Logic ---

  if (loading) {
    return (
        <Card>
          <div style={{padding: '10rem'}}>
            <BlockStack gap="400" inlineAlign="center" blockAlign="center">
              <Spinner />
              <Text as="p">Loading settings...</Text>
            </BlockStack>
          </div>
        </Card>
    );
  }

  return (
    <div style={{padding: '1rem 1.6rem'}}>
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

