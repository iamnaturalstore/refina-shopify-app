import * as React from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  Spinner,
  Frame,
  Toast,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { getSessionToken } from "@shopify/app-bridge-utils";

// This is a modern, robust way to make authenticated API calls from the frontend.
async function authenticatedFetch(app, url, options = {}) {
  const sessionToken = await getSessionToken(app);
  const headers = {
    ...options.headers,
    Authorization: `Bearer ${sessionToken}`,
  };
  return fetch(url, { ...options, headers });
}

export default function Settings() {
  const app = useAppBridge();

  // --- State Management ---
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [toast, setToast] = React.useState({ active: false, content: "" });

  // --- Form Fields ---
  // We initialize with empty strings and let the `load` function populate them.
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

  // Function to load the settings from our stable backend API
  const loadSettings = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(app, "/api/settings");
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const json = await response.json();
      const { settings } = json;

      // Populate the form fields with data from the server
      setBrandName(settings.brandName || "");
      setCategory(settings.category || "Generic");
      setTone(settings.tone || "expert");

      // Save the initial state for dirty checking
      setInitialState({
        brandName: settings.brandName || "",
        category: settings.category || "Generic",
        tone: settings.tone || "expert",
      });
    } catch (e) {
      console.error("Settings load failed", e);
      setError("Failed to load your settings. Please try reloading the page.");
    } finally {
      setLoading(false);
    }
  }, [app]);

  // Load settings when the component first mounts
  React.useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Function to save the settings to our backend API
  const saveSettings = React.useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        settings: {
          brandName,
          category,
          tone,
        },
      };
      const response = await authenticatedFetch(app, "/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const json = await response.json();

      // Update the "initialState" to the new saved state to reset dirty tracking
      setInitialState({
        brandName: json.settings.brandName,
        category: json.settings.category,
        tone: json.settings.tone,
      });

      // Show a success toast
      setToast({ active: true, content: "Settings saved successfully!" });
    } catch (e) {
      console.error("Settings save failed", e);
      setError("Failed to save your settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [app, brandName, category, tone]);

  // --- Render Logic ---

  const toastMarkup = toast.active ? (
    <Toast content={toast.content} onDismiss={() => setToast({ active: false, content: "" })} />
  ) : null;

  if (loading) {
    return (
      <Page title="Settings">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="200" inlineAlign="center">
                <Spinner />
                <Text as="p">Loading settings...</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Frame>
      <Page
        title="Settings"
        primaryAction={{
          content: "Save changes",
          onAction: saveSettings,
          disabled: !isDirty || saving,
          loading: saving,
        }}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {error && (
                <Banner tone="critical" onDismiss={() => setError(null)}>
                  <p>{error}</p>
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
      </Page>
      {toastMarkup}
    </Frame>
  );
}
