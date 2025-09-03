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
import { api, billingApi } from "../api/client.js";


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
function parsePlanResponse(jsonResponse) {
  // The actual plan data is nested in the response
  const p = jsonResponse?.plan || jsonResponse || {};
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

  const loadPlan = React.useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      // CORRECTED: Use the new api.get method and destructure the 'data' property
      const { data: json } = await api.get("/api/billing/plan");
      console.log("[Billing] Fetched plan data:", json);
      setPlan(parsePlanResponse(json));
    } catch (e) {
      console.error("[Billing] Failed to load current plan:", e);
      setError("Failed to load current plan.");
      setPlan(null);
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
      // CORRECTED: The billingApi wrapper still works, but we need its 'data' property
      const { data: json } = await billingApi.subscribe({ plan: which });
      const url = json?.confirmationUrl || json?.url || json?.confirmation_url || json?.redirectUrl;
      if (!url) throw new Error("No confirmation URL returned");
      try { localStorage.setItem(PENDING_KEY, which); } catch {}
      try { window.top.location.href = url; } catch { window.location.href = url; }
    } catch (e) {
      setError(e?.message || "Upgrade failed");
    } finally {
      setBusy(false);
    }
  }

  const currentLevel = plan ? normalizeLevel(plan.level) : null;
  const currentLabel = currentLevel ? labelFromLevel(currentLevel) : "";
  const currentStatus = plan?.status ? String(plan.status).toUpperCase() : "";
  const isPro = currentLevel === "pro";
  const isPremium = currentLevel === "premium";

  if (loading) {
    return (
      <Box padding="400"><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="p">Loading billing details...</Text></InlineStack></Box>
    );
  }

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
              {isCurrent ? `Current Plan` : busy ? "Opening…" : `Choose ${meta.label}`}
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
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Billing</Text>
            <Tooltip content={currentLevel === "pro" ? proMeta.tooltip : currentLevel === "premium" ? premiumMeta.tooltip : ""}>
              <Badge tone={isPro || isPremium ? "success" : "subdued"}>
                {currentLabel || "—"} {currentStatus && <>&nbsp;{currentStatus}</>}
              </Badge>
            </Tooltip>
          </InlineStack>

          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {`You’re on the ${currentLabel || "Free"} plan`}
              </Text>
              <Text as="p" tone="subdued">
                After approving a charge, click “Refresh” or wait for the billing webhook to update your plan.
              </Text>
            </BlockStack>
            <Button onClick={loadPlan} loading={loading || busy}>
              Refresh
            </Button>
          </InlineStack>

          {error && <Banner tone="critical" title="Billing error" onDismiss={() => setError("")}><p>{error}</p></Banner>}

          <InlineStack gap="400" wrap>
            <Box minWidth="320px" maxWidth="520px" width="100%">
              <PlanTile id="pro" meta={proMeta} current={currentLevel} onChoose={subscribe} />
            </Box>
            <Box minWidth="320px" maxWidth="520px" width="100%">
              <PlanTile id="premium" meta={premiumMeta} current={currentLevel} onChoose={subscribe} />
            </Box>
          </InlineStack>

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
  );
}
