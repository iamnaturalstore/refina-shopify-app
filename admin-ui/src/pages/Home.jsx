// admin-ui/src/pages/Home.jsx
//
// Dashboard page — route: "/dashboard"
// Shown as the default landing after setup is complete.
// Displays analytics stats, AI query usage, knowledge build status, recent activity.

import React from "react";
import { Banner, Spinner } from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { api, adminApi, getShop } from "../api/client";
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
    level:       normalizeLevel(p.level),
    status:      String(p.status || p.state || "unknown").toLowerCase(),
    reauthorize: !!j?.reauthorize,
  };
}

function planLabel(level) {
  return { premium: "Premium", pro: "Pro", growth: "Growth", lite: "Lite", free: "Free" }
    [normalizeLevel(level)] || "Free";
}

function fmt(n) {
  const x = Number(n || 0);
  return isFinite(x) ? x.toLocaleString() : "—";
}

function pct(n, d) {
  const N = Number(n || 0), D = Number(d || 0);
  if (!D) return 0;
  return Math.max(0, Math.min(100, (100 * N) / D));
}

// ─── design tokens ────────────────────────────────────────────────────────────

const GRAD = "linear-gradient(135deg, #4FC3F7, #6B8FFF, #8B5CF6)";

// ─── sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, change, changeUp }) {
  return (
    <div
      className="refina-stat-card"
      style={{
        background: "#FFFFFF", border: "1px solid #E4E7EE",
        borderRadius: "12px", padding: "18px 20px",
        boxShadow: "0 1px 3px rgba(15,24,41,0.05)",
        position: "relative", overflow: "hidden",
        flex: 1, minWidth: "160px",
      }}
    >
      {/* Gradient top accent */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "2px", background: GRAD, borderRadius: "12px 12px 0 0" }} />
      <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#94A3B8", marginBottom: "8px" }}>
        {label}
      </div>
      <div style={{ fontSize: "30px", fontWeight: "700", letterSpacing: "-1.5px", lineHeight: 1, color: "#0F1829", marginBottom: "6px" }}>
        {value}
      </div>
      {change && (
        <div style={{ fontSize: "12px", color: changeUp ? "#059669" : "#94A3B8", fontWeight: changeUp ? "500" : "400" }}>
          {change}
        </div>
      )}
    </div>
  );
}

function Panel({ title, linkLabel, onLinkClick, children }) {
  return (
    <div style={{
      background: "#FFFFFF", border: "1px solid #E4E7EE",
      borderRadius: "12px", padding: "20px",
      boxShadow: "0 1px 3px rgba(15,24,41,0.05)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <span style={{ fontSize: "14px", fontWeight: "600", color: "#0F1829" }}>{title}</span>
        {linkLabel && (
          <span
            onClick={onLinkClick}
            style={{ fontSize: "12px", fontWeight: "600", color: "#4338CA", cursor: "pointer" }}
          >
            {linkLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ value, tone }) {
  const color = tone === "critical" ? "#F87171" : tone === "warning" ? "#FBBF24" : GRAD;
  return (
    <div style={{ height: "6px", background: "#F2F4F7", borderRadius: "3px", overflow: "hidden", border: "1px solid #E4E7EE" }}>
      <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: "3px", transition: "width 0.4s ease" }} />
    </div>
  );
}

// ─── Home ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const shop     = React.useMemo(() => getShop(), []);
  const navigate = useNavigate();
  const qs       = React.useMemo(getQS, []);

  const [loading,   setLoading]   = React.useState(true);
  const [err,       setErr]       = React.useState("");
  const [plan,      setPlan]      = React.useState({ level: "free", status: "unknown" });
  const [overview,  setOverview]  = React.useState(null);
  const [logs,      setLogs]      = React.useState([]);
  const [indexer,   setIndexer]   = React.useState(null);
  const [reauthHint, setReauth]   = React.useState(false);
  const [syncBusy, setSyncBusy]   = React.useState(false);
  const [syncMsg,  setSyncMsg]    = React.useState("");

  // ── initial load ────────────────────────────────────────────────────────
  React.useEffect(() => {
    let on = true;
    (async () => {
      setLoading(true);
      try {
        const [
          { data: planData },
          { data: overviewData },
          { data: logsData },
          { data: idxData },
        ] = await Promise.all([
          api.get("/api/billing/plan"),
          adminApi.getAnalyticsSummary({ days: 30 }).catch(() => ({ data: null })),
          adminApi.getAnalyticsEvents({ limit: 5 }).catch(() => ({ data: [] })),
          api.get(`/api/indexer/status?shop=${encodeURIComponent(shop)}&fresh=1`),
        ]);

        if (!on) return;

        const parsed = parsePlan(planData);
        setPlan(parsed);
        setReauth(Boolean(parsed.reauthorize));
        setOverview(overviewData || {});

        const items = Array.isArray(logsData?.rows) ? logsData.rows
          : Array.isArray(logsData?.logs) ? logsData.logs
          : Array.isArray(logsData) ? logsData : [];
        setLogs(items.slice(0, 5));
        setIndexer(idxData?.indexer || null);
      } catch (e) {
        if (on) setErr(`Failed to load dashboard: ${e?.message || "Unknown error"}`);
      } finally {
        if (on) setLoading(false);
      }
    })();

    // Re-fetch analytics when a new event is ingested
    const refresh = async () => {
      try {
        const [{ data: ov }, { data: ev }] = await Promise.all([
          adminApi.getAnalyticsSummary({ days: 30 }),
          adminApi.getAnalyticsEvents({ limit: 5 }),
        ]);
        setOverview(ov || {});
        const items = Array.isArray(ev?.rows) ? ev.rows : Array.isArray(ev?.logs) ? ev.logs : [];
        setLogs(items.slice(0, 5));
      } catch { /* silent */ }
    };
    window.addEventListener("rf:analytics:ingested", refresh);
    return () => { on = false; window.removeEventListener("rf:analytics:ingested", refresh); };
  }, [shop]);

  // ── indexer polling (stops at complete) ─────────────────────────────────
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

  // ── derived ──────────────────────────────────────────────────────────────
  const level         = normalizeLevel(plan?.level);
  const totals        = overview?.totals || overview || {};
  const interactions  = Number(totals.interactions ?? totals.events ?? totals.queries ?? 0);
  const productClicks = Number(totals.productClicks ?? totals.clicks ?? 0);
  const ctr           = interactions ? ((100 * productClicks) / interactions) : 0;

  const usage   = overview?.usage || {};
  const used    = Number(usage.used ?? 0);
  const limit   = Number(usage.limit ?? (level === "lite" ? 500 : level === "growth" ? 2000 : level === "pro" ? 5000 : level === "premium" ? 10000 : 0));
  const usagePct = pct(used, limit);

  const indexerPhase    = String(indexer?.phase || "").toLowerCase();
  const kbDone          = indexerPhase === "complete";
  const kbActive        = !!indexer && !kbDone && indexerPhase !== "error";
  const kbTotal         = Number(indexer?.totalProducts || 0);
  const kbProcessed     = Number(indexer?.embeddedCount || indexer?.importedCount || 0);
  const kbPct           = kbTotal > 0 ? pct(kbProcessed, kbTotal) : 0;

  // ── loading ──────────────────────────────────────────────────────────────

  const startSync = React.useCallback(async () => {
  setSyncMsg("");
  setSyncBusy(true);
  try {
    const { data } = await api.post("/api/sync/start", {});
    if (data?.queued)                    setSyncMsg("Sync started — progress will update below.");
    else if (data?.reason === "already_running") setSyncMsg("Sync already in progress.");
    else if (data?.reason === "cooldown")        setSyncMsg(`Cooling down. ${data?.retryAfterSec ? `Try again in ~${data.retryAfterSec}s.` : ""}`);
    else                                         setSyncMsg("Nothing to sync right now.");
  } catch (e) {
    setSyncMsg(e?.message || "Sync failed.");
  } finally {
    setSyncBusy(false);
  }
}, []);

  if (loading) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <AppNav />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
          <Spinner size="small" />
          <span style={{ fontSize: "14px", color: "#64748B" }}>Loading your dashboard…</span>
        </div>
      </div>
    );
  }

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ background: "#F2F4F7", minHeight: "calc(100vh - 0px)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <AppNav planLevel={plan?.level} planStatus={plan?.status} />

      <div style={{ maxWidth: "820px", margin: "0 auto", padding: "28px 24px 48px" }}>

        {/* ── Banners ── */}
        {err && (
          <div style={{ marginBottom: "16px" }}>
            <Banner tone="critical" onDismiss={() => setErr("")}><p>{err}</p></Banner>
          </div>
        )}
        {reauthHint && (
          <div style={{ marginBottom: "16px" }}>
            <Banner
              tone="info"
              title="Billing needs a quick re-check"
              action={{ content: "Open Billing", onAction: () => navigate(`/billing${qs}`) }}
              onDismiss={() => setReauth(false)}
            >
              <p>We're showing your cached plan. Open Billing to refresh from Shopify.</p>
            </Banner>
          </div>
        )}
        {level === "free" && (
          <div style={{ marginBottom: "16px" }}>
            <Banner
              tone="info"
              title="Choose a plan to unlock AI recommendations"
              action={{ content: "View plans", onAction: () => navigate(`/billing${qs}`) }}
            >
              <p>Refina's AI answers, analytics, and styling controls require an active plan. Free trial available on all plans.</p>
            </Banner>
          </div>
        )}

        {/* ── Stats row ── */}
        <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.8px", color: "#94A3B8", marginBottom: "12px" }}>
          Last 30 days
        </div>
        <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
          <StatCard
            label="Customer interactions"
            value={fmt(interactions)}
            change={interactions > 0 ? "Shoppers asking Refina questions" : "No activity yet"}
            changeUp={interactions > 0}
          />
          <StatCard
            label="Product clicks"
            value={fmt(productClicks)}
            change={productClicks > 0 ? "Products clicked from recommendations" : "—"}
            changeUp={productClicks > 0}
          />
          <StatCard
            label="Click-through rate"
            value={`${ctr ? ctr.toFixed(1) : "0.0"}%`}
            change={interactions > 0 ? "Recommendations → clicks" : "—"}
            changeUp={ctr > 20}
          />
        </div>

        {/* ── Two column ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>

          {/* AI query usage */}
          <Panel
            title="AI queries"
            linkLabel="Manage plan →"
            onLinkClick={() => navigate(`/billing${qs}`)}
          >
            {level === "free" ? (
              <div>
                <p style={{ fontSize: "13px", color: "#64748B", marginBottom: "12px" }}>
                  Upgrade to unlock AI answers and usage tracking.
                </p>
                <button
                  onClick={() => navigate(`/billing${qs}`)}
                  style={{
                    padding: "7px 14px", borderRadius: "8px", fontSize: "13px", fontWeight: "600",
                    background: GRAD, color: "white", border: "none", cursor: "pointer",
                    boxShadow: "0 2px 6px rgba(107,143,255,0.25)", fontFamily: "inherit",
                  }}
                >
                  Choose a plan →
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: "#64748B", marginBottom: "8px" }}>
                  <span>Used this month</span>
                  <span style={{ fontWeight: "600", color: "#0F1829" }}>{fmt(used)} / {fmt(limit)}</span>
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <ProgressBar value={usagePct} tone={usagePct >= 90 ? "critical" : usagePct >= 75 ? "warning" : null} />
                </div>
                <div style={{ fontSize: "12px", color: "#94A3B8" }}>
                  {fmt(limit - used)} remaining this month
                </div>
                {usagePct >= 75 && (
                  <div style={{ marginTop: "10px" }}>
                    <button
                      onClick={() => navigate(`/billing${qs}`)}
                      style={{ padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: "600", background: GRAD, color: "white", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                    >
                      Upgrade plan
                    </button>
                  </div>
                )}

                {/* Divider */}
                <div style={{ height: "1px", background: "#E4E7EE", margin: "14px 0" }} />

                {/* KB status */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
                  <div style={{
                    width: "8px", height: "8px", borderRadius: "50%",
                    background: kbDone ? "#059669" : kbActive ? "#FBBF24" : "#94A3B8",
                    boxShadow: kbDone
                      ? "0 0 0 3px rgba(5,150,105,0.15)"
                      : kbActive ? "0 0 0 3px rgba(251,191,36,0.15)" : "none",
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: "13px", fontWeight: "600", color: "#0F1829" }}>Product knowledge</span>
                  <span style={{ marginLeft: "auto", fontSize: "12px", color: "#94A3B8" }}>
                    {kbTotal > 0 ? `${fmt(kbTotal)} products` : indexerPhase || "—"}
                  </span>
                </div>
                {kbActive && (
                  <div style={{ marginTop: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#64748B", marginBottom: "5px" }}>
                      <span>Scanning catalogue…</span>
                      <span>{kbTotal > 0 ? `${fmt(kbProcessed)} / ${fmt(kbTotal)}` : `${Math.round(kbPct)}%`}</span>
                    </div>
                    <ProgressBar value={kbPct} />
                  </div>
                )}
                {kbDone && indexer?.updatedAt && (
                  <div style={{ fontSize: "12px", color: "#94A3B8", marginTop: "4px" }}>
                    Last sync: {new Date(indexer.updatedAt).toLocaleString()}
                  </div>
                )}
              </>
            )}

            <div style={{ height: "1px", background: "#E4E7EE", margin: "14px 0" }} />
<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
  <span style={{ fontSize: "13px", fontWeight: "600", color: "#0F1829" }}>Product sync</span>
  <button
    onClick={startSync}
    disabled={syncBusy || kbActive}
    style={{
      padding: "6px 12px", borderRadius: "8px",
      fontSize: "12px", fontWeight: "600",
      background: syncBusy || kbActive ? "#F2F4F7" : GRAD,
      color: syncBusy || kbActive ? "#94A3B8" : "white",
      border: "none", cursor: syncBusy || kbActive ? "not-allowed" : "pointer",
      fontFamily: "inherit",
      boxShadow: syncBusy || kbActive ? "none" : "0 2px 6px rgba(107,143,255,0.25)",
    }}
  >
    {syncBusy ? "Starting…" : kbActive ? "Sync in progress…" : "Sync products"}
  </button>
</div>
{syncMsg && (
  <div style={{ fontSize: "12px", color: "#64748B", marginTop: "6px" }}>
    {syncMsg}
  </div>
)}
          </Panel>

          {/* Recent activity */}
          <Panel
            title="Recent activity"
            linkLabel={logs.length ? "Full log →" : null}
            onLinkClick={() => navigate(`/analytics${qs}`)}
          >
            {logs.length > 0 ? (
              <div>
                {logs.map((row, i) => {
                  const query       = row?.concern || row?.query || "Customer asked…";
                  const product     = row?.topProduct?.title || "";
                  const when        = row?.createdAt || row?.ts || "";
                  const isLast      = i === logs.length - 1;
                  return (
                    <div
                      key={i}
                      style={{
                        padding: "9px 0",
                        borderBottom: isLast ? "none" : "1px solid #F2F4F7",
                      }}
                    >
                      <div style={{ fontSize: "13px", fontWeight: "500", color: "#0F1829", marginBottom: "3px" }}>
                        {query}
                      </div>
                      <div style={{ fontSize: "12px", color: "#94A3B8" }}>
                        {product ? `→ ${product}` : "No product click"}
                        {when ? ` · ${new Date(when).toLocaleString()}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <div style={{ fontSize: "24px", marginBottom: "8px" }}>💬</div>
                <p style={{ fontSize: "13px", color: "#94A3B8" }}>
                  No activity yet. Check back after some store traffic.
                </p>
              </div>
            )}
          </Panel>

        </div>

        {/* ── Plan card ── */}
        <div style={{
          background: "#FFFFFF", border: "1px solid #E4E7EE",
          borderRadius: "12px", padding: "18px 22px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: "12px",
          boxShadow: "0 1px 3px rgba(15,24,41,0.05)",
        }}>
          <div>
            <div style={{ fontSize: "15px", fontWeight: "600", color: "#0F1829", marginBottom: "4px" }}>
              {level === "free"
                ? "No plan active"
                : `${planLabel(level)} plan · ${String(plan.status).charAt(0).toUpperCase() + String(plan.status).slice(1)}`}
            </div>
            <div style={{ fontSize: "13px", color: "#64748B" }}>
              {level === "free"
                ? "Choose a plan to unlock AI recommendations and analytics."
                : level === "lite"    ? "Up to 500 AI queries/mo · Core AI answers · Basic analytics"
                : level === "growth"  ? "Up to 2,000 AI queries/mo · Core AI answers + explanations · Storefront launcher"
                : level === "pro"     ? "Up to 5,000 AI queries/mo · Richer AI answers · Unlimited products"
                : "Up to 10,000 AI queries/mo · Advanced AI · Full styling · Priority support"}
            </div>
          </div>
          <button
            onClick={() => navigate(`/billing${qs}`)}
            style={{
              padding: "8px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: "600",
              background: level === "free" ? GRAD : "#F7F8FA",
              border: level === "free" ? "none" : "1px solid #CDD2DE",
              color: level === "free" ? "white" : "#2D3A55",
              cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
              boxShadow: level === "free" ? "0 2px 6px rgba(107,143,255,0.25)" : "none",
            }}
          >
            {level === "free" ? "Choose a plan →" : level === "premium" ? "Manage billing" : "Upgrade plan"}
          </button>
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
            {[["Analytics", "/analytics"], ["Settings", "/settings"], ["Billing", "/billing"], ["Get Started", "/"]].map(([label, path]) => (
              <button
                key={path}
                onClick={() => navigate(`${path}${qs}`)}
                style={{
                  padding: "6px 12px", borderRadius: "8px",
                  fontSize: "12px", fontWeight: "600",
                  background: "transparent", border: "1px solid #CDD2DE", color: "#64748B",
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}