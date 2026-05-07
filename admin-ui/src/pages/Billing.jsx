// admin-ui/src/pages/Billing.jsx
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
  Spinner,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";

import { api, billingApi, buildEmbeddedUrl } from "../api/client.js";
import app from "../appBridge";
import { Redirect } from "@shopify/app-bridge/actions";

import { useEffect, useMemo, useState } from "react";

import AppNav from "../components/AppNav";


const PENDING_KEY = "refina:billing:pending";

// ── Plan meta (EDIT here to change prices/blurbs) ────────────────────────
const PLAN_DETAILS = {
  lite: {
    label: "Lite",
    priceMonthly: "$9/mo",
    priceAnnualNote: "",
    tooltip: "Refina guides your shoppers. You see the add-to-carts.",
    ribbon: "Great Value",
    features: [
      "Full AI recommendations with clear reasons why",
      "Basic analytics dashboard",
      "30-day free trial — with full app features",
      "300 shopper questions/month (repeat questions not counted)",
      "Perfect for stores with up to ~15,000 monthly sessions",
    ],
  },

    growth: {
    label: "Growth",
    priceMonthly: "$19/mo",
    priceAnnualNote: "",
    tooltip: "See exactly what your shoppers are asking for.",
    ribbon: "Most popular",
    features: [
      "Full AI recommendations with clear reasons why",
      "Advanced analytics — see every question your shoppers ask",
      "30-day free trial — full app features",
      "Up to 1,000 shopper questions/month (repeat questions not counted)",
      "Designed for stores with up to ~60,000 monthly sessions",
    ],
  },

  pro: {
    label: "Pro",
    priceMonthly: "$49/mo",
    priceAnnualNote: "",
    tooltip: "Refina runs all day. No limits.",
    ribbon: "High traffic stores",
    features: [
      "Unlimited shopper questions",
      "Full AI recommendations with clear reasons why",
      "Advanced analytics + conversation history",
      "30-day free trial — full app features",
      "For stores with over ~60,000 monthly sessions",
    ],
  },

  premium: {
    label: "Premium",
    priceMonthly: "$79/mo",
    priceAnnualNote: "or $790/yr",
    tooltip: "Premium — Advanced AI quality • full styling • deep analytics • priority support",
    ribbon: "Best value",
    features: [
      "Advanced AI reasoning & quality",
      "Full styling & placements",
      "Priority support + deep analytics",
      "Up to 10,000 AI queries/month",
    ],
  },
};

// ── helpers ──────────────────────────────────────────────────────────────
function normalizeLevel(level) {
  const v = String(level || "").toLowerCase().trim();
  if (v === "lite") return "lite";
  if (v === "growth") return "growth";
  if (v === "pro") return "pro";
  if (v === "premium" || v === "pro+") return "premium";
  if (v === "plus") return "premium"; // alias legacy "plus" to premium
  return "free";
}
function labelFromLevel(level) {
  const v = normalizeLevel(level);
  if (v === "lite") return "Lite";
  if (v === "growth") return "Growth";
  if (v === "pro") return "Pro";
  if (v === "premium") return "Premium";
  return v === "free" ? "Free" : v;
}
function parsePlanResponse(jsonResponse) {
  const p = jsonResponse?.plan || jsonResponse || {};
  return {
    level: normalizeLevel(p.level),
    status: (p.status || p.state || "unknown").toString(),
    billingInterval: (p.billingInterval || p.interval || "").toString().toLowerCase(),
  };
}

// Extract Shopify reauth headers (Axios lowercases keys) + fallback when headers are missing
function getReauthInfo(err) {
  const h = err?.response?.headers || {};
  const needHdr = String(h["x-shopify-api-request-failure-reauthorize"] || "").trim() === "1";
  const urlHdr = h["x-shopify-api-request-failure-reauthorize-url"] || "";

  if (needHdr) return { need: true, url: urlHdr };

  // Fallback: plain Error from our api() wrapper (no headers).
  // If the message suggests 401/403 or an auth/session issue, synthesize a safe /api/auth URL.
  const msg = String(err?.message || "").toLowerCase();
  const looksUnauthorized = /\b(401|403)\b/.test(msg) || /reauthoriz|unauth|forbid|token|session/.test(msg);

  if (looksUnauthorized) {
    // buildEmbeddedUrl adds host/shop automatically from persisted context
    const to = buildEmbeddedUrl("/api/auth");
    return { need: true, url: to };
    }

  return { need: false, url: "" };
}

function redirectTop(urlOrPath = "/", extra = {}) {
  const url = buildEmbeddedUrl(urlOrPath, extra);
  try {
    const redirect = Redirect.create(app);
    redirect.dispatch(Redirect.Action.REMOTE, url);
  } catch {
    try { window.top.location.href = url; } catch { window.location.href = url; }
  }
}

export default function Billing() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [plan, setPlan] = React.useState(null); // { level, status }
  const [error, setError] = React.useState("");
  const [toast, setToast] = React.useState("");
  const [syncing, setSyncing] = React.useState(false);
  const [reauthUrl, setReauthUrl] = React.useState(""); // show reauth banner when present
  const pollRef = React.useRef(null);
  const timeoutRef = React.useRef(null);

  // Lite cap gating (fetch from existing indexer status API)
const [catalogSize, setCatalogSize] = useState(null);     // number | null
const [catalogLoading, setCatalogLoading] = useState(false);
const [catalogError, setCatalogError] = useState("");

const LITE_CAP = Infinity;
const GROWTH_CAP = Infinity;

// On mount, fetch catalog size from indexer status (same endpoint used in Setup.jsx)
useEffect(() => {
  let on = true;
  (async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      // fresh=1 mirrors the Setup.jsx polling style
      const { data } = await api.get(`/api/indexer/status?fresh=1`);
      const total = Number(data?.indexer?.totalProducts ?? 0);
      if (on) setCatalogSize(Number.isFinite(total) ? total : 0);
    } catch (e) {
      if (on) setCatalogError(e?.message || "Failed to check catalog size");
    } finally {
      if (on) setCatalogLoading(false);
    }
  })();
  return () => { on = false; };
}, []);

// Decide if Lite should be disabled
const liteOverCap = useMemo(() => {
  return typeof catalogSize === "number" && catalogSize > LITE_CAP;
}, [catalogSize]);

const growthOverCap = useMemo(() => {
  return typeof catalogSize === "number" && catalogSize > GROWTH_CAP;
}, [catalogSize]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  const loadPlan = React.useCallback(async () => {
    setError("");
    setReauthUrl("");
    setLoading(true);
    try {
      // ✅ Read Firestore-backed plan (no fresh) — avoids 401 loops on cold sessions
      const { data } = await billingApi.getPlan();
      setPlan(parsePlanResponse(data));
    } catch (e) {
      console.error("[Billing] GET /api/billing/plan failed:", e);
      const { need, url } = getReauthInfo(e);
      if (need && url) {
        setReauthUrl(url);
      } else {
        setError("Failed to load current plan.");
        setPlan(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Manual sync from Shopify (triggers offline session read; may reauth)
  async function syncFromShopify() {
    setError("");
    setReauthUrl("");
    setBusy(true);
    try {
      await api.post("/api/billing/sync", {}); // backend writes plans/{shop}
      await loadPlan();
      showToast("Plan synced from Shopify");
    } catch (e) {
      console.error("[Billing] POST /api/billing/sync failed:", e);
      const { need, url } = getReauthInfo(e);
      if (need && url) {
        setReauthUrl(url);
      } else {
        setError("Could not sync plan from Shopify.");
      }
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    loadPlan();

    // If we just returned from the Shopify confirmation page
    const u = new URL(window.location.href);
    if (u.searchParams.get("billing") === "success") {
      try { localStorage.removeItem(PENDING_KEY); } catch {}
      showToast("Plan updated 🎉");
      u.searchParams.delete("billing");
      window.history.replaceState({}, "", u.toString());
      // Ask Shopify for latest (explicit sync)
      syncFromShopify();
    }

    const onVis = () => { if (document.visibilityState === "visible") loadPlan(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadPlan]);

  // Poll while waiting for Shopify confirmation if user is coming back (POLL REMOVED)
// We only do a one-time check: if the plan already matches the pending target, finish up.
// No setInterval / setTimeout — avoids refresh loops.
React.useEffect(() => {
  const wantRaw = localStorage.getItem(PENDING_KEY);
  if (!wantRaw) return;

  const want = normalizeLevel(wantRaw);
  const have = plan ? normalizeLevel(plan.level) : null;

  if (have && have === want) {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    setSyncing(false);
    showToast(`Plan updated to ${labelFromLevel(have)} 🎉`);
    syncFromShopify(); // one-time explicit sync to persist to Firestore
  }
}, [plan]); 


  React.useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

async function subscribe(which /* "premium" | "pro" | "growth" | "lite" */, interval /* "monthly" | "annual" */) {
  try {
    setBusy(true);
    setError("");
    setReauthUrl("");

    // Normalize inputs
    const plan = String(which || "").toLowerCase();
    const safeInterval = interval === "annual" ? "annual" : "monthly";

    // Lite + Growth + Pro → unified subscribe endpoint (plan-based)
    if (plan === "lite" || plan === "growth" || plan === "pro") {
      const resp = await api.post("/api/billing/subscribe", {
        plan,           // "lite" | "growth" | "pro"
        interval: safeInterval, // backend can ignore or use
      });

      const json = resp?.data || {};
      const url =
        json?.confirmationUrl ||
        json?.url ||
        json?.confirmation_url ||
        json?.redirectUrl;

      if (!url) throw new Error("No confirmation URL returned");

      try {
        localStorage.setItem(PENDING_KEY, plan);
      } catch {}

      redirectTop(url);
      return;
    }

    // Premium (existing protocol) → use /api/billing/upgrade with body
    const sep = window.location.href.includes("?") ? "&" : "?";
    const returnUrl = `${window.location.href}${sep}billing=success`;

    const { data: json } = await billingApi.upgrade({
      returnUrl,
      interval: safeInterval,
    });

    const url =
      json?.confirmationUrl ||
      json?.url ||
      json?.confirmation_url ||
      json?.redirectUrl;

    if (!url) throw new Error("No confirmation URL returned");

    try {
      // fall back to original "which" if plan was empty
      localStorage.setItem(PENDING_KEY, plan || which);
    } catch {}

    redirectTop(url);
  } catch (e) {
    console.error("[Billing] Subscribe/Upgrade failed:", e);
    const { need, url } = getReauthInfo(e);
    if (need && url) {
      setReauthUrl(url);
    } else {
      setError(e?.message || "Upgrade failed");
    }
  } finally {
    setBusy(false);
  }
}


  async function downgrade() {
    try {
      setBusy(true); setError(""); setReauthUrl("");
      const { data } = await api.post("/api/billing/downgrade", {});
      if (!data?.ok && !data?.canceled) throw new Error(data?.error || "Downgrade failed");
      await syncFromShopify();
      showToast("Downgrade complete. You are now on the Free plan.");
    } catch (e) {
      console.error("[Billing] Downgrade failed:", e);
      const { need, url } = getReauthInfo(e);
      if (need && url) {
        setReauthUrl(url);
      } else {
        setError(e?.message || "Downgrade failed");
      }
    } finally {
      setBusy(false);
    }
  }

  const currentLevel = plan ? normalizeLevel(plan.level) : null;
const currentInterval = (plan?.billingInterval || "").toLowerCase();
const currentLabel = currentLevel ? labelFromLevel(currentLevel) : "";
const currentStatus = plan?.status ? String(plan.status).toUpperCase() : "";

const isLite = currentLevel === "lite";
const isGrowth = currentLevel === "growth";
const isPro = currentLevel === "pro";
const isPremium = currentLevel === "premium";
const isPlus = currentLevel === "plus";

const isPaid = isLite || isGrowth || isPro || isPremium || isPlus;

// pick meta for current plan if available (for tooltip/badge)
const currentMeta = PLAN_DETAILS[currentLevel] || null;
const premiumMeta = PLAN_DETAILS.premium;


  if (loading) {
    return (
      <Box padding="400">
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="p">Loading billing details...</Text>
        </InlineStack>
      </Box>
    );
  }

  function PlanTile({ id, meta, current, onChoose, allowAnnual = true }) {
  const isLite = id === "lite";
  const isGrowth = id === "growth";
  const isCapPlan = isLite || isGrowth;

  const [capErr, setCapErr] = useState("");

  async function handleChoose(interval) {
    if (!onChoose) return;

    if (isCapPlan) {
      setCapErr("");
      const cap = isLite ? LITE_CAP : GROWTH_CAP;
      const label = isLite ? "Lite" : "Growth";

      try {
        const ts = Date.now();
        const { data } = await api.get(`/api/indexer/status?fresh=1&ts=${ts}`);
        const total = Number(data?.indexer?.totalProducts ?? 0);

        if (total > cap) {
          setCapErr(
            `${label} is limited to ${cap.toLocaleString()} products. Your catalog has ${total.toLocaleString()}. Please choose a higher plan.`
          );
          return;
        }
      } catch (e) {
        setCapErr("Could not verify catalog size. Please try again.");
        return;
      }
    }

    onChoose(id, interval);
  }

  const isCurrent = current === id;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Tooltip content={meta.tooltip}>
              <Text as="h3" variant="headingLg">{meta.label}</Text>
            </Tooltip>
            {isCurrent && <Badge tone="success">Current</Badge>}
            {!isCurrent && meta.ribbon && <Badge tone="attention">{meta.ribbon}</Badge>}
          </InlineStack>
          <BlockStack gap="050" align="end">
            <Text as="span" variant="headingLg">{meta.priceMonthly}</Text>
            {meta.priceAnnualNote && allowAnnual && (
              <Text as="span" tone="subdued" variant="bodySm">
                {meta.priceAnnualNote}
              </Text>
            )}
          </BlockStack>
        </InlineStack>

        <BlockStack gap="150">
          {meta.features.map((f, i) => (
            <InlineStack key={i} gap="150" blockAlign="center">
              <Icon source={CheckIcon} tone="success" />
              <Text as="span" tone="subdued">{f}</Text>
            </InlineStack>
          ))}
        </BlockStack>

        <Divider />

        <InlineStack gap="200" align="start">
          <Button
  variant="primary"
  disabled={Boolean(isCurrent || !onChoose)}
  onClick={() => handleChoose("monthly")}
>
  {isCurrent && currentInterval === "monthly"
    ? `Current (Monthly)`
    : `Choose Monthly`}
</Button>

          {allowAnnual && (
  <Button
    disabled={Boolean(isCurrent || !onChoose)}
    onClick={() => handleChoose("annual")}
  >
    {isCurrent && currentInterval === "annual"
      ? `Current (Annual)`
      : `Choose Annual`}
  </Button>
)}
        </InlineStack>
        {isCapPlan && capErr && (
  <div style={{ marginTop: 8 }}>
    <Text tone="critical" as="p">{capErr}</Text>
  </div>
)}
      </BlockStack>
    </Card>
  );
}

  return (
    <>
    <AppNav />
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      {reauthUrl && (
        <Box paddingBlockEnd="400">
          <Banner
            tone="info"
            title="Please re-authorize to manage billing"
            action={{ content: "Re-authorize", onAction: () => redirectTop(reauthUrl) }}
            onDismiss={() => setReauthUrl("")}
          >
            <p>Shopify asked us to refresh your app session before continuing.</p>
          </Banner>
        </Box>
      )}

      {error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" title="Billing error" onDismiss={() => setError("")}>
            <p>{error}</p>
          </Banner>
        </Box>
      )}

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Billing</Text>
            <Tooltip content={currentMeta?.tooltip || ""}>
        <Badge tone={isPaid ? "success" : "subdued"}>
        {isPaid ? currentLabel : "None"}
        {isPaid && currentInterval && (
          <> · {currentInterval === "annual" ? "Annual" : "Monthly"}</>
        )}
        {isPaid && currentStatus && <>&nbsp;{currentStatus}</>}
      </Badge>
      </Tooltip>

          </InlineStack>

          <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {isPaid
              ? `You’re on the ${currentLabel} plan`
              : "You haven’t selected a plan yet"}
          </Text>

          <Text as="p" tone="subdued">
            {isPaid
              ? "Your billing status is active. You can change, downgrade, or cancel anytime."
              : "Choose a plan. After approving a charge, click “Refresh” or wait a moment for confirmation."}
          </Text>
        </BlockStack>

        <InlineStack gap="200">
          <Button onClick={loadPlan} disabled={busy}>
            Refresh
          </Button>
        </InlineStack>
      </InlineStack>

          {/* Catalog-size precheck (non-blocking) */}
{catalogLoading ? (
  <InlineStack align="start" blockAlign="center" gap="200">
    <Spinner size="small" />
    <Text tone="subdued">Checking your catalog size…</Text>
  </InlineStack>
) : (
  <Text tone="subdued">
    {typeof catalogSize === "number"
      ? `Catalog: ${catalogSize.toLocaleString()} products`
      : catalogError
      ? `Couldn’t verify catalog size: ${catalogError}`
      : `Catalog: —`}
  </Text>
)}

<Box
            background="bg-surface-secondary"
            borderRadius="200"
            padding="400"
          >
            <BlockStack gap="100">
              <Text as="h4" variant="headingSm" fontWeight="semibold">
                All plans start with a 30-day free trial — full features, no limits.
              </Text>
              <Text as="p" tone="subdued">
                Your selected plan kicks in after 30 days. Upgrade, downgrade or cancel anytime.
              </Text>
            </BlockStack>
          </Box>

          <InlineStack gap="400" wrap>
  {/* Lite (monthly only) */}
  <Box minWidth="320px" maxWidth="520px" width="100%">
    <Tooltip
      content={
        liteOverCap
          ? `Your catalog (${(catalogSize ?? 0).toLocaleString()}) exceeds Lite’s ${LITE_CAP} cap. Choose Pro or Premium.`
          : catalogLoading
          ? "Still checking your catalog size. We’ll verify before activating Lite."
          : ""
      }
      dismissOnMouseOut
    >
      <div style={{ opacity: liteOverCap ? 0.5 : 1 }}>
        <PlanTile
          id="lite"
          meta={PLAN_DETAILS.lite}
          current={currentLevel}
          // Disable by removing the handler when over cap; keep UI visible
          onChoose={liteOverCap ? null : subscribe}
          allowAnnual={false}
        />
      </div>
    </Tooltip>
  </Box>

  {/* Pro (monthly only) */}
  <Box minWidth="320px" maxWidth="520px" width="100%">
    <PlanTile
      id="pro"
      meta={PLAN_DETAILS.pro}
      current={currentLevel}
      onChoose={subscribe}
      allowAnnual={false}
    />
  </Box>

    {/* Growth (monthly only) */}
  <Box minWidth="320px" maxWidth="520px" width="100%">
    <Tooltip
      content={
        growthOverCap
          ? `Your catalog (${(catalogSize ?? 0).toLocaleString()}) exceeds Growth’s ${GROWTH_CAP.toLocaleString()} cap. Choose Pro or Premium.`
          : catalogLoading
          ? "Still checking your catalog size. We’ll verify before activating Growth."
          : ""
      }
      dismissOnMouseOut
    >
      <div style={{ opacity: growthOverCap ? 0.5 : 1 }}>
        <PlanTile
          id="growth"
          meta={PLAN_DETAILS.growth}
          current={currentLevel}
          onChoose={growthOverCap ? null : subscribe}
          allowAnnual={false}
        />
      </div>
    </Tooltip>
  </Box>

</InlineStack>


          {isPaid && (
  <>
    <Divider />
    <InlineStack align="space-between" blockAlign="center">
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="semibold">Manage your subscription</Text>
        <Text as="p" tone="subdued">You can downgrade to Free at any time. We’ll cancel the current subscription with proration.</Text>
      </BlockStack>
      <Button tone="critical" onClick={downgrade} disabled={busy}>
        Downgrade to Free
      </Button>
    </InlineStack>
  </>
)}


          <Divider />

          {syncing && !toast && (
            <Text tone="subdued" as="p" variant="bodySm">
              Syncing billing status…
            </Text>
          )}
        </BlockStack>
      </Card>

      {toast && (
        <Box
          position="fixed"
          insetInlineEnd="400"
          insetBlockEnd="400"
          padding="300"
          borderRadius="200"
          background="bg-inverse"
          style={{ color: "#fff", zIndex: 9999, boxShadow: "0 8px 24px rgba(0,0,0,.2)" }}
        >
          <Text as="span" tone="inverse">{toast}</Text>
        </Box>
      )}
    </Box>
    </>
  );
}
