import React from "react";
import ReactDOM from "react-dom/client";
import "@shopify/polaris/build/esm/styles.css";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import App from "./App.jsx";

console.log('ADMIN-UI BUILD', import.meta.env.VITE_BUILD_ID);

ReactDOM.createRoot(document.getElementById("root")).render(
  <AppProvider i18n={en}>
    <App />
  </AppProvider>
);
