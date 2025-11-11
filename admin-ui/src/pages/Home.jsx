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
  Tabs, // NEW: Tabs control for Overview ↔ Setup
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { api, adminApi, getShop } from "../api/client.js";
import { useLocation, useNavigate } from "react-router-dom"; // NEW

// ── helpers ──────────────────────────────────────────────────────────────

// Enumerate the tiers you consider paid.
// Keep this in sync with your backend (planSync).
const PAID_LEVELS = ["lite", "pro", "premium", "growth"];

function normalizeLevel(level) {
  const v = String(level || "").toLowerCase().trim();
  if (!v) return "free";

  // Direct known tiers
  if (["free", "lite", "pro", "premium", "growth"].includes(v)) {
    return v;
  }

  // Aliases / legacy labels → map them
  if (v === "plus" || /\bpro\+|\bpro plus\b/.test(v)) {
    return "premium";
  }

  // Fallback: treat unknowns as free (safe default)
  return "free";
}

function labelFromLevel(level) {
  const v = String(level || "").toLowerCase();
  if (v === "premium") return "Premium";
  if (v === "pro") return "Pro";
  if (v === "lite") return "Lite";
  if (v === "growth") return "Growth";
  return "Free";
}

function parsePlanResponse(j) {
  const p = j?.plan || j || {};
  const level = normalizeLevel(p.level || p.name || p.tier);
  return {
    level,
    status: String(p.status || p.state || "unknown"),
    reauthorize: !!j?.reauthorize,
  };
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

// Extract current host param reliably (top-level search OR hash query)
function getCurrentHost() {
  const search = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const hash = new URLSearchParams(hashQ);
  return search.get("host") || hash.get("host") || "";
}

export default function Home() {
  const shop = React.useMemo(() => getShop(), []);
  const host = React.useMemo(() => getCurrentHost(), []);
  const qs = React.useMemo(() => {
    const params = new URLSearchParams();
    if (host) params.set("host", host);
    if (shop) params.set("shop", shop);
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [host, shop]);

  const location = useLocation(); // NEW
  const navigate = useNavigate(); // NEW

  // ── Tabs (URL-driven) ──────────────────────────────────────────────────
  const tabs = React.useMemo(
    () => [
      { id: "overview", content: "Overview" },
      { id: "setup", content: "Setup" },
    ],
    []
  );

  const selectedTab = React.useMemo(() => {
    const path = String(location?.pathname || "/");
    return path.startsWith("/setup") ? 1 : 0;
  }, [location?.pathname]);

  const onTabSelect = React.useCallback(
    (index) => {
      if (index === 0) {
        navigate(`/${qs}`); // Overview → "/"
      } else {
        navigate(`/setup${qs}`); // Setup → "/setup"
      }
    },
    [navigate, qs]
  );

  // ── data state ─────────────────────────────────────────────────────────
  const [err, setErr] = React.useState("");
  const [reauthHint, setReauthHint] = React.useState(false);
  const [plan, setPlan] = React.useState({ level: "free", status: "unknown" });
  const [settings, setSettings] = React.useState(null);
  const [overview, setOverview] = React.useState(null);
  const [indexerApi, setIndexerApi] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  // NEW: live indexer status state
  const [indexer, setIndexer] = React.useState(null);
  const [indexerErr, setIndexerErr] = React.useState("");

  const refreshAnalytics = React.useCallback(async () => {
    try {
      console.log("[Home] Refreshing analytics...");
      const [{ data: over }, { data: ev }] = await Promise.all([
        adminApi.getAnalyticsSummary({ days: 30 }),
        adminApi.getAnalyticsEvents({ limit: 5 }),
      ]);
      setOverview(over || {});
      const items = Array.isArray(ev?.rows)
        ? ev.rows
        : Array.isArray(ev?.logs)
        ? ev.logs
        : Array.isArray(ev)
        ? ev
        : [];
      setLogs(items.slice(0, 5));
      console.log("[Home] Analytics refresh successful.");
    } catch (e) {
      console.warn("Home: refreshAnalytics failed:", e?.message || e);
    }
  }, []);

  // Initial load: plan, settings, overview, logs, indexer snapshot
React.useEffect(() => {
  let on = true;

  (async () => {
    setLoading(true);
    setErr("");

    try {
      console.log("[Home] Fetching initial data...");

      const [
        { data: planData },
        { data: settingsData },
        { data: overviewData },
        { data: logsData },
        { data: idxData },
      ] = await Promise.all([
        api.get(`/api/billing/plan`),
        api.get(`/api/admin/store-settings`),
        adminApi.getAnalyticsSummary({ days: 30 }),
        adminApi.getAnalyticsEvents({ limit: 5 }),
        api.get(
          `/api/indexer/status?shop=${encodeURIComponent(
            shop
          )}&fresh=1`
        ),
      ]);

      console.log("[Home] Fetched Plan:", planData);
      console.log("[Home] Fetched Settings:", settingsData);
      console.log("[Home] Fetched Overview:", overviewData);
      console.log("[Home] Fetched Logs:", logsData);

      if (on) {
        const parsed = parsePlanResponse(planData);
        setPlan(parsed);
        setReauthHint(Boolean(parsed.reauthorize)); // show soft hint if backend indicates reauth is needed
        setSettings(settingsData?.settings || {});
        setOverview(overviewData || {});

        const items = Array.isArray(logsData?.rows)
          ? logsData.rows
          : Array.isArray(logsData?.logs)
          ? logsData.logs
          : Array.isArray(logsData)
          ? logsData
          : [];
        setLogs(items.slice(0, 5));

        setIndexerApi(idxData?.indexer || null);
      }

      console.log("[Home] Initial data load successful.");
    } catch (e) {
      console.error("[Home] Initial data load failed:", e);
      if (on) {
        setErr(
          `Failed to load dashboard: ${
            e?.message || "Unknown error"
          }`
        );
      }
    } finally {
      if (on) setLoading(false);
    }
  })();

  window.addEventListener("rf:analytics:ingested", refreshAnalytics);

  return () => {
    on = false;
    window.removeEventListener(
      "rf:analytics:ingested",
      refreshAnalytics
    );
  };
}, [shop, refreshAnalytics]);

// -------- Derived values --------

const level = normalizeLevel(plan?.level);
const levelLabel = labelFromLevel(level);

// Treat Pro/Premium with active/trial-like status as "has a plan".
// Everything else (incl. none/free/unknown) counts as "no active plan" → eligible for Welcome.
const hasActivePlan = React.useMemo(() => {
  const lvl = normalizeLevel(plan?.level);
  const status = String(plan?.status || "").toLowerCase();

  const isPaid = PAID_LEVELS.includes(lvl);
  const isActiveLike =
    status === "active" ||
    status === "trialing" ||
    status === "current";

  return isPaid && isActiveLike;
}, [plan]);

// If there is no active plan yet and we're on "/", send the merchant to the Welcome page.
// Runs after initial load so we don't fight OAuth, deep links, or return_to.
React.useEffect(() => {
  if (loading) return;

  const path = String(location?.pathname || "/");

  // If no plan yet: always start in Mission Control (/welcome)
  if (path === "/" && !hasActivePlan) {
    console.log("[Home] No active plan; redirecting to /welcome");
    navigate(`/welcome${qs}`, { replace: true });
    return;
  }

  // If plan is active but setup isn't complete yet:
  // Prefer Mission Control so they see the checklist.
  if (path === "/" && hasActivePlan && !isSetupComplete) {
    console.log("[Home] Plan active but setup incomplete; redirecting to /welcome");
    navigate(`/welcome${qs}`, { replace: true });
    return;
  }

  // If plan active AND setup complete:
  // Stay on "/", this is their true dashboard.
}, [loading, hasActivePlan, isSetupComplete, location?.pathname, navigate, qs]);

// -------- Live indexer status loader + light polling (stops at complete) --------

React.useEffect(() => {
  let timer = null;
  let cancelled = false;

  async function fetchStatusOnce() {
    if (!shop) return;
    try {
      const { data } = await api.get(
        `/api/indexer/status?shop=${encodeURIComponent(
          shop
        )}&fresh=1`
      );
      // Expected shape: { ok, shop, indexer: { phase, totalProducts, importedCount, embeddedCount, pct, updatedAt } }
      if (!cancelled) {
        setIndexer(data?.indexer ?? null);
        setIndexerErr("");
      }
      // Stop polling when complete (or explicit pct >= 100)
      const phase = String(
        data?.indexer?.phase || ""
      ).toLowerCase();
      const pct = Number(data?.indexer?.pct ?? 0);
      const done =
        phase === "complete" || pct >= 100;
      // If not done, schedule another read
      if (!done && !cancelled) {
        timer = setTimeout(fetchStatusOnce, 8000);
      }
    } catch (e) {
      if (!cancelled) {
        setIndexerErr(e?.message || "status_failed");
        // Back off a little and try again
        timer = setTimeout(fetchStatusOnce, 12000);
      }
    }
  }

  fetchStatusOnce();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}, [shop]);

  const badgeTone = level === "premium" ? "success" : level === "pro" ? "attention" : "subdued";

  const totals = overview?.totals || overview || {};
  const interactions = Number(totals.interactions ?? totals.events ?? totals.queries ?? 0) || 0;
  const productClicks = Number(totals.productClicks ?? totals.clicks ?? 0);

  const usage = overview?.usage || {};
  const used = Number(usage.used ?? 0);
  const limit =
    usage.limit ?? (level === "free" ? 0 : level === "pro" ? 1000 : level === "premium" ? 10000 : 0);
  const ctr = interactions ? (100 * productClicks) / interactions : 0;

  const hasTone = Boolean(settings?.aiTone);
  const hasCategory = Boolean(settings?.category);
  const checklistDone = [hasTone, hasCategory].filter(Boolean).length;
  const isSetupComplete = checklistDone === 2; // minimal, Home-visible completion signal
  // High-level state flags for Home behavior
  const isNewlyActivated = hasActivePlan && !isSetupComplete;
  const isLive = hasActivePlan && isSetupComplete;


  // ── Knowledge/indexer: prefer live status; fall back to legacy shapes (settings/overview) ──
const liveOrLegacy = (
  indexer ??
  (
    (settings && (settings.indexer || settings.indexerStatus)) ||
    (overview && (overview.indexer || overview.indexerStatus)) ||
    null
  )
);

const indexerPhaseRaw = liveOrLegacy?.phase || liveOrLegacy?.status || "";
const indexerPhase = String(indexerPhaseRaw || "").toLowerCase().replace(/\s+/g, "_");

const totalProducts = Number(liveOrLegacy?.totalProducts ?? liveOrLegacy?.total ?? 0) || 0;
const importedCount = Number(liveOrLegacy?.importedCount ?? liveOrLegacy?.imported ?? 0) || 0;
const embeddedCount = Number(liveOrLegacy?.embeddedCount ?? liveOrLegacy?.embedded ?? 0) || 0;
const updatedAtIso = liveOrLegacy?.updatedAt || liveOrLegacy?.updated || liveOrLegacy?.ts || "";

const knowledgeHasCounts = totalProducts > 0 && (importedCount > 0 || embeddedCount > 0);
const coarsePctByPhase = {
  queued: 5, importing: 10, indexing: 40, embedding: 80, building_kb: 90, complete: 100, error: 0,
};
const pctFromDoc = Number(liveOrLegacy?.pct ?? 0);

const knowledgePct = knowledgeHasCounts
  ? pct(embeddedCount || importedCount, totalProducts)
  : (pctFromDoc ? Math.max(0, Math.min(100, pctFromDoc)) : (coarsePctByPhase[indexerPhase] ?? 0));


  if (loading) {
    return (
      <Box padding="400">
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="p">Loading dashboard...</Text>
        </InlineStack>
      </Box>
    );
  }

  return (
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      {/* Tabs — selected index is derived from the current pathname.
          Changing tab navigates to the target route, not an in-page toggle. */}
      <Box paddingBlockEnd="300">
        <Tabs tabs={tabs} selected={selectedTab} onSelect={onTabSelect} />
      </Box>

      {/* Setup callout — flips to a read-only success state when both quick settings are done */}
      <Box paddingBlockEnd="400">
  <Card>
    <Box padding="400">
      <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">
            {isLive
              ? "Setup complete — you're live with Refina"
              : isNewlyActivated
              ? "Refina activated — you're almost ready"
              : "Finish setup"}
          </Text>
          <Text as="p" tone="subdued">
            {isLive
              ? "Refina is now answering your customer queries using your store's enriched knowledge base."
              : "Complete 3 quick steps: enable the app embed, choose your category, and verify the launcher is visible."}
          </Text>
        </BlockStack>
        <Button
          variant="primary"
          onClick={() => navigate(`/setup${qs}`)}
          disabled={isLive}
        >
          {isLive ? "Setup complete ✓" : "Go to setup"}
        </Button>
      </InlineStack>
    </Box>
  </Card>
</Box>


      {/* Existing Home content remains the Overview tab’s content */}
      <Card>
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
            {!hasActivePlan
              ? "Welcome to Refina"
              : isNewlyActivated
              ? "Refina is activated — finish setup to go live"
              : "Refina overview"}
            </Text>

            <InlineStack gap="200" blockAlign="center">
              <Tooltip content={levelLabel}>
                <Badge tone={badgeTone}>{levelLabel}</Badge>
              </Tooltip>
              {plan?.status && <Badge tone="subdued">{String(plan.status).toUpperCase()}</Badge>}
              <Button url={`#/billing${qs}`}>Manage billing</Button>
            </InlineStack>
          </InlineStack>
        </Box>
        <Divider />
        <Box padding="400">
          <InlineStack gap="300">
            <Button variant="primary" url={`#/analytics${qs}`}>
              View analytics
            </Button>
            <Button url={`#/settings${qs}`}>Settings</Button>
            <Button url={`#/billing${qs}`}>Billing</Button>
          </InlineStack>
        </Box>
      </Card>

      {/* ───────────────── Plan + Usage Banners ───────────────── */}
      <Box paddingBlockStart="400">
        {/* FREE → Upsell to Pro */}
        {level === "free" && (
          <Banner
            tone="info"
            title="Turn on AI answers with Pro — 2,000 AI requests/mo. 7-day free trial."
            action={{ content: "Upgrade to Pro", url: `#/billing${qs}` }}
          >
            <p>Unlock AI recommendations, analytics, and styling controls with Pro. No changes to your storefront theme required.</p>
          </Banner>
        )}

        {/* PRO → Usage near cap */}
        {level === "pro" && limit > 0 && pct(used, limit) >= 85 && (
          <Banner
            tone="warning"
            title={`You're at ${Math.round(pct(used, limit))}% of your monthly AI allowance`}
            action={{ content: "Manage billing", url: `#/billing${qs}` }}
          >
            <p>{`${fmt(used)} of ${fmt(limit)} AI requests used this month. Consider upgrading to Premium for higher limits.`}</p>
          </Banner>
        )}

        {/* PRO → Light heads-up when not near cap */}
        {level === "pro" && limit > 0 && pct(used, limit) < 85 && (
          <Banner
            tone="info"
            title="Pro plan active — AI answers enabled"
            action={{ content: "Manage billing", url: `#/billing${qs}` }}
          >
            <p>{`${fmt(used)} of ${fmt(limit)} AI requests used this month. Premium unlocks higher limits and advanced analytics.`}</p>
          </Banner>
        )}

        {/* PREMIUM → simple confirmation */}
        {level === "premium" && (
          <Banner tone="success" title="Premium active — higher limits & advanced analytics">
            <p>You’re getting the highest-quality AI responses and higher monthly token limits.</p>
          </Banner>
        )}
      </Box>

      {reauthHint && (
        <Box paddingBlockStart="400">
          <Banner
            tone="info"
            title="Billing needs a quick re-check"
            action={{ content: "Open Billing", url: `#/billing${qs}` }}
            onDismiss={() => setReauthHint(false)}
          >
            <p>
              We’re showing your cached plan. To refresh from Shopify, open Billing (we’ll re-authorize
              if needed).
            </p>
          </Banner>
        </Box>
      )}

      {err && (
        <Box paddingBlockStart="400">
          <Banner tone="critical" title="Something went wrong" onDismiss={() => setErr("")}>
            <p>{err}</p>
          </Banner>
        </Box>
      )}

      {/* ───────────────── Knowledge / Indexer Status (live, minimal) ───────────────── */}
      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">Product Knowledge Build</Text>
                <Badge
                  tone={
                    (indexer?.phase === "complete") ? "success"
                    : (indexer?.phase === "error") ? "critical"
                    : (indexer ? "attention" : "subdued")
                  }
                >
                  {indexer?.phase ? indexer.phase.replace(/_/g, " ") : "preparing"}
                </Badge>
              </InlineStack>

              <BlockStack gap="150">
                {indexerErr ? (
                  <Text as="span" tone="critical">{indexerErr}</Text>
                ) : (
                  <>
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" tone="subdued">Progress</Text>
                      <Text as="span" tone="subdued">
                        {(() => {
                          const t = Number(indexer?.totalProducts || 0);
                          const d = Number(indexer?.embeddedCount || indexer?.importedCount || 0);
                          if (t > 0) return `${d.toLocaleString()} of ${t.toLocaleString()}`;
                          const coarse = {
                            queued: 5, importing: 10, indexing: 40,
                            embedding: 80, building_kb: 90, complete: 100, error: 0,
                          };
                          const ph = (indexer?.phase || "").toLowerCase();
                          const p = coarse[ph] ?? 0;
                          return `${Math.round(p)}%`;
                        })()}
                      </Text>
                    </InlineStack>

                    {(() => {
                      const t = Number(indexer?.totalProducts || 0);
                      const d = Number(indexer?.embeddedCount || indexer?.importedCount || 0);
                      const coarse = {
                        queued: 5, importing: 10, indexing: 40,
                        embedding: 80, building_kb: 90, complete: 100, error: 0,
                      };
                      const ph = (indexer?.phase || "").toLowerCase();
                      const p = t > 0 ? pct(d, t) : (coarse[ph] ?? 0);
                      return <ProgressBar progress={Number.isFinite(p) ? p : 0} size="small" />;
                    })()}

                    <Text as="span" tone="subdued">
                      {indexer?.updatedAt
                        ? `Last update ${new Date(indexer.updatedAt).toLocaleString()}`
                        : "Waiting for status from the indexer…"}
                    </Text>

                    {!indexer && !indexerErr && (
                      <Text as="span" tone="subdued">
                        Tip: If you’ve just installed Refina, the importer and indexer start automatically. You can continue setting up — this will reach “complete” when embeddings are ready.
                      </Text>
                    )}
                  </>
                )}
              </BlockStack>
            </BlockStack>
          </Box>
        </Card>
      </Box>

     {isLive && (
      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Your month at a glance
                </Text>
                <Text as="span" tone="subdued" variant="bodySm">
                  Last 30 days
                </Text>
              </InlineStack>
              <BlockStack gap="150">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" tone="subdued">
                    Smart queries
                  </Text>
                  <Text as="span" tone="subdued">
                    {level === "free" ? "Locked on Free" : `${fmt(used)} / ${fmt(limit)}`}
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
              <InlineStack gap="400" wrap>
                <Box minWidth="220px" maxWidth="340px" width="100%">
                  <Card>
                    <Box padding="300">
                      <BlockStack gap="050">
                        <Text as="span" tone="subdued" variant="bodySm">
                          Customer interactions
                        </Text>
                        <Text as="h4" variant="headingLg">
                          {fmt(interactions)}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </Box>
                <Box minWidth="220px" maxWidth="340px" width="100%">
                  <Card>
                    <Box padding="300">
                      <BlockStack gap="050">
                        <Text as="span" tone="subdued" variant="bodySm">
                          Product clicks
                        </Text>
                        <Text as="h4" variant="headingLg">
                          {fmt(productClicks)}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </Box>
                <Box minWidth="220px" maxWidth="340px" width="100%">
                  <Card>
                    <Box padding="300">
                      <BlockStack gap="050">
                        <Text as="span" tone="subdued" variant="bodySm">
                          CTR
                        </Text>
                        <Text as="h4" variant="headingLg">
                          {`${ctr ? ctr.toFixed(1) : "0.0"}%`}
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
      )}

      <Box paddingBlockStart="400">
        <Card>
          <Box padding="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Unlock more with your plan
                </Text>
                <Text as="p" tone="subdued">
                  {level === "free"
                    ? "Pro unlocks AI recommendations, analytics, and styling controls."
                    : level === "pro"
                    ? "Premium unlocks higher limits and advanced analytics."
                    : "You’re on Premium — Need more? Talk to us about Enterprise plans with higher usage limits, larger catalogs, and dedicated support."}
                </Text>
              </BlockStack>
              {level === "premium" ? (
                <Badge tone="success">Premium</Badge>
              ) : (
                <Button variant="primary" url={`#/billing${qs}`}>
                  {level === "free" ? "Upgrade to Pro" : "Upgrade to Premium"}
                </Button>
              )}
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
                    <Text as="h3" variant="headingSm">
                      Recommended next steps
                    </Text>
                    <Badge tone={checklistDone === 2 ? "success" : "attention"}>
                      {checklistDone}/2
                    </Badge>
                  </InlineStack>
                  <InlineStack align="space-between" gap="150" blockAlign="center">
  <Text as="span">
    Set your <strong>tone</strong> in{" "}
    <a href={`#/settings${qs}`}>Settings</a>
  </Text>
  <Icon
    source={CheckIcon}
    tone={hasTone ? "success" : "subdued"}
  />
</InlineStack>
                  <InlineStack align="space-between" gap="150" blockAlign="center">
  <Text as="span">
    Choose your <strong>category</strong> in{" "}
    <a href={`#/settings${qs}`}>Settings</a>
  </Text>
  <Icon
    source={CheckIcon}
    tone={hasCategory ? "success" : "subdued"}
  />
</InlineStack>
                </BlockStack>
              </Box>
            </Card>
          </Box>

{isLive && (
          <Box minWidth="320px" maxWidth="520px" width="100%">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Recent activity
                  </Text>
                  {logs.length ? (
                    <BlockStack gap="200">
                      {logs.map((row, i) => {
                        const concern = row?.concern || row?.query || "Customer asked…";
                        const productTitle = row?.topProduct?.title || "";
                        const when = row?.createdAt || row?.ts || "";
                        return (
                          <Box
                            key={i}
                            paddingBlock="150"
                            borderBlockEndWidth={i < logs.length - 1 ? "025" : "0"}
                          >
                            <Text as="p">
                              <strong>{concern}</strong>
                            </Text>
                            <Text as="p" tone="subdued">
                              {productTitle ? `→ ${productTitle}` : " "}
                              {when ? ` • ${new Date(when).toLocaleString()}` : ""}
                            </Text>
                          </Box>
                        );
                      })}
                      <Button url={`#/analytics${qs}`} plain>
                        See full log
                      </Button>
                    </BlockStack>
                  ) : (
                    <Text tone="subdued">No activity yet — check back after some traffic.</Text>
                  )}
                </BlockStack>
              </Box>
            </Card>
          </Box>
          )}
        </InlineStack>
      </Box>
    </Box>
  );
}
