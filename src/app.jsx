// src/app.jsx
import {AppProvider} from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import {HashRouter, Routes, Route, Navigate, useLocation} from "react-router-dom";

import AdminLayout from "./components/AdminLayout.jsx";
import Home from "./pages/Home.jsx";
import Settings from "./pages/Settings.jsx";
import Analytics from "./pages/Analytics.jsx";
import Billing from "./pages/Billing.jsx";
import NotFound from "./pages/NotFound.jsx";

function RouteDebugger() {
  const loc = useLocation();
  console.log("RouteDebugger:", {
    pathname: loc.pathname,
    hash: window.location.hash,
    full: window.location.href,
  });
  return null;
}

export default function App() {
  return (
    <AppProvider i18n={en}>
      <HashRouter>
        <AdminLayout>
          <RouteDebugger />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/home" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AdminLayout>
      </HashRouter>
    </AppProvider>
  );
}
