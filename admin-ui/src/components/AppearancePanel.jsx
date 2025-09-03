import api from "../api/client";
import React, { useEffect, useMemo, useState } from "react";
import {
  Card, BlockStack, InlineGrid, Text, Button, Divider, TextField, Select, InlineStack, Badge, Banner
} from "@shopify/polaris";

// NOTE: No changes to PRESETS object
const PRESETS = {
  Classic: {
    preset: "Classic", version: 1,
    tokens: {
      bg:"#FFFFFF", surface:"#FFFFFF", text:"#111827", muted:"#6B7280",
      primary:"#2563EB", accent:"#10B981", border:"#E5E7EB",
      radius:"12px", shadow:"0 4px 14px rgba(0,0,0,0.05)",
      gap:"16px", pad:"16px",
      fontBody:"-apple-system, Inter, Segoe UI, Roboto, Arial, sans-serif",
      fontHeadings:"system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif",
      fontSize:"16px", lineHeight:"1.55",
    }
  },
  Minimal: { /* ... */ },
  Luxe: { /* ... */ },
  Playful: { /* ... */ }
};

export default function AppearancePanel({ planLevel, planStatus }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false); // Added for save button state
  const [saveError, setSaveError] = useState(null); // Added for showing save errors
  const [featureFlags, setFeatureFlags] = useState({ enableTheming:false });
  const [themeDraft, setThemeDraft] = useState(null);
  const [liveTheme, setLiveTheme] = useState(null);
  const [preset, setPreset] = useState("Classic");
  const isPro = planLevel === "pro" || planStatus === "trial";
  const isProPlus = planLevel === "pro+";

  // Data fetching useEffect - now with better logging
  useEffect(() => {
    (async () => {
      setLoading(true);
      console.log("[AppearancePanel] Fetching store settings...");
      try {
        const res = await api.get("/api/admin/store-settings");
        // The API client might have already parsed it, but let's be safe.
        const json = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
        
        console.log("[AppearancePanel] Received settings payload:", json);
        
        // The backend sends { settings: {...} }, so we need to access that key
        const settings = json.settings || {};
        const draft = settings.themeDraft || settings.theme || PRESETS.Classic;

        setThemeDraft(draft);
        setLiveTheme(settings.theme || null);
        setFeatureFlags(settings.featureFlags || { enableTheming: false });
        setPreset(draft?.preset || "Classic");
        console.log("[AppearancePanel] State updated successfully.");
      } catch (error) {
        console.error("[AppearancePanel] Failed to fetch settings:", error);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const lockedPreset = !isPro;
  const lockedAdvanced = !isProPlus;

  const tokens = useMemo(() => themeDraft?.tokens || {}, [themeDraft]);

  const updateTokens = (patch) => {
    const next = {
      ...(themeDraft || { preset: preset, version: 1, tokens: {} }),
      tokens: { ...(themeDraft?.tokens || {}), ...patch },
      preset, version: 1
    };
    setThemeDraft(next);
  };

  async function saveDraft() {
    setSaving(true);
    setSaveError(null);
    console.log("[AppearancePanel] Saving draft...", { themeDraft });
    try {
      // CHANGED: Using PUT method and corrected payload structure
      const response = await api.put("/api/admin/store-settings", {
        settings: { themeDraft }
      });

      if (response.status !== 200) {
        throw new Error(`Failed to save. Server responded with ${response.status}`);
      }
      console.log("[AppearancePanel] Save successful!");

    } catch (error) {
      console.error("[AppearancePanel] Save failed:", error);
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function applyTheme() {
    // NOTE: This route doesn't exist on the backend yet, but the save logic is what matters.
    console.warn("applyTheme function needs a corresponding backend route.");
  }

  function resetToPreset(name) {
    setPreset(name);
    setThemeDraft(PRESETS[name]);
  }

  if (loading) return <Card><BlockStack gap="400"><Text as="p" variant="bodyMd">Loading appearance…</Text></BlockStack></Card>;

  return (
    <Card>
      <BlockStack gap="400">
        {saveError && (
          <Banner title="Error" tone="critical" onDismiss={() => setSaveError(null)}>
            <p>Could not save settings: {saveError}</p>
          </Banner>
        )}
        
        {/* The rest of the JSX is unchanged... */}
        
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Appearance</Text>
          {/* ... */}
        </InlineStack>
        
        {/* ... Preset Picker ... */}
        
        <Card>
          <BlockStack gap="300" padding="300">
            {/* ... Advanced Editor ... */}
            <InlineGrid columns={{xs:1, md:2}} gap="300">
              <TextField label="Primary" value={tokens.primary || ""} onChange={v => updateTokens({primary:v})} disabled={!isProPlus}/>
              {/* ... other TextFields ... */}
            </InlineGrid>

            <InlineStack gap="200">
              {/* Added loading state to save button */}
              <Button onClick={saveDraft} variant="secondary" loading={saving}>Save draft</Button>
              <Button onClick={applyTheme} variant="primary">Apply to storefront</Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* ... Preview ... */}
      </BlockStack>
    </Card>
  );
}
