// frontend/src/main.jsx
console.log("🟢 Refina Embed: v3 Direct-Mount Loader Executed");

import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./app.jsx";

import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase"; // make sure this exports the initialized auth object

// --- Theme color hydration (widget-only) ---
(() => {
  try {
    const qp = new URLSearchParams(window.location.search);
    const primary = qp.get("primary-color");
    const accent = qp.get("accent-color");
    if (primary) document.documentElement.style.setProperty("--rf-color-primary", primary);
    if (accent) document.documentElement.style.setProperty("--rf-accent-color", accent);
  } catch {}
})();

// --- Read prefill from URL once (widget-only) ---
let __rf_initialPrompt = "";
try {
  const qp = new URLSearchParams(window.location.search);
  __rf_initialPrompt = (qp.get("prefill") || "").trim();
} catch {}

/**
 * The Root component remains the same. It accepts the storeId and handles Firebase auth.
 */
function Root({ storeId }) {
  const [authReady, setAuthReady] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        console.log("✅ Firebase: Anonymous auth ready");
        setAuthReady(true);
      } else {
        signInAnonymously(auth)
          .then(() => console.log("✅ Firebase: Signed in anonymously"))
          .catch((err) => console.error("❌ Firebase anonymous auth failed", err));
      }
    });
    return () => unsubscribe();
  }, []);

  // Seed from ?prefill= if present (PDP Assist → iframe URL)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const prefill = params.get("prefill");
      if (prefill) setInitialPrompt(prefill);
    } catch {}
  }, []);

  if (!authReady) {
    return null;
  }

  return (
    <React.StrictMode>
      <App storeId={storeId} initialPrompt={__rf_initialPrompt} />
    </React.StrictMode>
  );
}

/**
 * FINAL, ROBUST MOUNTING LOGIC
 * This code now runs immediately, mirroring the timing of your old, working version,
 * while still using the safe data-fetching method required to prevent security errors.
 */
const rootElement = document.getElementById("refina-concierge-root");

if (rootElement) {
  // Safely get the storeId from the data attribute, with fallbacks. This is frame-safe.
  const storeId = rootElement.dataset.storeId || (window.Shopify && window.Shopify.shop) || null;

  if (storeId) {
    // Render the Root component immediately.
    ReactDOM.createRoot(rootElement).render(<Root storeId={storeId} />);
  } else {
    console.error("Refina Concierge: Could not determine store ID. App will not mount.");
    rootElement.innerHTML = "<div>Error: Could not identify the store.</div>";
  }
}
