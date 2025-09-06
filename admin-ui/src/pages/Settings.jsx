// admin-ui/src/pages/Settings.jsx
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
  Checkbox,
  Divider,
  Banner,
  Spinner,
  Button,
} from "@shopify/polaris";
import { adminApi, getShop } from "../api/client.js";

export default function Settings() {
  const shop = getShop();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState(null);

  // form state
  const [form, setForm] = React.useState({
    category: "Beauty",
    tone: "friendly",
    showExplanations: true,
    enableWidget: true,
    themePreset: "Minimal",
  });
  const [baseline, setBaseline] = React.useState(form);

  const dirty = React.useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline]
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApi("/api/settings", { method: "GET" });
        const data = (await res.json()) || {};
        if (cancelled) return;
        const next = {
          category: data.category || "Beauty",
          tone: data.tone || "friendly",
          showExplanations: data.showExplanations ?? true,
          enableWidget: data.enableWidget ?? true,
          themePreset: data.themePreset || "Minimal",
        };
        setForm(next);
        setBaseline(next);
      } catch (e) {
        // keep sensible defaults; surface message inline
        console.warn("Settings load failed", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (key) => (value) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const onSave = async () => {
    setSaving(true);
    try {
      await adminApi("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, ...form }),
      });
      setBaseline(form);
      setSavedAt(new Date());
    } catch (e) {
      console.error("Settings save failed", e);
    } finally {
      setSaving(false);
    }
  };

  const onReset = () => setForm(baseline);

  return (
    <Page
      title="Settings"
      primaryAction={{
        content: "Save changes",
        onAction: onSave,
        disabled: !dirty || saving,
        loading: saving,
      }}
    >
      <Layout>
        <Layout.Section>
          {loading ? (
            <Card>
              <BlockStack gap="400" align="center" inlineAlign="center">
                <InlineStack gap="200" align="center">
                  <Spinner accessibilityLabel="Loading settings" size="small" />
                  <Text as="span" variant="bodyMd">Loading settings…</Text>
                </InlineStack>
              </BlockStack>
            </Card>
          ) : (
            <>
              {dirty && (
                <Card>
                  <Banner tone="warning" title="Unsaved changes">
                    <p>Make sure to save your updates before leaving this page.</p>
                  </Banner>
                </Card>
              )}

              {savedAt && !dirty && (
                <Card>
                  <Banner tone="success" title="Settings saved">
                    <p>Last saved {savedAt.toLocaleTimeString()}.</p>
                  </Banner>
                </Card>
              )}

              <Layout>
                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">Store configuration</Text>
                      <InlineStack gap="400" wrap={false} align="start">
                        <div style={{flex: 1}}>
                          <Select
                            label="Store category"
                            options={[
                              { label: "Beauty", value: "Beauty" },
                              { label: "Home & Living", value: "Home" },
                              { label: "Outdoors", value: "Outdoors" },
                              { label: "Wellness", value: "Wellness" },
                              { label: "Other", value: "Other" },
                            ]}
                            value={form.category}
                            onChange={update("category")}
                          />
                        </div>
                        <div style={{flex: 1}}>
                          <Select
                            label="Tone"
                            options={[
                              { label: "Friendly", value: "friendly" },
                              { label: "Expert", value: "expert" },
                              { label: "Concise", value: "concise" },
                              { label: "Playful", value: "playful" },
                            ]}
                            value={form.tone}
                            onChange={update("tone")}
                          />
                        </div>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                </Layout.Section>

                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">Widget & AI</Text>
                      <Checkbox
                        label="Enable storefront widget"
                        checked={form.enableWidget}
                        onChange={(v) => update("enableWidget")(v)}
                      />
                      <Checkbox
                        label="Show AI explanations (Premium)"
                        checked={form.showExplanations}
                        onChange={(v) => update("showExplanations")(v)}
                      />
                    </BlockStack>
                  </Card>
                </Layout.Section>

                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">Styling preset</Text>
                      <Select
                        label="Theme preset"
                        options={[
                          { label: "Minimal", value: "Minimal" },
                          { label: "Modern", value: "Modern" },
                          { label: "Boutique", value: "Boutique" },
                          { label: "Editorial", value: "Editorial" },
                          { label: "Bold", value: "Bold" },
                        ]}
                        value={form.themePreset}
                        onChange={update("themePreset")}
                      />
                      <InlineStack gap="300">
                        <Button onClick={onReset} disabled={!dirty || saving} variant="tertiary">
                          Reset
                        </Button>
                        <Button onClick={onSave} disabled={!dirty || saving} loading={saving} variant="primary">
                          Save changes
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>
            </>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
