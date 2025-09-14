import React from "react";
import ReactDOM from "react-dom/client";
import "@shopify/polaris/build/esm/styles.css";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import App from "./App.jsx";

import app from "./appBridge";
import { authenticatedFetch } from "@shopify/app-bridge/utilities";
import { setAuthedFetch } from "./api/client";

// Fail-fast: if authenticatedFetch cannot be initialized, throw
const authed = authenticatedFetch(app);
if (typeof authed !== "function") {
  throw new Error("[AdminUI] authenticatedFetch initialization failed.");
}
setAuthedFetch(authed);

// Minimal, safe info message (no secrets)
console.info("[AdminUI] App Bridge ready; authenticated fetch wired.");

ReactDOM.createRoot(document.getElementById("root")).render(
  <AppProvider i18n={en}>
    <App />
  </AppProvider>
);
