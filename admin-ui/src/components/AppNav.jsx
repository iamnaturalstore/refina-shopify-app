// admin-ui/src/components/AppNav.jsx
//
// Shared horizontal top-nav for all Refina admin pages.
// Self-contained — fetches its own plan state, no props required.
//
// Usage (every page, no props needed):
//   import AppNav from "../components/AppNav";
//   <AppNav />

import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";

// ─── helpers ──────────────────────────────────────────────────────────────────

function getQS() {
  try {
    const search = new URLSearchParams(window.location.search || "");
    const hashQ  = (window.location.hash || "").split("?")[1] || "";
    const hash   = new URLSearchParams(hashQ);
    const host   = search.get("host") || hash.get("host") || "";
    const shop   = search.get("shop") || hash.get("shop") || "";
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
    level:  normalizeLevel(p.level),
    status: String(p.status || p.state || "unknown").toLowerCase(),
  };
}

function planLabel(level) {
  return { premium: "Premium", pro: "Pro", growth: "Growth", lite: "Lite", free: "Free" }
    [normalizeLevel(level)] || "Free";
}

function planDotColor(level) {
  return { premium: "#8B5CF6", pro: "#6B8FFF", growth: "#4FC3F7", lite: "#34D399" }
    [normalizeLevel(level)] || "#94A3B8";
}

// ─── constants ────────────────────────────────────────────────────────────────

const GRAD = "linear-gradient(135deg, #4FC3F7, #6B8FFF, #8B5CF6)";

const NAV_ITEMS = [
  { label: "Get Started", path: "/" },
  { label: "Dashboard",   path: "/dashboard" },
  { label: "Analytics",   path: "/analytics" },
  { label: "Settings",    path: "/settings" },
  { label: "Billing",     path: "/billing" },
];

// ─── component ────────────────────────────────────────────────────────────────

export default function AppNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const qs       = React.useMemo(getQS, []);
  const [hovered, setHovered] = React.useState(null);

  // Self-contained plan fetch — lightweight Firestore read, safe to call per page.
  // Renders nothing in the chip slot while loading to avoid a flash of "Choose a plan".
  const [plan, setPlan] = React.useState(null);
  React.useEffect(() => {
    let on = true;
    api.get("/api/billing/plan")
      .then(({ data }) => { if (on) setPlan(parsePlan(data)); })
      .catch(() => { /* silently degrade — chip just won't show */ });
    return () => { on = false; };
  }, []);

  // Derive active nav item from current pathname
  const activePath = React.useMemo(() => {
    const p = String(location?.pathname || "/");
    if (p.startsWith("/analytics")) return "/analytics";
    if (p.startsWith("/settings"))  return "/settings";
    if (p.startsWith("/billing"))   return "/billing";
    if (p.startsWith("/dashboard")) return "/dashboard";
    return "/";
  }, [location?.pathname]);

  const level    = normalizeLevel(plan?.level);
  const isActive = ["active", "trialing", "current"].includes(plan?.status || "");
  const showChip = level !== "free" && isActive;

  return (
    <nav
      style={{
        background: "#FFFFFF",
        borderBottom: "1px solid #E4E7EE",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        height: "52px",
        position: "sticky",
        top: 0,
        zIndex: 100,
        boxShadow: "0 1px 3px rgba(15,24,41,0.06)",
        fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* ── Left: logo mark + nav items ── */}
      <div style={{ display: "flex", alignItems: "center", height: "100%", gap: "2px" }}>

        {/* Logo mark */}
        <div
          style={{
            width: "26px", height: "26px", borderRadius: "6px",
            background: GRAD,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "13px", fontWeight: "900", color: "white",
            marginRight: "16px", flexShrink: 0,
            boxShadow: "0 2px 6px rgba(107,143,255,0.3)",
          }}
        >
          R
        </div>

        {/* Nav items */}
        {NAV_ITEMS.map((item) => {
          const active  = activePath === item.path;
          const isHover = hovered === item.path;
          return (
            <div
              key={item.path}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`${item.path}${qs}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`${item.path}${qs}`)}
              onMouseEnter={() => setHovered(item.path)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: "flex", alignItems: "center",
                height: "100%", padding: "0 14px",
                fontSize: "13px",
                fontWeight: active ? "600" : "500",
                color: active ? "#4338CA" : isHover ? "#2D3A55" : "#64748B",
                cursor: "pointer",
                position: "relative",
                userSelect: "none",
                transition: "color 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {item.label}
              {/* Active gradient underline */}
              {active && (
                <span style={{
                  position: "absolute", bottom: 0,
                  left: "14px", right: "14px",
                  height: "2px", background: GRAD,
                  borderRadius: "2px 2px 0 0",
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* ── Right: plan chip ── */}
      <div>
        {showChip ? (
          // Active paid plan — name + coloured dot
          <div style={{
            display: "flex", alignItems: "center", gap: "7px",
            padding: "5px 12px",
            background: "#F7F8FA", border: "1px solid #E4E7EE",
            borderRadius: "20px",
            fontSize: "12px", fontWeight: "600", color: "#2D3A55",
          }}>
            <div style={{
              width: "7px", height: "7px", borderRadius: "50%",
              background: planDotColor(level), flexShrink: 0,
            }} />
            {planLabel(level)}
            <span style={{ fontSize: "11px", fontWeight: "500", color: "#94A3B8" }}>· Active</span>
          </div>
        ) : plan && level === "free" ? (
          // Free plan loaded — show CTA chip
          <div
            onClick={() => navigate(`/billing${qs}`)}
            style={{
              display: "flex", alignItems: "center",
              padding: "5px 14px",
              background: GRAD, borderRadius: "20px",
              fontSize: "12px", fontWeight: "700", color: "white",
              cursor: "pointer",
              boxShadow: "0 2px 6px rgba(107,143,255,0.3)",
            }}
          >
            Choose a plan →
          </div>
        ) : null /* still loading — render nothing to avoid flash */}
      </div>
    </nav>
  );
}