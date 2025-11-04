// frontend/src/components/CustomerRecommender.jsx
import React, { useEffect, useState, useCallback, useRef } from "react";
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
function formatPrice(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

// --- SAFE catalog HTML sanitizer (UI-only) ---
function sanitizeCatalogHtml(html = "") {
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    tmp.querySelectorAll("script, style, iframe, object, embed, link").forEach(n => n.remove());
    tmp.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const val = String(attr.value || "");
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        if (name === "href" || name === "src") {
          const lower = val.trim().toLowerCase();
          if (lower.startsWith("javascript:") || lower.startsWith("data:text/html")) {
            el.removeAttribute(attr.name);
          }
        }
      });
    });
    return tmp.innerHTML;
  } catch {
    return "";
  }
}

// Keep only the first N paragraph/list blocks; fallback to ~200 words if needed.
function firstParagraphsOrWords(html = "", n = 2, wordCap = 200) {
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = html; // already sanitized
    const blocks = [...tmp.querySelectorAll("p, ul, ol")].slice(0, n);
    if (blocks.length) {
      const out = document.createElement("div");
      blocks.forEach(b => out.appendChild(b.cloneNode(true)));
      return out.innerHTML;
    }
  } catch {}
  const text = String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(" ");
  return words.length <= wordCap ? text : words.slice(0, wordCap).join(" ") + "…";
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

// ─────────────────────────────────────────────
// NEW (diff): one-shot prefill + editor guard + analytics
// ─────────────────────────────────────────────
const enableAutoAnswerFromPDP = true;

function inThemeEditorOrAdmin() {
  try {
    if (window.Shopify && window.Shopify.designMode) return true;
    const ref = new URL(document.referrer || "", location.href);
    if (/(^|\.)admin\.shopify\.com$/i.test(ref.hostname || "")) return true;
  } catch {}
  return false;
}

// Read full prefill payload once from sessionStorage (and clear), else from URL.
// Returns { text, payload } where `payload` may contain contextId, productId, intent…
function readRefinaPrefillOnce() {
  // 1) Prefer drawer handoff via sessionStorage
  try {
    const raw = sessionStorage.getItem("refina_prefill");
    if (raw) {
      sessionStorage.removeItem("refina_prefill"); // one-shot
      const p = JSON.parse(raw);
      const text = String(p?.prefill || "");
      return { text, payload: (p && typeof p === "object") ? p : {} };
    }
  } catch {}

  // 2) Fallback: parse URL params (drawer in admin/editor uses querystring too)
  try {
    const params = new URLSearchParams(location.search);
    const text = String(params.get("prefill") || "");
    if (text) {
      const payload = {};
      for (const [k, v] of params.entries()) {
        // capture known keys for analytics
        if (["contextId","productId","intent","shop","source","priceCap"].includes(k)) {
          payload[k] = v;
        }
      }
      return { text, payload };
    }
  } catch {}

  return { text: "", payload: {} };
}

export default function CustomerRecommender({ initialPrompt = "" }) {
  const settings = useUrlSettings();
  const [concern, setConcern] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const [commonConcerns, setCommonConcerns] = useState([]);
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [copy, setCopy] = useState({ why: "", rationale: "", extras: "" });
  const [reasonsById, setReasonsById] = useState({});

  const [selectedProduct, setSelectedProduct] = useState(null);
  const didAutoStartRef = useRef(false);      // auto-start once guard
  const seededFromPrefillRef = useRef(false); // track if we seeded from prefill
  const userInteractedRef = useRef(false);    // cancel auto if user types in-widget
  const lastPrefillPayloadRef = useRef(null); // keep full payload for analytics

  // ===== Staged progress label (diffs only) =====
  const [progressLabel, setProgressLabel] = useState("Thinking…");
  const progressTimers = useRef([]);

  const PROGRESS_PHASES = [
    { at: 0,       text: "Thinking…" },
    { at: 10_000,  text: "Researching…" },
    { at: 20_000,  text: "Shortlisting products…" },
    { at: 30_000,  text: "Analyzing matches…" },
    { at: 40_000,  text: "Finalizing your Top 3…" },
  ];

  function startProgressCycle() {
    progressTimers.current.forEach(clearTimeout);
    progressTimers.current = [];
    setProgressLabel(PROGRESS_PHASES[0].text);

    PROGRESS_PHASES.slice(1).forEach((p) => {
      const id = setTimeout(() => setProgressLabel(p.text), p.at);
      progressTimers.current.push(id);
    });

    const idLast = setTimeout(() => setProgressLabel("Still working… almost there"), 55_000);
    progressTimers.current.push(idLast);
  }

  function stopProgressCycle() {
    progressTimers.current.forEach(clearTimeout);
    progressTimers.current = [];
  }

  useEffect(() => {
    return () => progressTimers.current.forEach(clearTimeout);
  }, []);
  // ===== end staged progress =====

  // (1) Seed concern from URL ?prefill=, initialPrompt, or sessionStorage handoff (ONE-SHOT).
  useEffect(() => {
    let seeded = false;
    let seedText = "";

    // Prefer the one-shot helper (clears storage; also parses URL if present)
    const { text: oneShotText, payload } = readRefinaPrefillOnce();
    if (oneShotText) {
      seedText = oneShotText;
      lastPrefillPayloadRef.current = payload || null;
      seeded = true;
    }

    // If no one-shot, then URL-only prefill (already handled above) or initialPrompt
    if (!seeded && initialPrompt) {
      seedText = initialPrompt;
      seeded = true;
    }

    if (seeded && seedText && !concern) {
      setConcern(seedText);
      seededFromPrefillRef.current = true;

      // (2) Auto-start once, immediately after seeding (with guards)
      const preLen = seedText.trim().length;
      const skip =
        !enableAutoAnswerFromPDP ||
        inThemeEditorOrAdmin() ||
        didAutoStartRef.current ||
        userInteractedRef.current ||
        preLen < 6 ||
        loading ||
        (Array.isArray(matchedProducts) && matchedProducts.length > 0);

      if (!skip) {
        didAutoStartRef.current = true;

        // Analytics: drawer_auto_answer (best-effort)
        try {
          const storeId =
            new URLSearchParams(location.search).get("shop") ||
            document.getElementById("root")?.dataset.shop ||
            "";

          const meta = lastPrefillPayloadRef.current || {};
          fetch(`${API_PREFIX}/analytics/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storeId,
              type: "concern",
              event: "drawer_auto_answer",
              concern: seedText,
              contextId: meta.contextId || null,
              productId: meta.productId || null,
              intent: meta.intent || null,
            }),
            keepalive: true,
          });
        } catch {}

        // call with the seed explicitly so we don't race on state
        setTimeout(() => handleRecommend(seedText), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]); // one-time seed on mount

  // (3) Runtime seed bridge: allow opener to send a seed after mount (one-shot semantics)
  useEffect(() => {
    function onSeed(ev) {
      const d = ev?.detail || {};
      const pre = String(d.prefill || "");
      if (!pre) return;

      // treat as one-shot: overwrite any existing concern only if we have none
      setConcern((prev) => prev || pre);
      seededFromPrefillRef.current = true;
      lastPrefillPayloadRef.current = d || null;

      const preLen = pre.trim().length;
      const skip =
        !enableAutoAnswerFromPDP ||
        inThemeEditorOrAdmin() ||
        didAutoStartRef.current ||
        userInteractedRef.current ||
        preLen < 6 ||
        loading ||
        (Array.isArray(matchedProducts) && matchedProducts.length > 0);

      if (!skip) {
        didAutoStartRef.current = true;

        // Analytics: drawer_auto_answer (best-effort)
        try {
          const storeId =
            new URLSearchParams(location.search).get("shop") ||
            document.getElementById("root")?.dataset.shop ||
            "";
          fetch(`${API_PREFIX}/analytics/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storeId,
              type: "concern",
              event: "drawer_auto_answer",
              concern: pre,
              contextId: d.contextId || null,
              productId: d.productId || null,
              intent: d.intent || null,
            }),
            keepalive: true,
          });
        } catch {}

        setTimeout(() => handleRecommend(pre), 0);
      }
    }
    document.addEventListener("refina:seed", onSeed);
    return () => document.removeEventListener("refina:seed", onSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRecommend, loading, matchedProducts]);

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
      startProgressCycle(); // <<< diff: start staged progress
      setMatchedProducts([]);
      setCopy({ why: "", rationale: "", extras: "" });
      setReasonsById({});
      setLastQuery(q);

      try {
        // --- resolve storeId from ?shop= or #root[data-shop] ---
       const rootEl = document.getElementById("root");
       const storeId =
         new URLSearchParams(location.search).get("shop") ||
         (rootEl && rootEl.dataset ? rootEl.dataset.shop : "") ||
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
          const rootEl2 = document.getElementById("root");
          const storeId2 =
            new URLSearchParams(location.search).get("shop") ||
            (rootEl2 && rootEl2.dataset ? rootEl2.dataset.shop : "") ||
            "";

          const analyticsPayload = {
            storeId: storeId2, // ✅ include canonical shop id
            type: "concern",
            event: "recommendation_received",
            concern: q,
            productIds: products.map((p) => p.id),
            meta: {
              plan: (window.__REFINA__ && window.__REFINA__.plan) || "unknown",
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
        stopProgressCycle(); // <<< diff: stop staged progress
        setLoading(false);
        setProgressLabel("Thinking…"); // <<< diff: reset for next ask
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
        data-refina-input
        value={concern}
        onChange={(e) => {
          userInteractedRef.current = true; // <<< diff: cancel auto on manual edits
          setConcern(e.target.value);
        }}
        onKeyDown={onTextKeyDown}
        placeholder="Type your concern… (Enter to Ask, Shift+Enter for new line)"
      />

      <button
        data-refina-ask-btn
        className={styles.askButton}
        onClick={() => handleRecommend(concern)}
        disabled={loading}
        aria-busy={loading}
        aria-live="polite"
      >
        {loading ? (
          <>
            {progressLabel}<span className={styles.dots} aria-hidden="true" />
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
    const raw =
      (selectedProduct && (
        selectedProduct.description ||
        selectedProduct.body_html ||
        selectedProduct.bodyHtml ||
        selectedProduct.body ||
        ""
      )) || "";

    const safe = sanitizeCatalogHtml(raw);
    const short = firstParagraphsOrWords(safe, 2, 200);

    if (!short || short.trim() === "") {
      return (
        <p>
          {teaserFromHtml(selectedProduct?.description || "") ||
            "A solid match for your request."}
        </p>
      );
    }

    return (
      <div
        style={{ marginBottom: 8 }}
        dangerouslySetInnerHTML={{ __html: short }}
      />
    );
  })()}

  {/* No LLM reasons or extras in the modal */}
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
