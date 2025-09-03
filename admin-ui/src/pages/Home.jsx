// admin-ui/src/pages/Home.jsx
import * as React from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Button,
  Tooltip,
  Badge,
  Text,
  Box,
  Divider,
  Banner,
  Icon,
  ProgressBar,
  Spinner,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { api, adminApi, getShop } from "../api/client.js";

// ── helpers ──────────────────────────────────────────────────────────────
function normalizeLevel(level) {
  const v = String(level || "").toLowerCase().trim();
  if (/\bpremium\b/.test(v) || /\bpro\s*\+|\bpro\W*plus\b/.test(v)) return "premium";
  if (/\bpro\b/.test(v)) return "pro";
  return "free";
}
function labelFromLevel(level) {
  const v = (level || "").toLowerCase();
  if (v === "premium" || v === "pro+") return "Premium";
  if (v === "pro") return "Pro";
  return "Free";
}
function parsePlanResponse(j) {
  const p = j?.plan || j || {};
  return { level: normalizeLevel(p.level), status: (p.status || p.state || "unknown").toString() };
}
function pct(n, d) {
  const N = Number(n || 0);
  const D = Number(d || 0);
  if (!D) return 0;
  const p = (100 * N) / D;
  return isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
}
function fmt(n) {
  const x = Number(n || 0);
  return isFinite(x) ? x.toLocaleString() : "—";
}

export default function Home() {
  const shop = React.useMemo(() => getShop(), []);
  const shopQS = React.useMemo(() => (shop ? `?shop=${encodeURIComponent(shop)}` : ""), [shop]);

  const [err, setErr] = React.useState("");
  const [plan, setPlan] = React.useState({ level: "free", status: "unknown" });
  const [settings, setSettings] = React.useState(null);
  const [overview, setOverview] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const refreshAnalytics = React.useCallback(async () => {
    try {
      console.log("[Home] Refreshing analytics...");
      // CORRECTED: Destructure the 'data' property
      const [{ data: over }, { data: ev }] = await Promise.all([
        adminApi.getAnalyticsSummary({ days: 30 }),
        adminApi.getAnalyticsEvents({ limit: 5 }),
      ]);
      setOverview(over || {});
      const items = Array.isArray(ev?.rows) ? ev.rows : Array.isArray(ev?.logs) ? ev.logs : Array.isArray(ev) ? ev : [];
      setLogs(items.slice(0, 5));
      console.log("[Home] Analytics refresh successful.");
    } catch (e) {
      console.warn("Home: refreshAnalytics failed:", e?.message || e);
    }
  }, []);

  React.useEffect(() => {
    let on = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        console.log("[Home] Fetching initial data...");
        // CORRECTED: Fetch all data concurrently and destructure 'data' from each response
        const [
          { data: planData },
          { data: settingsData },
          { data: overviewData },
          { data: logsData }
        ] = await Promise.all([
          api.get(`/api/billing/plan`),
          api.get(`/api/admin/store-settings`),
          adminApi.getAnalyticsSummary({ days: 30 }),
          adminApi.getAnalyticsEvents({ limit: 5 }),
        ]);

        console.log("[Home] Fetched Plan:", planData);
        console.log("[Home] Fetched Settings:", settingsData);
        console.log("[Home] Fetched Overview:", overviewData);
        console.log("[Home] Fetched Logs:", logsData);

        if (on) {
          setPlan(parsePlanResponse(planData));
          setSettings(settingsData?.settings || {});
          setOverview(overviewData || {});
          const items = Array.isArray(logsData?.rows) ? logsData.rows : Array.isArray(logsData?.logs) ? logsData.logs : Array.isArray(logsData) ? logsData : [];
          setLogs(items.slice(0, 5));
        }
        console.log("[Home] Initial data load successful.");
      } catch (e) {
        console.error("[Home] Initial data load failed:", e);
        if (on) setErr(`Failed to load dashboard: ${e?.message || "Unknown error"}`);
      } finally {
        if (on) setLoading(false);
      }
    })();

    // Setup event listener for analytics updates
    window.addEventListener("rf:analytics:ingested", refreshAnalytics);
    return () => {
      on = false;
      window.removeEventListener("rf:analytics:ingested", refreshAnalytics);
    };
  }, [shop, refreshAnalytics]);


  // derived values
  const level = normalizeLevel(plan?.level);
  const levelLabel = labelFromLevel(level);
  const badgeTone = level === "premium" ? "success" : level === "pro" ? "attention" : "subdued";

  const totals = overview?.totals || overview || {};
  const interactions = Number(totals.interactions ?? totals.events ?? totals.queries ?? 0) || 0;
  const productClicks = Number(totals.productClicks ?? totals.clicks ?? 0);
  
  const usage = overview?.usage || {};
  const used = Number(usage.used ?? 0);
  const limit = usage.limit ?? (level === "free" ? 0 : level === "pro" ? 1000 : level === "premium" ? 10000 : 0);
  const ctr = interactions ? (100 * productClicks) / interactions : 0;

  const hasTone = Boolean(settings?.aiTone);
  const hasCategory = Boolean(settings?.category);
  const checklistDone = [hasTone, hasCategory].filter(Boolean).length;

  if (loading) {
    return (
      <Box padding="400"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="p">Loading dashboard...</Text></InlineStack></Box>
    );
  }

  return (
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      <Card>
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Welcome to Refina</Text>
            <InlineStack gap="200" blockAlign="center">
              <Tooltip content={levelLabel}><Badge tone={badgeTone}>{levelLabel}</Badge></Tooltip>
              {plan?.status && <Badge tone="subdued">{String(plan.status).toUpperCase()}</Badge>}
              <Button url={`#/billing${shopQS}`}>Manage billing</Button>
            </InlineStack>
          </InlineStack>
        </Box>
        <Divider />
        <Box padding="400">
          <InlineStack gap="300">
            <Button variant="primary" url={`#/analytics${shopQS}`}>View analytics</Button>
            <Button url={`#/settings${shopQS}`}>Settings</Button>
            <Button url={`#/billing${shopQS}`}>Billing</Button>
          </InlineStack>
        </Box>
      </Card>

      {err && (
        <Box paddingBlockStart="400">
          <Banner tone="critical" title="Something went wrong" onDismiss={() => setErr("")}>
            <p>{err}</p>
          </Banner>
        </Box>
      )}

      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">Your month at a glance</Text>
                <Text as="span" tone="subdued" variant="bodySm">Last 30 days</Text>
              </InlineStack>
              <BlockStack gap="150">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" tone="subdued">Smart queries</Text>
                  <Text as="span" tone="subdued">{level === "free" ? "Locked on Free" : `${fmt(used)} / ${fmt(limit)}`}</Text>
                </InlineStack>
                <ProgressBar progress={level === "free" ? 0 : pct(used, limit)} size="small" />
                {level === "free" && (
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={CheckIcon} tone="success" /><Text as="span" tone="subdued">Upgrade to Pro to unlock AI-powered recommendations & analytics</Text>
                  </InlineStack>
                )}
              </BlockStack>
              <InlineStack gap="400" wrap>
                <Box minWidth="220px" maxWidth="340px" width="100%"><Card><Box padding="300"><BlockStack gap="050"><Text as="span" tone="subdued" variant="bodySm">Customer interactions</Text><Text as="h4" variant="headingLg">{fmt(interactions)}</Text></BlockStack></Box></Card></Box>
                <Box minWidth="220px" maxWidth="340px" width="100%"><Card><Box padding="300"><BlockStack gap="050"><Text as="span" tone="subdued" variant="bodySm">Product clicks</Text><Text as="h4" variant="headingLg">{fmt(productClicks)}</Text></BlockStack></Box></Card></Box>
                <Box minWidth="220px" maxWidth="340px" width="100%"><Card><Box padding="300"><BlockStack gap="050"><Text as="span" tone="subdued" variant="bodySm">CTR</Text><Text as="h4" variant="headingLg">{`${ctr ? ctr.toFixed(1) : "0.0"}%`}</Text></BlockStack></Box></Card></Box>
              </InlineStack>
            </BlockStack>
          </Box>
        </Card>
      </Box>

      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">Unlock more with your plan</Text>
                <Text as="p" tone="subdued">{level === "free" ? "Pro unlocks AI recommendations, analytics, and styling controls." : level === "pro" ? "Premium unlocks higher limits and advanced analytics." : "You’re on Premium — thanks for supporting Refina!"}</Text>
              </BlockStack>
              {level === "premium" ? (<Badge tone="success">Premium</Badge>) : (<Button variant="primary" url={`#/billing${shopQS}`}>{level === "free" ? "Upgrade to Pro" : "Upgrade to Premium"}</Button>)}
            </InlineStack>
          </Box>
        </Card>
      </Box>

      <Box paddingBlockStart="400">
        <InlineStack gap="400" wrap>
          <Box minWidth="320px" maxWidth="520px" width="100%">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">Recommended next steps</Text>
                    <Badge tone={checklistDone === 2 ? "success" : "attention"}>{checklistDone}/2</Badge>
                  </InlineStack>
                  <InlineStack gap="150" blockAlign="center">
                    <Icon source={CheckIcon} tone={hasTone ? "success" : "subdued"} /><Text as="span">Set your <strong>tone</strong> in <a href={`#/settings${shopQS}`}>Settings</a></Text>
                  </InlineStack>
                  <InlineStack gap="150" blockAlign="center">
                    <Icon source={CheckIcon} tone={hasCategory ? "success" : "subdued"} /><Text as="span">Choose your <strong>category</strong> in <a href={`#/settings${shopQS}`}>Settings</a></Text>
                  </InlineStack>
                </BlockStack>
              </Box>
            </Card>
          </Box>
          <Box minWidth="320px" maxWidth="520px" width="100%">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Recent activity</Text>
                  {logs.length ? (
                    <BlockStack gap="200">
                      {logs.map((row, i) => {
                        const concern = row?.concern || row?.query || "Customer asked…";
                        const productTitle = row?.topProduct?.title || "";
                        const when = row?.createdAt || row?.ts || "";
                        return (
                          <Box key={i} paddingBlock="150" borderBlockEndWidth={i < logs.length - 1 ? "025" : "0"}>
                            <Text as="p"><strong>{concern}</strong></Text>
                            <Text as="p" tone="subdued">{productTitle ? `→ ${productTitle}` : " "}{when ? ` • ${new Date(when).toLocaleString()}` : ""}</Text>
                          </Box>
                        );
                      })}
                      <Button url={`#/analytics${shopQS}`} plain>See full log</Button>
                    </BlockStack>
                  ) : (<Text tone="subdued">No activity yet — check back after some traffic.</Text>)}
                </BlockStack>
              </Box>
            </Card>
          </Box>
        </InlineStack>
      </Box>
    </Box>
  );
}
