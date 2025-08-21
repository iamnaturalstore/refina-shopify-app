// frontend/src/concierge/main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import CustomerRecommender from "../components/CustomerRecommender.jsx";

const rootEl = document.getElementById("root");
const props = {
  initialStoreId: rootEl?.dataset.storeId || null,
  shop: rootEl?.dataset.shop || null,
};

if (rootEl) {
  createRoot(rootEl).render(<CustomerRecommender {...props} />);
}
