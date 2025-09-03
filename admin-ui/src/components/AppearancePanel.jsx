import api from "../api/client";
import React, { useEffect, useMemo, useState } from "react";
import {
  Card, BlockStack, InlineGrid, Text, Button, Divider, TextField, Select, InlineStack, Badge, Banner
} from "@shopify/polaris";

// NOTE: No changes to PRESETS object
const PRESETS = {
  Classic: {
    preset: "Classic", version: 1,
    tokens: { bg:"#FFFFFF", surface:"#FFFFFF", text:"#111827", muted:"#6B7280", primary:"#2563EB", accent:"#10B981", border:"#E5E7EB", radius:"12px", shadow:"0 4px 14px rgba(0,0,0,0.05)", gap:"16px", pad:"16px", fontBody:"-apple-system, Inter, Segoe UI, Roboto, Arial, sans-serif", fontHeadings:"system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif", fontSize:"16px", lineHeight:"1.55" }
  },
  Minimal: { preset: "Minimal", version: 1, tokens: { bg:"#FAFAFA", surface:"#FFFFFF", text:"#111827", muted:"#6B7280", primary:"#111827", accent:"#9CA3AF", border:"#E5E7EB", radius:"10px", shadow:"0 2px 10px rgba(0,0,0,0.04)", gap:"16px", pad:"16px", fontBody:"-apple-system, Inter, Segoe UI, Roboto, Arial, sans-serif", fontHeadings:"system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif", fontSize:"16px", lineHeight:"1.55" } },
  Luxe: { preset: "Luxe", version: 1, tokens: { bg:"#FFFFFF", surface:"#F7F5F2", text:"#1F2328", muted:"#5F6B76", primary:"#2E2A24", accent:"#D4AF37", border:"#E7E1D0", radius:"14px", shadow:"0 6px 20px rgba(0,0,0,0.06)", gap:"16px", pad:"16px", fontBody:"-apple-system, Inter, Segoe UI, Roboto, Arial, sans-serif", fontHeadings:"system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif", fontSize:"16px", lineHeight:"1.55" } },
  Playful: { preset: "Playful", version: 1, tokens: { bg:"#FFFFFF", surface:"#F8F7FF", text:"#1F2937", muted:"#6B7280", primary:"#7C3AED", accent:"#22C55E", border:"#E5E7EB", radius:"14px", shadow:"0 8px 24px rgba(0,0,0,0.08)", gap:"16px", pad:"16px", fontBody:"-apple-system, Inter, Segoe UI, Roboto, Arial, sans-serif", fontHeadings:"system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif", fontSize:"16px", lineHeight:"1.55" } }
};

export default function AppearancePanel({ planLevel, planStatus }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [featureFlags, setFeatureFlags] = useState({ enableTheming:false });
  const [themeDraft, setThemeDraft] = useState(null);
  const [liveTheme, setLiveTheme] = useState(null);
  const [preset, setPreset] = useState("Classic");
  const isPro = planLevel === "pro" || planStatus === "trial";
  const isProPlus = planLevel === "pro+";

  useEffect(() => {
    (async () => {
      setLoading(true);
      console.log("[AppearancePanel] Fetching store settings...");
      try {
        const { data: json } = await api.get("/api/admin/store-settings");
        console.log("[AppearancePanel] Received settings payload:", json);
        
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
    setSaveSuccess(false);
    console.log("[AppearancePanel] Saving draft...", { themeDraft });
    try {
      const response = await api.put("/api/admin/store-settings", {
        settings: { themeDraft }
      });

      if (!response.ok) {
        throw new Error(`Failed to save. Server responded with ${response.status}`);
      }
      console.log("[AppearancePanel] Save successful!");
      setSaveSuccess(true);

    } catch (error) {
      console.error("[AppearancePanel] Save failed:", error);
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function applyTheme() {
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
        {saveSuccess && (
          <Banner title="Success" tone="success" onDismiss={() => setSaveSuccess(false)}>
            <p>Your settings have been saved successfully.</p>
          </Banner>
        )}
        {saveError && (
          <Banner title="Error" tone="critical" onDismiss={() => setSaveError(null)}>
            <p>Could not save settings: {saveError}</p>
          </Banner>
        )}
        
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Appearance</Text>
          <InlineStack gap="200">
            <Badge tone={isProPlus ? "success" : isPro ? "attention" : "critical"}>{isProPlus ? "Pro+" : isPro ? (planStatus === "trial" ? "Pro (trial)" : "Pro") : "Free"}</Badge>
          </InlineStack>
        </InlineStack>

        <InlineGrid columns={{xs:1, sm:2, md:3, lg:4}} gap="300">
          {Object.keys(PRESETS).map((name) => {
            const selected = preset === name;
            const disabled = lockedPreset && name !== "Classic";
            return (
              <Card key={name} subdued={selected}>
                <BlockStack gap="200" padding="300">
                  <Text as="h3" variant="headingSm">{name}</Text>
                  <InlineStack gap="200">
                    <div style={{width:16,height:16,background:PRESETS[name].tokens.primary,borderRadius:4}}/>
                    <div style={{width:16,height:16,background:PRESETS[name].tokens.accent,borderRadius:4}}/>
                    <div style={{width:16,height:16,background:PRESETS[name].tokens.surface,borderRadius:4,border:"1px solid #E5E7EB"}}/>
                  </InlineStack>
                  <InlineStack>
                    <Button disabled={disabled} variant={selected ? "primary" : "plain"} onClick={() => resetToPreset(name)}>{selected ? "Selected" : disabled ? "Locked" : "Choose"}</Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
        
        <Card>
          <BlockStack gap="300" padding="300">
            <Text as="h3" variant="headingSm">Advanced (Pro+)</Text>
            {!isProPlus && <Text tone="subdued">Upgrade to Pro+ to unlock advanced theming controls.</Text>}

            <InlineGrid columns={{xs:1, md:2}} gap="300">
              <TextField label="Primary" value={tokens.primary || ""} onChange={v => updateTokens({primary:v})} disabled={!isProPlus}/>
              <TextField label="Accent" value={tokens.accent || ""} onChange={v => updateTokens({accent:v})} disabled={!isProPlus}/>
              <TextField label="Background" value={tokens.bg || ""} onChange={v => updateTokens({bg:v})} disabled={!isProPlus}/>
              <TextField label="Surface" value={tokens.surface || ""} onChange={v => updateTokens({surface:v})} disabled={!isProPlus}/>
              <TextField label="Text" value={tokens.text || ""} onChange={v => updateTokens({text:v})} disabled={!isProPlus}/>
              <TextField label="Muted" value={tokens.muted || ""} onChange={v => updateTokens({muted:v})} disabled={!isProPlus}/>
              <TextField label="Border" value={tokens.border || ""} onChange={v => updateTokens({border:v})} disabled={!isProPlus}/>
              <TextField label="Radius" value={tokens.radius || ""} onChange={v => updateTokens({radius:v})} disabled={!isProPlus} placeholder="e.g., 14px"/>
              <TextField label="Shadow" value={tokens.shadow || ""} onChange={v => updateTokens({shadow:v})} disabled={!isProPlus} placeholder="CSS box-shadow"/>
              <TextField label="Gap" value={tokens.gap || ""} onChange={v => updateTokens({gap:v})} disabled={!isProPlus}/>
              <TextField label="Padding" value={tokens.pad || ""} onChange={v => updateTokens({pad:v})} disabled={!isProPlus}/>
            </InlineGrid>

            <InlineStack gap="200">
              {/* FINAL DIAGNOSTIC: Added a console.log directly to the onClick */}
              <Button
                onClick={() => {
                  console.log('[AppearancePanel] "Save draft" button was clicked.');
                  saveDraft();
                }}
                variant="secondary"
                loading={saving}
              >
                Save draft
              </Button>
              <Button onClick={applyTheme} variant="primary">Apply to storefront</Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200" padding="300">
            <Text as="h3" variant="headingSm">Preview</Text>
            <div style={{ "--rf-bg": tokens.bg, "--rf-surface": tokens.surface, "--rf-text": tokens.text, "--rf-muted": tokens.muted, "--rf-primary": tokens.primary, "--rf-accent": tokens.accent, "--rf-border": tokens.border, "--rf-radius": tokens.radius, "--rf-shadow": tokens.shadow, "--rf-gap": tokens.gap, "--rf-pad": tokens.pad, fontFamily: tokens.fontBody, background: "var(--rf-bg)", padding: "var(--rf-gap)", borderRadius: "var(--rf-radius)"}}>
              <div style={{display:"grid", gap:"var(--rf-gap)", gridTemplateColumns:"repeat(3, minmax(0,1fr))"}}>
                {[1,2,3].map((i) => (
                  <div key={i} style={{ background:"var(--rf-surface)", border:`1px solid var(--rf-border)`, borderRadius:"var(--rf-radius)", boxShadow:"var(--rf-shadow)", padding:"var(--rf-pad)" }}>
                    <div style={{height:120, background:"var(--rf-border)", borderRadius:"calc(var(--rf-radius) - 6px)"}}/>
                    <div style={{marginTop:12, color:"var(--rf-text)", fontWeight:600}}>Product {i}</div>
                    <div style={{color:"var(--rf-muted)", fontSize:12}}>Short description</div>
                    <div style={{marginTop:10, display:"flex", gap:8}}>
                      <span style={{background:"var(--rf-accent)", color:"#fff", borderRadius:12, padding:"2px 8px", fontSize:11}}>badge</span>
                      <span style={{border:`1px solid var(--rf-primary)`, color:"var(--rf-primary)", borderRadius:12, padding:"2px 8px", fontSize:11}}>type</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {!featureFlags.enableTheming && (<Text tone="subdued">This is an admin-only preview. It won’t affect your storefront until theming is enabled.</Text>)}
          </BlockStack>
        </Card>
      </BlockStack>
    </Card>
  );
}

