// admin-ui/src/pages/Analytics.jsx
import * as React from "react";
import {
  Page,
  Layout,
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
  DataTable,
} from "@shopify/polaris";
import { adminApi, getShop } from "../api/client.js";
import styles from "./Analytics.module.css";

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
  const recentEventsRows = events.map(e => [
    e.tsServerIso ? new Date(e.tsServerIso).toLocaleString() : "—",
    e.type || "—",
    e.concern || "—",
    e.productTitle || "—",
  ]);

  if (loading) {
    return (
      <Box padding="400"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="p">Loading analytics...</Text></InlineStack></Box>
    );
  }

  return (
    <Page>
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg" className={styles.pageTitle}>Analytics</Text>
        <Text as="p" tone="subdued">See what your customers are asking for and how Refina is helping them find the perfect product.</Text>

        {err && <Banner tone="critical" onDismiss={() => setErr("")}><p>{err}</p></Banner>}

        {loading ? (
          <div className={styles.spinnerContainer}>
            <Spinner accessibilityLabel="Loading analytics" size="large" />
          </div>
        ) : (
          <BlockStack gap="400">
            <Layout>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm" tone="subdued">Total Queries (30 Days)</Text>
                    <p className={styles.metricNumber}>{totals.interactions}</p>
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm" tone="subdued">Unique Concerns</Text>
                    <p className={styles.metricNumber}>{aggs.uniqueConcerns}</p>
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm" tone="subdued">Unique Products Suggested</Text>
                    <p className={styles.metricNumber}>{aggs.uniqueProducts}</p>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
            
            <Layout>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="300">
                     <Text as="h3" variant="headingMd">Top 5 Concerns</Text>
                     {aggs.topConcerns.length > 0 ? (
                       <BlockStack gap="200">
                         {aggs.topConcerns.slice(0, 5).map((row) => (
                           <div key={row.label}>
                             <InlineStack align="space-between">
                               <Text>{titleCase(row.label)}</Text>
                               <Text tone="subdued">{row.count} queries</Text>
                             </InlineStack>
                             <Box paddingBlockStart="100">
                               <ProgressBar progress={(row.count / maxConcernCount) * 100} size="small" />
                             </Box>
                           </div>
                         ))}
                       </BlockStack>
                     ) : (
                       <Text tone="subdued">No concern data yet.</Text>
                     )}
                  </BlockStack>
                </Card>
              </Layout.Section>

              <Layout.Section variant="twoThirds">
                 <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Recent Activity</Text>
                    {recentEventsRows.length > 0 ? (
                      <>
                        <DataTable
                          columnContentTypes={['text', 'text', 'text', 'text']}
                          headings={['Timestamp', 'Type', 'Concern', 'Top Product']}
                          rows={recentEventsRows.slice(0, 50)}
                        />
                        {cursor && (
                          <Box paddingBlockStart="200">
                            <Button onClick={loadMore} loading={loadingMore} disabled={loadingMore}>Load more</Button>
                          </Box>
                        )}
                      </>
                    ) : (
                      <Text as="p" tone="subdued">No recent activity found.</Text>
                    )}
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
