// frontend/src/components/CustomerRecommender.jsx
import React, { useEffect, useRef, useState } from "react";
import styles from "./CustomerRecommender.module.css";
import { stripHtml } from "../utils/stripHtml";

// ───────────────────────────
// Phase 2 helpers (UI + sort)
// ───────────────────────────
const ROUTINE_ORDER = [
  "cleanser",
  "toner",
  "essence",
  "serum",
  "treatment",
  "moisturiser",
  "moisturizer",
  "mask",
  "sunscreen",
  "spf",
  "oil",
];
const rankType = (t = "") => {
  const i = ROUTINE_ORDER.findIndex((k) => (t || "").toLowerCase().includes(k));
  return i === -1 ? 999 : i;
};

function deriveBadges(p, storeSettings) {
  if (storeSettings?.ui && storeSettings.ui.showBadges === false) return [];
  const tags = (p.tags || []).map((s) => String(s).toLowerCase());
  const ings = (p.ingredients || []).map((s) => String(s).toLowerCase());
  const type = String(p.productType || "").toLowerCase();
  const out = new Set();
  if (ings.some((x) => /niacinamide/.test(x)) || tags.includes("niacinamide"))
    out.add("Niacinamide");
  if (
    ings.some((x) => /ascorb|vitamin\s*c|thd/.test(x)) ||
    tags.some((x) => /vitamin\s*c|ascorb|rosehip|kakadu/.test(x))
  )
    out.add("Vitamin C");
  if (ings.some((x) => /retinol|retinal/.test(x))) out.add("Retinoid");
  if (ings.some((x) => /hyalur|(^|\W)ha($|\W)/.test(x))) out.add("Hyaluronic Acid");
  if (ings.some((x) => /ceramide/.test(x))) out.add("Ceramides");
  if (type.includes("sunscreen") || tags.includes("spf")) out.add("SPF");
  if (ings.some((x) => /zinc|titanium/.test(x)) && (type.includes("sunscreen") || tags.includes("spf")))
    out.add("Mineral");
  if (tags.includes("fragrance-free") || /fragrance[-\s]?free/.test((p.description || "").toLowerCase()))
    out.add("Fragrance-free");
  if (type.includes("oil")) out.add("Oil");
  if (type.includes("serum")) out.add("Serum");
  return Array.from(out).slice(0, 3);
}

// simple ingredient→benefit phrases for fallback bullets
const ING_BENEFITS = [
  { re: /niacinamide/, msg: "niacinamide to balance oil and even tone" },
  { re: /hyalur/, msg: "hyaluronic acid to pull in and hold moisture" },
  { re: /ceramide/, msg: "ceramides to fortify the skin barrier" },
  { re: /ascorb|vitamin\s*c|thd|tetrahexyldecyl/, msg: "vitamin C to brighten and support a firmer look" },
  { re: /retinol|retinal/, msg: "retinoids to smooth texture and renew overnight" },
  { re: /salicyl|bha/, msg: "BHA to decongest pores and reduce bumps" },
  { re: /lactic|glycolic|aha/, msg: "AHA to gently resurface for glow" },
  { re: /squalane/, msg: "squalane for lightweight, non-greasy moisture" },
  { re: /shea/, msg: "shea butter to deeply nourish and protect" },
  { re: /zinc|titanium/, msg: "mineral filters for gentle SPF defense" },
  { re: /shilajit/, msg: "mineral-dense shilajit for everyday vitality" },
  { re: /colloidal\s+silver/, msg: "colloidal silver for hygienic support" },
];

const FALLBACK_SUGGESTIONS = {
  Beauty: [
    "Hydrating cleanser",
    "Niacinamide serum",
    "Vitamin C face oil",
    "Retinol night routine",
    "Fragrance-free moisturiser",
  ],
  Haircare: [
    "Scalp soothing shampoo",
    "Heat protectant spray",
    "Curl defining cream",
    "Repair mask",
  ],
  "Body + Bath": [
    "KP (BHA) body lotion",
    "Retinol body treatment",
    "Mineral body SPF",
    "Hydrating body wash",
  ],
  Makeup: ["Blurring primer", "Skin tint", "Cream blush", "Long-wear concealer"],
};

// ───────────────────────────

function CustomerRecommender({ initialStoreId = null, shop = null }) {
  const [storeId, setStoreId] = useState(initialStoreId);
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [commonConcerns, setCommonConcerns] = useState([]);
  const [responseText, setResponseText] = useState("");
  const [storeSettings, setStoreSettings] = useState(null);
  const [plan, setPlan] = useState("free");
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);

  // AI extras
  const [aiReasons, setAiReasons] = useState(new Map()); // id(lowercased) -> reason lines (joined)
  const keyOf = (p) => String(p.id || p.name || "").toLowerCase().trim();

  // Track A session
  const [sessionContext, setSessionContext] = useState({});
  const [followUps, setFollowUps] = useState([]);
  const sessionIdRef = useRef(`sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const turnRef = useRef(0);

  // Bootstrap once
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`/apps/refina/api/bootstrap${window.location.search || ""}`, {
          credentials: "same-origin",
        });
        const json = await resp.json();
        if (!json?.ok) throw new Error("bootstrap failed");
        setPlan(json.plan || "free");
        setStoreSettings(json.storeSettings || {});
        setCommonConcerns(Array.isArray(json.commonConcerns) ? json.commonConcerns : []);
        if (!storeId && json.storeId) setStoreId(json.storeId);
      } catch (e) {
        console.error("❌ Bootstrap failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // concierge-style fallback bullet synthesis (when reasons are thin)
  function synthesizeBullets(product, userConcern) {
    const out = [];

    const typeLabel = (product.productType || product.category || "").toString().toLowerCase();
    if (typeLabel) {
      out.push(`For ${userConcern}, this ${typeLabel} is a direct fit without extra steps or guesswork.`);
    }

    const ingredients = (product.ingredients || []).map((s) => String(s).toLowerCase());

    const benefitBits = [];
    for (const rule of ING_BENEFITS) {
      if (ingredients.some((ing) => rule.re.test(ing))) {
        benefitBits.push(rule.msg);
        if (benefitBits.length >= 2) break;
      }
    }
    if (benefitBits.length) out.push(`Key actives: ${benefitBits.join(", ")}.`);

    if (typeLabel.includes("serum")) {
      out.push("Use tip: apply 2–3 drops to damp skin, then seal with moisturiser.");
    } else if (typeLabel.includes("oil")) {
      out.push("Use tip: press 2–3 drops into skin as last step to lock in moisture.");
    } else if (typeLabel.includes("moistur")) {
      out.push("Use tip: apply a blueberry-size amount to face and neck, am/pm.");
    } else if (typeLabel.includes("sunscreen") || typeLabel.includes("spf")) {
      out.push("Use tip: two-finger rule for face; apply after moisturiser, before makeup.");
    } else if (typeLabel.includes("shampoo")) {
      out.push("Use tip: massage into scalp for 60 seconds before rinsing thoroughly.");
    }

    const hay = [
      typeLabel,
      (product.tags || []).join(" ").toLowerCase(),
      (product.category || "").toLowerCase(),
    ].join(" ");
    const strongActives = ingredients.some((x) => /(retin|aha|bha|acid)/.test(x));
    const isSupplement =
      /supplement|capsule|powder|tincture|ingest/i.test(hay) ||
      /(shilajit|collagen|vitamin)\b/i.test(ingredients.join(" "));

    if (isSupplement) {
      out.push("Heads-up: if pregnant, nursing, or on medication, check with your clinician first.");
    } else if (strongActives) {
      out.push("Heads-up: start 2–3×/week and wear SPF daily.");
    }

    return out.slice(0, 4);
  }

  const handleRecommend = async (nextConcern = null) => {
    const resolvedConcern = (nextConcern ?? concern).trim();
    if (!resolvedConcern) return;

    setLoading(true);
    setResponseText("");
    setMatchedProducts([]);
    setAiReasons(new Map());
    setFollowUps([]);
    setLastQuery(resolvedConcern);

    try {
      turnRef.current += 1;
      const body = {
        concern: resolvedConcern,
        context: sessionContext,
        plan,
        sessionId: sessionIdRef.current,
        turn: turnRef.current,
      };

      const resp = await fetch(`/apps/refina/api/recommend${window.location.search || ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const json = await resp.json();

      if (!json?.ok) throw new Error(json?.error || "recommend failed");

      setResponseText(json.explanation || "Here are your recommended products.");
      setFollowUps(Array.isArray(json.followUps) ? json.followUps.slice(0, plan === "premium" ? 3 : 0) : []);
      const products = Array.isArray(json.products) ? json.products : [];
      // Sort: (optional) by scores if provided, then routine order
      const scores = json.scoresById || {};
      const keyed = (p) => scores[p.id] ?? scores[p.name] ?? 0;
      setMatchedProducts(
        [...products].sort((a, b) => {
          const sb = keyed(b);
          const sa = keyed(a);
          if (sb !== sa) return sb - sa;
          return rankType(a.productType) - rankType(b.productType);
        })
      );

      // reasons
      const reasonsMap = new Map();
      const rb = json.reasonsById || {};
      products.forEach((p) => {
        const id = p.id || p.name;
        const r =
          rb[id] ||
          rb[String(id).toLowerCase()] ||
          ""; // server might return any key style
        if (r) reasonsMap.set(String(id).toLowerCase(), String(r));
      });
      setAiReasons(reasonsMap);
    } catch (e) {
      console.error("❌ Recommend error:", e);
      setResponseText("⚠️ Sorry, something went wrong with our smart suggestions.");
    } finally {
      setLoading(false);
    }
  };

  // Follow-up chip click → update concern + context → re-ask
  const parseChipToContext = (chip) => {
    const s = String(chip || "").toLowerCase();
    const ctx = {};
    if (/\boil\b/.test(s)) ctx.prefer = "oil";
    else if (/\bserum\b/.test(s)) ctx.prefer = "serum";
    else if (/\bcleanser\b/.test(s)) ctx.prefer = "cleanser";
    else if (/\btoner\b/.test(s)) ctx.prefer = "toner";
    else if (/\bmask\b/.test(s)) ctx.prefer = "mask";
    else if (/\bsunscreen|spf\b/.test(s)) ctx.prefer = "sunscreen";
    if (/\bsensitive|reactive|irritat/.test(s)) ctx.sensitivity = "sensitive";
    if (/\bfragrance[-\s]?free|unscented\b/.test(s)) ctx.fragrance = "free";
    if (/\bscalp\b/.test(s)) ctx.focus = "scalp";
    if (/\bcurl|curly\b/.test(s)) ctx.style = "curl";
    if (/\bfrizz\b/.test(s)) ctx.style = "frizz";
    if (/\bmatte\b/.test(s)) ctx.finish = "matte";
    if (/\bdewy|glow/.test(s)) ctx.finish = "dewy";
    const m = s.match(/\bunder\s*\$?\s*(\d{1,4})/);
    if (m) ctx.budget = `<$${m[1]}`;
    return ctx;
  };

  const mergeContext = (base, delta) => {
    const out = { ...(base || {}) };
    Object.entries(delta || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = v;
    });
    return out;
  };

  const onFollowUpClick = async (chip) => {
    const delta = parseChipToContext(chip);
    const merged = mergeContext(sessionContext, delta);
    setSessionContext(merged);

    const appended = `${concern} ${chip}`.replace(/\s+/g, " ").trim();
    setConcern(appended); // UI sync
    await handleRecommend(appended);
  };

  // Press Enter to "Ask" (Shift+Enter inserts a newline)
  const onTextKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) handleRecommend();
    }
  };

  // Parse + enrich bullets for the modal
  const getBulletsForProduct = (p) => {
    const key = keyOf(p);
    const reason = aiReasons.get(key) || "";
    let bullets = reason
      .split("\n")
      .map((s) => s.replace(/^•\s?/, "").trim())
      .filter(Boolean);

    if (bullets.length < 2) {
      const synth = synthesizeBullets(p, lastQuery || "your request");
      bullets = [...bullets, ...synth].slice(0, 4);
    }
    return bullets;
  };

  // Loading state while bootstrapping
  if (!storeId && !storeSettings) {
    return (
      <div className={styles.container}>
        <h1 className={styles.heading}>🛍️ Refina: Your Personal AI Shopping Concierge</h1>
        <p className={styles.subtext}>Loading your store…</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>🛍️ Refina: Your Personal AI Shopping Concierge</h1>
      <p className={styles.subtext}>What do you need help with?</p>

      {/* Suggestion chips: prefer store commonConcerns; else category defaults */}
      <div className={styles.concernButtons}>
        {(commonConcerns.length
          ? commonConcerns.slice(0, 6)
          : (FALLBACK_SUGGESTIONS[storeSettings?.category || "Beauty"] ||
              FALLBACK_SUGGESTIONS.Beauty)
        ).map((item) => (
          <button
            key={item}
            className={styles.chip}
            onClick={() => setConcern(item)}
            aria-label={`Use suggestion: ${item}`}
          >
            {item}
          </button>
        ))}
      </div>

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
          "Ask"
        )}
      </button>

      {responseText && (
        <div className={styles.responseBox} aria-live="polite">
          <h2>💡 Our Recommendation</h2>
          <p>{responseText}</p>

          {/* Track A: Follow-up chips (Premium only) */}
          {plan === "premium" && followUps.length > 0 && (
            <div className={styles.concernButtons} style={{ marginTop: 10 }}>
              {followUps.map((fu, i) => (
                <button
                  key={`${fu}-${i}`}
                  className={styles.chip}
                  onClick={() => onFollowUpClick(fu)}
                  aria-label={`Refine: ${fu}`}
                >
                  {fu}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {matchedProducts.length > 0 && (
        <>
          <div className={styles.responseBox}>
            <h2>🛍️ Product Matches</h2>
            <p>Here are some product matches based on your concern!</p>
          </div>
          <div className={styles.grid} role="list">
            {matchedProducts.map((product, idx) => {
              const bullets = getBulletsForProduct(product);
              const teaser = (() => {
                const firstBullet = bullets[0];
                const txt = firstBullet || stripHtml(product.description || "");
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

                  {deriveBadges(product, storeSettings).length > 0 && (
                    <div className={styles.badges}>
                      {deriveBadges(product, storeSettings).map((b) => (
                        <span key={b} className={styles.badge}>
                          {b}
                        </span>
                      ))}
                    </div>
                  )}

                  <p className={styles.productDescription}>{teaser}</p>

                  {storeSettings?.ui?.showPrices && product.price != null && (
                    <div className={styles.price}>${product.price}</div>
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

            <img
              src={selectedProduct.image}
              alt={selectedProduct.name}
              onError={(e) => {
                e.currentTarget.src =
                  "https://cdn.shopify.com/s/images/admin/no-image-compact.gif";
              }}
              style={{ marginTop: 12 }}
            />

            <div className={styles.modalSubtitle}>
              Why it's right for you
            </div>

            {(() => {
              const bullets = getBulletsForProduct(selectedProduct);
              if (bullets.length) {
                return (
                  <ul className={styles.reasonsList}>
                    {bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                );
              }
              return <p>{stripHtml(selectedProduct.description || "")}</p>;
            })()}

            <a
              href={selectedProduct.link || "#"}
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
