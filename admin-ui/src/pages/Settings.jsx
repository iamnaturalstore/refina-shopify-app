import api from "../api/client"
// admin-ui/src/pages/Settings.jsx
import * as React from "react";
import { api } from "../api/client";
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

// Try preferred /api route; fall back to non-/api
async function getSettings() {
  try {
    const j = await api("/api/admin/store-settings");
    return j?.settings || j || {};
  } catch {
    const r = await api("/api/admin/store-settings");
    if (!r.ok) throw new Error("Failed to load settings");
    const j = await r.json();
    return j?.settings || j || {};
  }
}

async function saveSettings(settings) {
  try {
    const j = await api("/api/admin/store-settings", {
      method: "POST",
      body: { settings },
    });
    return j;
  } catch {
    const r = { const __opts = {
      method: "POST",

      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    if (!r.ok) throw new Error("Failed to save settings");
    return await r.json();
  }
}

export default function Settings() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [ok, setOk] = React.useState("");
  const [planBadge, setPlanBadge] = React.useState(""); // optional: show current plan if backend attaches it

  const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
  const [initial, setInitial] = React.useState(DEFAULT_SETTINGS);

  const dirty = JSON.stringify(settings) !== JSON.stringify(initial);

  React.useEffect(() => {
    (async () => {
      setError(""); setOk(""); setLoading(true);
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
    setBusy(true); setError(""); setOk("");
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

          {/* General */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">General</Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="280px" width="100%">
                  <TextField
                    label="Store category"
                    value={settings.category}
                    onChange={(v) => set("category", v)}
                    autoComplete="off"
                    placeholder="e.g. Beauty, Fishing Gear, Garden Care"
                  />
                </Box>
                <Box minWidth="280px" width="100%">
                  <Select
                    label="AI tone"
                    options={[
                      { label: "Professional", value: "professional" },
                      { label: "Friendly", value: "friendly" },
                      { label: "Playful", value: "playful" },
                      { label: "Scientific", value: "scientific" },
                    ]}
                    onChange={(v) => set("aiTone", v)}
                    value={settings.aiTone}
                  />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Frontend Theme */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Frontend Theme</Text>

              <InlineStack gap="300" wrap>
                <Box minWidth="240px" width="100%">
                  <Text as="span" variant="bodySm">Primary color</Text>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <input
                      type="color"
                      value={settings.theme.primaryColor}
                      onChange={(e) => set("theme.primaryColor", e.target.value)}
                      style={{ width: 36, height: 36, border: "1px solid #E5E7EB", borderRadius: 6 }}
                    />
                    <TextField
                      label="Hex"
                      labelHidden
                      value={settings.theme.primaryColor}
                      onChange={(v) => set("theme.primaryColor", v)}
                      autoComplete="off"
                    />
                  </div>
                </Box>

                <Box minWidth="240px" width="100%">
                  <Text as="span" variant="bodySm">Accent color</Text>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <input
                      type="color"
                      value={settings.theme.accentColor}
                      onChange={(e) => set("theme.accentColor", e.target.value)}
                      style={{ width: 36, height: 36, border: "1px solid #E5E7EB", borderRadius: 6 }}
                    />
                    <TextField
                      label="Hex"
                      labelHidden
                      value={settings.theme.accentColor}
                      onChange={(v) => set("theme.accentColor", v)}
                      autoComplete="off"
                    />
                  </div>
                </Box>

                <Box minWidth="240px" width="100%">
                  <Select
                    label="Border radius"
                    options={[
                      { label: "Small", value: "sm" },
                      { label: "Medium", value: "md" },
                      { label: "Large", value: "lg" },
                      { label: "2XL", value: "2xl" },
                    ]}
                    onChange={(v) => set("theme.borderRadius", v)}
                    value={settings.theme.borderRadius}
                  />
                </Box>

                <Box minWidth="240px" width="100%">
                  <Select
                    label="Grid columns"
                    options={[
                      { label: "2", value: "2" },
                      { label: "3", value: "3" },
                      { label: "4", value: "4" },
                    ]}
                    onChange={(v) => set("theme.gridColumns", Number(v))}
                    value={String(settings.theme.gridColumns)}
                  />
                </Box>

                <Box minWidth="240px" width="100%">
                  <Select
                    label="Button style"
                    options={[
                      { label: "Solid", value: "solid" },
                      { label: "Outline", value: "outline" },
                    ]}
                    onChange={(v) => set("theme.buttonStyle", v)}
                    value={settings.theme.buttonStyle}
                  />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* UI Toggles */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">UI Options</Text>
              <InlineStack gap="400" wrap>
                <Checkbox
                  label="Show product badges"
                  checked={!!settings.ui.showBadges}
                  onChange={(v) => set("ui.showBadges", v)}
                />
                <Checkbox
                  label="Show prices"
                  checked={!!settings.ui.showPrices}
                  onChange={(v) => set("ui.showPrices", v)}
                />
                <Checkbox
                  label="Enable product modal"
                  checked={!!settings.ui.enableModal}
                  onChange={(v) => set("ui.enableModal", v)}
                />
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Copy */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Copy</Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="280px" width="100%">
                  <TextField
                    label="Heading"
                    value={settings.copy.heading}
                    onChange={(v) => set("copy.heading", v)}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="280px" width="100%">
                  <TextField
                    label="Subheading"
                    value={settings.copy.subheading}
                    onChange={(v) => set("copy.subheading", v)}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="280px" width="100%">
                  <TextField
                    label="CTA text"
                    value={settings.copy.ctaText}
                    onChange={(v) => set("copy.ctaText", v)}
                    autoComplete="off"
                  />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          <Divider />

          {/* Actions */}
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
