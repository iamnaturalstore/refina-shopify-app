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
  Banner,
} from "@shopify/polaris";
import { api, adminApi, getShop } from "../api/client.js";
import styles from "./Analytics.module.css";

import AppNav from "../components/AppNav";

/**
 * Guardrails:
 * - Always use full <shop>.myshopify.com (no short IDs)
 * - Tolerate both old and new Admin API response shapes:
 * - Summary: sum.totals.* OR  sum.totalEvents, topProducts, etc.
 * - Events: ev.items[]  OR  ev.rows[]  OR  ev.events[]  OR  bare arrays
 * - No misleading fallbacks: if productClicks is not provided, show 0 (don't infer).
 * - Keep UI functional even if backend adds/removes fields.
 *
 * GATING:
 * - Lite: basic interaction count only + upgrade prompt
 * - Growth / Pro / Premium: full analytics
 */

const GRAD = "linear-gradient(135deg, #4FC3F7, #6B8FFF, #8B5CF6)";

function normalizeLevel(level) {
  const v = String(level || "").toLowerCase().trim();
  if (/\bpremium\b/.test(v)) return "premium";
  if (/\bpro\b/.test(v))     return "pro";
  if (/\bgrowth\b/.test(v))  return "growth";
  if (/\blite\b/.test(v))    return "lite";
  return "free";
}

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
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
    const uniqueConcerns = Number(sum.totals.uniqueConcerns ?? 0) || 0;
    const topConcerns = Array.isArray(sum.totals.topConcerns) ? sum.totals.topConcerns : [];
    return { ...sum, totals: { ...sum.totals, interactions, productClicks, uniqueConcerns, topConcerns } };
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

/** Map the raw stored event name to what a merchant should see in the Type column. */
const EVENT_TYPE_LABELS = {
  recommendation_received: "Query",
  product_click: "Product Click",
  drawer_open: "PDP Drawer Opened",
  drawer_confirm: "PDP Drawer Confirmed",
  mapping_applied: "Query",
};

/** Normalize a single event, deriving common fields we want to render/aggregate. */
function normalizeEvent(e) {
  const id = e.id || e.eventId || e.tsServer || e.createdAt || Math.random().toString(36).slice(2);
  const tsServerIso = e.tsServerIso || (typeof e.ts === "string" ? e.ts : null) || (typeof e.createdAt === "string" ? e.createdAt : null) || (typeof e.tsServer === "number" ? new Date(e.tsServer).toISOString() : null) || null;
  const type = EVENT_TYPE_LABELS[e.event] || e.type || e.eventType || "event";
  const concern = e.concern || e.query || e.question || e.note || "";
  const productTitle = e.topProduct?.title || e.productTitle || e.topProductTitle || (Array.isArray(e.products) ? (e.products[0]?.title || e.products[0]?.name) : "") || (e.productId ? String(e.productId) : "");
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

// ─── Lite gated view ─────────────────────────────────────────────────────────
// Shows basic interaction count only. Query detail is a Growth+ feature.

function LiteGatedView({ interactions, onUpgrade }) {
  return (
    <BlockStack gap="400">
      <Text as="h1" variant="headingLg" className={styles.pageTitle}>Analytics</Text>
      <Text as="p" tone="subdued">See what your customers are asking for and how Refina is helping them.</Text>

      {/* Basic count — always visible on Lite */}
      <Layout>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm" tone="subdued">Total Queries (30 Days)</Text>
              <p className={styles.metricNumber}>{interactions}</p>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Upgrade prompt */}
      <Card>
        <BlockStack gap="400">
          <div style={{ textAlign: "center", padding: "32px 24px" }}>
            <div style={{ fontSize: "32px", marginBottom: "16px" }}>🔍</div>
            <Text as="h2" variant="headingMd">See exactly what your shoppers are asking</Text>
            <Box paddingBlockStart="200" paddingBlockEnd="400">
              <Text as="p" tone="subdued">
                Upgrade to Growth to unlock full analytics — every query your shoppers ask,
                top concerns, recent activity, and product click-through data.
              </Text>
            </Box>

            {/* Feature preview — what they're missing */}
            <div style={{
              background: "#F8F9FF",
              border: "1px solid #E4E7EE",
              borderRadius: "12px",
              padding: "20px 24px",
              marginBottom: "24px",
              textAlign: "left",
            }}>
              <Text as="p" variant="headingSm" tone="subdued">Unlocked on Growth:</Text>
              <Box paddingBlockStart="200">
                <BlockStack gap="150">
                  {[
                    "Full query log — every shopper question with timestamp",
                    "Top concerns — what your customers struggle to choose between",
                    "Product click-through rate — which recommendations convert",
                    "Unique concern tracking — spot patterns in shopper behaviour",
                  ].map((feature) => (
                    <InlineStack key={feature} gap="200" blockAlign="center">
                      <span style={{ color: "#8B5CF6", fontSize: "14px" }}>✓</span>
                      <Text as="p">{feature}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Box>
            </div>

            <button
              onClick={onUpgrade}
              style={{
                padding: "10px 24px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: "600",
                background: GRAD,
                color: "white",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(107,143,255,0.3)",
                fontFamily: "inherit",
              }}
            >
              Upgrade to Growth — $19/mo →
            </button>
            <Box paddingBlockStart="200">
              <Text as="p" tone="subdued" variant="bodySm">30-day free trial available</Text>
            </Box>
          </div>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Analytics() {
  const shop     = getShop();
  const navigate = React.useCallback((path) => {
    // Minimal navigate — preserves host/shop query params
    try {
      const search = new URLSearchParams(window.location.search || "");
      const hashQ  = (window.location.hash || "").split("?")[1] || "";
      const hash   = new URLSearchParams(hashQ);
      const host   = search.get("host") || hash.get("host") || "";
      const shopP  = search.get("shop") || hash.get("shop") || "";
      const p      = new URLSearchParams();
      if (host)  p.set("host", host);
      if (shopP) p.set("shop", shopP);
      const qs = p.toString() ? `?${p.toString()}` : "";
      window.location.href = `${path}${qs}`;
    } catch {
      window.location.href = path;
    }
  }, []);

  const [level,       setLevel]       = React.useState("free");
  const [summary,     setSummary]     = React.useState(null);
  const [events,      setEvents]      = React.useState([]);
  const [cursor,      setCursor]      = React.useState("");
  const [loading,     setLoading]     = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [err,         setErr]         = React.useState("");
  const [rawPlan, setRawPlan] = React.useState(null);
  const [aggs,        setAggs]        = React.useState({
    uniqueConcerns: 0,
    uniqueProducts: 0,
    planMix: { free: 0, pro: 0, premium: 0, unknown: 0 },
    topConcerns: [],
  });

  const refetchAll = React.useCallback(async (initialLimit = 100) => {
    try {
const [{ data: sumData }, { data: ev }, { data: planData }] = await Promise.all([
adminApi.getAnalyticsSummary({ days: 30 }),
adminApi.getAnalyticsEvents({ limit: initialLimit }),
api.get("/api/billing/plan").catch(() => ({ data: null })),
      ]);
setSummary(normalizeSummary(sumData));
setRawPlan(planData);
const items = pickArray(ev).map(normalizeEvent);
setEvents(items);
const next = ev?.nextCursor ?? ev?.cursor ?? "";
setCursor(typeof next === "string" ? next : "");
setAggs(buildAggregates(items));
    } catch (e) {
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
      try {
        // Fetch plan level alongside analytics data
        const [{ data: planData }] = await Promise.all([
          api.get("/api/billing/plan"),
        ]);
        const parsed = planData?.plan || planData || {};
        const resolvedLevel = normalizeLevel(parsed.level);
        if (on) setLevel(resolvedLevel);
        if (on) setRawPlan(planData);

        // Always fetch summary for interaction count (needed for Lite basic view too)
        await refetchAll(100);
      } catch (e) {
        if (on) setErr(e?.message || "Failed to load analytics.");
      } finally {
        if (on) setLoading(false);
      }
    })();

    function onIngest() { refetchAll(50); }
    window.addEventListener("rf:analytics:ingested", onIngest);
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") refetchAll(50);
    }, 30000);

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

  const totals           = summary?.totals || { interactions: 0, productClicks: 0, uniqueConcerns: 0, topConcerns: [] };
  const topConcerns      = totals.topConcerns?.length ? totals.topConcerns : aggs.topConcerns;
  const maxConcernCount  = topConcerns.length > 0 ? topConcerns[0].count : 0;
  const aiSessions = Number(
  rawPlan?.plan?.usage?.requestsThisPeriod ?? 0
);
  const truncate = (s, max) => (s && s.length > max ? `${s.slice(0, max).trim()}…` : s);
  const recentEventsRows = events.map(e => [
    e.tsServerIso ? new Date(e.tsServerIso).toLocaleString() : "—",
    e.type || "—",
    truncate(e.concern, 60) || "—",
    e.productTitle || "—",
  ]);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Box padding="400">
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="p">Loading analytics...</Text>
        </InlineStack>
      </Box>
    );
  }

  // ── Lite: gated view ─────────────────────────────────────────────────────
  if (level === "lite") {
    return (
      <>
        <AppNav />
        <Page>
          <LiteGatedView
            interactions={totals.interactions}
            onUpgrade={() => navigate("/billing")}
          />
        </Page>
      </>
    );
  }

  // ── Free: no plan ─────────────────────────────────────────────────────────
  if (level === "free") {
    return (
      <>
        <AppNav />
        <Page>
          <BlockStack gap="400">
            <Text as="h1" variant="headingLg" className={styles.pageTitle}>Analytics</Text>
            <Banner
              tone="info"
              title="Choose a plan to unlock analytics"
              action={{ content: "View plans", onAction: () => navigate("/billing") }}
            >
              <p>Analytics are available on all paid plans. Start your 30-day free trial today.</p>
            </Banner>
          </BlockStack>
        </Page>
      </>
    );
  }

  // ── Growth / Pro / Premium: full analytics (unchanged) ───────────────────
  return (
    <>
      <AppNav />
      <Page>
        <BlockStack gap="400">
          <Text as="h1" variant="headingLg" className={styles.pageTitle}>Analytics</Text>
          <Text as="p" tone="subdued">See what your customers are asking for and how Refina is helping them find the perfect product.</Text>

          {/* Usage banner — safe: renders only if usage present */}
          {summary?.usage && typeof summary.usage.limit === "number" && summary.usage.limit > 0 && (
            <Box paddingBlockStart="300">
              {(() => {
                const used  = Number(summary.usage.used || 0);
                const limit = Number(summary.usage.limit || 0);
                const pct   = limit ? Math.min(100, Math.round((100 * used) / limit)) : 0;
                if (pct >= 85) {
                  return (
                    <Banner tone="warning" title={`You're at ${pct}% of your monthly AI allowance`}>
                      <p>{`${used.toLocaleString()} of ${limit.toLocaleString()} AI requests used this month. Upgrade on the Billing page for higher limits.`}</p>
                    </Banner>
                  );
                }
                return (
                  <Banner tone="info" title="AI usage this month">
                    <p>{`${used.toLocaleString()} of ${limit.toLocaleString()} AI requests used.`}</p>
                  </Banner>
                );
              })()}
            </Box>
          )}

          {err && <Banner tone="critical" onDismiss={() => setErr("")}><p>{err}</p></Banner>}

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
                    <p className={styles.metricNumber}>{totals.uniqueConcerns || aggs.uniqueConcerns}</p>
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm" tone="subdued">Quota-Free Queries</Text>
                    <p className={styles.metricNumber}>{Math.max(0, totals.interactions - (summary?.totals?.aiEvents ?? 0))}</p>
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm" tone="subdued">Product Clicks (30 Days)</Text>
                    <p className={styles.metricNumber}>{totals.productClicks}</p>
                    <Text tone="subdued">
                      {totals.interactions
                        ? `${Math.round((totals.productClicks / totals.interactions) * 100)}% click-through rate`
                        : "No queries yet"}
                    </Text>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>

            <Layout>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">Top 5 Concerns</Text>
                    {topConcerns.length > 0 ? (
                      <BlockStack gap="200">
                        {topConcerns.slice(0, 5).map((row) => (
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
                            <Button onClick={loadMore} loading={loadingMore} disabled={loadingMore}>
                              Load more
                            </Button>
                          </Box>
                        )}
                      </>
                    ) : (
                      <Text as="p" tone="subdued">
                        No recent activity found. If you just installed Refina, this will populate as customers start interacting.
                      </Text>
                    )}
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          </BlockStack>
        </BlockStack>
      </Page>
    </>
  );
}