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

const splitParagraphs = (text = "") =>
  String(text)
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);

const parseBulletsFromText = (text = "") =>
  String(text)
    .split(/\n+/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(\u2022|•|\-|\*|\d+[.)])\s+/, "")) // strip bullet markers
    .filter(Boolean);

const renderParagraphs = (text, className) => {
  const parts = splitParagraphs(text);
  if (!parts.length) return null;

  return parts.map((p, i) => (
    <p key={`${className || "para"}-${i}`} className={className}>
      {p}
    </p>
  ));
};

/**
 * Proof renderer rules (matches your conversion-shape contract):
 * - If array -> render as <ul><li>
 * - If string contains a lead + blank line + bullet section -> lead as <p>, rest as <ul>
 * - If plain string -> keep as <p>
 */
const renderRationale = (rationale) => {
  if (!rationale) return null;

  // 1) Array = already structured bullets
  if (Array.isArray(rationale)) {
    return (
      <ul className={styles.reasonsList}>
        {rationale
          .map((b) => String(b || "").trim())
          .filter(Boolean)
          .map((b, i) => (
            <li key={`r-arr-${i}`}>{b}</li>
          ))}
      </ul>
    );
  }

  const blocks = splitParagraphs(rationale);

  // 2) If we have 2+ blocks: treat block 1 as lead, rest as bullet proof
  if (blocks.length >= 2) {
    const lead = blocks[0];
    const bulletText = blocks.slice(1).join("\n");
    const bullets = parseBulletsFromText(bulletText);

    return (
      <>
        {lead ? <p>{lead}</p> : null}

        {bullets.length ? (
          <ul className={styles.reasonsList}>
            {bullets.map((b, i) => (
              <li key={`r-bul-${i}`}>{b}</li>
            ))}
          </ul>
        ) : null}
      </>
    );
  }

  // 3) Single block: plain paragraph
  return <p>{blocks[0]}</p>;
};

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
  ? awesome.explanation.expertBullets.map(b => `• ${String(b).trim()}`).join("\n")
  : "";

  const why = friendly || oneLiner || "";
  const rationale = awesome.copy?.rationale || expertBullets || "";
  const extras = awesome.copy?.extras || "";

  return { why, rationale, extras };
}
function teaserForCard(product, reasonsById) {
  const reason = reasonsById?.[product.id] || "";
  if (reason) return decodeEntities(reason);
  // Backend does not send `description`; if empty after decode, show a safe line.
  const fromDesc = teaserFromHtml(product.description || "");
  return fromDesc || "A solid match for your request.";
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

  const didAutoStartRef = useRef(false);      // auto-start once guard
  const seededFromPrefillRef = useRef(false); // track if we seeded from prefill

  const [followUps, setFollowUps] = useState([]);
  const [viewMode, setViewMode] = useState("results");
  const [returnState, setReturnState] = useState(null);

  // ===== Staged progress label (diffs only) =====
  const [progressLabel, setProgressLabel] = useState("Thinking…");
  const progressTimers = useRef([]);

 const MAIN_PROGRESS_PHASES = [
  { at: 0,      text: "Thinking" },
  { at: 600,    text: "Scanning product catalogue" },
  { at: 1_800,  text: "Shortlisting products" },
  { at: 3_800,  text: "Ranking candidates" },
  { at: 6_500,  text: "Selecting your Top 3" },
  { at: 10_500, text: "Writing reasons why" },
  { at: 14_500, text: "Finalizing recommendations" },
];

const FOLLOWUP_PROGRESS_PHASES = [
  { at: 0,      text: "Thinking" },
  { at: 500,    text: "Checking the product details" },
  { at: 1_600,  text: "Reviewing the best fit" },
  { at: 3_200,  text: "Writing the answer" },
];

  function startProgressCycle(mode = "main") {
  const phases =
    mode === "followup" ? FOLLOWUP_PROGRESS_PHASES : MAIN_PROGRESS_PHASES;

  progressTimers.current.forEach(clearTimeout);
  progressTimers.current = [];
  setProgressLabel(phases[0].text);

  phases.slice(1).forEach((p) => {
    const id = setTimeout(() => setProgressLabel(p.text), p.at);
    progressTimers.current.push(id);
  });

  const idLast = setTimeout(
    () => setProgressLabel("Still working… almost there"),
    55_000
  );
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

 const buildCurrentRecommendationState = () => ({
  matchedProducts,
  copy,
  reasonsById,
  followUps,
  lastQuery,
});

async function fetchUtilityPeek({
  storeId,
  heroProductId,
  q = "",
  intent = "similar",
  currency = "",
  priceCap = "",
}) {
  const qs = new URLSearchParams({
    mode: "peek",
    storeId: String(storeId || ""),
    productId: String(heroProductId || ""),
  });

  if (String(q || "").trim()) {
    qs.set("q", String(q).trim());
  }

  if (String(intent || "").trim()) {
    qs.set("intent", String(intent).trim());
  }

  if (String(currency || "").trim()) {
    qs.set("currency", String(currency).trim());
  }

  if (priceCap !== "" && priceCap != null) {
    qs.set("priceCap", String(priceCap));
  }

  const resp = await fetch(`${API_PREFIX}/recommend?${qs.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!resp.ok) throw new Error(`peek ${resp.status}`);

  return resp.json();
}

  const handleRecommend = useCallback(
    async (nextConcern) => {
      const q = String(nextConcern ?? concern).trim();
      if (!q) return;

      setLoading(true);
      startProgressCycle("main"); // <<< diff: start staged progress
      setMatchedProducts([]);
      setCopy({ why: "", rationale: "", extras: "" });
      setReasonsById({});
      setLastQuery(q);
      setFollowUps([]); // Clear old suggestions

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

        // --- NEW: Capture follow-up questions
        const followUpsData = Array.isArray(data?.followUps) ? data.followUps : [];
const currentHeroProductId =
  Array.isArray(products) && products.length > 0 ? String(products[0]?.id || "") : "";

    const visibleSetIds = products.map((p) => String(p.id)).filter(Boolean);

setFollowUps(
  followUpsData
    .map((fu) => {
      if (typeof fu === "string") {
        return { type: "hero", label: fu };
      }

      const normalized = {
        type: String(fu?.type || "").trim(),
        label: String(fu?.label || "").trim(),
        ...(fu?.heroProductId ? { heroProductId: String(fu.heroProductId) } : {}),
        ...(Array.isArray(fu?.setProductIds) && fu.setProductIds.length
          ? { setProductIds: fu.setProductIds.map(String) }
          : {}),
        ...(fu?.action ? { action: String(fu.action) } : {}),
      };

      if (
        normalized.type === "hero" &&
        normalized.heroProductId &&
        (!Array.isArray(normalized.setProductIds) || !normalized.setProductIds.length)
      ) {
        normalized.setProductIds = visibleSetIds;
      }
      return normalized;
    })
    .filter((fu) => fu.label)
);

        setMatchedProducts(products);
        setCopy({
          why: String(copyOut.why || ""),
          rationale: String(copyOut.rationale || ""),
          extras: String(copyOut.extras || ""),
        });
        setReasonsById(reasonsMap);

        // In CustomerRecommender.jsx, BEFORE the analytics fetch:
if (data?.cacheHit) {
  // Skip analytics - server already logged it
  return;
}

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
            topProductTitle: products[0]?.name || products[0]?.title || "",
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
        stopProgressCycle(); // <<< diff: stop staged progress
        setLoading(false);
        setProgressLabel("Thinking…"); // <<< diff: reset for next ask
      }
    },
    [concern, startProgressCycle, stopProgressCycle, setProgressLabel]
  );

  const handleReturnToResults = useCallback(() => {
  if (!returnState) return;

  setMatchedProducts(Array.isArray(returnState.matchedProducts) ? returnState.matchedProducts : []);
  setCopy(returnState.copy || { why: "", rationale: "", extras: "" });
  setReasonsById(returnState.reasonsById || {});
  setFollowUps(Array.isArray(returnState.followUps) ? returnState.followUps : []);
  setLastQuery(String(returnState.lastQuery || ""));
  setViewMode("results");
  setReturnState(null);
}, [returnState]);

const handleFollowUp = useCallback(
  async (pill) => {
    if (!pill || !pill.type) return;

    // Real scoped handling for hero + compare_set
    if (pill.type === "hero" || pill.type === "compare_set") {
      const storeId =
        new URLSearchParams(location.search).get("shop") ||
        document.getElementById("root")?.dataset.shop ||
        "";

      if (!storeId) return;

      if (viewMode === "results") {
        setReturnState(buildCurrentRecommendationState());
    }

      setLastQuery(String(pill.label || ""));
      setLoading(true);
      startProgressCycle("followup");

      try {
        const resp = await fetch(`${API_PREFIX}/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storeId,
            concern: pill.label,
            followUp: {
              type: pill.type,
              ...(pill.type === "hero" && pill.heroProductId
                ? { heroProductId: String(pill.heroProductId) }
                : {}),
              ...(Array.isArray(pill.setProductIds)
                ? { setProductIds: pill.setProductIds.map(String) }
                : {}),
            },
          }),
        });

        if (!resp.ok) throw new Error(`recommend ${resp.status}`);

        const data = await resp.json();

        const products = normalizeProducts(
          Array.isArray(data?.products) ? data.products : []
        );

        const reasonsMap = buildReasonsMapFromAwesome(data?.awesome);
        const copyOut = buildCopyFromAwesome(data?.awesome, data?.explanation || "");

        const followUpsData = Array.isArray(data?.followUps) ? data.followUps : [];
        const currentHeroProductId =
          Array.isArray(products) && products.length > 0 ? String(products[0]?.id || "") : "";

        setFollowUps(
          followUpsData
            .map((fu) => {
              if (typeof fu === "string") {
                return { type: "hero", label: fu };
              }

              const normalized = {
                type: String(fu?.type || "").trim(),
                label: String(fu?.label || "").trim(),
                ...(fu?.heroProductId ? { heroProductId: String(fu.heroProductId) } : {}),
                ...(Array.isArray(fu?.setProductIds)
                  ? { setProductIds: fu.setProductIds.map(String) }
                  : {}),
                ...(fu?.action ? { action: String(fu.action) } : {}),
              };

              if (
                normalized.type === "utility" &&
                normalized.action === "show_similar" &&
                !normalized.heroProductId &&
                currentHeroProductId
              ) {
                normalized.heroProductId = currentHeroProductId;
              }

              return normalized;
            })
            .filter((fu) => fu.label)
        );

        setMatchedProducts(products);
        setCopy({
          why: String(copyOut.why || ""),
          rationale: String(copyOut.rationale || ""),
          extras: String(copyOut.extras || ""),
        });
        setReasonsById(reasonsMap);
        setLastQuery(String(pill.label || ""));
        setViewMode("followup");
      } catch (err) {
        console.error("[followUp scoped] recommend failed:", err);
      } finally {
        setLoading(false);
        stopProgressCycle();
      }

      return;
    }

    // Real utility handling
    if (pill.type === "utility" && pill.action === "show_similar") {
      const storeId =
        new URLSearchParams(location.search).get("shop") ||
        document.getElementById("root")?.dataset.shop ||
        "";

      const heroProductId = String(pill.heroProductId || "");
      if (!storeId || !heroProductId) return;

      setLoading(true);
      startProgressCycle();

      try {
        if (viewMode !== "utility") {
          setReturnState(buildCurrentRecommendationState());
        }

        const data = await fetchUtilityPeek({
          storeId,
          heroProductId,
          q: String(lastQuery || concern || "").trim(),
          intent: "similar",
        });

        const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
        const products = normalizeProducts(candidates);

        setMatchedProducts(products);
        setCopy({
          why: "Here are similar options to your top pick.",
          rationale: "",
          extras: "",
        });
        setReasonsById({});
        setFollowUps([]);
        setLastQuery("Similar options");
        setViewMode("utility");
      } catch (err) {
        console.error("[followUp utility] peek failed:", err);
      } finally {
        setLoading(false);
      }

      return;
    }
  },
  [
    handleRecommend,
    matchedProducts,
    copy,
    reasonsById,
    followUps,
    lastQuery,
    viewMode,
    concern,
  ]
);

  // (1) Seed concern from URL ?prefill=, initialPrompt, or sessionStorage handoff.
  useEffect(() => {
    let seeded = false;
    let seedText = "";

    try {
      const params = new URLSearchParams(window.location.search);
      const urlPrefill = params.get("prefill");
      if (urlPrefill && !seeded) {
        seedText = urlPrefill;
        seeded = true;
      }
    } catch {}

    if (!seeded && initialPrompt) {
      seedText = initialPrompt;
      seeded = true;
    }

    if (!seeded) {
      try {
        const raw = sessionStorage.getItem("refina_prefill");
        if (raw) {
          try {
            const p = JSON.parse(raw);
            if (p && p.prefill) {
              seedText = String(p.prefill || "");
              seeded = !!seedText;
            }
          } catch {}
          // optional: keep or clear; concierge clears on handoff already
        }
      } catch {}
    }

    if (seeded && seedText && !concern) {
      setConcern(seedText);
      seededFromPrefillRef.current = true;

      // (2) Auto-start once, immediately after seeding
      if (!didAutoStartRef.current) {
        didAutoStartRef.current = true;
        // call with the seed explicitly so we don't race on state
        setTimeout(() => handleRecommend(seedText), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]); // one-time seed on mount

  // (3) Runtime seed bridge: allow opener to send a seed after mount
  useEffect(() => {
    function onSeed(ev) {
      const d = ev?.detail || {};
      const pre = String(d.prefill || "");
      if (!pre) return;
      setConcern(pre);
      seededFromPrefillRef.current = true;
      if (!didAutoStartRef.current) {
        didAutoStartRef.current = true;
        setTimeout(() => handleRecommend(pre), 0);
      }
    }
    document.addEventListener("refina:seed", onSeed);
    return () => document.removeEventListener("refina:seed", onSeed);
  }, [handleRecommend]);

    // useEffect to apply Theme Editor appearance settings from URL
  useEffect(() => {
    const root = document.documentElement;
    if (!root || !settings) return;

    const cssColor = (value, fallback = "") => {
      const v = String(value || "").trim();
      return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)
        ? v
        : fallback;
    };

    const radiusMap = {
      none: "0px",
      sm: "8px",
      md: "12px",
      lg: "16px",
      "2xl": "24px",
    };

    const primaryColor = cssColor(settings.primaryColor);
    const accentColor = cssColor(settings.accentColor);
    const buttonTextColor = cssColor(settings.buttonTextColor);
    const widgetBackgroundColor = cssColor(settings.widgetBackgroundColor);
    const widgetTextColor = cssColor(settings.widgetTextColor);
    const inputBackgroundColor = cssColor(settings.inputBackgroundColor);

    const stylesToApply = {
      // Keep both legacy and current names because older inline styles still reference --rf-primary-color.
      "--rf-primary-color": primaryColor,
      "--rf-color-primary": primaryColor,

      "--rf-accent-color": accentColor,
      "--rf-color-accent": accentColor,

      "--rf-button-text-color": buttonTextColor,
      "--rf-on-primary": buttonTextColor,

      "--rf-widget-background-color": widgetBackgroundColor,
      "--rf-widget-bg": widgetBackgroundColor,
      "--rf-page-bg": widgetBackgroundColor,
      "--rf-surface": widgetBackgroundColor,

      "--rf-widget-text-color": widgetTextColor,
      "--rf-color-text": widgetTextColor,

      "--rf-input-background-color": inputBackgroundColor,
      "--rf-input-bg": inputBackgroundColor,

      "--rf-border-radius": radiusMap[settings.borderRadius] || "",
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

const renderOpener = (text) => {
  const raw = typeof text === "string" ? text : String(text || "");
  const paragraphs = raw
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);

  return paragraphs.map((p, i) => (
    <p key={i} className={styles.opener}>
      {p}
    </p>
  ));
};

const askLabel = widgetCtaOverride || legacyCta || "Find My Products";

const renderRationale = (text) => {
  const raw = typeof text === "string" ? text : String(text || "");

  // Split into paragraph blocks (blank lines)
  const blocks = raw
    .split(/\n\s*\n/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const isBulletLine = (line) => {
    const l = line.trim();
    if (!l) return false;

    // Normal bullets: • / - / * / 1) / 1.
    if (/^(\u2022|•|\-|\*|\d+[.)])\s+/.test(l)) return true;

    // Colon bullets: "PRODUCT NAME: reason..."
    if (/^.{3,80}:\s+/.test(l)) return true;

    return false;
  };

  const cleanBullet = (line) =>
    line
      .trim()
      .replace(/^(\u2022|•|\-|\*|\d+[.)])\s+/, "") // remove classic bullet markers
      .trim();

  // Rule: if there are 2+ blocks, last block is the "proof block"
  const narrativeBlocks = blocks.length >= 2 ? blocks.slice(0, -1) : [];
  const proofBlock = blocks.length >= 2 ? blocks[blocks.length - 1] : blocks[0] || "";

  // Split proof block into candidate "bullet lines"
  const proofLines = proofBlock
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // 1) Try explicit bullets / colon bullets first
  const explicitBullets = proofLines.filter(isBulletLine);

  if (explicitBullets.length >= 2) {
    return (
      <>
        {narrativeBlocks.map((p, i) => (
          <p key={`n-${i}`} className={styles.blurb}>
            {p}
          </p>
        ))}

        <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
          {explicitBullets.map((l, i) => (
            <li key={`b-${i}`} style={{ marginBottom: 6, lineHeight: 1.45 }}>
              {cleanBullet(l)}
            </li>
          ))}
        </ul>
      </>
    );
  }

  // 2) If no explicit bullets, but the proof block is "sentence-proof" (like your screenshot),
  // turn sentences into bullets.
  const sentenceBullets = proofBlock
    .replace(/\s+Tip:\s+/g, " Tip: ") // keep tip with sentence
    .split(/(?<=[.!?])\s+/) // split by sentence endings
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentenceBullets.length >= 2) {
    return (
      <>
        {narrativeBlocks.map((p, i) => (
          <p key={`n2-${i}`} className={styles.blurb}>
            {p}
          </p>
        ))}

        <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
          {sentenceBullets.map((s, i) => (
            <li key={`s-${i}`} style={{ marginBottom: 6, lineHeight: 1.45 }}>
              {s}
            </li>
          ))}
        </ul>
      </>
    );
  }

  // 3) Final fallback: preserve as paragraphs / pre-line
  return (
    <>
      {blocks.map((p, i) => (
        <p key={`p-${i}`} className={styles.blurb}>
          {p}
        </p>
      ))}
    </>
  );
};


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
        onChange={(e) => setConcern(e.target.value)}
        onKeyDown={onTextKeyDown}
        placeholder="What are you looking for?"
      />

      <button
        data-refina-ask-btn
        className={styles.askButton}
        onClick={() => handleRecommend(concern)}
        disabled={loading}
        aria-busy={loading}
        aria-live="polite"
      >
        {loading ? "Working…" : askLabel}
      </button>


           {(copy.why || copy.rationale || copy.extras) && (
        <div className={styles.responseBox} aria-live="polite">
          <h2>Here’s what I’d pick</h2>

          {copy.why ? renderOpener(copy.why) : null}

          {copy.rationale ? renderRationale(copy.rationale) : null}

          {copy.extras ? (
            <p className={styles.usageNote} style={{ whiteSpace: "pre-line" }}>
              {copy.extras}
            </p>
          ) : null}
        </div>
      )}

     {(viewMode === "utility" || viewMode === "followup") && returnState && !loading && (
  <div style={{ marginTop: "1rem", marginBottom: "0.75rem" }}>
    <button
      type="button"
      onClick={handleReturnToResults}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        fontSize: "14px",
        fontWeight: 600,
        color: "var(--rf-primary-color, #e91e63)",
      }}
    >
      ← Return to results
    </button>
  </div>
)}

{loading && (
  <div
    className={styles.responseBox}
    style={{
      textAlign: "center",
      padding: "1.5rem 1rem",
      marginTop: "1rem",
    }}
  >
    <h2 style={{ marginBottom: "0.5rem" }}>Checking that for you…</h2>

    {!!lastQuery && (
      <p
        style={{
          fontSize: "14px",
          color: "#666",
          marginBottom: "0.75rem",
        }}
      >
        “{lastQuery}”
      </p>
    )}

    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "10px",
        justifyContent: "center",
        marginBottom: "0.5rem",
      }}
    >
      <div
        style={{
          width: "18px",
          height: "18px",
          border: "2px solid rgba(0,0,0,0.12)",
          borderTopColor: "var(--rf-primary-color, #e91e63)",
          borderRadius: "50%",
          animation: "rfSpin 0.8s linear infinite",
        }}
      />
      <span style={{ fontSize: "14px", fontWeight: 600, color: "#333" }}>
        {progressLabel}
      </span>
    </div>

    <p style={{ fontSize: "13px", color: "#777", margin: 0 }}>
      Refina is reviewing your shortlisted products.
    </p>
  </div>
)}

{!loading && matchedProducts.length > 0 && (
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
            onClick={() => {
                console.log('[Refina] Sending product:', product.name);
              window.parent.postMessage({
                type: 'refina:product:open',
                product: {
                  id: product.id,
                  name: product.name,
                  image: product.image,
                  price: product.price,
                  description: product.description,
                  url: product.url
                },
                context: { query: lastQuery }
              }, '*');
            }}
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

{!loading && followUps.length > 0 && (
  <div
    style={{
      marginTop: "2rem",
      padding: "1rem 0",
      textAlign: "center",
      borderTop: "1px solid #f0f0f0",
    }}
  >
    <p style={{ fontSize: "14px", color: "#666", marginBottom: "1rem" }}>
      Still have questions?
    </p>
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        justifyContent: "center",
      }}
    >
      {followUps.map((pill, idx) => (
        <button
          key={`${pill.type || "followup"}-${idx}-${pill.label}`}
          style={{
            background: "white",
            border: "1px solid var(--rf-primary-color, #e91e63)",
            color: "var(--rf-primary-color, #e91e63)",
            padding: "8px 16px",
            borderRadius: "20px",
            fontSize: "13px",
            cursor: "pointer",
          }}
          onClick={() => handleFollowUp(pill)}
        >
          {pill.label}
        </button>
      ))}
    </div>
  </div>
)}
    </div>
  );
}
