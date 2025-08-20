// admin-ui/src/App.jsx
import React, { useEffect, useRef } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import * as P from "@shopify/polaris";
import { initAppBridge } from "./appBridge";

// Real pages
import Home from "./pages/Home.jsx";
import Analytics from "./pages/Analytics.jsx";
import Settings from "./pages/Settings.jsx";
import Billing from "./pages/Billing.jsx";

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

  const items = [
    { to: "/",          label: "Home" },
    { to: "/analytics", label: "Analytics" },
    { to: "/settings",  label: "Settings" },
    { to: "/billing",   label: "Billing" },
  ];

  return (
    <P.Box padding="300" borderBlockEndWidth="025" borderColor="border" as="nav">
      <P.InlineStack gap="200">
        {items.map(it => (
          <P.Button
            key={it.to}
            onClick={() => nav(it.to)}
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
  const enableAB = new URLSearchParams(window.location.search).get("ab") === "1";

  function titleFor(path) {
    if (path.startsWith("/analytics")) return "Analytics";
    if (path.startsWith("/settings"))  return "Settings";
    if (path.startsWith("/billing"))   return "Billing";
    return "Home";
  }

  useEffect(() => {
    if (!enableAB) return;
    try {
      const bridge = initAppBridge();
      bridgeRef.current = bridge;
      const { TitleBar } = bridge.actions || {};
      if (TitleBar) tbRef.current = TitleBar.create(bridge.app, { title: titleFor(pathname) });
    } catch (e) {
      console.warn("TitleBar init skipped:", e?.message || e);
    }
    return () => { tbRef.current = null; };
  }, [enableAB]);

  useEffect(() => {
    if (!enableAB) return;
    const b = bridgeRef.current;
    if (!b || !tbRef.current) return;
    try { tbRef.current.set({ title: titleFor(pathname) }); } catch {}
  }, [pathname, enableAB]);

  return null;
}

// ---------- App
export default function App() {
  return (
    <P.Frame>
      <HashRouter>
        <TitleBarSync />
        <TopNav />
        <P.Box padding="400">
          <Routes>
            <Route path="/" element={<Home />} />
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
