// refina/admin-ui/src/pages/Analytics.jsx
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
} from "@shopify/polaris";
import { adminApi, getShop } from "../api/client.js";

/**
 * Guardrails:
 * - Always use full <shop>.myshopify.com (no short IDs)
 * - Tolerate both old and new Admin API response shapes:
 *   - Summary: sum.totals.*  OR  sum.totalEvents, topProducts, etc.
 *   - Events: ev.items[]  OR  ev.rows[]  OR  bare arrays
 * - No misleading fallbacks: if productClicks is not provided, show 0 (don’t infer).
 */

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

function normalizeSummary(sum) {
  if (!sum || typeof sum !== "object") return { totals: { interactions: 0, productClicks: 0 } };
  // Prefer explicit totals if present
  if (sum.totals && typeof sum.totals === "object") {
    const interactions = Number(sum.totals.interactions ?? sum.totals.queries ?? 0) || 0;
    const productClicks = Number(sum.totals.productClicks ?? sum.totals.clicks ?? 0) || 0;
    return { ...sum, totals: { ...sum.totals, interactions, productClicks } };
  }
  // Back-compat mapping from new overview shape (don’t guess clicks)
  const interactions = Number(sum.totalEvents ?? 0) || 0;
  const productClicks = 0; // do NOT infer from suggestions; avoid flaky fallbacks
  return { ...sum, totals: { interactions, productClicks } };
}

function pickArray(ev) {
  if (!ev) return [];
  if (Array.isArray(ev)) return ev;
  if (Array.isArray(ev.items)) return ev.items;
  if (Array.isArray(ev.rows)) return ev.rows;
  if (Array.isArray(ev.events)) return ev.events;
  return [];
}

function normalizeEvent(e) {
  const id = e.id || e.eventId || e.tsServer || e.createdAt || Math.random().toString(36).slice(2);
  const iso =
    e.tsServerIso ||
    (typeof e.createdAt === "string" ? e.createdAt : null) ||
    (typeof e.tsServer === "number" ? new Date(e.tsServer).toISOString() : null) ||
    null;
  const type = e.type || e.eventType || "event";
  return { ...e, id, tsServerIso: iso, type };
}

export default function Analytics() {
  const shop = toMyshopifyDomain(getShop());

  const [summary, setSummary] = React.useState(null);
  const [events, setEvents] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [cursor, setCursor] = React.useState("");
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setErr("");
        setLoading(true);
        // 30-day window keys (server may ignore; safe to send)
        const to = new Date();
        const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const toKey = to.toISOString().slice(0, 10);
        const fromKey = from.toISOString().slice(0, 10);

        const [sum, ev] = await Promise.all([
          adminApi.getAnalyticsSummary({ shop, from: fromKey, to: toKey }),
          adminApi.getAnalyticsEvents({ shop, limit: 25 }),
        ]);
        if (!on) return;

        setSummary(normalizeSummary(sum));

        const items = pickArray(ev).map(normalizeEvent);
        setEvents(items);

        const next = ev?.nextCursor ?? ev?.cursor ?? "";
        setCursor(typeof next === "string" ? next : "");
      } catch (e) {
        if (on) setErr(e?.message || "Failed to load analytics");
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => {
      on = false;
    };
  }, [shop]);

  async function loadMore() {
    try {
      setLoadingMore(true);
      const ev = await adminApi.getAnalyticsEvents({ shop, limit: 25, cursor });
      const items = pickArray(ev).map(normalizeEvent);
      setEvents((prev) => prev.concat(items));
      const next = ev?.nextCursor ?? ev?.cursor ?? "";
      setCursor(typeof next === "string" ? next : "");
    } catch (e) {
      setErr(e?.message || "Failed to load more events");
    } finally {
      setLoadingMore(false);
    }
  }

  const totals = summary?.totals || { interactions: 0, productClicks: 0 };

  return (
    <Page title="Analytics">
      <Card>
        <BlockStack gap="300">
          {err && <Text tone="critical">{err}</Text>}
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">Last 30 days</Text>
            {loading && <Spinner size="small" />}
          </InlineStack>
          <Divider />
          <InlineStack gap="400" wrap>
            <Card>
              <BlockStack padding="300" gap="050">
                <Text tone="subdued">Interactions</Text>
                <Text variant="headingLg" as="h4">{totals.interactions}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack padding="300" gap="050">
                <Text tone="subdued">Product clicks</Text>
                <Text variant="headingLg" as="h4">{totals.productClicks}</Text>
              </BlockStack>
            </Card>
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300" padding="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">Events</Text>
            {loadingMore && <Spinner size="small" />}
          </InlineStack>
          {events.length === 0 ? (
            <Text tone="subdued">{loading ? "Loading…" : "No events yet"}</Text>
          ) : (
            <BlockStack gap="200">
              {events.map((e) => (
                <InlineStack key={e.id} align="space-between">
                  <Text>{e.type}</Text>
                  <Text tone="subdued">{e.tsServerIso || "—"}</Text>
                </InlineStack>
              ))}
              {cursor && <Button onClick={loadMore}>Load more</Button>}
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
