// admin-ui/src/App.jsx
import React, { useEffect, useRef, useCallback } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import * as P from "@shopify/polaris";
import { initAppBridge } from "./appBridge";
import { consumeReturnTo } from "./utils/returnTo";

// Real pages
import Home from "./pages/Home.jsx";
import Analytics from "./pages/Analytics.jsx";
import Settings from "./pages/Settings.jsx";
import Billing from "./pages/Billing.jsx";
import Setup from "./pages/Setup.jsx";
import Welcome from "./pages/Welcome.jsx";


// (no app-bridge-react hooks here)

// ---------- Safe shells (no *.Section)
function PageShell({ title, children }) {
  return (
    <P.Box padding="400">
      <P.Text as="h1" variant="headingLg">{title}</P.Text>
      <P.Box paddingBlockStart="400">
        {children}
      </P.Box>
    </P.Box>
  );
}
function CardBody({ children }) {
  return (
    <P.Card>
      <P.Box padding="400">
        {children}
      </P.Box>
    </P.Card>
  );
}

// ---------- Simple top nav (no Polaris Navigation.Section)
function TopNav() {
  const { pathname } = useLocation();
  const nav = useNavigate();

  // Preserve current ?host / ?shop across in-app navigations (HashRouter-safe)
  const currentSearch = typeof window !== "undefined" ? (window.location.search || "") : "";

  const items = [
    { to: "/",          label: "Home" },
    { to: "/analytics", label: "Analytics" },
    { to: "/settings",  label: "Settings" },
    { to: "/billing",   label: "Billing" },
    // NOTE: We do NOT add "Setup" here; it’s reachable via Tabs/CTA and NavMenu.
  ];

  return (
    <P.Box padding="300" borderBlockEndWidth="025" borderColor="border" as="nav">
      <P.InlineStack gap="200">
        {items.map(it => (
          <P.Button
            key={it.to}
            onClick={() => nav(`${it.to}${currentSearch}`)}
            variant={pathname === it.to ? "primary" : "secondary"}
          >
            {it.label}
          </P.Button>
        ))}
      </P.InlineStack>
    </P.Box>
  );
}

// ---------- Pages (placeholders for now)
const NotFound = () => (
  <PageShell title="Not found">
    <CardBody><P.Text as="p">Not Found ❌</P.Text></CardBody>
  </PageShell>
);

// ---------- App Bridge TitleBar (guarded so it can’t blank UI)
function TitleBarSync() {
  const { pathname } = useLocation();
  const tbRef = useRef(null);
  const bridgeRef = useRef(null);
  const redirectRef = useRef(null);
  const enableAB = new URLSearchParams(window.location.search).get("ab") === "1";

  function titleFor(path) {
    if (path.startsWith("/setup"))     return "Setup";
    if (path.startsWith("/analytics")) return "Analytics";
    if (path.startsWith("/settings"))  return "Settings";
    if (path.startsWith("/billing"))   return "Billing";
    return "Home";
  }

  // Build a hash-based in-app path preserving host/shop.
  function buildAppPath(path) {
    const ensureSlash = String(path || "/").startsWith("/") ? String(path) : `/${path}`;
    const hashQ = (window.location.hash || "").split("?")[1] || "";
    const searchQ = (window.location.search || "").replace(/^\?/, "");
    const current = new URLSearchParams(hashQ || searchQ);
    const host = current.get("host") || "";
    const shop = current.get("shop") || "";
    const qs = new URLSearchParams();
    if (host) qs.set("host", host);
    if (shop) qs.set("shop", shop);
    const q = qs.toString();
    // App Bridge APP redirect will set iframe location; our SPA listens to hash.
    return q ? `/#${ensureSlash}?${q}` : `/#${ensureSlash}`;
  }

  // Compute per-route buttons
  function buttonsFor(path) {
    // We only add actions for Home and Setup; others keep title only.
    if (!redirectRef.current) return undefined;

    const go = (to) => {
      try {
        const href = buildAppPath(to);
        redirectRef.current.dispatch(bridgeRef.current.actions.Redirect.Action.APP, href);
      } catch {}
    };

    if (path === "/") {
      return {
        primary: {
          label: "Finish setup",
          onAction: () => go("/setup"),
        },
      };
    }

    if (path.startsWith("/setup")) {
      return {
        secondary: [
          {
            label: "Back to Home",
            onAction: () => go("/"),
          },
        ],
      };
    }

    return undefined;
  }

  useEffect(() => {
    if (!enableAB) return;
    try {
      const bridge = initAppBridge();
      bridgeRef.current = bridge;
      const { TitleBar, Redirect } = bridge.actions || {};
      if (Redirect && bridge.app) {
        redirectRef.current = Redirect.create(bridge.app);
      }
      if (TitleBar) {
        tbRef.current = TitleBar.create(bridge.app, {
          title: titleFor(pathname),
          buttons: buttonsFor(pathname) || {},
        });
      }
    } catch (e) {
      console.warn("TitleBar init skipped:", e?.message || e);
    }
    return () => { tbRef.current = null; redirectRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableAB]);

  useEffect(() => {
    if (!enableAB) return;
    const b = bridgeRef.current;
    if (!b || !tbRef.current) return;
    try {
      tbRef.current.set({
        title: titleFor(pathname),
        buttons: buttonsFor(pathname) || {},
      });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, enableAB]);

  return null;
}

// ---------- NEW: consume return_to inside Router context (preserve host/shop)
function ReturnToSync() {
  const navigate = useNavigate();

  // Wrap navigate so we always keep the current ?host / ?shop in the hash query
  const navigateWithHost = useCallback((path) => {
    const search = typeof window !== "undefined" ? (window.location.search || "") : "";
    // If 'path' already has a query, leave it; otherwise append current search
    const target = path.includes("?") ? path : `${path}${search}`;
    navigate(target, { replace: true });
  }, [navigate]);

  useEffect(() => {
    consumeReturnTo(navigateWithHost);
  }, [navigateWithHost]);
  return null;
}

// ---------- App
export default function App() {
  return (
    <P.Frame>
      <HashRouter>
        <TitleBarSync />
        <ReturnToSync /> {/* keeps return_to flows host-safe */}
        <TopNav />
        <P.Box padding="400">
          <Routes>
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/" element={<Home />} />
            <Route path="/setup" element={<Setup />} />        {/* NEW ROUTE */}
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/home" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </P.Box>
      </HashRouter>
    </P.Frame>
  );
}
