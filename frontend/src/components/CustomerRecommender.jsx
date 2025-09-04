// frontend/src/components/CustomerRecommender.jsx  BFF-first UI: fetches settings, uses dynamic copy, and reports analytics correctly.

import React, { useEffect, useState, useCallback } from "react";
import styles from "./CustomerRecommender.module.css";

const API_PREFIX = "/apps/refina/v1";

// --- Helper Functions ---
function decodeEntities(str = "") {
  return String(str).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function teaserFromHtml(html = "", max = 140) {
  const txt = decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return txt.length > max ? `${txt.slice(0, max)}…` : txt;
}
function formatPrice(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

export default function CustomerRecommender() {
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(null);

  const [commonConcerns, setCommonConcerns] = useState([]);
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [copy, setCopy] = useState({ why: "", rationale: "", extras: "" });
  const [reasonsById, setReasonsById] = useState({});

  const [selectedProduct, setSelectedProduct] = useState(null);

  // useEffect to fetch settings on initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_PREFIX}/settings`);
        if (!r.ok) throw new Error(`settings fetch failed with status ${r.status}`);
        const settingsJson = await r.json();
        if (!cancelled) setSettings(settingsJson);
      } catch (e) {
        console.error("[Recommender] Could not load settings:", e);
        if (!cancelled) setSettings({});
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
      setCopy({ why: String(cpy.why || ""), rationale: String(cpy.rationale || ""), extras: String(cpy.extras || "") });
      setReasonsById(rbi);

      // FINAL FIX: Use a standard fetch with the correct Content-Type header.
      try {
        console.log("[Recommender] Reporting analytics event for concern:", q);
        const analyticsPayload = {
          type: "concern",
          event: "recommendation_received", // Added for clarity
          concern: q,
          productIds: products.map(p => p.id),
          meta: {
             plan: (window.__REFINA__ && __REFINA__.plan) || "unknown",
             model: (data?.meta?.model || data?.meta?.source) || ""
          }
        };
        
        // Using fetch guarantees the Content-Type header is set correctly.
        // `keepalive: true` ensures the request completes even if the user navigates away.
        fetch(`${API_PREFIX}/analytics/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(analyticsPayload),
          keepalive: true
        });

      } catch (analyticsError) {
        console.warn("[Recommender] Analytics reporting failed:", analyticsError);
      }

    } catch (_e) {
      setMatchedProducts([]);
      setCopy({ why: "Gentle, low-foam cleansing preserves your skin barrier.", rationale: "I couldn’t fetch smart picks just now, so I’ve kept things simple.", extras: "Use lukewarm water and pat dry—no scrubbing." });
      setReasonsById({});
    } finally {
      setLoading(false);
    }
  }, [concern]);

  const onTextKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) handleRecommend(concern);
    }
  };
  
  const headingText = settings?.copy?.heading || "Let’s find your perfect pick";
  const subheadingText = settings?.copy?.subheading || "Tell me what you’re after and I’ll fetch the best fits.";
  const ctaText = settings?.copy?.ctaText || "Get picks";

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>{headingText}</h1>
      <p className={styles.subtext}>{subheadingText}</p>
      
      {commonConcerns.length > 0 && (
        <div className={styles.concernButtons}>
          {commonConcerns.slice(0, 6).map((item) => (
            <button key={item} className={styles.chip} onClick={() => { setConcern(item); handleRecommend(item); }} aria-label={`Use suggestion: ${item}`}>{item}</button>
          ))}
        </div>
      )}

      <textarea className={styles.textarea} value={concern} onChange={(e) => setConcern(e.target.value)} onKeyDown={onTextKeyDown} placeholder="Type your concern… (Enter to Ask, Shift+Enter for new line)" />

      <button className={styles.askButton} onClick={() => handleRecommend(concern)} disabled={loading} aria-busy={loading}>
        {loading ? <>Thinking<span className={styles.dots} aria-hidden="true" /></> : ctaText}
      </button>

      {(copy.why || copy.rationale || copy.extras) && ( <div className={styles.responseBox} aria-live="polite"> <h2>Here’s what I’d pick</h2> {copy.why ? <p className={styles.opener}>{copy.why}</p> : null} {copy.rationale ? <p className={styles.blurb}>{copy.rationale}</p> : null} {copy.extras ? <p className={styles.usageNote}>{copy.extras}</p> : null} </div> )}
      
      {matchedProducts.length > 0 && ( <> <div className={styles.responseBox}> <h2>Top matches</h2> <p>Tap a product to see details.</p> </div> <div className={styles.grid} role="list"> {matchedProducts.map((product, idx) => { const isTopPick = idx === 0; const reason = reasonsById?.[product.id] || ""; const teaser = reason || teaserFromHtml(product.description || ""); return ( <div key={product.id || product.name} className={styles.card} role="listitem" onClick={() => setSelectedProduct(product)}> <img src={product.image} alt={product.name} className={styles.image} onError={(e) => { e.currentTarget.src = "https://cdn.shopify.com/s/images/admin/no-image-compact.gif"; }} /> {isTopPick && <div className={styles.topPickBadge} aria-label="Top pick">Top pick</div>} <h3 className={styles.productTitle}>{product.name}</h3> <p className={styles.productDescription}>{decodeEntities(teaser)}</p> {formatPrice(product.price) && <div className={styles.price}>{formatPrice(product.price)}</div>} </div> ); })} </div> </> )}
      
      {selectedProduct && ( <div className={styles.modalOverlay} onClick={() => setSelectedProduct(null)}> <div className={styles.modal} onClick={(e) => e.stopPropagation()}> <h2>{selectedProduct.name}</h2> <div style={{ marginTop: 4, opacity: 0.7, fontSize: 13 }}> Why this fits <span style={{ opacity: 0.6 }}>— “{lastQuery}”</span> </div> <img src={selectedProduct.image} alt={selectedProduct.name} onError={(e) => { e.currentTarget.src = "https://cdn.shopify.com/s/images/admin/no-image-compact.gif"; }} style={{ marginTop: 12 }} /> <div style={{ marginTop: 12, lineHeight: 1.5 }}> {reasonsById?.[selectedProduct.id] ? (<p>{reasonsById[selectedProduct.id]}</p>) : (<p>{teaserFromHtml(selectedProduct.description || "")}</p>)} {copy.extras ? <p style={{ opacity: 0.85 }}>{copy.extras}</p> : null} </div> <a href={selectedProduct.url || selectedProduct.link || "#"} target="_blank" rel="noopener noreferrer" className={styles.buyNow}> Buy Now </a> </div> </div> )}
    </div>
  );
}
