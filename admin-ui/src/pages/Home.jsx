import React, { useEffect, useMemo, useState } from "react";
import * as P from "@shopify/polaris";
import { api, getStoreIdFromUrl } from "../api/client.js";

export default function Home() {
  const storeId = useMemo(() => getStoreIdFromUrl(), []);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [settings, setSettings] = useState(null);

  console.log("ADMIN-UI BUILD", import.meta.env.VITE_BUILD_ID);

  useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        // Let api() inject storeId/host automatically
        const data = await api(`/api/admin/store-settings`);
        if (on) setSettings(data?.settings || {});
      } catch (e) {
        if (on) setErr(e.message || "Failed to load settings");
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => { on = false; };
  }, []);

  const [plan, setPlan] = useState("free");

 // Load plan directly from Firebase-backed API
  useEffect(() => {
    let on = true;
    api(`/api/billing/plan?ts=${Date.now()}`)
      .then((r) => { if (on) setPlan(String(r?.plan?.level || "free").toLowerCase()); })
      .catch(() => {});
    return () => { on = false; };
  }, []);
  const tone = plan === "premium" ? "success" : plan === "pro" ? "attention" : "subdued";

  return (
    <P.Page title="Home">
      <P.Layout>
        {err && (
          <P.Box paddingBlockStart="400">
            <P.Banner tone="critical" title="Something went wrong"><p>{err}</p></P.Banner>
          </P.Box>
        )}

        <P.Box paddingBlockStart="400">
          <P.Card>
            <P.Box padding="400">
              <P.BlockStack gap="300">
                <P.Text as="p">Welcome to Refina.</P.Text>
                <P.InlineStack gap="300">
                  <P.Button url={`#/analytics${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ""}`} variant="primary">
                    View analytics
                  </P.Button>
                  <P.Button url={`#/settings${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ""}`}>Settings</P.Button>
                  <P.Button url={`#/billing${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ""}`}>Billing</P.Button>
                </P.InlineStack>
              </P.BlockStack>
            </P.Box>
          </P.Card>
        </P.Box>

        <P.Box paddingBlockStart="400">
          <P.Card>
            <P.Box padding="400">
              <P.InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <P.TextField label="Store ID" value={storeId} disabled />
                <div>
                  <P.Text as="p" tone="subdued">Plan</P.Text>
                  {loading ? (
                    <P.Text as="p" tone="subdued">Loading settings…</P.Text>
                  ) : (
                    <P.Badge tone={tone}>{plan}</P.Badge>
                  )}
                </div>
              </P.InlineGrid>
            </P.Box>
          </P.Card>
        </P.Box>
      </P.Layout>
    </P.Page>
  );
}
