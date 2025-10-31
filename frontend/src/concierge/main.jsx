// frontend/src/concierge/main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import CustomerRecommender from "../components/CustomerRecommender.jsx";

const rootEl = document.getElementById("root");

// Read ?prefill= from the iframe URL (PDP Assist → launcher adds this)
let initialPrompt = "";
try {
  const params = new URLSearchParams(window.location.search);
  initialPrompt = params.get("prefill") || "";
} catch {}

const props = {
  initialStoreId: rootEl?.dataset.storeId || null,
  shop: rootEl?.dataset.shop || null,
  initialPrompt,
};

if (rootEl) {
  createRoot(rootEl).render(<CustomerRecommender {...props} />);
}
