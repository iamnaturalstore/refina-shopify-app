// BFF-first UI: fetches settings, uses dynamic copy, and reports analytics correctly.

import React, { useEffect, useState, useCallback } from "react";
import styles from "./CustomerRecommender.module.css";

const API_PREFIX = "/apps/refina/v1";

// --- Helper Functions (No changes needed) ---
function decodeEntities(str = "") { /* ... */ }
function teaserFromHtml(html = "", max = 140) { /* ... */ }
function formatPrice(val) { /* ... */ }

export default function CustomerRecommender() {
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(null); // NEW: State for settings

  const [commonConcerns, setCommonConcerns] = useState([]);
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [copy, setCopy] = useState({ why: "", rationale: "", extras: "" });
  const [reasonsById, setReasonsById] = useState({});

  const [selectedProduct, setSelectedProduct] = useState(null);

  // NEW: useEffect to fetch settings on initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        console.log("[Recommender] Fetching settings...");
        const r = await fetch(`${API_PREFIX}/settings`);
        if (!r.ok) throw new Error(`settings fetch failed with status ${r.status}`);
        const settingsJson = await r.json();
        console.log("[Recommender] Settings loaded:", settingsJson);
        if (!cancelled) setSettings(settingsJson);
      } catch (e) {
        console.error("[Recommender] Could not load settings:", e);
        if (!cancelled) setSettings({}); // Set to empty object on failure to avoid render errors
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // useEffect to load chips (common concerns)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_PREFIX}/concerns`);
        if (!r.ok) throw new Error(`concerns ${r.status}`);
        const j = await r.json();
        if (!cancelled) setCommonConcerns(Array.isArray(j.chips) ? j.chips : []);
      } catch (_e) {
        if (!cancelled) setCommonConcerns([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRecommend = useCallback(async (nextConcern) => {
    const q = String(nextConcern ?? concern).trim();
    if (!q) return;

    setLoading(true);
    setMatchedProducts([]);
    setCopy({ why: "", rationale: "", extras: "" });
    setReasonsById({});
    setLastQuery(q);

    try {
      const resp = await fetch(`${API_PREFIX}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concern: q })
      });
      if (!resp.ok) throw new Error(`recommend ${resp.status}`);

      const data = await resp.json();
      const products = Array.isArray(data?.products) ? data.products : [];
      const cpy = data?.copy || { why: "", rationale: "", extras: "" };
      const rbi = data?.reasonsById && typeof data.reasonsById === "object" ? data.reasonsById : {};

      setMatchedProducts(products);
      setCopy({
        why: String(cpy.why || ""),
        rationale: String(cpy.rationale || ""),
        extras: String(cpy.extras || "")
      });
      setReasonsById(rbi);

      // MOVED & CORRECTED: Emit analytics event AFTER a successful recommendation
      try {
        console.log("[Recommender] Reporting analytics event for concern:", q);
        window.RefinaAnalytics?.report({
          type: "concern",
          concern: q,
          productIds: products.map(p => p.id),
          plan: (window.__REFINA__ && __REFINA__.plan) || "unknown",
          model: (data?.meta?.model || data?.meta?.source) || ""
        });
      } catch (analyticsError) {
        console.warn("[Recommender] Analytics reporting failed:", analyticsError);
      }

    } catch (_e) {
      setMatchedProducts([]);
      setCopy({
        why: "Gentle, low-foam cleansing preserves your skin barrier.",
        rationale: "I couldn’t fetch smart picks just now, so I’ve kept things simple.",
        extras: "Use lukewarm water and pat dry—no scrubbing."
      });
      setReasonsById({});
    } finally {
      setLoading(false);
    }
  }, [concern]);

  const onTextKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) handleRecommend();
    }
  };
  
  // Use dynamic copy from settings, with fallbacks
  const headingText = settings?.copy?.heading || "Let’s find your perfect pick";
  const subheadingText = settings?.copy?.subheading || "Tell me what you’re after and I’ll fetch the best fits.";

  return (
    <div className={styles.container}>
      {/* CORRECTED: Use dynamic text from settings */}
      <h1 className={styles.heading}>{headingText}</h1>
      <p className={styles.subtext}>{subheadingText}</p>

      {commonConcerns.length > 0 && (
        <div className={styles.concernButtons}>
          {commonConcerns.slice(0, 6).map((item) => (
            <button
              key={item}
              className={styles.chip}
              onClick={() => {
                setConcern(item);
                handleRecommend(item);
              }}
              aria-label={`Use suggestion: ${item}`}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      <textarea
        className={styles.textarea}
        value={concern}
        onChange={(e) => setConcern(e.target.value)}
        onKeyDown={onTextKeyDown}
        placeholder="Type your concern… (Enter to Ask, Shift+Enter for new line)"
      />

      <button
        className={styles.askButton}
        onClick={() => handleRecommend()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? <>Thinking<span className={styles.dots} aria-hidden="true" /></> : (settings?.copy?.ctaText || "Get picks")}
      </button>

      {/* --- Rest of the JSX remains the same --- */}
      {(copy.why || copy.rationale || copy.extras) && ( <div className={styles.responseBox} aria-live="polite"> {/* ... */} </div> )}
      {matchedProducts.length > 0 && ( <> {/* ... */} </> )}
      {selectedProduct && ( <div className={styles.modalOverlay} onClick={() => setSelectedProduct(null)}> {/* ... */} </div> )}
    </div>
  );
}
