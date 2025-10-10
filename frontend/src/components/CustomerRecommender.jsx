// frontend/src/components/CustomerRecommender.jsx
import React, { useEffect, useState, useCallback } from "react";
import styles from "./CustomerRecommender.module.css";

const API_PREFIX = "/apps/refina/v1";

// --- Helper Functions ---
function decodeEntities(str = "") {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function teaserFromHtml(html = "", max = 140) {
  const txt = decodeEntities(
    String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );
  return txt.length > max ? `${txt.slice(0, max)}…` : txt;
}
// Extract the first N real paragraphs from an HTML description.
// Falls back to a clean teaser if no <p> tags exist.
function extractFirstParagraphsFromHtml(html = "", maxParas = 2) {
  const s = String(html || "");
  const matches = s.match(/<p\b[^>]*>(.*?)<\/p>/gis);
  let paras = [];

  if (matches && matches.length) {
    paras = matches
      .map(p => decodeEntities(p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
      .filter(Boolean)
      .slice(0, maxParas);
  } else {
    // fallback: split by sentence if there are no <p> tags
    const flat = decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (flat) {
      const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
      const first = sentences.slice(0, Math.max(1, maxParas)).join(" ");
      if (first) paras = [first];
    }
  }

  return paras;
}

function formatPrice(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

// New helper hook to read settings from URL parameters
function useUrlSettings() {
  const [settings, setSettings] = useState({});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlSettings = {};
    for (const [key, value] of params.entries()) {
      // Convert kebab-case (e.g., 'primary-color') to camelCase (e.g., 'primaryColor')
      const camelCaseKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
      urlSettings[camelCaseKey] = value;
    }
    setSettings(urlSettings);
  }, []);

  return settings;
}

// --- Local helpers for Awesome/copy fallbacks ---
function normalizeProducts(list = []) {
  // Backend sends {id,title,price,image,url} (no `name`, no `description`).
  // Map to the UI’s expected shape and keep original fields.
  return list.map((p) => ({
    ...p,
    name: p.name || p.title || "", // UI expects `name`
    description: p.description || "", // may be empty; UI has a fallback
  }));
}
function buildReasonsMapFromAwesome(awesome) {
  const map = {};
  if (!awesome) return map;
  if (awesome.primary?.id && Array.isArray(awesome.primary.reasons)) {
    map[String(awesome.primary.id)] = awesome.primary.reasons.join(" ");
  }
  if (Array.isArray(awesome.alternatives)) {
    for (const alt of awesome.alternatives) {
      if (alt?.id && Array.isArray(alt.reasons)) {
        map[String(alt.id)] = alt.reasons.join(" ");
      }
    }
  }
  return map;
}
function buildCopyFromAwesome(awesome, fallbackExplanation = "") {
  if (!awesome) {
    return {
      why: String(fallbackExplanation || ""),
      rationale: "",
      extras: "",
    };
  }
  const oneLiner = awesome.explanation?.oneLiner || "";
  const friendly = awesome.explanation?.friendlyParagraph || "";
  const expertBullets = Array.isArray(awesome.explanation?.expertBullets)
    ? awesome.explanation.expertBullets.join(" ")
    : "";
  const usageTips = Array.isArray(awesome.explanation?.usageTips)
    ? awesome.explanation.usageTips.join(" ")
    : "";

  const why = friendly || oneLiner || "";
  const rationale = awesome.copy?.rationale || expertBullets || "";
  const extras = awesome.copy?.extras || usageTips || "";

  return { why, rationale, extras };
}
function teaserForCard(product, reasonsById) {
  const reason = reasonsById?.[product.id] || "";
  if (reason) return decodeEntities(reason);
  // Backend does not send `description`; if empty after decode, show a safe line.
  const fromDesc = teaserFromHtml(product.description || "");
  return fromDesc || "A solid match for your request.";
}
// Split a reason into a short lead sentence + the remaining rationale.
function splitFirstSentence(text = "") {
  const s = String(text).trim();
  if (!s) return { lead: "", rest: "" };
  // First sentence ends at ., !, or ? followed by space/end
  const m = s.match(/^(.+?[.!?])(\s+|$)([\s\S]*)$/);
  if (!m) return { lead: s, rest: "" };
  const lead = m[1].trim();
  const rest = (m[3] || "").trim();
  return { lead, rest };
}

export default function CustomerRecommender() {
  const settings = useUrlSettings();
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const [commonConcerns, setCommonConcerns] = useState([]);
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [copy, setCopy] = useState({ why: "", rationale: "", extras: "" });
  const [reasonsById, setReasonsById] = useState({});

  const [selectedProduct, setSelectedProduct] = useState(null);

  // useEffect to apply theme settings from URL
  useEffect(() => {
    const root = document.documentElement;
    if (!root || !settings) return;

    // Map URL settings to CSS variables
    const stylesToApply = {
      "--rf-primary-color": settings.primaryColor,
      "--rf-accent-color": settings.accentColor,
      // Simple mapping for border-radius. Assumes you have CSS classes/vars for sm, md, lg, 2xl.
      "--rf-border-radius": settings.borderRadius?.replace(
        /^(sm|md|lg|2xl)$/,
        "var(--rf-radius-$1)"
      ),
    };

    for (const [key, value] of Object.entries(stylesToApply)) {
      if (value) {
        root.style.setProperty(key, value);
      }
    }
  }, [settings]);

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
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRecommend = useCallback(
    async (nextConcern) => {
      const q = String(nextConcern ?? concern).trim();
      if (!q) return;

      setLoading(true);
      setMatchedProducts([]);
      setCopy({ why: "", rationale: "", extras: "" });
      setReasonsById({});
      setLastQuery(q);

      try {
        // --- resolve storeId from ?shop= or #root[data-shop] ---
        const storeId =
          new URLSearchParams(location.search).get("shop") ||
          document.getElementById("root")?.dataset.shop ||
          "";

        const resp = await fetch(`${API_PREFIX}/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // include { storeId, concern } in body
          body: JSON.stringify({ storeId, concern: q }),
        });
        if (!resp.ok) throw new Error(`recommend ${resp.status}`);

        const data = await resp.json();

        // 1) Normalize products to have `name`
        const products = normalizeProducts(
          Array.isArray(data?.products) ? data.products : []
        );

        // 2) Build reasonsById from Awesome
        const reasonsMap = buildReasonsMapFromAwesome(data?.awesome);

        // 3) Populate copy: prefer Awesome, else backend explanation (fallback)
        const copyOut = buildCopyFromAwesome(data?.awesome, data?.explanation || "");

        setMatchedProducts(products);
        setCopy({
          why: String(copyOut.why || ""),
          rationale: String(copyOut.rationale || ""),
          extras: String(copyOut.extras || ""),
        });
        setReasonsById(reasonsMap);

        // Analytics (best-effort)
        try {
          // Resolve storeId again the same way as for /recommend
          const storeId2 =
            new URLSearchParams(location.search).get("shop") ||
            document.getElementById("root")?.dataset.shop ||
            "";

          const analyticsPayload = {
            storeId: storeId2, // ✅ include canonical shop id
            type: "concern",
            event: "recommendation_received",
            concern: q,
            productIds: products.map((p) => p.id),
            meta: {
              plan: (window.__REFINA__ && __REFINA__.plan) || "unknown",
              model: (data?.meta?.model || data?.meta?.source) || "",
            },
          };

          fetch(`${API_PREFIX}/analytics/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(analyticsPayload),
            keepalive: true,
          });
        } catch (analyticsError) {
          console.warn("[Recommender] Analytics reporting failed:", analyticsError);
        }
      } catch (_e) {
        setMatchedProducts([]);
        setCopy({
          why: "Gentle, low-foam cleansing preserves your skin barrier.",
          rationale:
            "I couldn’t fetch smart picks just now, so I’ve kept things simple.",
          extras: "Use lukewarm water and pat dry—no scrubbing.",
        });
        setReasonsById({});
      } finally {
        setLoading(false);
      }
    },
    [concern]
  );

  const onTextKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) handleRecommend(concern);
    }
  };

  const headingText = settings.heading || "Let’s find your perfect pick";
  const subheadingText =
    settings.subheading || "Tell me what you’re after and I’ll fetch the best fits.";
  // === Ask button label wiring (Theme Editor: "In-Widget Button Text") ===
// useUrlSettings() converts ?widget-cta-text=... → settings.widgetCtaText
const widgetCtaOverride = (settings.widgetCtaText || "").trim();

// Optional soft fallback if you still want to accept any legacy param
// coming through as `ctaText` (safe to keep, harmless if absent).
const legacyCta = (settings.ctaText || "").trim();

// Final label priority: URL override → legacy → safe default.
// (Change the default if you prefer another phrase.)
const askLabel = widgetCtaOverride || legacyCta || "Find My Products";


  return (
    <div className={styles.container}>
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
  data-refina-ask-btn
  className={styles.askButton}
  onClick={() => handleRecommend(concern)}
  disabled={loading}
  aria-busy={loading}
>
  {loading ? (
    <>
      Researching<span className={styles.dots} aria-hidden="true" />
    </>
  ) : (
    askLabel
  )}
</button>


      {(copy.why || copy.rationale || copy.extras) && (
        <div className={styles.responseBox} aria-live="polite">
          <h2>Here’s what I’d pick</h2>
          {copy.why ? <p className={styles.opener}>{copy.why}</p> : null}
          {copy.rationale ? <p className={styles.blurb}>{copy.rationale}</p> : null}
          {copy.extras ? <p className={styles.usageNote}>{copy.extras}</p> : null}
        </div>
      )}

      {matchedProducts.length > 0 && (
        <>
          <div className={styles.responseBox}>
            <h2>Top matches</h2>
            <p>Tap a product to see details.</p>
          </div>

          <div className={styles.grid} role="list">
            {matchedProducts.map((product, idx) => {
              const isTopPick = idx === 0;
              const teaser = teaserForCard(product, reasonsById);

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
                  {isTopPick && (
                    <div className={styles.topPickBadge} aria-label="Top pick">
                      Top pick
                    </div>
                  )}
                  <h3 className={styles.productTitle}>{product.name}</h3>
                  <p className={styles.productDescription}>{teaser}</p>
                  {formatPrice(product.price) && (
                    <div className={styles.price}>{formatPrice(product.price)}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

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
            <div style={{ marginTop: 12, lineHeight: 1.5 }}>
  {(() => {
    // 1–2 opening paragraphs from the product description (preferred)
    const paras = extractFirstParagraphsFromHtml(selectedProduct.description || "", 2);

    if (paras.length) {
      return (
        <>
          <p>{paras[0]}</p>
          {paras[1] ? <p style={{ marginTop: 8 }}>{paras[1]}</p> : null}

          {/* Optional: a subtle, single-line "why this fits" if you still want it */}
          {reasonsById?.[selectedProduct.id] ? (
            <p style={{ opacity: 0.8, marginTop: 10 }}>
              <em>Why this fits:</em> {reasonsById[selectedProduct.id]}
            </p>
          ) : null}
        </>
      );
    }

    // Fallback: if no description, show reason or generic teaser
    return (
      <>
        <p>
          {reasonsById?.[selectedProduct.id] ||
            teaserFromHtml(selectedProduct.description || "") ||
            "A solid match for your request."}
        </p>
      </>
    );
  })()}
</div>


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
