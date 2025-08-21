// refina/src/pages/Billing.jsx
import { useEffect, useMemo, useState } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  RadioButton,
  Button,
  Badge,
  Banner,
  Toast,
} from "@shopify/polaris";
import { useLocation } from "react-router-dom";
import { useTitleBar } from "../lib/useTitleBar";
import { copyCurrentDeepLink } from "../lib/copyLink";

// Read params from both search and hash (HashRouter-friendly)
function useQueryParamReader() {
  const location = useLocation();
  return useMemo(() => {
    const searchParams = new URLSearchParams(location.search || "");
    const hash = (location.hash || "").split("?")[1] || "";
    const hashParams = new URLSearchParams(hash);
    return (key) => searchParams.get(key) ?? hashParams.get(key);
  }, [location]);
}

function PlanBadge({ level }) {
  const tone = level === "free" ? "attention" : "success";
  const label = (level || "free").toUpperCase();
  return <Badge tone={tone}>{label}</Badge>;
}

export default function Billing() {
  useTitleBar("Billing", {
    primaryAction: {
      content: "Copy link",
      onAction: () => copyCurrentDeepLink(),
    },
  });

  const q = useQueryParamReader();

  const [shop, setShop] = useState("");
  const [plan, setPlan] = useState({ level: "free", status: "none" });
  const [chosen, setChosen] = useState("pro");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Derive shop from query (?shop= or ?storeId=)
  useEffect(() => {
    const s = q("shop") || q("storeId") || "";
    if (s && s !== shop) setShop(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Handle return from Shopify confirmation
  useEffect(() => {
    const flag = q("billing");
    if (flag === "confirmed") {
      setToast({ content: "Billing confirmed. Thanks for upgrading! 🎉", error: false });
      refreshPlan();
    } else if (flag === "error") {
      setToast({ content: "We couldn’t confirm the subscription. Please try again.", error: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function refreshPlan() {
    if (!shop) return;
    try {
      const r = await fetch(`/api/billing/plan?storeId=${encodeURIComponent(shop)}`);
      const j = await r.json();
      if (j.ok && j.plan) setPlan(j.plan);
    } catch {
      // best-effort; keep prior state
    }
  }

  useEffect(() => {
    refreshPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop]);

  async function startSubscribe() {
    try {
      if (!shop) return;
      setLoading(true);
      const r = await fetch(`/api/billing/subscribe?storeId=${encodeURIComponent(shop)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: chosen }), // "pro" | "pro+"
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Failed to start subscription");

      if (j.alreadyActive) {
        setToast({ content: "You already have an active subscription for this plan.", error: false });
        refreshPlan();
        return;
      }

      // Redirect to Shopify's confirmation page (break out of iframe if embedded)
      window.top.location.href = j.confirmationUrl;
    } catch (e) {
      setToast({ content: e.message, error: true });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Page title="Billing" subtitle="Manage your Refina plan">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Text as="h2" variant="headingMd">Current plan</Text>
              <PlanBadge level={plan.level} />
            </div>

            <div style={{ height: 12 }} />

            {plan.level === "free" ? (
              <Banner tone="info">
                You’re on the Free plan. Upgrade to unlock AI concierge (Pro) and enhanced AI prompt + styling + analytics (Pro+).
              </Banner>
            ) : (
              <Banner tone="success">
                You’re on <b>{plan.level.toUpperCase()}</b>. You can switch plans anytime.
              </Banner>
            )}

            <div style={{ height: 16 }} />

            <div role="group" aria-label="Choose a plan" style={{ display: "flex", gap: 24 }}>
              <RadioButton
                label="Pro • $19/mo"
                checked={chosen === "pro"}
                id="r-pro"
                name="plan"
                onChange={() => setChosen("pro")}
              />
              <RadioButton
                label="Pro+ • $39/mo"
                checked={chosen === "pro+"}
                id="r-pro-plus"
                name="plan"
                onChange={() => setChosen("pro+")}
              />
            </div>

            <div style={{ height: 16 }} />

            <Button primary onClick={startSubscribe} loading={loading} disabled={!shop}>
              {plan.level === "free" ? "Upgrade" : "Change plan"}
            </Button>

            {!shop && (
              <>
                <div style={{ height: 12 }} />
                <Banner tone="warning">
                  Missing <code>shop</code> param. Open the app from Shopify Admin so it receives <code>shop/host</code>, or append <code>?shop=&lt;your-store&gt;.myshopify.com</code> to the URL.
                </Banner>
              </>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {toast && (
        <Toast content={toast.content} error={toast.error} onDismiss={() => setToast(null)} />
      )}
    </Page>
  );
}
