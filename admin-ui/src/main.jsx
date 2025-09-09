import React from "react";
import ReactDOM from "react-dom/client";
import "@shopify/polaris/build/esm/styles.css";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import App from "./App.jsx";

// One-time authenticated fetch wiring (prevents fallback/race conditions)
import { authenticatedFetch } from "@shopify/app-bridge-utils";
import app from "./appBridge";
import { setAuthedFetch } from "./api/client";

try {
  setAuthedFetch(authenticatedFetch(app));
} catch {
  // noop: fallback path in client will still work if this fails
}

console.log("ADMIN-UI BUILD", import.meta.env.VITE_BUILD_ID);

ReactDOM.createRoot(document.getElementById("root")).render(
  <AppProvider i18n={en}>
    <App />
  </AppProvider>
);
