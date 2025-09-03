// admin-ui/src/pages/Analytics.jsx
import * as React from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Divider,
  Spinner,
  Badge,
  Box,
  ProgressBar,
} from "@shopify/polaris";
import { adminApi, getShop } from "../api/client.js";

/**
 * Guardrails:
 * - Always use full <shop>.myshopify.com (no short IDs)
 * - Tolerate both old and new Admin API response shapes:
 * - Summary: sum.totals.* OR  sum.totalEvents, topProducts, etc.
 * - Events: ev.items[]  OR  ev.rows[]  OR  ev.events[]  OR  bare arrays
 * - No misleading fallbacks: if productClicks is not provided, show 0 (don’t infer).
 * - Keep UI functional even if backend adds/removes fields.
 */

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  // Note: a previous version of this function was incorrectly appending .myshopify.com
  // This version assumes the getShop() helper provides a valid domain.
  return s.endsWith(".myshopify.com") ? s : "";
}

/** Normalize the overview summary so totals.interactions is always present. */
function normalizeSummary(sum) {
  if (!sum || typeof sum !== "object") return { totals: { interactions: 0, productClicks: 0 } };
  if (sum.totals && typeof sum.totals === "object") {
    const interactions = Number(
      sum.totals.interactions ?? sum.totals.events ?? sum.totals.queries ?? 0
    ) || 0;
    const productClicks = Number(sum.totals.productClicks ?? sum.totals.clicks ?? 0) || 0;
    return { ...sum, totals: { ...sum.totals, interactions, productClicks } };
  }
  const interactions = Number(sum.totalEvents ?? 0) || 0;
  const productClicks = 0; // do not infer
  return { ...sum, totals: { interactions, productClicks } };
}

/** Pick the array of events from various server shapes. */
function pickArray(ev) {
  if (!ev) return [];
  if (Array.isArray(ev)) return ev;
  if (Array.isArray(ev.items)) return ev.items;
  if (Array.isArray(ev.rows)) return ev.rows;
  if (Array.isArray(ev.events)) return ev.events;
  return [];
}

/** Normalize a single event, deriving common fields we want to render/aggregate. */
function normalizeEvent(e) {
  const id = e.id || e.eventId || e.tsServer || e.createdAt || Math.random().toString(36).slice(2);
  const tsServerIso = e.tsServerIso || (typeof e.ts === "string" ? e.ts : null) || (typeof e.createdAt === "string" ? e.createdAt : null) || (typeof e.tsServer === "number" ? new Date(e.tsServer).toISOString() : null) || null;
  const type = e.type || e.eventType || "event";
  const concern = e.concern || e.query || e.question || e.note || "";
  const productTitle = e.topProduct?.title || e.productTitle || (Array.isArray(e.products) ? (e.products[0]?.title || e.products[0]?.name) : "") || "";
  const planRaw = (e.plan || e.userPlan || e.meta?.plan || "").toString().toLowerCase();
  const plan = /premium|pro\+|pro plus/.test(planRaw) ? "premium" : /pro/.test(planRaw) ? "pro" : /free/.test(planRaw) ? "free" : planRaw || "unknown";
  const productIds = new Set();
  if (Array.isArray(e.products)) {
    for (const p of e.products) {
      const pid = p?.id || p?.productId || p?.sku || p?.title || "";
      if (pid) productIds.add(String(pid));
    }
  }
  if (e.topProduct?.id) productIds.add(String(e.topProduct.id));
  if (e.productId) productIds.add(String(e.productId));
  return { ...e, id, tsServerIso, type, concern, productTitle, plan, _productIds: productIds };
}

/** Aggregate UI metrics from a list of normalized events. */
function buildAggregates(events) {
  const concernCounts = new Map();
  const uniqueProducts = new Set();
  const planMix = { free: 0, pro: 0, "premium": 0, unknown: 0 };
  for (const ev of events) {
    const c = String(ev.concern || "").trim().toLowerCase();
    if (c) concernCounts.set(c, (concernCounts.get(c) || 0) + 1);
    for (const pid of ev._productIds || []) uniqueProducts.add(pid);
    if (ev.plan === "free") planMix.free++;
    else if (ev.plan === "pro") planMix.pro++;
    else if (ev.plan === "premium") planMix["premium"]++;
    else planMix.unknown++;
  }
  const topConcerns = Array.from(concernCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ label: key, count }));
  return { uniqueConcerns: concernCounts.size, uniqueProducts: uniqueProducts.size, planMix, topConcerns };
}

/** Human: Title Case for nicer display of concern labels. */
function titleCase(s) {
  return String(s || "").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
}

export default function Analytics() {
  const shop = getShop(); // Relies on client.js to get the correct shop

  const [summary, setSummary] = React.useState(null);
  const [events, setEvents] = React.useState([]);
  const [cursor, setCursor] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [aggs, setAggs] = React.useState({ uniqueConcerns: 0, uniqueProducts: 0, planMix: { free: 0, pro: 0, "premium": 0, unknown: 0 }, topConcerns: [] });

  const refetchAll = React.useCallback(async (initialLimit = 100) => {
    try {
      console.log("[Analytics] Refetching all data...");
      // CORRECTED: Destructure the 'data' property from each API response
      const [{ data: sum }, { data: ev }] = await Promise.all([
        adminApi.getAnalyticsSummary({ days: 30 }),
        adminApi.getAnalyticsEvents({ limit: initialLimit }),
      ]);
      console.log("[Analytics] Fetched summary:", sum);
      console.log("[Analytics] Fetched events payload:", ev);

      setSummary(normalizeSummary(sum));
      const items = pickArray(ev).map(normalizeEvent);
      setEvents(items);
      const next = ev?.nextCursor ?? ev?.cursor ?? "";
      setCursor(typeof next === "string" ? next : "");
      setAggs(buildAggregates(items));
      console.log("[Analytics] Data processed successfully.");
    } catch (e) {
      console.error("[Analytics] Error during refetch:", e);
      setErr(e?.message || "Failed to load analytics data.");
    }
  }, []);

  React.useEffect(() => {
    let on = true;
    (async () => {
      if (!shop) {
        setErr("Could not determine shop context.");
        setLoading(false);
        return;
      }
      setErr("");
      setLoading(true);
      await refetchAll(100);
      if (on) setLoading(false);
    })();
    function onIngest() { refetchAll(50); }
    window.addEventListener("rf:analytics:ingested", onIngest);
    let iv = setInterval(() => { if (document.visibilityState === "visible") refetchAll(50); }, 30000);
    return () => {
      on = false;
      window.removeEventListener("rf:analytics:ingested", onIngest);
      clearInterval(iv);
    };
  }, [shop, refetchAll]);

  async function loadMore() {
    if (!cursor) return;
    try {
      setLoadingMore(true);
      // CORRECTED: Destructure the 'data' property from the API response
      const { data: ev } = await adminApi.getAnalyticsEvents({ limit: 200, cursor });
      const items = pickArray(ev).map(normalizeEvent);
      setEvents((prev) => {
        const merged = prev.concat(items);
        setAggs(buildAggregates(merged));
        return merged;
      });
      const next = ev?.nextCursor ?? ev?.cursor ?? "";
      setCursor(typeof next === "string" ? next : "");
    } catch (e) {
      setErr(e?.message || "Failed to load more events");
    } finally {
      setLoadingMore(false);
    }
  }

  const totals = summary?.totals || { interactions: 0, productClicks: 0 };
  const maxConcernCount = aggs.topConcerns.length ? Math.max(...aggs.topConcerns.map((t) => t.count)) : 0;

  if (loading) {
    return (
      <Box padding="400"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="p">Loading analytics...</Text></InlineStack></Box>
    );
  }

  return (
    <Page title="Analytics">
      <Card>
        <BlockStack gap="300" padding="300">
          {err && <Banner tone="critical" title="Error" onDismiss={() => setErr("")}><p>{err}</p></Banner>}
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">Last 30 days</Text>
            <InlineStack gap="200" blockAlign="center">
              {(loading || loadingMore) && <Spinner size="small" />}
              <Button onClick={() => refetchAll(100)} size="micro" disabled={loading || loadingMore}>Refresh</Button>
            </InlineStack>
          </InlineStack>
          <Divider />

          <InlineStack gap="400" wrap>
            <Card>
              <BlockStack padding="300" gap="050">
                <Text tone="subdued">Total events</Text>
                <Text variant="headingLg" as="h4">{totals.interactions}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack padding="300" gap="050">
                <Text tone="subdued">Unique concerns</Text>
                <Text variant="headingLg" as="h4">{aggs.uniqueConcerns}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack padding="300" gap="050">
                <Text tone="subdued">Unique products suggested</Text>
                <Text variant="headingLg" as="h4">{aggs.uniqueProducts}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack padding="300" gap="150">
                <Text tone="subdued">Plan mix</Text>
                <InlineStack gap="200" wrap blockAlign="center">
                  <Badge tone="subdued">Free {aggs.planMix.free}</Badge>
                  <Badge tone="attention">Pro {aggs.planMix.pro}</Badge>
                  <Badge tone="success">Premium {aggs.planMix["premium"]}</Badge>
                  {aggs.planMix.unknown ? (<Badge tone="critical">Unknown {aggs.planMix.unknown}</Badge>) : null}
                </InlineStack>
              </BlockStack>
            </Card>
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300" padding="300">
          <Text as="h3" variant="headingSm">Top concerns</Text>
          {!aggs.topConcerns.length ? (<Text tone="subdued">No concerns yet</Text>) : (
            <BlockStack gap="200">
              {aggs.topConcerns.map((row, i) => {
                const pct = maxConcernCount ? (100 * row.count) / maxConcernCount : 0;
                return (
                  <Box key={i} paddingBlock="100">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text>{titleCase(row.label)}</Text>
                      <Text tone="subdued">{row.count}</Text>
                    </InlineStack>
                    <Box paddingBlockStart="100"><ProgressBar progress={pct} size="small" /></Box>
                  </Box>
                );
              })}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300" padding="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">Recent activity</Text>
            {loadingMore && <Spinner size="small" />}
          </InlineStack>

          {!events.length ? (<Text tone="subdued">No events yet</Text>) : (
            <BlockStack gap="150">
              <InlineStack align="space-between" blockAlign="center">
                <Text tone="subdued" variant="bodySm" as="span" style={{ width: "24%" }}>Time</Text>
                <Text tone="subdued" variant="bodySm" as="span" style={{ width: "18%" }}>Type</Text>
                <Text tone="subdued" variant="bodySm" as="span" style={{ width: "38%" }}>Concern</Text>
                <Text tone="subdued" variant="bodySm" as="span" style={{ width: "20%", textAlign: "right" }}>Product</Text>
              </InlineStack>
              <Divider />
              {events.map((e) => (
                <Box key={e.id} paddingBlock="150" borderBlockEndWidth="016">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="bodySm" style={{ width: "24%" }}>{e.tsServerIso ? new Date(e.tsServerIso).toLocaleString() : "—"}</Text>
                    <Text variant="bodySm" style={{ width: "18%" }}>{e.type || "—"}</Text>
                    <Text variant="bodySm" style={{ width: "38%" }}>{e.concern || "—"}</Text>
                    <Text variant="bodySm" alignment="end" style={{ width: "20%", textAlign: "right" }}>{e.productTitle || "—"}</Text>
                  </InlineStack>
                </Box>
              ))}
              {cursor && (
                <Box paddingBlockStart="200">
                  <Button onClick={loadMore} disabled={loadingMore}>Load more</Button>
                </Box>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
