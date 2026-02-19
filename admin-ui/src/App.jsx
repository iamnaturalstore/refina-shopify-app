// admin-ui/src/App.jsx  — baseline (pre-Welcome/Get-Started)

// Core
import React, { useEffect, useRef } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import * as P from "@shopify/polaris";

// App Bridge (title only)
import { initAppBridge } from "./appBridge";

// Pages
import Home from "./pages/Home.jsx";
import Analytics from "./pages/Analytics.jsx";
import Settings from "./pages/Settings.jsx";
import Billing from "./pages/Billing.jsx";
import Welcome from "./pages/Welcome.jsx";

import "./refina-admin.css";


// ---------- Safe shells (used by 404 etc.)
function PageShell({ title, children }) {
  return (
    <P.Box padding="400">
      <P.Text as="h1" variant="headingLg">{title}</P.Text>
      <P.Box paddingBlockStart="400">{children}</P.Box>
    </P.Box>
  );
}
function CardBody({ children }) {
  return (
    <P.Card>
      <P.Box padding="400">{children}</P.Box>
    </P.Card>
  );
}

// ---------- Simple top nav (no host/shop propagation)
function TopNav() {
  const { pathname } = useLocation();
  const nav = useNavigate();

  const items = [
    { to: "/",          label: "Home" },
    { to: "/analytics", label: "Analytics" },
    { to: "/settings",  label: "Settings" },
    { to: "/billing",   label: "Billing" },
    // NOTE: Setup not in primary nav (reachable via CTA)
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

// ---------- NotFound
const NotFound = () => (
  <PageShell title="Not found">
    <CardBody><P.Text as="p">Not Found ❌</P.Text></CardBody>
  </PageShell>
);

// ---------- TitleBarSync (title only; no buttons, no AB gate)
function TitleBarSync() {
  const { pathname } = useLocation();
  const tbRef = useRef(null);
  const bridgeRef = useRef(null);

  function titleFor(path) {
    if (path.startsWith("/setup"))     return "Setup";
    if (path.startsWith("/analytics")) return "Analytics";
    if (path.startsWith("/settings"))  return "Settings";
    if (path.startsWith("/billing"))   return "Billing";
    return "Home";
  }

  useEffect(() => {
    try {
      const bridge = initAppBridge();
      bridgeRef.current = bridge;
      const { TitleBar } = bridge.actions || {};
      if (TitleBar && bridge.app) {
        tbRef.current = TitleBar.create(bridge.app, { title: titleFor(pathname) });
      }
    } catch (e) {
      console.warn("TitleBar init skipped:", e?.message || e);
    }
    return () => { tbRef.current = null; bridgeRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tbRef.current) return;
    try {
      tbRef.current.set({ title: titleFor(pathname) });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

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
            <Route path="/" element={<Welcome />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/dashboard" element={<Home />} />
            {/* optional alias: */}
            <Route path="/home" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </P.Box>
      </HashRouter>
    </P.Frame>
  );
}
