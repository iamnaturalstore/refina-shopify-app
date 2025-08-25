// src/components/CustomerRecommender.jsx — BFF-first (clean skeleton, no chip parsing)
import React, { useEffect, useState } from "react";
import styles from "./CustomerRecommender.module.css";

// All calls are same-origin under the shop: /apps/refina/v1/*
const API_PREFIX = "/apps/refina/v1";

const qs = new URLSearchParams(window.location.search);
const PLAN = (qs.get("plan") || "free").toLowerCase();

function CustomerRecommender() {
  // Query + UI state
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);

  // From BFF
  const [commonConcerns, setCommonConcerns] = useState([]);
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [copy, setCopy] = useState({ why: "", rationale: "", extras: "" });

  // Modal
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Load chips from BFF (store inferred via App Proxy; no storeId in browser)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_PREFIX}/concerns`);
        if (!r.ok) throw new Error(`concerns ${r.status}`);
        const j = await r.json();
        if (!cancelled) {
          setCommonConcerns(Array.isArray(j.chips) ? j.chips : []);
        }
      } catch (e) {
        console.warn("Failed to load concerns chips:", e);
        if (!cancelled) setCommonConcerns([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRecommend(nextConcern) {
    const q = String(nextConcern ?? concern).trim();
    if (!q) return;

    setLoading(true);
    setMatchedProducts([]);
    setCopy({ why: "", rationale: "", extras: "" });
    setLastQuery(q);

    try {
      const resp = await fetch(`${API_PREFIX}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // storeId is never sent from the browser; server derives it from the App Proxy context
        body: JSON.stringify({ concern: q, plan: PLAN }),
      });
      if (!resp.ok) throw new Error(`recommend ${resp.status}`);

      const data = await resp.json();
      const products = Array.isArray(data?.products) ? data.products : [];
      const cpy = data?.copy || { why: "", rationale: "", extras: "" };

      setMatchedProducts(products);
      setCopy({
        why: String(cpy.why || ""),
        rationale: String(cpy.rationale || ""),
        extras: String(cpy.extras || ""),
      });
    } catch (e) {
      console.error("recommend error:", e);
      setMatchedProducts([]);
      setCopy({
        why: "Sorry — I couldn’t fetch smart picks right now.",
        rationale: "",
        extras: "",
      });
    } finally {
      setLoading(false);
    }
  }

  // UI helpers
  const onTextKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) handleRecommend();
    }
  };

  const threeBullets = () => {
    return [copy.why, copy.rationale, copy.extras].filter(
      (s) => s && String(s).trim().length
    );
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>Let’s find your perfect pick</h1>
      <p className={styles.subtext}>
        Tell me what you’re after and I’ll fetch the best fits.
      </p>

      {/* Chips from BFF (if any). If none, this row stays minimal. */}
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
        {loading ? (
          <>
            Thinking<span className={styles.dots} aria-hidden="true" />
          </>
        ) : (
          "Get picks"
        )}
      </button>

      {/* Summary copy (store-wide for this query) */}
      {threeBullets().length > 0 && (
        <div className={styles.responseBox} aria-live="polite">
          <h2>Here’s what I’d pick</h2>
          <ul className={styles.reasonsList}>
            {threeBullets().map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Product cards */}
      {matchedProducts.length > 0 && (
        <>
          <div className={styles.responseBox}>
            <h2>Top matches</h2>
            <p>Tap a product to see details.</p>
          </div>

          <div className={styles.grid} role="list">
            {matchedProducts.map((product, idx) => {
              const teaser = (() => {
                const txt = String(product.description || "").replace(
                  /<[^>]+>/g,
                  " "
                );
                const cut = 140;
                return txt.length > cut ? `${txt.slice(0, cut)}…` : txt;
              })();

              const isTopPick = idx === 0;

              return (
                <div
                  key={product.id || product.name}
                  className={styles.card}
                  role="listitem"
                  onClick={() => setSelectedProduct(product)}
                >
                  <img
                    src={product.image}
                    alt={product.name}
                    className={styles.image}
                    onError={(e) => {
                      e.currentTarget.src =
                        "https://cdn.shopify.com/s/images/admin/no-image-compact.gif";
                    }}
                  />

                  {isTopPick ? (
                    <div className={styles.topPickBadge} aria-label="Top pick">
                      Top pick
                    </div>
                  ) : null}

                  <h3 className={styles.productTitle}>{product.name}</h3>
                  <p className={styles.productDescription}>{teaser}</p>

                  {product.price != null && (
                    <div className={styles.price}>${product.price}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Modal: uses the 3-part copy as rationale for the selection */}
      {selectedProduct && (
        <div
          className={styles.modalOverlay}
          onClick={() => setSelectedProduct(null)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2>{selectedProduct.name}</h2>
            <div style={{ marginTop: 4, opacity: 0.7, fontSize: 13 }}>
              Why this fits <span style={{ opacity: 0.6 }}>— “{lastQuery}”</span>
            </div>
            <img
              src={selectedProduct.image}
              alt={selectedProduct.name}
              onError={(e) => {
                e.currentTarget.src =
                  "https://cdn.shopify.com/s/images/admin/no-image-compact.gif";
              }}
              style={{ marginTop: 12 }}
            />
            {threeBullets().length ? (
              <ul className={styles.reasonsList} style={{ marginTop: 12 }}>
                {threeBullets().map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            ) : (
              <p style={{ marginTop: 12 }}>
                {String(selectedProduct.description || "")
                  .replace(/<[^>]+>/g, " ")
                  .trim()}
              </p>
            )}

            <a
              href={selectedProduct.url || selectedProduct.link || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.buyNow}
            >
              Buy Now
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default CustomerRecommender;
