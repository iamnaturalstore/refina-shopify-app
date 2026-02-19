// admin-ui/src/pages/Welcome.jsx
//
// Onboarding / "Get Started" page — route: "/"
// Shows setup steps with real completion state.
// Self-dismissing (shows all-done state + link to Dashboard) once complete.
// Always accessible via AppNav "Get Started" tab.

import React from "react";
import { Banner, Spinner } from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { api, getShop } from "../api/client";
import AppNav from "../components/AppNav";

// ─── helpers ──────────────────────────────────────────────────────────────────

function getQS() {
  try {
    const search = new URLSearchParams(window.location.search || "");
    const hashQ = (window.location.hash || "").split("?")[1] || "";
    const hash = new URLSearchParams(hashQ);
    const host = search.get("host") || hash.get("host") || "";
    const shop = search.get("shop") || hash.get("shop") || "";
    const p = new URLSearchParams();
    if (host) p.set("host", host);
    if (shop) p.set("shop", shop);
    const s = p.toString();
    return s ? `?${s}` : "";
  } catch { return ""; }
}

function getChargeId() {
  try {
    const search = new URLSearchParams(window.location.search || "");
    const hashQ = (window.location.hash || "").split("?")[1] || "";
    const hash = new URLSearchParams(hashQ);
    return search.get("charge_id") || hash.get("charge_id") || null;
  } catch { return null; }
}

function clearChargeId() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("charge_id");
    window.history.replaceState({}, "", url.toString());
  } catch { /* hash router — harmless */ }
}

function normalizeLevel(level) {
  const v = String(level || "").toLowerCase().trim();
  if (/\bpremium\b/.test(v)) return "premium";
  if (/\bpro\b/.test(v))     return "pro";
  if (/\bgrowth\b/.test(v))  return "growth";
  if (/\blite\b/.test(v))    return "lite";
  return "free";
}

function parsePlan(j) {
  const p = j?.plan || j || {};
  return {
    level:  normalizeLevel(p.level),
    status: String(p.status || p.state || "unknown").toLowerCase(),
  };
}

function isActivePlan(plan) {
  if (!plan) return false;
  return (
    ["pro", "premium", "growth", "lite"].includes(normalizeLevel(plan.level || "")) &&
    ["active", "trialing", "current"].includes(String(plan.status || "").toLowerCase())
  );
}

function planLabel(level) {
  return { premium: "Premium", pro: "Pro", growth: "Growth", lite: "Lite", free: "Free" }
    [normalizeLevel(level)] || "Free";
}

function fmt(n) {
  const x = Number(n || 0);
  return isFinite(x) ? x.toLocaleString() : "—";
}

async function fetchPlanWithRetry(retry = false) {
  const attempts = retry ? 5 : 1;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000));
    try {
      const { data } = await api.get("/api/billing/plan");
      last = parsePlan(data);
      if (!retry || isActivePlan(last)) return last;
    } catch (e) {
      if (!retry) throw e;
    }
  }
  return last || parsePlan({});
}

// ─── design tokens ────────────────────────────────────────────────────────────

const GRAD = "linear-gradient(135deg, #4FC3F7, #6B8FFF, #8B5CF6)";

// ─── StepCard ─────────────────────────────────────────────────────────────────

function StepCard({ number, title, badge, badgeVariant, desc, state, children }) {
  const cardBg = {
    complete:   { background: "#FAFFFE", borderColor: "#A7F3D0" },
    inProgress: { background: "#FFFEF9", borderColor: "#FDE68A" },
    pending:    { background: "#FFFFFF", borderColor: "#E4E7EE" },
  }[state] || { background: "#FFFFFF", borderColor: "#E4E7EE" };

  const circleSt = {
    complete:   { background: "#ECFDF5", border: "1.5px solid #A7F3D0", color: "#059669", fontSize: "16px" },
    inProgress: { background: "#EFF6FF", border: "1.5px solid #BFDBFE", color: "#2563EB", fontSize: "15px" },
    pending:    { background: "#F7F8FA", border: "1.5px solid #CDD2DE", color: "#94A3B8", fontSize: "13px" },
  }[state] || {};

  const badgeSt = {
    complete:   { background: "#ECFDF5", color: "#059669", border: "1px solid #A7F3D0" },
    required:   { background: "#EFF6FF", color: "#2563EB", border: "1px solid #BFDBFE" },
    inProgress: { background: "#FFFBEB", color: "#D97706", border: "1px solid #FDE68A" },
    auto:       { background: "#F7F8FA", color: "#64748B", border: "1px solid #E4E7EE" },
  }[badgeVariant] || {};

  return (
    <div
      className="refina-step-card"
      style={{
        border: `1px solid ${cardBg.borderColor}`,
        background: cardBg.background,
        borderRadius: "12px",
        padding: "18px 20px",
        display: "flex",
        alignItems: "flex-start",
        gap: "16px",
        boxShadow: "0 1px 3px rgba(15,24,41,0.05)",
        transition: "box-shadow 0.15s, border-color 0.15s, transform 0.15s",
      }}
    >
      {/* Circle */}
      <div
        style={{
          width: "36px", height: "36px", minWidth: "36px",
          borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: "700", flexShrink: 0, marginTop: "1px",
          ...circleSt,
        }}
      >
        {state === "complete" ? "✓" : state === "inProgress" ? "⟳" : number}
      </div>

      {/* Body */}
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "5px", gap: "12px" }}>
          <span style={{ fontSize: "15px", fontWeight: "600", color: "#0F1829", letterSpacing: "-0.2px" }}>
            {title}
          </span>
          <span
            style={{
              fontSize: "11px", fontWeight: "600",
              padding: "3px 10px", borderRadius: "20px",
              letterSpacing: "0.2px", whiteSpace: "nowrap", flexShrink: 0,
              ...badgeSt,
            }}
          >
            {badge}
          </span>
        </div>
        <p style={{ fontSize: "13px", color: "#64748B", lineHeight: "1.55", marginBottom: children ? "12px" : "0" }}>
          {desc}
        </p>
        {children}
      </div>
    </div>
  );
}

// ─── InlineProgress ───────────────────────────────────────────────────────────

function InlineProgress({ label, current, total }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div style={{ background: "#F7F8FA", border: "1px solid #E4E7EE", borderRadius: "8px", padding: "10px 12px", marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#64748B", fontWeight: "500", marginBottom: "7px" }}>
        <span>{label}</span>
        <span>{total > 0 ? `${fmt(current)} / ${fmt(total)} products` : "Starting…"}</span>
      </div>
      <div style={{ height: "4px", background: "#E4E7EE", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: GRAD, borderRadius: "2px", transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
}

// ─── Btn helpers ──────────────────────────────────────────────────────────────

const btnPrimary = {
  display: "inline-flex", alignItems: "center", gap: "5px",
  padding: "8px 16px", borderRadius: "8px",
  fontSize: "13px", fontWeight: "600",
  cursor: "pointer", border: "none",
  background: GRAD, color: "white",
  boxShadow: "0 2px 8px rgba(107,143,255,0.28)",
  fontFamily: "inherit", textDecoration: "none",
};

const btnSecondary = {
  display: "inline-flex", alignItems: "center", gap: "5px",
  padding: "8px 16px", borderRadius: "8px",
  fontSize: "13px", fontWeight: "600",
  cursor: "pointer",
  background: "#F7F8FA", border: "1px solid #CDD2DE", color: "#2D3A55",
  fontFamily: "inherit", textDecoration: "none",
};

const btnGhost = {
  display: "inline-flex", alignItems: "center",
  padding: "6px 12px", borderRadius: "8px",
  fontSize: "12px", fontWeight: "600",
  cursor: "pointer",
  background: "transparent", border: "1px solid #CDD2DE", color: "#64748B",
  fontFamily: "inherit",
};

// ─── Welcome ──────────────────────────────────────────────────────────────────

export default function Welcome() {
  const shop     = React.useMemo(() => getShop(), []);
  const navigate = useNavigate();
  const qs       = React.useMemo(getQS, []);
  const returnedFromBilling = React.useMemo(() => !!getChargeId(), []);

  const [loading,       setLoading]       = React.useState(true);
  const [err,           setErr]           = React.useState("");
  const [verifying,     setVerifying]     = React.useState(returnedFromBilling);
  const [planStillFree, setPlanStillFree] = React.useState(false);
  const [plan,          setPlan]          = React.useState(null);
  const [settings,      setSettings]      = React.useState({});
  const [indexer,       setIndexer]       = React.useState(null);

  // ── initial load ────────────────────────────────────────────────────────
  React.useEffect(() => {
    let on = true;
    (async () => {
      try {
        setLoading(true);
        const [resolvedPlan, { data: sd }, { data: id }] = await Promise.all([
          fetchPlanWithRetry(returnedFromBilling),
          api.get("/api/admin/store-settings"),
          api.get(`/api/indexer/status?shop=${encodeURIComponent(shop)}&fresh=1`),
        ]);
        if (!on) return;
        setPlan(resolvedPlan);
        setSettings(sd?.settings || {});
        setIndexer(id?.indexer || null);
        if (returnedFromBilling) {
          if (isActivePlan(resolvedPlan)) clearChargeId();
          else setPlanStillFree(true);
          setVerifying(false);
        }
      } catch (e) {
        if (on) setErr("Couldn't load setup status. Please refresh.");
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => { on = false; };
  }, [shop, returnedFromBilling]);

  // ── indexer polling ──────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!shop) return;
    let timer = null, cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const { data } = await api.get(`/api/indexer/status?shop=${encodeURIComponent(shop)}&fresh=1`);
        if (!cancelled) setIndexer(data?.indexer || null);
        const phase = String(data?.indexer?.phase || "").toLowerCase();
        if (phase !== "complete" && phase !== "error" && !cancelled)
          timer = setTimeout(poll, 8000);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 12000);
      }
    }
    timer = setTimeout(poll, 8000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [shop]);

  // ── plan refresh (escape hatch) ──────────────────────────────────────────
  const refreshPlan = React.useCallback(async () => {
    setVerifying(true);
    setPlanStillFree(false);
    try {
      const p = await fetchPlanWithRetry(true);
      setPlan(p);
      if (!isActivePlan(p)) setPlanStillFree(true);
      else clearChargeId();
    } finally {
      setVerifying(false);
    }
  }, []);

  // ── derived ──────────────────────────────────────────────────────────────
  const hasActivePlan   = React.useMemo(() => isActivePlan(plan), [plan]);
  const indexerPhase    = String(indexer?.phase || "").toLowerCase();
  const hasKnowledge    = indexerPhase === "complete";
  const knowledgeActive = !!indexer && !hasKnowledge && indexerPhase !== "error";
  const hasThemeEmbed   = Boolean(settings?.themeEmbedEnabled || settings?.appEmbedEnabled || settings?.refinaEnabled);
  const hasCategory     = Boolean(settings?.category);

  const steps     = [hasActivePlan, hasKnowledge, hasThemeEmbed, hasCategory];
  const doneCount = steps.filter(Boolean).length;
  const allDone   = steps.every(Boolean);
  const pct       = Math.round((doneCount / steps.length) * 100);

  const kbTotal = Number(indexer?.totalProducts || 0);
  const kbDone  = Number(indexer?.embeddedCount || indexer?.importedCount || 0);

  // ── loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <AppNav />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
          <Spinner size="small" />
          <span style={{ fontSize: "14px", color: "#64748B" }}>Loading your setup…</span>
        </div>
      </div>
    );
  }

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ background: "#F2F4F7", minHeight: "calc(100vh - 0px)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <AppNav planLevel={plan?.level} planStatus={plan?.status} />

      <div style={{ maxWidth: "740px", margin: "0 auto", padding: "28px 24px 48px" }}>

        {/* ── Banners ── */}
        {err && (
          <div style={{ marginBottom: "16px" }}>
            <Banner tone="critical" onDismiss={() => setErr("")}><p>{err}</p></Banner>
          </div>
        )}
        {verifying && !loading && (
          <div style={{ marginBottom: "16px" }}>
            <Banner tone="info" title="Verifying your plan…">
              <p>Confirming your plan with Shopify — just a moment.</p>
            </Banner>
          </div>
        )}
        {planStillFree && !verifying && (
          <div style={{ marginBottom: "16px" }}>
            <Banner
              tone="warning"
              title="Plan not confirmed yet"
              action={{ content: "Refresh plan status", onAction: refreshPlan }}
            >
              <p>Payment received but not synced yet. Hit refresh, or open <a href={`#/billing${qs}`}>Billing</a> to re-check.</p>
            </Banner>
          </div>
        )}

        {/* ── All done banner ── */}
        {allDone && (
          <div style={{
            background: "linear-gradient(135deg, #EEF2FF, #F5F3FF)",
            border: "1px solid #C7D2FE",
            borderRadius: "12px",
            padding: "20px 24px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: "16px",
            position: "relative", overflow: "hidden",
            boxShadow: "0 1px 3px rgba(15,24,41,0.05)",
          }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: GRAD, borderRadius: "12px 12px 0 0" }} />
            <div>
              <div style={{ fontSize: "15px", fontWeight: "700", color: "#0F1829", marginBottom: "4px" }}>
                ✅ Refina is live on your store
              </div>
              <div style={{ fontSize: "13px", color: "#64748B" }}>
                All steps complete · {planLabel(plan?.level)} plan · {fmt(kbTotal)} products indexed
              </div>
            </div>
            <button style={btnPrimary} onClick={() => navigate(`/dashboard${qs}`)}>
              Go to Dashboard →
            </button>
          </div>
        )}

        {/* ── Hero card ── */}
        <div style={{
          background: "#FFFFFF", border: "1px solid #E4E7EE",
          borderRadius: "12px", padding: "28px 32px",
          marginBottom: "16px", position: "relative", overflow: "hidden",
          boxShadow: "0 1px 3px rgba(15,24,41,0.06)",
        }}>
          {/* Gradient top border */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: GRAD, borderRadius: "12px 12px 0 0" }} />
          {/* Subtle glow */}
          <div style={{ position: "absolute", top: "-80px", right: "-80px", width: "280px", height: "280px", background: "radial-gradient(circle, rgba(107,143,255,0.06) 0%, transparent 70%)", pointerEvents: "none" }} />

          <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "1px", background: GRAD, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", marginBottom: "10px", display: "inline-block" }}>
            Setup · {doneCount} of {steps.length} steps complete
          </div>

          <h1 style={{ fontSize: "24px", fontWeight: "700", letterSpacing: "-0.4px", lineHeight: "1.25", color: "#0F1829", marginBottom: "8px" }}>
            {allDone ? "You're all set with Refina" : "Let's get Refina live on your store"}
          </h1>

          <p style={{ fontSize: "14px", color: "#64748B", lineHeight: "1.6", marginBottom: "22px", maxWidth: "480px" }}>
            {allDone
              ? "Your store is active. Shoppers are getting AI-powered recommendations."
              : "Complete the steps below to start helping shoppers choose the right product — faster."}
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "13px", color: "#64748B", fontWeight: "500", whiteSpace: "nowrap" }}>
              {doneCount} / {steps.length} complete
            </span>
            <div style={{ flex: 1, height: "6px", background: "#F2F4F7", borderRadius: "3px", overflow: "hidden", border: "1px solid #E4E7EE" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: GRAD, borderRadius: "3px", transition: "width 0.5s ease" }} />
            </div>
            <span style={{ fontSize: "13px", color: "#94A3B8", fontWeight: "500", whiteSpace: "nowrap" }}>{pct}%</span>
          </div>
        </div>

        {/* ── Step cards ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>

          {/* Step 1: Plan */}
          <StepCard
            number="1"
            title="Choose your plan"
            badge={hasActivePlan ? `${planLabel(plan?.level)} — Active` : "Required"}
            badgeVariant={hasActivePlan ? "complete" : "required"}
            state={hasActivePlan ? "complete" : "pending"}
            desc={
              hasActivePlan
                ? `You're on ${planLabel(plan?.level)}. AI recommendations and analytics are enabled.`
                : "Pick a plan to unlock Refina's AI. Lite, Growth, Pro, or Premium — free trial on all plans."
            }
          >
            {!hasActivePlan && (
              <div style={{ display: "flex", gap: "8px" }}>
                <button style={btnPrimary} onClick={() => navigate(`/billing${qs}`)}>
                  Choose a plan →
                </button>
              </div>
            )}
          </StepCard>

          {/* Step 2: Knowledge build */}
          <StepCard
            number="2"
            title="Product knowledge build"
            badge={hasKnowledge ? "Complete" : knowledgeActive ? "In progress" : "Auto-starts"}
            badgeVariant={hasKnowledge ? "complete" : knowledgeActive ? "inProgress" : "auto"}
            state={hasKnowledge ? "complete" : knowledgeActive ? "inProgress" : "pending"}
            desc={
              hasKnowledge
                ? `All ${fmt(kbTotal)} products scanned and indexed — Refina knows your catalogue.`
                : knowledgeActive
                ? "Refina is scanning your catalogue. You can continue setup — this finishes on its own."
                : "Refina automatically scans and indexes your catalogue after plan activation."
            }
          >
            {knowledgeActive && (
              <InlineProgress label="Scanning catalogue…" current={kbDone} total={kbTotal} />
            )}
          </StepCard>

          {/* Step 3: Theme embed */}
          <StepCard
            number="3"
            title="Enable Refina in your theme"
            badge={hasThemeEmbed ? "Complete" : "Required"}
            badgeVariant={hasThemeEmbed ? "complete" : "required"}
            state={hasThemeEmbed ? "complete" : "pending"}
            desc={
              hasThemeEmbed
                ? "The Refina app embed is active. Shoppers can see the launcher on your store."
                : "Turn on the app embed in your Shopify theme editor. Takes 30 seconds — toggle it on and save."
            }
          >
            {!hasThemeEmbed && (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <a
                  href={`https://${shop}/admin/themes/current/editor?context=apps&target=newAppsSection/app-embed`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={btnPrimary}
                >
                  Open Theme Editor ↗
                </a>
                <button style={btnSecondary} onClick={() => navigate(`/settings${qs}`)}>
                  Setup guide
                </button>
              </div>
            )}
          </StepCard>

          {/* Step 4: Category */}
          <StepCard
            number="4"
            title="Choose your store category"
            badge={hasCategory ? `"${settings.category}"` : "Required"}
            badgeVariant={hasCategory ? "complete" : "required"}
            state={hasCategory ? "complete" : "pending"}
            desc={
              hasCategory
                ? "Category set — Refina will tailor recommendations to your catalogue."
                : "Tell Refina what you sell so recommendations stay on point from day one. Takes 10 seconds."
            }
          >
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                style={hasCategory ? btnSecondary : btnPrimary}
                onClick={() => navigate(`/settings${qs}`)}
              >
                {hasCategory ? "Edit in Settings" : "Set category in Settings →"}
              </button>
            </div>
          </StepCard>

        </div>

        {/* ── Quick links ── */}
        <div style={{
          background: "#FFFFFF", border: "1px solid #E4E7EE",
          borderRadius: "12px", padding: "13px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          boxShadow: "0 1px 3px rgba(15,24,41,0.05)",
        }}>
          <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.6px", color: "#94A3B8" }}>
            Quick links
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            {[["Analytics", "/analytics"], ["Settings", "/settings"], ["Billing", "/billing"]].map(([label, path]) => (
              <button key={path} style={btnGhost} onClick={() => navigate(`${path}${qs}`)}>
                {label}
              </button>
            ))}
            {allDone && (
              <button style={btnGhost} onClick={() => navigate(`/dashboard${qs}`)}>Dashboard</button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}