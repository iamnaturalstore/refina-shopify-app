import * as React from "react";
import { Page, Card, BlockStack, InlineStack, Text, Button, Divider, Spinner, Badge } from "@shopify/polaris";
import { billingApi, getShop } from "../api/client.js";

function normalize(level) {
  const v = String(level || "").toLowerCase();
  if (/\bpremium\b/.test(v) || /\bpro\s*\+|\bpro\W*plus\b/.test(v)) return "premium";
  if (/\bpro\b/.test(v)) return "pro";
  return "free";
}

export default function Billing() {
  const shop = getShop(); // always full "<shop>.myshopify.com"

  const [plan, setPlan] = React.useState({ level: "free", status: "unknown" });
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoading(true);
        const j = await billingApi.getPlan(shop);
        const level = normalize(j?.plan?.level || j?.level);
        const status = j?.plan?.status || j?.status || "unknown";
        if (on) setPlan({ level, status });
      } catch (e) {
        if (on) setErr(e?.message || "Failed to load plan");
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => { on = false; };
  }, [shop]);

  async function upgrade(which) {
    try {
      setSaving(true);
      const j = await billingApi.subscribe({ shop, plan: which });
      if (j?.confirmationUrl) {
        window.location.assign(j.confirmationUrl);
      } else if (j?.checkoutUrl) {
        window.location.assign(j.checkoutUrl);
      } else {
        throw new Error("No checkout URL returned");
      }
    } catch (e) {
      setErr(e?.message || "Failed to start checkout");
    } finally {
      setSaving(false);
    }
  }

  const level = normalize(plan?.level);
  const badgeTone = level === "premium" ? "success" : level === "pro" ? "attention" : "subdued";

  return (
    <Page title="Billing">
      <Card>
        <BlockStack gap="300" padding="300">
          {err && <Text tone="critical">{err}</Text>}

          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">Your plan</Text>
            {loading ? <Spinner size="small" /> : <Badge tone={badgeTone}>{level}</Badge>}
          </InlineStack>

          <Divider />

          <BlockStack gap="300">
            <InlineStack gap="300">
              <Button
                variant="primary"
                loading={saving}
                disabled={loading}
                onClick={() => upgrade(level === "free" ? "pro" : "premium")}
              >
                {level === "free" ? "Upgrade to Pro" : "Upgrade to Premium"}
              </Button>
              <Button onClick={() => window.location.reload()} disabled={saving}>Refresh</Button>
            </InlineStack>
            <Text tone="subdued" as="p">
              Billing is managed via Shopify subscriptions for {shop}.
            </Text>
          </BlockStack>
        </BlockStack>
      </Card>
    </Page>
  );
}
