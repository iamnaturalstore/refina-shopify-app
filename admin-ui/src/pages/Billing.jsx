import api from "../api/client"
// admin-ui/src/pages/Billing.jsx
import * as React from "react";
import { api } from "../api/client";
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
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";

const PENDING_KEY = "refina:billing:pending";

// ── Plan meta (EDIT here to change prices/blurbs) ────────────────────────
const PLAN_DETAILS = {
  pro: {
    label: "Pro",
    priceMonthly: "$9/mo",
    priceAnnualNote: "or $90/yr (~2 mo free)",
    tooltip: "Pro — Core AI • 1k queries/mo • email support",
    features: [
      "Core AI recommendations",
      "Up to 1k queries / month",
      "Email support",
    ],
  },
  premium: {
    label: "Premium",
    priceMonthly: "$29/mo",
    priceAnnualNote: "or $290/yr (~2 mo free)",
    tooltip: "Premium — Advanced AI • styling & analytics • priority support",
    ribbon: "Best value",
    features: [
      "Advanced AI quality",
      "Styling controls & analytics",
      "Higher limits + priority support",
    ],
  },
};

// Resolve full myshopify domain from ?shop or ?host
function shopFromHostB64(hostB64) {
  if (!hostB64) return "";
  try {
    const decoded = atob(hostB64);
    const mAdmin = decoded.match(/^admin\.shopify\.com\/store\/([^\/?#]+)/i);
    if (mAdmin?.[1]) return `${mAdmin[1].toLowerCase()}.myshopify.com`;
    const mShop = decoded.match(/^([^\/?#]+)\.myshopify\.com\/admin/i);
    if (mShop?.[1]) return `${mShop[1].toLowerCase()}.myshopify.com`;
  } catch {}
  return "";
}
function resolveShop() {
  const usp = new URLSearchParams(window.location.search);
  const qShop = (usp.get("shop") || "").toLowerCase();
  if (qShop.endsWith(".myshopify.com")) return qShop;
  const host = usp.get("host") || "";
  const fromHost = shopFromHostB64(host);
  return fromHost || "";
}

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

export default function Billing() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [plan, setPlan] = React.useState(null); // { level, status }
  const [error, setError] = React.useState("");
  const [toast, setToast] = React.useState("");
  const [syncing, setSyncing] = React.useState(false);
  const pollRef = React.useRef(null);
  const timeoutRef = React.useRef(null);

  const proMeta = PLAN_DETAILS.pro;
  const premiumMeta = PLAN_DETAILS.premium;

  // Load plan (with fallback path)
  const loadPlan = React.useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const shop = resolveShop();
      if (!shop) throw new Error("Missing shop context");
      const j = await api(`/api/billing/plan?shop=${encodeURIComponent(shop)}`);
      setPlan(parsePlanResponse(j));
    } catch {
      try {
        const shop = resolveShop();
        if (!shop) throw new Error("Missing shop context");
        const r = await api(`/api/billing/plan?shop=${encodeURIComponent(shop)}`);
        if (!r.ok) throw new Error("bad status");
        const j = await r.json();
        setPlan(parsePlanResponse(j));
      } catch {
        setError("Failed to load current plan.");
        setPlan(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadPlan();
    const onVis = () => { if (document.visibilityState === "visible") loadPlan(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadPlan]);

  // Auto-refresh after returning from checkout
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  React.useEffect(() => {
    const wantRaw = localStorage.getItem(PENDING_KEY);
    if (!wantRaw) return;
    const want = normalizeLevel(wantRaw);
    const have = plan ? normalizeLevel(plan.level) : null;

    if (have && have === want) {
      localStorage.removeItem(PENDING_KEY);
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setSyncing(false);
      showToast(`Plan updated to ${labelFromLevel(have)} 🎉`);
      return;
    }
    if (!syncing) {
      setSyncing(true);
      pollRef.current = setInterval(loadPlan, 3000);
      timeoutRef.current = setTimeout(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        setSyncing(false);
      }, 60000);
    }
  }, [plan, syncing, loadPlan]);

  React.useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function subscribe(which /* "pro" | "premium" */) {
    try {
      setBusy(true); setError("");
      const shop = resolveShop();
      if (!shop) throw new Error("Missing shop context");
      const j = await api(`/api/billing/subscribe?shop=${encodeURIComponent(shop)}`, { method: "POST", body: { plan: which } });
      const url = j?.confirmationUrl || j?.url || j?.confirmation_url || j?.redirectUrl;
      if (!url) throw new Error("No confirmation URL returned");
      try { localStorage.setItem(PENDING_KEY, which); } catch {}
      try { window.top.location.href = url; } catch { window.location.href = url; }
    } catch (e) {
      setError(e?.message || "Upgrade failed");
    } finally {
      setBusy(false);
    }
  }

  // Derived UI state
  const currentLevel = plan ? normalizeLevel(plan.level) : null;
  const currentLabel = currentLevel ? labelFromLevel(currentLevel) : "";
  const currentStatus = plan?.status ? String(plan.status).toUpperCase() : "";
  const isPro = currentLevel === "pro";
  const isPremium = currentLevel === "premium";

  // Tile helper
  function PlanTile({ id, meta, current, onChoose }) {
    const isCurrent = current === id;
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingLg">{meta.label}</Text>
              {isCurrent && <Badge tone="success">Current</Badge>}
              {!isCurrent && meta.ribbon && <Badge tone="attention">{meta.ribbon}</Badge>}
            </InlineStack>
            <BlockStack gap="050" align="end">
              <Tooltip content={meta.tooltip}>
                <Text as="span" variant="headingLg">{meta.priceMonthly}</Text>
              </Tooltip>
              {meta.priceAnnualNote && (
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

          <InlineStack>
            <Button
              variant="primary"
              disabled={busy || isCurrent || loading}
              onClick={() => onChoose(id)}
            >
              {isCurrent ? `Current: ${meta.label}` : busy ? "Opening…" : `Choose ${meta.label}`}
            </Button>
          </InlineStack>
        </BlockStack>
      </Card>
    );
  }

  return (
    <Box padding="400" maxWidth="1200" width="100%" marginInline="auto">
      <Card>
        <BlockStack gap="400">
          {/* Header */}
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Billing</Text>
            {!loading ? (
              <Tooltip
                content={
                  currentLevel === "pro"
                    ? proMeta.tooltip
                    : currentLevel === "premium"
                    ? premiumMeta.tooltip
                    : ""
                }
              >
                <Badge tone={isPro || isPremium ? "success" : "subdued"}>
                  {currentLabel || "—"} {currentStatus && <>&nbsp;{currentStatus}</>}
                </Badge>
              </Tooltip>
            ) : (
              <Text as="span" tone="subdued">Loading…</Text>
            )}
          </InlineStack>

          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {loading ? "Loading…" : `You’re on ${currentLabel || "—"}`}
              </Text>
              <Text as="p" tone="subdued">
                After approving a charge, click “Refresh” or wait for the billing webhook to update your plan.
              </Text>
            </BlockStack>
            <Button onClick={loadPlan} disabled={loading || busy}>
              {busy ? "Refreshing…" : "Refresh"}
            </Button>
          </InlineStack>

          {error && (
            <Banner tone="critical" title="Billing error">
              <p>{error}</p>
            </Banner>
          )}

          {/* Side-by-side tiles */}
          <InlineStack gap="400" wrap>
            <Box minWidth="320px" maxWidth="520px" width="100%">
              <PlanTile id="pro" meta={proMeta} current={currentLevel} onChoose={subscribe} />
            </Box>
            <Box minWidth="320px" maxWidth="520px" width="100%">
              <PlanTile id="premium" meta={premiumMeta} current={currentLevel} onChoose={subscribe} />
            </Box>
          </InlineStack>

          <Divider />

          {/* Sync status + toast */}
          {syncing && !toast && (
            <Text tone="subdued" as="p" variant="bodySm">
              Syncing billing status…
            </Text>
          )}
        </BlockStack>
      </Card>

      {/* Helper note for future you / merchants */}
      <Box paddingBlockStart="200">
        <Text tone="subdued" as="p" variant="bodySm">
          Edit pricing & blurbs in <code>PLAN_DETAILS</code> inside this file.
        </Text>
      </Box>

      {/* Simple toast */}
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
  );
}
