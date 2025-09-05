// admin-ui/src/pages/Analytics.jsx

import React, { useEffect, useState, useCallback } from "react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner, Box, ProgressBar, Button, Divider } from "@shopify/polaris";
import { adminApi, getShop } from "../api/client.js";
import styles from "./Analytics.module.css";

// --- Data Normalization Helpers (from your working baseline) ---

function normalizeSummary(sum) {
  if (!sum || typeof sum !== "object") return { totals: { interactions: 0, aiSessions: 0 } };
  const totals = sum.totals || {};
  const interactions = Number(totals.interactions ?? totals.events ?? 0) || 0;
  const aiSessions = Number(totals.aiSessions ?? totals.aiEvents ?? 0) || 0;
  return { ...sum, totals: { ...totals, interactions, aiSessions } };
}

function pickArray(ev) {
  if (!ev) return [];
  if (Array.isArray(ev)) return ev;
  if (Array.isArray(ev.rows)) return ev.rows;
  if (Array.isArray(ev.items)) return ev.items;
  return [];
}

function buildAggregates(events) {
  const concernCounts = new Map();
  for (const ev of events) {
    const c = String(ev.concern || "").trim().toLowerCase();
    if (c) concernCounts.set(c, (concernCounts.get(c) || 0) + 1);
  }
  const topConcerns = Array.from(concernCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
  return { topConcerns };
}

function titleCase(s) {
  return String(s || "").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
}

// --- The Merged Component ---

export default function Analytics() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState({ totals: { interactions: 0, aiSessions: 0 } });
  const [aggregates, setAggregates] = useState({ topConcerns: [] });

  const fetchData = useCallback(async () => {
    try {
      const [summaryData, eventsData] = await Promise.all([
        adminApi.getAnalyticsSummary({ days: 30 }),
        adminApi.getAnalyticsEvents({ limit: 100 }), // Fetch more events to get a good top concern
      ]);

      const normalizedSum = normalizeSummary(summaryData);
      const eventList = pickArray(eventsData);
      const aggs = buildAggregates(eventList);
      
      setSummary(normalizedSum);
      setAggregates(aggs);

    } catch (e) {
      setError(e.message || "An error occurred while fetching analytics.");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);
  
  const topConcernLabel = aggregates.topConcerns.length > 0
    ? titleCase(aggregates.topConcerns[0].label)
    : "N/A";
  
  if (loading) {
    return (
      <Page>
        <div className={styles.spinnerContainer}>
          <Spinner accessibilityLabel="Loading analytics" />
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg" className={styles.pageTitle}>Analytics</Text>
        <Text as="p" tone="subdued">See what your customers are asking for and how Refina is helping them find the perfect product.</Text>

        {error && <Banner tone="critical"><p>{error}</p></Banner>}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm" tone="subdued">Total Queries (30 Days)</Text>
                <p className={styles.metricNumber}>{summary.totals.interactions}</p>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm" tone="subdued">AI-Powered Sessions</Text>
                <p className={styles.metricNumber}>{summary.totals.aiSessions}</p>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm" tone="subdued">Top Customer Concern</Text>
                <p className={styles.metricText}>{topConcernLabel}</p>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
        
        <Card>
          <BlockStack gap="300">
             <Text as="h3" variant="headingMd">Top 5 Concerns</Text>
             {aggregates.topConcerns.length > 0 ? (
               <BlockStack gap="200">
                 {aggregates.topConcerns.map((row) => (
                   <div key={row.label}>
                     <InlineStack align="space-between">
                       <Text>{titleCase(row.label)}</Text>
                       <Text tone="subdued">{row.count} queries</Text>
                     </InlineStack>
                     <Box paddingBlockStart="100">
                       <ProgressBar progress={(row.count / aggregates.topConcerns[0].count) * 100} size="small" />
                     </Box>
                   </div>
                 ))}
               </BlockStack>
             ) : (
               <Text tone="subdued">No concern data yet.</Text>
             )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}