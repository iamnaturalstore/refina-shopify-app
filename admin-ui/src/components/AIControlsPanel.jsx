import React from "react";
import * as P from "@shopify/polaris";
import api from "../api/client";

export default function AIControlsPanel() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const [featureFlags, setFeatureFlags] = React.useState({ enableAIControls: false });
  const [planLevel, setPlanLevel] = React.useState("free");
  const [planStatus, setPlanStatus] = React.useState("active");

  // aiControls
  const [promptStrictness, setPromptStrictness] = React.useState("balanced"); // "relaxed" | "balanced" | "strict"
  const [exclusions, setExclusions] = React.useState([]);
  const [newExclusion, setNewExclusion] = React.useState("");
  const [enableFollowUps, setEnableFollowUps] = React.useState(false);
  const [safetyTone, setSafetyTone] = React.useState(false);

  const isProPlus = planLevel === "pro+";
  const isTrialPro = planLevel === "pro" && planStatus === "trial";

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, plan] = await Promise.all([
        api("/api/admin/store-settings"),
        api("/api/billing/plan"),
      ]);

      setFeatureFlags(settings?.featureFlags || { enableAIControls: false });

      const ai = settings?.aiControls || {};
      setPromptStrictness(ai.promptStrictness || "balanced");
      setExclusions(Array.isArray(ai.exclusions) ? ai.exclusions : []);
      setEnableFollowUps(Boolean(ai.enableFollowUps));
      setSafetyTone(Boolean(ai.safetyTone));

      setPlanLevel(plan?.level || "free");
      setPlanStatus(plan?.status || "active");
    } catch (e) {
      setError(e?.message || "Failed to load AI controls");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let on = true;
    (async () => {
      await reload();
    })();
    return () => {
      on = false;
    };
  }, [reload]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/admin/store-settings", {
        method: "POST",
        body: {
          aiControls: {
            promptStrictness,
            exclusions: exclusions.slice(0, 50),
            enableFollowUps,
            safetyTone,
          },
        },
      });
    } catch (e) {
      setError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function addExclusion() {
    const v = (newExclusion || "").trim().toLowerCase();
    if (!v) return;
    if (exclusions.includes(v)) {
      setNewExclusion("");
      return;
    }
    setExclusions([...exclusions, v]);
    setNewExclusion("");
  }

  function removeExclusion(x) {
    setExclusions(exclusions.filter((e) => e !== x));
  }

  const locked = !isProPlus; // Pro+ only
  const flagOff = !featureFlags.enableAIControls;

  return (
    <P.Card>
      <P.Box padding="400">
        <P.BlockStack gap="400">
          {error && (
            <P.Banner tone="critical" title="Something went wrong">
              <p>{error}</p>
            </P.Banner>
          )}

          {flagOff && (
            <P.Banner tone="info" title="AI Controls are disabled on your storefront">
              <p>
                Changes here are saved but won’t affect your storefront until AI Controls are
                enabled for this store.
              </p>
            </P.Banner>
          )}

          <P.InlineStack align="space-between" blockAlign="center">
            <P.Text as="h2" variant="headingMd">
              AI Controls
            </P.Text>
            <P.Badge
              tone={
                isProPlus ? "success" : planLevel === "pro" ? "attention" : "subdued"
              }
            >
              {isProPlus ? "Pro+" : isTrialPro ? "Pro (trial)" : planLevel}
            </P.Badge>
          </P.InlineStack>

          {loading ? (
            <P.Text tone="subdued">Loading…</P.Text>
          ) : (
            <>
              {!isProPlus && (
                <P.Banner tone="warning" title="Upgrade to Pro+ to unlock AI fine-tuning">
                  <p>
                    Adjust strictness, exclude ingredients, and enable multi-turn follow-ups with
                    Pro+.
                  </p>
                </P.Banner>
              )}

              <P.Divider />

              <P.BlockStack gap="400">
                <P.Select
                  label="Prompt strictness"
                  options={[
                    { label: "Relaxed (more variety)", value: "relaxed" },
                    { label: "Balanced (recommended)", value: "balanced" },
                    { label: "Strict (tight filtering)", value: "strict" },
                  ]}
                  value={promptStrictness}
                  onChange={setPromptStrictness}
                  disabled={locked}
                />

                <P.BlockStack gap="200">
                  <P.Text as="h3" variant="headingSm">
                    Exclude ingredients/attributes
                  </P.Text>
                  <P.InlineStack gap="200" wrap>
                    {exclusions.map((x) => (
                      <P.Tag
                        key={x}
                        onRemove={locked ? undefined : () => removeExclusion(x)}
                      >
                        {x}
                      </P.Tag>
                    ))}
                  </P.InlineStack>
                  <P.InlineStack gap="200">
                    <P.TextField
                      label="Add exclusion"
                      labelHidden
                      value={newExclusion}
                      onChange={setNewExclusion}
                      placeholder="e.g., fragrance, alcohol denat."
                      disabled={locked}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addExclusion();
                        }
                      }}
                    />
                    <P.Button
                      onClick={addExclusion}
                      disabled={locked || !newExclusion.trim()}
                    >
                      Add
                    </P.Button>
                  </P.InlineStack>
                  <P.Text tone="subdued">
                    Refina will avoid recommending products that match these terms in tags,
                    ingredients, or description.
                  </P.Text>
                </P.BlockStack>

                <P.Divider />

                <P.InlineStack gap="400" align="start">
                  <P.Checkbox
                    label="Enable multi-turn follow-up suggestions"
                    checked={enableFollowUps}
                    onChange={setEnableFollowUps}
                    disabled={locked}
                  />
                </P.InlineStack>

                <P.InlineStack gap="400" align="start">
                  <P.Checkbox
                    label="Use a clinical safety tone where relevant"
                    checked={safetyTone}
                    onChange={setSafetyTone}
                    disabled={locked}
                  />
                </P.InlineStack>

                <P.InlineStack gap="200">
                  <P.Button onClick={save} loading={saving} disabled={locked}>
                    Save
                  </P.Button>
                  <P.Button onClick={reload} disabled={saving}>
                    Reset
                  </P.Button>
                </P.InlineStack>
              </P.BlockStack>
            </>
          )}
        </P.BlockStack>
      </P.Box>
    </P.Card>
  );
}
