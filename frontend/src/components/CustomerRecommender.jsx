// src/components/CustomerRecommender.jsx — BFF (App Proxy) version with client-side Gemini
import React, { useEffect, useRef, useState } from "react";
import styles from "./CustomerRecommender.module.css";
import { getGeminiResponse } from "../gemini";

// ───────────────────────────
// Helpers (kept from your version)
// ───────────────────────────
const ROUTINE_ORDER = [
  "cleanser","toner","essence","serum","treatment","moisturiser","moisturizer",
  "mask","sunscreen","spf","oil",
];
const rankType = (t = "") => {
  const i = ROUTINE_ORDER.findIndex((k) => (t || "").toLowerCase().includes(k));
  return i === -1 ? 999 : i;
};

// hard limits by plan (client-side guard; server can still send more)
const MAX_PRODUCTS_BY_PLAN = {
  free: 3,
  pro: 6,
  premium: 8,
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
  Haircare: ["Scalp soothing shampoo", "Heat protectant spray", "Curl defining cream", "Repair mask"],
  "Body + Bath": ["KP (BHA) body lotion", "Retinol body treatment", "Mineral body SPF", "Hydrating body wash"],
  Makeup: ["Blurring primer", "Skin tint", "Cream blush", "Long-wear concealer"],
};

const makeSessionId = () =>
  `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function parseChipToContext(chip) {
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
  if (/\blengths\b/.test(s)) ctx.focus = "lengths";
  if (/\bcurl|curly\b/.test(s)) ctx.style = "curl";
  if (/\bfrizz\b/.test(s)) ctx.style = "frizz";
  if (/\bmatte\b/.test(s)) ctx.finish = "matte";
  if (/\bdewy|glow/.test(s)) ctx.finish = "dewy";
  const m = s.match(/\bunder\s*\$?\s*(\d{1,4})/);
  if (m) ctx.budget = `<$${m[1]}`;
  return ctx;
}
function mergeContext(base, delta) {
  const out = { ...(base || {}) };
  Object.entries(delta || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = v;
  });
  return out;
}

const stripHtml = (html = "") => String(html).replace(/<[^>]+>/g, "").trim();

// Synthesize bullets when AI reasons are missing
function synthesizeBullets(product, userConcern) {
  const out = [];
  const typeLabel = String(product.productType || product.category || "").toLowerCase();
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
  const strongActives = ingredients.some((x) => /(retin|aha|bha|acid)/.test(x));
  const hay = [typeLabel, (product.tags || []).join(" "), (product.category || "").toLowerCase()].join(" ");
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

// Determine API base (/apps/<slug>/api)
const getApiBase = () => {
  const m = (window.location.pathname || "").match(/\/apps\/([^/]+)/);
  return m ? `/apps/${m[1]}/api` : "/apps/refina/api";
};

function CustomerRecommender() {
  // Bootstrap/store state
  const [storeId, setStoreId] = useState(null);
  const [plan, setPlan] = useState("free");
  const [storeSettings, setStoreSettings] = useState(null);
  const [commonConcerns, setCommonConcerns] = useState([]);

  // Query state
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);

  // Results
  const [responseText, setResponseText] = useState("");
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);

  // AI extras (server may send reasons/scores later)
  const [aiReasons, setAiReasons] = useState(new Map());
  const [followUps, setFollowUps] = useState([]);

  // Session tracking
  const sessionIdRef = useRef(makeSessionId());
  const turnRef = useRef(0);
  const [sessionContext, setSessionContext] = useState({});

  // Bootstrap from BFF
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${getApiBase()}/bootstrap`, { method: "GET" });
        const data = await resp.json();
        if (!data.ok) throw new Error("bootstrap failed");
        setStoreId(data.storeId);
        setPlan(String(data.plan || "free").toLowerCase());
        setStoreSettings(data.storeSettings || {});
        setCommonConcerns(Array.isArray(data.commonConcerns) ? data.commonConcerns : []);
      } catch (e) {
        console.error("bootstrap error:", e);
      }
    })();
  }, []);

  const handleRecommend = async (nextConcern = null) => {
    const q = (nextConcern ?? concern).trim();
    if (!q) return;

    setLoading(true);
    setResponseText("");
    setMatchedProducts([]);
    setFollowUps([]);
    setLastQuery(q);

    try {
      turnRef.current += 1;

      // 1) Ask BFF for a candidate pool (cache/fallback/mapping)
      const recResp = await fetch(`${getApiBase()}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concern: q,
          context: sessionContext,
          plan,
          sessionId: sessionIdRef.current,
          turn: turnRef.current,
        }),
      });
      const bff = await recResp.json();
      const candidates = Array.isArray(bff.products) ? bff.products : [];

      // 2) Run Gemini client-side to re-rank and craft copy (bestie + expert)
      const cap = MAX_PRODUCTS_BY_PLAN[plan] ?? MAX_PRODUCTS_BY_PLAN.free;
      const gem = await getGeminiResponse({
        concern: q,
        category: storeSettings?.category || "Beauty",
        tone: storeSettings?.aiTone || "bestie+expert",
        products: candidates,
        context: sessionContext,
        maxPicks: cap,
      });

      // 3) Reorder to Gemini picks; append any leftovers if needed
      const byId = new Map(
        candidates.map((p) => [String(p.id || p.name || "").toLowerCase().trim(), p])
      );

      const picked = (gem.productIds || [])
        .map((id) => byId.get(String(id || "").toLowerCase().trim()))
        .filter(Boolean);

      // If Gemini returned fewer than cap, pad with remaining candidates (stable sort)
      const scores = gem.scoresById || {};
      const leftovers = candidates
        .filter((p) => !picked.includes(p))
        .sort((a, b) => {
          const sa = typeof scores[a.id] === "number" ? scores[a.id] : 0;
          const sb = typeof scores[b.id] === "number" ? scores[b.id] : 0;
          if (sb !== sa) return sb - sa;
          return rankType(a.productType) - rankType(b.productType);
        });

      const finalList = [...picked, ...leftovers].slice(0, cap);
      setMatchedProducts(finalList);

      // 4) Copy + chips + reasons
      setResponseText(gem.explanation || bff.explanation || "Here are the most relevant products for you.");
      setFollowUps(Array.isArray(gem.followUps) ? gem.followUps.slice(0, 3) : []);

      const reasons = new Map();
      const r = gem.reasonsById || {};
      finalList.forEach((p) => {
        const key = String(p.id || p.name || "").toLowerCase().trim();
        const text = r[p.id] || r[p.name] || r[key] || "";
        if (text) reasons.set(key, String(text));
      });
      setAiReasons(reasons);
    } catch (e) {
      console.error("recommend error:", e);
      setResponseText("⚠️ Sorry, something went wrong with our smart suggestions.");
    }
    setLoading(false);
  };

  const onFollowUpClick = async (chip) => {
    const merged = mergeContext(sessionContext, parseChipToContext(chip));
    setSessionContext(merged);
    const appended = `${concern} ${chip}`.replace(/\s+/g, " ").trim();
    setConcern(appended);
    await handleRecommend(appended);
  };

  const onSuggestionClick = async (text) => {
    const autoAsk = !!storeSettings?.ui?.autoAskOnSuggestion;
    setConcern(text);
    if (autoAsk && !loading) {
      await handleRecommend(text);
    }
  };

  const onTextKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) handleRecommend();
    }
  };

  const getBulletsForProduct = (p) => {
    const key = String(p.id || p.name || "").toLowerCase().trim();
    const reason = aiReasons.get(key) || "";
    let bullets = reason
      .split("\n")
      .map((s) => s.replace(/^•\s?/, "").trim())
      .filter(Boolean);

    // Ensure exactly 3 bullets: top up with synth, then cap to 3
    if (bullets.length < 3) {
      const synth = synthesizeBullets(p, lastQuery || "your request");
      bullets = [...bullets, ...synth];
    }
    return bullets.slice(0, 3);
  };

  // Loading / bootstrap
  if (!storeId) {
    return (
      <div className={styles.container}>
        <h1 className={styles.heading}>🛍️ Refina: Your Personal AI Shopping Concierge</h1>
        <p className={styles.subtext}>Loading your store…</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>Let’s find your perfect pick</h1>
      <p className={styles.subtext}>Tell me what you’re after and I’ll fetch the best fits.</p>

      <div className={styles.concernButtons}>
        {(commonConcerns.length
          ? commonConcerns.slice(0, 6)
          : (FALLBACK_SUGGESTIONS[storeSettings?.category || "Beauty"] || FALLBACK_SUGGESTIONS.Beauty)
        ).map((item) => (
          <button
            key={item}
            className={styles.chip}
            onClick={() => onSuggestionClick(item)}
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
        {loading ? <>Thinking<span className={styles.dots} aria-hidden="true" /></> : "Get picks"}
      </button>

      {responseText && (
        <div className={styles.responseBox} aria-live="polite">
          <h2>Here’s what I’d pick</h2>
          <p>{responseText}</p>

          {followUps.length > 0 && (
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
            <h2>Top matches</h2>
            <p>
              Tap a product to see why.
              {plan === "free" ? " (showing up to 3 on the free plan)" : ""}
            </p>
          </div>

          <div className={styles.grid} role="list">
            {matchedProducts.map((product, idx) => {
              const teaser = (() => {
                const firstBullet = getBulletsForProduct(product)[0];
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
        <div className={styles.modalOverlay} onClick={() => setSelectedProduct(null)}>
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
            <div className={styles.modalSubtitle}>Why it’s our pick</div>
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
