// admin-ui/src/pages/Analytics.jsx

import React, { useEffect, useState } from "react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Spinner, Banner, DataTable } from "@shopify/polaris";
import { adminApi } from "../api/client.js";
import styles from "./Analytics.module.css";

export default function Analytics() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState({ totalQueries: 0, aiSessions: 0, topConcern: "N/A" });
  const [recentEvents, setRecentEvents] = useState([]);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError("");
        
        // Fetch both summary and recent logs in parallel
        const [summaryData, eventsData] = await Promise.all([
          adminApi.getAnalyticsSummary({ days: 30 }),
          adminApi.getAnalyticsEvents({ limit: 20 })
        ]);

        // Process summary data for the metric cards
        const totals = summaryData?.totals || {};
        const topConcern = summaryData?.rows?.[0]?.concern || "N/A";
        setSummary({
          totalQueries: totals.events || 0,
          aiSessions: totals.aiEvents || 0,
          topConcern: topConcern,
        });

        // Process recent events for the log table
        setRecentEvents(eventsData?.rows || []);

      } catch (e) {
        setError(e.message || "An unknown error occurred while fetching analytics.");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const recentEventsRows = recentEvents.map(event => [
    new Date(event.ts).toLocaleString(),
    event.concern,
    event.plan,
    event.meta?.source || 'N/A'
  ]);

  const pageContent = loading ? (
    <Spinner accessibilityLabel="Loading analytics" size="large" />
  ) : (
    <BlockStack gap="400">
      {error && <Banner tone="critical"><p>{error}</p></Banner>}
      
      <Layout>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm" tone="subdued">Total Queries (30 Days)</Text>
              <p className={styles.metricNumber}>{summary.totalQueries}</p>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm" tone="subdued">AI-Powered Sessions</Text>
              <p className={styles.metricNumber}>{summary.aiSessions}</p>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm" tone="subdued">Top Customer Concern</Text>
              <p className={styles.metricText}>{summary.topConcern}</p>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Recent Activity</Text>
          <DataTable
            columnContentTypes={['text', 'text', 'text', 'text']}
            headings={['Timestamp', 'Concern', 'Plan', 'Source']}
            rows={recentEventsRows}
          />
        </BlockStack>
      </Card>
    </BlockStack>
  );

  return (
    <Page>
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg" className={styles.pageTitle}>Analytics</Text>
        <Text as="p" tone="subdued">See what your customers are asking for and how Refina is helping them find the perfect product.</Text>
        {pageContent}
      </BlockStack>
    </Page>
  );
}