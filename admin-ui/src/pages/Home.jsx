// admin-ui/src/pages/Home.jsx
import * as React from "react";
import { Card, BlockStack, InlineStack, Button, Tooltip, Badge, Text, Box, Divider, Banner, Icon, ProgressBar } from "@shopify/polaris";
import { api, getShop } from "../api/client.js";

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
  // Always a FULL domain, e.g. "refina-demo.myshopify.com"
  const shop = React.useMemo(() => getShop(), []);
  const shopQS = React.useMemo(
    () => (shop ? `?shop=${encodeURIComponent(shop)}` : ""),
    [shop]
  );

  // state
  const [err, setErr] = React.useState("");
  const [plan, setPlan] = React.useState({ level: "free", status: "unknown" });
  const [settings, setSettings] = React.useState(null);
  const [overview, setOverview] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [health, setHealth] = React.useState({ ok: false, now: "" });

  const [loadingPlan, setLoadingPlan] = React.useState(true);
  const [loadingSettings, setLoadingSettings] = React.useState(true);
  const [loadingOverview, setLoadingOverview] = React.useState(true);
  const [loadingLogs, setLoadingLogs] = React.useState(true);
  const [checkingHealth, setCheckingHealth] = React.useState(true);

  // NEW: refresh both overview + logs on-demand (used by event listener below)
  async function refreshAnalytics() {
    try {
      setLoadingOverview(true);
      setLoadingLogs(true);
      const [over, j] = await Promise.all([
        api(`/api/admin/analytics/overview?days=30`),
        api(`/api/admin/analytics/logs?limit=5`),
      ]);
      setOverview(over || {});
      const items = Array.isArray(j?.rows)
        ? j.rows
        : Array.isArray(j?.logs)
        ? j.logs
        : Array.isArray(j)
        ? j
        : [];
      setLogs(items.slice(0, 5));
    } catch (e) {
      // keep this quiet; initial load already reports errors
      console.warn("Home: refreshAnalytics failed:", e?.message || e);
    } finally {
      setLoadingOverview(false);
      setLoadingLogs(false);
    }
  }

  // fetch: plan
  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoadingPlan(true);
        // api() appends host/shop/storeId context; no need to pass ?shop=
        const j = await api(`/api/billing/plan`);
        if (on) setPlan(parsePlanResponse(j));
      } catch (e) {
        if (on) setErr(`Plan error: ${e?.message || "failed to load"}`);
      } finally {
        if (on) setLoadingPlan(false);
      }
    })();
    return () => { on = false; };
  }, [shop]);

  // fetch: settings
  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoadingSettings(true);
        // api() injects context; do not send short IDs
        const j = await api(`/api/admin/store-settings`);
        if (on) setSettings(j?.settings || {});
      } catch (e) {
        // Non-blocking: fall back silently so Home doesn’t show a red banner for settings alone
        console.warn("Home: settings load failed", e?.message || e);
        if (on) setSettings({});
      } finally {
        if (on) setLoadingSettings(false);
      }
    })();
    return () => { on = false; };
  }, [shop]);

  // fetch: analytics overview (30d)
  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoadingOverview(true);
        const over = await api(`/api/admin/analytics/overview?days=30`);
        if (on) setOverview(over || {});
      } catch (e) {
        if (on) setErr(prev => prev || `Analytics error: ${e?.message || "failed to load"}`);
      } finally {
        if (on) setLoadingOverview(false);
      }
    })();
    return () => { on = false; };
  }, [shop]);

  // fetch: recent logs (limit 5)
  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoadingLogs(true);
        const j = await api(`/api/admin/analytics/logs?limit=5`);
        // CHANGED: prefer `rows`, then `logs`, then array fallback (matches backend response)
        const items = Array.isArray(j?.rows)
          ? j.rows
          : Array.isArray(j?.logs)
          ? j.logs
          : Array.isArray(j)
          ? j
          : [];
        if (on) setLogs(items.slice(0, 5));
      } catch {
        // silently ignore
      } finally {
        if (on) setLoadingLogs(false);
      }
    })();
    return () => { on = false; };
  }, [shop]);

  // NEW: auto-refresh the dashboard after a successful ingest (from anywhere in the UI)
  React.useEffect(() => {
    function onIngest() {
      refreshAnalytics();
    }
    window.addEventListener("rf:analytics:ingested", onIngest);
    return () => window.removeEventListener("rf:analytics:ingested", onIngest);
  }, []);

  // health
  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setCheckingHealth(true);
        const r = await fetch("/v1/health");
        const j = r.ok ? await r.json() : {};
        if (on) setHealth({ ok: !!j?.ok, now: j?.now || "" });
      } catch {
        if (on) setHealth({ ok: false, now: "" });
      } finally {
        if (on) setCheckingHealth(false);
      }
    })();
    return () => { on = false; };
  }, []);

  // derived
  const level = normalizeLevel(plan?.level);
  const levelLabel = labelFromLevel(level);
  const badgeTone = level === "premium" ? "success" : level === "pro" ? "attention" : "subdued";

  // overview shape tolerance
  const totals = overview?.totals || overview || {};
  const interactions = Number(
    totals.interactions ?? totals.queries ?? totals.sessions ?? totals.requests ?? 0
  );
  const productClicks = Number(
    totals.productClicks ?? totals.clicks ?? totals.cta ?? 0
  );
  // usage (fallback based on plan)
  const usage = overview?.usage || {};
  const used = Number(usage.used ?? usage.monthUsed ?? 0);
  const limit =
    usage.limit ??
    (level === "free" ? 0 : level === "pro" ? 1000 : level === "premium" ? 10000 : 0);

  const ctr = interactions ? (100 * (productClicks || 0)) / interactions : 0;

  // checklist derived
  const hasTone = Boolean(settings?.tone);
  const hasCategory = Boolean(settings?.category);
  const hasDomain = Boolean(settings?.domain);
  const checklistDone = [hasTone, hasCategory, hasDomain].filter(Boolean).length;

  // links
  const qsParam = shop ? `?shop=${encodeURIComponent(shop)}` : "";

  return (
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      {/* header */}
      <Card>
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Welcome to Refina</Text>
            <InlineStack gap="200" blockAlign="center">
              <Tooltip content={levelLabel}>
                <Badge tone={badgeTone}>{levelLabel}</Badge>
              </Tooltip>
              {plan?.status && (
                <Badge tone="subdued">{String(plan.status).toUpperCase()}</Badge>
              )}
              <Button url={`#/billing${qsParam}`}>Manage billing</Button>
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

      {/* errors */}
      {err && (
        <Box paddingBlockStart="400">
          <Banner tone="critical" title="Something went wrong">
            <p>{err}</p>
          </Banner>
        </Box>
      )}

      {/* month at a glance */}
      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">Your month at a glance</Text>
                <Text as="span" tone="subdued" variant="bodySm">
                  {loadingOverview ? "Loading…" : "Last 30 days"}
                </Text>
              </InlineStack>

              {/* usage meter */}
              <BlockStack gap="150">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" tone="subdued">Smart queries</Text>
                  <Text as="span" tone="subdued">
                    {level === "free"
                      ? "Locked on Free"
                      : `${fmt(used)} / ${fmt(limit)}${limit ? "" : ""}`}
                  </Text>
                </InlineStack>
                <ProgressBar progress={level === "free" ? 0 : pct(used, limit)} size="small" />
                {level === "free" && (
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={CheckIcon} tone="success" />
                    <Text as="span" tone="subdued">
                      Upgrade to Pro to unlock AI-powered recommendations & analytics
                    </Text>
                  </InlineStack>
                )}
              </BlockStack>

              {/* impact tiles */}
              <InlineStack gap="400" wrap>
                <Box minWidth="220px" maxWidth="340px" width="100%">
                  <Card>
                    <Box padding="300">
                      <BlockStack gap="050">
                        <Text as="span" tone="subdued" variant="bodySm">Customer interactions</Text>
                        <Text as="h4" variant="headingLg">
                          {loadingOverview ? "—" : fmt(interactions)}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </Box>
                <Box minWidth="220px" maxWidth="340px" width="100%">
                  <Card>
                    <Box padding="300">
                      <BlockStack gap="050">
                        <Text as="span" tone="subdued" variant="bodySm">Product clicks</Text>
                        <Text as="h4" variant="headingLg">
                          {loadingOverview ? "—" : fmt(productClicks)}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </Box>
                <Box minWidth="220px" maxWidth="340px" width="100%">
                  <Card>
                    <Box padding="300">
                      <BlockStack gap="050">
                        <Text as="span" tone="subdued" variant="bodySm">CTR</Text>
                        <Text as="h4" variant="headingLg">
                          {loadingOverview ? "—" : `${ctr ? ctr.toFixed(1) : "0.0"}%`}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </Box>
              </InlineStack>
            </BlockStack>
          </Box>
        </Card>
      </Box>

      {/* unlock more with your plan */}
      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">Unlock more with your plan</Text>
                <Text as="p" tone="subdued">
                  {level === "free"
                    ? "Pro unlocks AI recommendations, analytics, and styling controls."
                    : level === "pro"
                    ? "Premium unlocks higher limits and advanced analytics."
                    : "You’re on Premium — thanks for supporting Refina!"}
                </Text>
              </BlockStack>
              {level === "premium" ? (
                <Badge tone="success">Premium</Badge>
              ) : (
                <Button variant="primary" url={`#/billing${shopQS}`}>
                  {level === "free" ? "Upgrade to Pro" : "Upgrade to Premium"}
                </Button>
              )}
            </InlineStack>
          </Box>
        </Card>
      </Box>

      {/* onboarding checklist + recent activity */}
      <Box paddingBlockStart="400">
        <InlineStack gap="400" wrap>
          {/* checklist */}
          <Box minWidth="320px" maxWidth="520px" width="100%">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">Recommended next steps</Text>
                    <Badge tone={checklistDone === 3 ? "success" : "attention"}>
                      {checklistDone}/3
                    </Badge>
                  </InlineStack>

                  <InlineStack gap="150" blockAlign="center">
                    <Icon source={CheckIcon} tone={hasTone ? "success" : "subdued"} />
                    <Text as="span">
                      Set your <strong>tone</strong> in{" "}
                      <a href={`#/settings${shopQS}`}>Settings</a>
                    </Text>
                  </InlineStack>

                  <InlineStack gap="150" blockAlign="center">
                    <Icon source={CheckIcon} tone={hasCategory ? "success" : "subdued"} />
                    <Text as="span">
                      Choose your <strong>category</strong> in{" "}
                      <a href={`#/settings${shopQS}`}>Settings</a>
                    </Text>
                  </InlineStack>

                  <InlineStack gap="150" blockAlign="center">
                    <Icon source={CheckIcon} tone={hasDomain ? "success" : "subdued"} />
                    <Text as="span">
                      Connect your <strong>domain</strong> in{" "}
                      <a href={`#/settings${shopQS}`}>Settings</a>
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Box>
            </Card>
          </Box>

          {/* recent activity */}
          <Box minWidth="320px" maxWidth="520px" width="100%">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Recent activity</Text>
                  {loadingLogs ? (
                    <Text tone="subdued">Loading…</Text>
                  ) : logs.length ? (
                    <BlockStack gap="200">
                      {logs.map((row, i) => {
                        const concern = row?.concern || row?.query || row?.question || "Customer asked…";
                        const productTitle =
                          row?.topProduct?.title ||
                          row?.productTitle ||
                          (Array.isArray(row?.products) ? row.products[0]?.title : "") ||
                          "";
                        const when =
                          row?.createdAt ||
                          row?.ts ||
                          row?.timestamp ||
                          "";
                        return (
                          <Box key={i} paddingBlock="150" borderBlockEndWidth={i < logs.length - 1 ? "025" : "0"}>
                            <Text as="p"><strong>{concern}</strong></Text>
                            <Text as="p" tone="subdued">
                              {productTitle ? `→ ${productTitle}` : " "}
                              {when ? ` • ${new Date(when).toLocaleString()}` : ""}
                            </Text>
                          </Box>
                        );
                      })}
                      <Button url={`#/analytics${shopQS}`} plain>See full log</Button>
                    </BlockStack>
                  ) : (
                    <Text tone="subdued">No activity yet — check back after some traffic.</Text>
                  )}
                </BlockStack>
              </Box>
            </Card>
          </Box>
        </InlineStack>
      </Box>

      {/* health */}
      <Box paddingBlockStart="400" paddingBlockEnd="200">
        <Card>
          <Box padding="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">System health</Text>
              <Badge tone={health.ok ? "success" : "critical"}>
                {checkingHealth ? "Checking…" : health.ok ? "OK" : "Issue"}
              </Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              {health.ok ? `Last check: ${health.now || "—"}` : "If issues persist, open Settings or contact support."}
            </Text>
          </Box>
        </Card>
      </Box>
    </Box>
  );
}
