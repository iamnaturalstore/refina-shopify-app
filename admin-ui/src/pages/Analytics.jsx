// admin-ui/src/pages/Analytics.jsx
import React, { useEffect, useMemo, useState } from "react";
import * as P from "@shopify/polaris";
import { api, getStoreIdFromUrl } from "../api/client.js";

export default function Analytics() {
  const storeId = useMemo(() => getStoreIdFromUrl(), []);
  const [days] = useState(30);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [overview, setOverview] = useState(null);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoading(true);
        setErr(null);

        const overUrl = storeId
          ? `/api/admin/analytics/overview?storeId=${encodeURIComponent(storeId)}&days=${days}`
          : `/api/admin/analytics/overview?days=${days}`;
        const logsUrl = storeId
          ? `/api/admin/analytics/logs?storeId=${encodeURIComponent(storeId)}&limit=50`
          : `/api/admin/analytics/logs?limit=50`;

        const [o, l] = await Promise.all([api(overUrl), api(logsUrl)]);
        if (!on) return;
        setOverview(o);
        setLogs(l?.rows || []);
      } catch (e) {
        if (!on) return;
        setErr(e?.message || "Failed to load analytics");
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => {
      on = false;
    };
  }, [storeId, days]);

  const planCounts = overview?.planCounts || { free: 0, pro: 0, "premium+": 0, unknown: 0 };
  const topConcerns = overview?.topConcerns || [];
  const maxCount = topConcerns.reduce((m, x) => Math.max(m, x.count), 0);

  const rows = logs.map((r) => [
    r.createdAt ? new Date(r.createdAt).toLocaleString() : "—",
    "—",
    r.concern || "—",
    (r.productIds && r.productIds[0]) || "—",
  ]);

  return (
    <P.Page title="Analytics">
      <P.BlockStack gap="400">
        <P.Text as="p" tone="subdued">
          Last {days} days • Store: {storeId || "—"}
        </P.Text>

        {err && (
          <P.Banner tone="critical" title="Failed to load analytics">
            <p>{err}</p>
          </P.Banner>
        )}

        {loading ? (
          <P.Card>
            <P.Box padding="400" align="center" inlineAlign="center">
              <P.Spinner accessibilityLabel="Loading analytics" size="large" />
            </P.Box>
          </P.Card>
        ) : (
          <>
            {/* KPI cards */}
            <P.InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
              <P.Card>
                <P.Box padding="400">
                  <P.Text as="h3" variant="headingSm">
                    Total events
                  </P.Text>
                  <P.Text as="p" variant="headingLg">
                    {overview?.totalEvents ?? "—"}
                  </P.Text>
                </P.Box>
              </P.Card>

              <P.Card>
                <P.Box padding="400">
                  <P.Text as="h3" variant="headingSm">
                    Unique concerns
                  </P.Text>
                  <P.Text as="p" variant="headingLg">
                    {overview?.uniqueConcerns ?? "—"}
                  </P.Text>
                </P.Box>
              </P.Card>

              <P.Card>
                <P.Box padding="400">
                  <P.Text as="h3" variant="headingSm">
                    Unique products suggested
                  </P.Text>
                  <P.Text as="p" variant="headingLg">
                    {overview?.uniqueProductsSuggested ?? "—"}
                  </P.Text>
                </P.Box>
              </P.Card>

              <P.Card>
                <P.Box padding="400">
                  <P.Text as="h3" variant="headingSm">
                    Plan mix
                  </P.Text>
                  <P.InlineStack gap="200">
                    <P.Badge>Free {planCounts.free || 0}</P.Badge>
                    <P.Badge tone="attention">Pro {planCounts.pro || 0}</P.Badge>
                    <P.Badge tone="success">Premium+ {planCounts["premium"] || 0}</P.Badge>
                  </P.InlineStack>
                </P.Box>
              </P.Card>
            </P.InlineGrid>

            {/* Top concerns chart */}
            <P.Card>
              <P.Box padding="400">
                <P.Text as="h3" variant="headingMd">
                  Top concerns
                </P.Text>
                <P.BlockStack gap="300">
                  {topConcerns.length === 0 && (
                    <P.Text as="p" tone="subdued">
                      No data yet.
                    </P.Text>
                  )}
                  {topConcerns.map((c) => (
                    <div key={c.label}>
                      <P.InlineStack align="space-between">
                        <P.Text as="p">{c.label}</P.Text>
                        <P.Text as="p" tone="subdued">
                          {c.count}
                        </P.Text>
                      </P.InlineStack>
                      <P.ProgressBar
                        progress={maxCount ? Math.round((c.count / maxCount) * 100) : 0}
                        size="medium"
                      />
                    </div>
                  ))}
                </P.BlockStack>
              </P.Box>
            </P.Card>

            {/* Recent activity table */}
            <P.Card>
              <P.Box padding="400">
                <P.Text as="h3" variant="headingMd">
                  Recent activity
                </P.Text>
                {rows.length === 0 ? (
                  <P.Text as="p" tone="subdued">
                    No rows yet.
                  </P.Text>
                ) : (
                  <P.DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Time", "Type", "Concern", "Product"]}
                    rows={rows}
                  />
                )}
              </P.Box>
            </P.Card>
          </>
        )}
      </P.BlockStack>
    </P.Page>
  );
}
