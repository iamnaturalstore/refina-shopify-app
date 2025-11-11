// admin-ui/src/pages/Welcome.jsx

import React from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Badge,
  Icon,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { api, getShop } from "../api/client";

// --- helpers -------------------------------------------------------

function getCurrentHost() {
  try {
    const search = new URLSearchParams(window.location.search || "");
    const hashQ = (window.location.hash || "").split("?")[1] || "";
    const hash = new URLSearchParams(hashQ);
    return search.get("host") || hash.get("host") || "";
  } catch {
    return "";
  }
}

function buildQS() {
  const shop = getShop();
  const host = getCurrentHost();
  const params = new URLSearchParams();
  if (host) params.set("host", host);
  if (shop) params.set("shop", shop);
  const s = params.toString();
  return s ? `?${s}` : "";
}

function normalizeLevel(lvl) {
  return String(lvl || "").toLowerCase();
}

function isActivePlanLike(plan) {
  if (!plan) return false;

  const lvl = normalizeLevel(plan.level || plan.name || plan.tier);
  const status = String(plan.status || "").toLowerCase();

  const isPaid =
    lvl === "pro" ||
    lvl === "premium" ||
    lvl === "paid";

  const isActiveish =
    status === "active" ||
    status === "trialing" ||
    status === "current";

  return isPaid && isActiveish;
}

// --- component -----------------------------------------------------

export default function Welcome() {
  const [loading, setLoading] = React.useState(true);
  const [plan, setPlan] = React.useState(null);
  const [settings, setSettings] = React.useState({});
  const [err, setErr] = React.useState("");

  const qs = React.useMemo(buildQS, []);
  const billingUrl = `#/billing${qs || ""}`;

  // Load minimal state for the checklist
  React.useEffect(() => {
    let on = true;

    (async () => {
      try {
        setLoading(true);
        setErr("");

        const shop = getShop();

        const [
          { data: planData },
          { data: settingsData },
        ] = await Promise.all([
          api.get(`/api/billing/plan`),
          api.get(`/api/admin/store-settings`),
        ]);

        if (!on) return;

        // If your Home.jsx uses parsePlanResponse, you can do the same here.
        // For now we assume planData already has { level, status, ... } when present.
        const resolvedPlan =
          planData?.plan || planData || null;

        setPlan(resolvedPlan);
        setSettings(settingsData?.settings || {});
      } catch (e) {
        if (on) {
          console.error("[Welcome] Failed to load state:", e);
          setErr("We couldn’t load your setup status. You can still start your trial or open Settings.");
        }
      } finally {
        if (on) setLoading(false);
      }
    })();

    return () => {
      on = false;
    };
  }, []);

  const hasActivePlan = React.useMemo(
    () => isActivePlanLike(plan),
    [plan]
  );

  const hasCategory = Boolean(settings?.category);
  // Adjust this flag to match however you persist theme/embed enablement.
  const hasThemeEmbed =
    Boolean(settings?.themeEmbedEnabled) ||
    Boolean(settings?.appEmbedEnabled) ||
    Boolean(settings?.refinaEnabled);

  const completed = [
    hasActivePlan,
    hasCategory,
    hasThemeEmbed,
  ].filter(Boolean).length;

  const allDone =
    hasActivePlan && hasCategory && hasThemeEmbed;

  // --- UI helpers --------------------------------------------------

  function StepRow({
    label,
    description,
    complete,
    primaryAction,
    subtle,
  }) {
    return (
      <Card>
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <BlockStack gap="100">
              <InlineStack gap="150" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  {label}
                </Text>
                <Badge tone={complete ? "success" : "attention"}>
                  {complete ? "Done" : "Required"}
                </Badge>
              </InlineStack>
              {description && (
                <Text as="p" tone={subtle ? "subdued" : "body"}>
                  {description}
                </Text>
              )}
              {primaryAction}
            </BlockStack>
            <Icon
              source={CheckIcon}
              tone={complete ? "success" : "subdued"}
            />
          </InlineStack>
        </Box>
      </Card>
    );
  }

  // --- Render ------------------------------------------------------

const title = !hasActivePlan
  ? "Let’s Get You Started"
  : allDone
  ? "You’re live with Refina"
  : "Complete your setup";

const subcopy = !hasActivePlan
  ? "Start your free trial to kick off Refina’s AI product scan, then complete two quick steps to go live."
  : allDone
  ? "Your plan is active, Refina is configured, and you’re ready to help shoppers choose faster."
  : "Your plan is active. Finish the remaining steps below to get Refina live on your store.";

return (
  <Page title={title}>
    <Layout>
      {/* Hero / summary */}
      <Layout.Section>
        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <BlockStack gap="150">
                <Text as="p" tone="subdued">
                  🎯 Refina turns your catalog into clear, guided recommendations that tell shoppers why a product is right for them.
                </Text>
                <Text as="p" tone="subdued">
                  {subcopy}
                </Text>
              </BlockStack>

              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" tone="subdued">
                    Setup progress
                  </Text>
                  <Text as="p" variant="headingMd">
                    {completed} / 3 steps complete
                  </Text>
                </BlockStack>
                {allDone && (
                  <Button
                    variant="primary"
                    url={`/#/${""}${qs}`}
                  >
                    Go to dashboard
                  </Button>
                )}
              </InlineStack>

              {err && (
                <Text as="p" tone="critical">
                  {err}
                </Text>
              )}
            </BlockStack>
          </Box>
        </Card>
      </Layout.Section>

      {/* Step 1: Plan / Trial */}
      <Layout.Section>
        <StepRow
          label="1. Start your free trial"
          description={
            hasActivePlan
              ? "Your plan is active. You can change it anytime in Shopify billing."
              : "Confirm your plan in Shopify to start your trial and trigger Refina’s product scan. You won’t be charged until the trial ends."
          }
          complete={hasActivePlan}
          primaryAction={
            !hasActivePlan && (
              <Button
                variant="primary"
                size="medium"
                url={billingUrl}
                loading={loading}
              >
                Start free trial in Shopify
              </Button>
            )
          }
          subtle={hasActivePlan}
        />
      </Layout.Section>

      {/* Step 2: Category */}
      <Layout.Section>
        <StepRow
          label="2. Choose your primary category"
          description="Tell Refina what you sell so answers and recommendations stay relevant from day one."
          complete={hasCategory}
          primaryAction={
            <Button
              variant={hasCategory ? "secondary" : "primary"}
              size="medium"
              url={`#/settings${qs}`}
            >
              {hasCategory ? "Edit in Settings" : "Choose category in Settings"}
            </Button>
          }
        />
      </Layout.Section>

      {/* Step 3: Theme embed */}
      <Layout.Section>
        <StepRow
          label="3. Enable Refina in your theme"
          description="Turn on the Refina app embed in your theme so shoppers can start using it where it matters most."
          complete={hasThemeEmbed}
          primaryAction={
            <Button
              variant={hasThemeEmbed ? "secondary" : "primary"}
              size="medium"
              url={`#/setup${qs}`}
            >
              {hasThemeEmbed ? "View theme setup" : "Open theme setup"}
            </Button>
          }
        />
      </Layout.Section>

      {/* If everything is done, reinforce success */}
      {allDone && (
        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="150">
                <Text as="h3" variant="headingSm">
                  ✅ You’re live with Refina
                </Text>
                <Text as="p" tone="subdued">
                  Refina is active in your theme. Head to the dashboard to track engagement and performance.
                </Text>
                <Button
                  variant="primary"
                  url={`/#/${""}${qs}`}
                >
                  Go to dashboard
                </Button>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      )}
    </Layout>
  </Page>
);
}

