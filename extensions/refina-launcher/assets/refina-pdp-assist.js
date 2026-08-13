/* Refina — PDP Assist client
   - Side Drawer presets UX + handoff to main concierge
   - Builds a canonical paramstring and saves to sessionStorage
   - Option B (Refresh on Continue): re-reads live PDP variant/price before opening
   - Seeds inline verdict + quick-peek via tiny GET fast paths
*/

(() => {
  if (window.__REFINA_PDP_ASSIST__) return;
  window.__REFINA_PDP_ASSIST__ = true;

  const STORAGE_KEY = "refina_prefill";

  // The App Proxy path 302-redirects to the backend (myshopify.com -> custom
  // domain -> onrender.com). sendBeacon fails that redirect with a CORS error,
  // and even a plain POST loses its JSON body on a 302 (standard HTTP redirect
  // behavior). Query params survive the redirect though — same as how Shopify's
  // own shop/timestamp/signature params make it through — so send fields that way.
  function sendAnalyticsBeacon(payload) {
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) {
        if (v != null) qs.set(k, String(v));
      }
      fetch(`/apps/refina/v1/analytics/ingest?${qs.toString()}`, {
        method: "POST",
        keepalive: true,
      });
    } catch {}
  }

  // Detect Theme Editor/Admin (open in new tab)
  const IN_THEME_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  let IN_ADMIN = false;
  try {
    const refHost = new URL(document.referrer || "", location.href).hostname || "";
    IN_ADMIN = /(^|\.)admin\.shopify\.com$/i.test(refHost);
  } catch {}

  // ─────────────────────────────────────────────
  // Drawer CSS injection
  // ─────────────────────────────────────────────
  (function injectDrawerCssOnce() {
    if (document.getElementById("refina-pdp-drawer-css")) return;

    const css = `
/* ── Host ── */
.refina-dw-host {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  pointer-events: none;
  /* Design tokens — overridable per-instance via JS */
  --rf-bg:           #FFFFFF;
  --rf-bg-alt:       #F7F5F1;
  --rf-fg:           #1C1A18;
  --rf-muted:        #7A756F;
  --rf-rule:         rgba(28, 26, 24, 0.09);
  --rf-chip-bg:      #EEEBE5;
  --rf-accent:       #2D4A3E;
  --rf-accent-light: #EBF2EB;
  --rf-dw-radius:    16px;
  --rf-primary:      #1C1A18;
  --rf-primary-txt:  #FAFAF8;
  color-scheme: light;
  isolation: isolate;
}
.refina-dw-host.is-open { pointer-events: auto; }

/* ── Backdrop ── */
.refina-dw-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.38);
  opacity: 0;
  transition: opacity 0.24s ease;
}
.refina-dw-host.is-open .refina-dw-backdrop { opacity: 1; }

/* ── Drawer panel ── */
.refina-dw {
  position: absolute;
  right: 0;
  top: 50%;
  width: min(400px, 92vw);
  max-height: min(82vh, 760px);
  background: var(--rf-bg);
  /* No border by default — shadow only when open avoids the keyline flash */
  transform: translateX(100%) translateY(-50%);
  transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1),
              box-shadow 0.26s ease;
  display: flex;
  flex-direction: column;
  border-radius: var(--rf-dw-radius) 0 0 var(--rf-dw-radius);
  overflow: hidden;
  color: var(--rf-fg);
}
.refina-dw-host.is-open .refina-dw {
  transform: translateX(0) translateY(-50%);
  box-shadow: -2px 0 0 0 var(--rf-rule),
              -20px 0 70px rgba(0, 0, 0, 0.18);
}

/* ── Header ── */
.refina-dw-head {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 18px 16px;
  border-bottom: 1px solid var(--rf-rule);
  flex-shrink: 0;
}

.refina-dw-icon {
  width: 36px;
  height: 36px;
  min-width: 36px;
  border-radius: 10px;
  background: var(--rf-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  align-self: flex-start;
  margin-top: 1px;
}
.refina-dw-icon svg { width: 16px; height: 16px; }

.refina-dw-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.refina-dw-title {
  font-weight: 500;
  font-size: 1.05em;
  line-height: 1.25;
  color: var(--rf-fg);
}
.refina-dw-sub {
  font-size: 0.83em;
  line-height: 1.4;
  color: var(--rf-muted);
}

.refina-dw-close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--rf-chip-bg);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--rf-muted);
  flex-shrink: 0;
  transition: background 0.15s;
  align-self: flex-start;
}
.refina-dw-close:hover { background: rgba(28,26,24,0.14); }
.refina-dw-close svg { width: 10px; height: 10px; }

/* ── Context strip ── */
.refina-dw-context {
  padding: 9px 18px;
  border-bottom: 1px solid var(--rf-rule);
  background: var(--rf-accent-light);
  font-size: 0.82em;
  color: var(--rf-accent);
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}
.refina-dw-context[data-hidden] { display: none; }
.refina-dw-context svg {
  width: 13px; height: 13px;
  opacity: 0.65;
  flex-shrink: 0;
}
.refina-dw-context strong { font-weight: 500; }

/* ── Scrollable body ── */
.refina-dw-body {
  padding: 16px 18px 14px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── Results section ── */
.refina-dw-results { margin-bottom: 4px; }

.refina-dw-results-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 11px;
}

.refina-dw-results-title {
  font-size: 0.70em;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--rf-muted);
}
.refina-dw-results-sub {
  font-size: 0.84em;
  color: var(--rf-muted);
  line-height: 1.35;
}

.refina-dw-results-list { display: flex; flex-direction: column; gap: 8px; }

/* ── Product result card: 3-col grid: image | info | price ── */
.refina-dw-result {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1.5px solid var(--rf-rule);
  background: var(--rf-bg);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.18s, background 0.18s, transform 0.14s;
  position: relative;
  overflow: hidden;
  width: 100%;
  box-sizing: border-box;
}
.refina-dw-result:hover {
  border-color: var(--rf-accent);
  background: var(--rf-accent-light);
  transform: translateX(3px);
}
.refina-dw-result:active { transform: translateY(1px); }

/* Accent left bar */
.refina-dw-result::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0;
  background: var(--rf-accent);
  transition: width 0.15s ease;
  border-radius: 12px 0 0 12px;
}
.refina-dw-result:hover::before { width: 3px; }

.refina-dw-result-img {
  width: 52px;
  height: 52px;
  border-radius: 9px;
  object-fit: cover;
  background: var(--rf-chip-bg);
  border: 1px solid var(--rf-rule);
  display: block;
}

.refina-dw-result-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.refina-dw-result-title {
  font-size: 0.88em;
  font-weight: 500;
  line-height: 1.2;
  color: var(--rf-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.refina-dw-result-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.refina-dw-result-why {
  font-size: 0.80em;
  color: var(--rf-muted);
  line-height: 1.3;
}

/* ── Badge pills ── */
.refina-dw-badge {
  display: inline-block;
  font-size: 0.73em;
  font-weight: 400;
  padding: 2px 8px;
  border-radius: 100px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  line-height: 1.6;
}
.refina-dw-badge--value   { background: #DFF0E0; color: #2A6035; }
.refina-dw-badge--similar { background: var(--rf-chip-bg); color: var(--rf-muted); }
.refina-dw-badge--upgrade { background: #F5E8E0; color: #9C4A28; }

/* ── Price ── */
.refina-dw-result-price {
  font-size: 0.92em;
  font-weight: 500;
  color: var(--rf-fg);
  white-space: nowrap;
  text-align: right;
  align-self: center;
}

/* ── Empty state ── */
.refina-dw-empty {
  padding: 12px 14px;
  border-radius: 11px;
  border: 1.5px dashed var(--rf-rule);
  font-size: 0.86em;
  line-height: 1.4;
  color: var(--rf-muted);
}

/* ── Divider inside body ── */
.refina-dw-divider {
  height: 1px;
  background: var(--rf-rule);
  margin: 18px -18px;
}

/* ── Rank chips section ── */
.refina-dw-rank-title {
  margin-bottom: 9px;
  font-size: 0.70em;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--rf-muted);
}

.refina-dw-chips {
  display: flex;
  gap: 7px;
}

.refina-dw-chip {
  flex: 1;
  padding: 10px 8px 9px;
  border-radius: 10px;
  border: 1.5px solid var(--rf-rule);
  background: var(--rf-bg);
  font-size: 0.83em;
  font-weight: 400;
  color: var(--rf-fg);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  line-height: 1;
  font-family: inherit;
}
.refina-dw-chip-icon {
  font-size: 15px;
  line-height: 1;
  display: block;
}
.refina-dw-chip:hover {
  border-color: var(--rf-fg);
  background: var(--rf-chip-bg);
}
.refina-dw-chip.is-active {
  background: var(--rf-fg);
  border-color: var(--rf-fg);
  color: #FAFAF8;
}
.refina-dw-chip:active { transform: translateY(1px); }

/* ── Text input ── */
.refina-dw-input {
  width: 100%;
  min-height: 72px;
  padding: 10px 12px;
  border-radius: 11px;
  border: 1.5px solid var(--rf-rule);
  background: var(--rf-bg);
  color: var(--rf-fg);
  font-size: 0.87em;
  line-height: 1.45;
  resize: vertical;
  transition: border-color 0.15s;
  font-family: inherit;
  box-sizing: border-box;
}
.refina-dw-input:focus {
  outline: none;
  border-color: var(--rf-accent);
}
.refina-dw-input::placeholder { color: var(--rf-muted); opacity: 0.7; }

/* ── Footer ── */
.refina-dw-foot {
  padding: 14px 18px 16px;
  border-top: 1px solid var(--rf-rule);
  background: var(--rf-bg-alt);
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
}

.refina-dw-foot-note {
  min-width: 0;
}
.refina-dw-foot-note strong {
  display: block;
  font-size: 0.92em;
  font-weight: 500;
  color: var(--rf-fg);
  line-height: 1.3;
  margin-bottom: 2px;
}
.refina-dw-foot-note span {
  font-size: 0.82em;
  color: var(--rf-muted);
  line-height: 1.3;
}

.refina-dw-continue {
  padding: 11px 18px;
  border-radius: 10px;
  border: none;
  background: var(--rf-primary);
  color: var(--rf-primary-txt);
  font-size: 0.86em;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  letter-spacing: 0.02em;
  transition: opacity 0.15s;
  font-family: inherit;
}
.refina-dw-continue:hover { opacity: 0.84; }
.refina-dw-continue:active { transform: translateY(1px); }
.refina-dw-continue svg { width: 12px; height: 12px; opacity: 0.75; }

/* ── Empty-state actions ── */
.refina-dw-empty-btn {
  padding: 7px 12px;
  border-radius: 999px;
  border: 1.5px solid var(--rf-rule);
  background: var(--rf-chip-bg);
  font-size: 0.84em;
  font-weight: 500;
  cursor: pointer;
  color: var(--rf-fg);
  font-family: inherit;
}
.refina-dw-empty-btn:active { transform: translateY(1px); }

/* ── Mobile ── */
@media (max-width: 640px) {
  .refina-dw {
    top: 0;
    max-height: 100dvh;
    transform: translateX(100%);
    border-radius: var(--rf-dw-radius) 0 0 0;
  }
  .refina-dw-host.is-open .refina-dw { transform: translateX(0); }
}
    `;

    const el = document.createElement("style");
    el.id = "refina-pdp-drawer-css";
    el.textContent = css;
    document.head.appendChild(el);
  })();

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────
  const uuid = () =>
    ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g,c=>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

  function findCurrentVariantId() {
    const cand = document.querySelector('form[action*="/cart"] [name="id"], form[action*="/cart/add"] [name="id"]');
    if (!cand) return null;
    const val = (cand.value || cand.getAttribute("value") || "").trim();
    return val || null;
  }

  function coerceInt(v) {
    const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function getPayload(root, overrides = {}) {
    const ds = root.dataset || {};
    const chips = [ds.chip1, ds.chip2, ds.chip3, ds.chip4]
      .filter(Boolean)
      .map((s) => s.trim());

    const priceCap = (overrides.priceCap ?? ds.priceCap ?? "").toString().trim();
    const productTitle = (overrides.productTitle ?? ds.productTitle ?? "").toString().trim();
    const productType = (overrides.productType ?? ds.productType ?? "").toString().trim();

    const defaultPrefill = productTitle
      ? `I'm looking at "${productTitle}". Can you suggest better fits for me?`
      : `Can you suggest the best fit for me from this store?`;

    const prefill = (overrides.prefill && overrides.prefill.trim()) || defaultPrefill;

    return {
      source: "pdp",
      shop: ds.shop || (window.Shopify && (Shopify.shop || Shopify.permanent_domain)) || "",
      productId: ds.productId || null,
      productTitle,
      productType: productType || null,
      variantId: ds.selectedVariantId || null,
      variantTitle: ds.selectedVariantTitle || null,
      available: String(ds.selectedVariantAvailable || "").toLowerCase() === "true",
      price: coerceInt(ds.priceCents),
      compareAtPrice: coerceInt(ds.compareAtPriceCents),
      currency: ds.currency || (window.Shopify && Shopify.currency && Shopify.currency.active) || null,
      priceCap: priceCap || null,
      chips,
      intent: null,
      contextId: null,
      prefill,
      headline: ds.headline || "",
      subcopy: ds.subcopy || "",
      drawerHeading: ds.drawerHeading || "",
      drawerSubheading: ds.drawerSubheading || "",
      buttonText: ds.buttonText || ""
    };
  }

  function resolveAccentHex(name) {
    switch ((name || "").toLowerCase()) {
      case "amber":   return "#FFC466";
      case "teal":    return "#17E6C3";
      case "neutral": return null; // use primary colour
      default:        return "#7A5CFF"; // violet
    }
  }

  function parseChipKeys(root) {
    const raw =
      root && root.dataset && root.dataset.chipKeys ? String(root.dataset.chipKeys) : "";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function mapChipKeyToIntent(key) {
    const k = String(key || "").toLowerCase().trim();
    if (k === "compare") return "util-compare";
    if (k === "value" || k === "best-value") return "util-value";
    if (k === "cheaper" || k === "budget") return "util-cheaper";
    if (k === "upgrade") return "util-upgrade";
    return null;
  }

  function mapChipToIntent(chip) {
    const s = String(chip || "").toLowerCase();
    if (s.includes("compare")) return "util-compare";
    if (s.includes("best value") || s.includes("value")) return "util-value";
    if (s.includes("cheaper")) return "util-cheaper";
    if (s.includes("upgrade")) return "util-upgrade";
    if (s.includes("best value") || s.includes("value")) return "rank-value";
    if (s.includes("cheaper") || s.includes("budget")) return "rank-budget";
    if (s.includes("upgrade")) return "rank-upgrade";
    return null;
  }

  function getIntentForPdpChip(root, chipEl) {
    const keys = parseChipKeys(root);
    const chips = Array.from(root.querySelectorAll(".refina-pdp-assist__chip"));
    const idx = Math.max(0, chips.indexOf(chipEl));
    const key = keys && keys[idx] ? keys[idx] : null;
    const text = (chipEl && chipEl.textContent ? chipEl.textContent : "").trim();
    return mapChipKeyToIntent(key) || mapChipToIntent(text);
  }

  function getIntentForDrawerChip(root, chipIndex, chipLabelText) {
    const s = String(chipLabelText || "").toLowerCase();
    if (s.includes("best value") || s.includes("value")) return "rank-value";
    if (s.includes("cheaper") || s.includes("budget")) return "rank-budget";
    if (s.includes("upgrade")) return "rank-upgrade";
    return null;
  }

  // ─────────────────────────────────────────────
  // Money / candidate helpers
  // ─────────────────────────────────────────────
  function formatMoneyFromCents(cents, currency) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "";
    const cur = (currency || "USD").toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: cur,
        maximumFractionDigits: 0,
      }).format(n / 100);
    } catch {
      return `$${Math.round(n / 100)}`;
    }
  }

  function normalizePeekCandidates(data) {
    const raw =
      (data && Array.isArray(data.candidates) && data.candidates) ||
      (data && Array.isArray(data.alts) && data.alts) ||
      (data && Array.isArray(data.alternatives) && data.alternatives) ||
      [];

    return raw
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        const id = p.id || p.productId || p.shopifyId || null;
        const title = p.title || p.name || "";
        const why = p.why || p.reason || p.subtitle || "";
        const image =
          (Array.isArray(p.images) && p.images[0] && (p.images[0].src || p.images[0].url)) ||
          p.image || p.imageUrl || "";
        const handle = p.handle || "";
        const url = p.url || (handle ? `/products/${handle}` : "");
        const priceCents =
          p.priceCents ?? p.price_cents ??
          (typeof p.price === "number" ? Math.round(p.price * 100) : null);
        const score = typeof p.score === "number" ? p.score : null;
        return { id, title, why, image, url, priceCents, score };
      })
      .filter(Boolean)
      .slice(0, 3);
  }

  function getRankLabel(intent) {
    switch (intent) {
      case "rank-value":  return "Best value";
      case "rank-budget": return "Cheaper";
      case "rank-upgrade":return "Upgrade pick";
      default:            return "";
    }
  }

  function getRankWhy(intent) {
    switch (intent) {
      case "rank-value":  return "Best balance of fit and price.";
      case "rank-budget": return "Cheaper options from these picks.";
      case "rank-upgrade":return "Premium step-up from these picks.";
      default:            return "";
    }
  }

  function rankCandidatesByIntent(candidates, intent) {
    const list = Array.isArray(candidates) ? [...candidates] : [];
    if (!list.length) return list;

    const getPrice = (x) =>
      x && x.priceCents != null && Number.isFinite(Number(x.priceCents))
        ? Number(x.priceCents) : null;
    const getScore = (x) =>
      x && x.score != null && Number.isFinite(Number(x.score))
        ? Number(x.score) : null;

    if (intent === "rank-budget") {
      return list.sort((a, b) => {
        const ap = getPrice(a), bp = getPrice(b);
        if (ap == null && bp == null) return 0;
        if (ap == null) return 1;
        if (bp == null) return -1;
        return ap - bp;
      });
    }
    if (intent === "rank-upgrade") {
      return list.sort((a, b) => {
        const ap = getPrice(a), bp = getPrice(b);
        if (ap == null && bp == null) return 0;
        if (ap == null) return 1;
        if (bp == null) return -1;
        return bp - ap;
      });
    }
    if (intent === "rank-value") {
      return list.sort((a, b) => {
        const as = getScore(a), bs = getScore(b);
        if (as != null && bs != null && as !== bs) return bs - as;
        if (as != null && bs == null) return -1;
        if (as == null && bs != null) return 1;
        const ap = getPrice(a), bp = getPrice(b);
        if (ap == null && bp == null) return 0;
        if (ap == null) return 1;
        if (bp == null) return -1;
        return ap - bp;
      });
    }
    return list;
  }

  function applyRankWhy(candidates, intent) {
    const why = getRankWhy(intent);
    if (!why) return candidates;
    return (candidates || []).map((p) => ({ ...p, why }));
  }

  // ─────────────────────────────────────────────
  // Render helpers
  // ─────────────────────────────────────────────
  function renderDrawerCandidates(host, payload, candidates) {
    const list = host.querySelector("[data-results]");
    const sub  = host.querySelector("[data-results-sub]");
    if (!list || !sub) return;

    list.innerHTML = "";

    if (!candidates || !candidates.length) {
      const hasRefine = !!String(payload?.refineText || "").trim();
      sub.textContent = hasRefine
        ? `No strong matches found for: "${payload.refineText}".`
        : "No instant alternatives found for this item.";

      const wrap = document.createElement("div");
      wrap.className = "refina-dw-empty";

      const line1 = document.createElement("div");
      line1.textContent = "This may already be one of the best fits in this store.";

      const line2 = document.createElement("div");
      line2.style.marginTop = "6px";
      line2.textContent =
        "Try a different preference, or open the full assistant for deeper recommendations.";

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;";

      const btnClosest = document.createElement("button");
      btnClosest.type = "button";
      btnClosest.className = "refina-dw-empty-btn";
      btnClosest.textContent = "Show closest matches";
      btnClosest.onclick = () => {
        try { payload.intent = "compare-3"; hydrateDrawerPeek(host, payload); } catch {}
      };

      actions.appendChild(btnClosest);
      wrap.appendChild(line1);
      wrap.appendChild(line2);
      wrap.appendChild(actions);
      list.appendChild(wrap);
      return;
    }

    if (payload.refineText) {
      sub.textContent = `Updated for: "${payload.refineText}"`;
    } else {
      sub.textContent =
        candidates.length === 1
          ? "Found 1 close match to compare."
          : `Found ${candidates.length} close matches to compare.`;
    }

    candidates.forEach((p, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "refina-dw-result";

      // Image
      const img = document.createElement("img");
      img.className = "refina-dw-result-img";
      img.alt = p.title ? String(p.title) : "Alternative product";
      if (p.image) img.src = p.image;

      // Meta column (title + badge row)
      const meta = document.createElement("div");
      meta.className = "refina-dw-result-meta";

      const t = document.createElement("div");
      t.className = "refina-dw-result-title";
      t.textContent = p.title || "";

      // Badge + why row
      const row = document.createElement("div");
      row.className = "refina-dw-result-row";

      // Badge based on intent or position
      const badge = document.createElement("span");
      badge.className = "refina-dw-badge";
      const intentKey = (payload.intent || "").toLowerCase();
      if (intentKey === "rank-value" || intentKey === "util-value" || idx === 0) {
        badge.classList.add("refina-dw-badge--value");
        badge.textContent = intentKey.includes("budget") ? "Cheaper" :
                            intentKey.includes("upgrade") ? "Premium" : "Best value";
      } else if (intentKey === "rank-upgrade" || intentKey === "util-upgrade") {
        badge.classList.add("refina-dw-badge--upgrade");
        badge.textContent = "Premium";
      } else if (intentKey === "rank-budget" || intentKey === "util-cheaper") {
        badge.classList.add("refina-dw-badge--value");
        badge.textContent = "Cheaper";
      } else {
        badge.classList.add("refina-dw-badge--similar");
        badge.textContent = "Similar";
      }

      const why = document.createElement("span");
      why.className = "refina-dw-result-why";
      why.textContent = p.why || "";

      row.appendChild(badge);
      if (p.why) row.appendChild(why);

      meta.appendChild(t);
      meta.appendChild(row);

      // Price column
      const price = document.createElement("div");
      price.className = "refina-dw-result-price";
      if (p.priceCents != null) {
        price.textContent = formatMoneyFromCents(p.priceCents, payload.currency);
      }

      btn.appendChild(img);
      btn.appendChild(meta);
      btn.appendChild(price);

      if (p.url) {
        btn.onclick = () => {
          sendAnalyticsBeacon({
            storeId: payload.shop || payload.storeId || "",
            type: "concern",
            event: "product_click",
            productId: (p.id || p.productId || p.shopifyId) != null ? String(p.id || p.productId || p.shopifyId) : null,
            contextId: payload.contextId || null
          });
          try { window.location.href = p.url; } catch {}
        };
      }

      list.appendChild(btn);
    });
  }

  async function hydrateDrawerPeek(host, payload) {
    const sub  = host.querySelector("[data-results-sub]");
    const list = host.querySelector("[data-results]");
    if (!sub || !list) return;

    const token = uuid();
    host.dataset.rfPeekToken = token;

    const hasRefine = !!String(payload.refineText || "").trim();
    sub.textContent = hasRefine ? "Updating matches…" : "Finding the best matches…";
    list.innerHTML = "";

    const storeId = payload.shop || payload.storeId || "";
    if (!storeId) { renderDrawerCandidates(host, payload, []); return; }

    const refineText = String(payload.refineText || "").trim().slice(0, 240);
    payload.refineText = refineText;

    const qs = new URLSearchParams({
      mode: "peek",
      storeId,
      productId: payload.productId || "",
      intent: payload.intent || "",
      priceCap: payload.priceCap || "",
      currency: payload.currency || "",
      q: refineText || "",
    });

    try {
      const resp = await fetch(`/apps/refina/v1/recommend?${qs.toString()}`, {
        credentials: "same-origin",
      });
      if (!resp.ok) throw new Error("peek_failed");

      const data = await resp.json();
      if (host.dataset.rfPeekToken !== token) return;

      const candidates = normalizePeekCandidates(data);
      host.__rfPeekCandidates = candidates;
      renderDrawerCandidates(host, payload, candidates);
    } catch {
      if (host.dataset.rfPeekToken !== token) return;
      sub.textContent = "Quick alternatives are unavailable right now.";
      renderDrawerCandidates(host, payload, []);
    }
  }

  // ─────────────────────────────────────────────
  // Session storage / concierge handoff
  // ─────────────────────────────────────────────
  function savePrefill(payload) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
  }

  function openConcierge(payload) {
    savePrefill(payload);

    if (window.RefinaLauncher && typeof window.RefinaLauncher.open === "function") {
      window.RefinaLauncher.open({ source: payload.source, prefill: payload.prefill, context: payload });
      return;
    }

    if (IN_THEME_EDITOR || IN_ADMIN) {
      const shop =
        payload.shop || (window.Shopify && (Shopify.shop || Shopify.permanent_domain)) || "";
      if (!shop) return;
      const url = new URL(`https://${shop}/apps/refina`);
      for (const [k, v] of Object.entries(payload)) {
        if (v == null) continue;
        if (Array.isArray(v)) url.searchParams.set(k, v.join(","));
        else url.searchParams.set(k, String(v));
      }
      try { window.open(url.toString(), "_blank", "noopener"); } catch { location.href = url.toString(); }
      return;
    }

    const params = new URLSearchParams({ refina: "1" });
    for (const [k, v] of Object.entries(payload)) {
      if (v == null) continue;
      if (Array.isArray(v)) params.set(k, v.join(","));
      else params.set(k, String(v));
    }
    try {
      history.replaceState(null, "", location.pathname + location.search + "#refina?" + params.toString());
    } catch {
      location.hash = "#refina?" + params.toString();
    }
    document.dispatchEvent(new CustomEvent("refina:open", { detail: payload }));
  }

  // ─────────────────────────────────────────────
  // Drawer creation
  // ─────────────────────────────────────────────
  function ensureDrawer(radiusPx = "16px", accentHex = null, primaryHex = null) {
    let host = document.getElementById("refina-pdp-drawer");
    if (host) {
      // Update accent/primary in case a different PDP block triggered it
      const finalAccent = accentHex || primaryHex;
      if (accentHex) host.style.setProperty("--rf-accent", accentHex);
      if (primaryHex) {
        host.style.setProperty("--rf-primary", primaryHex);
        if (!accentHex) host.style.setProperty("--rf-accent", primaryHex);
      }
      // Always re-derive the tint from whatever accent won
      if (finalAccent) host.style.setProperty("--rf-accent-light", hexToLightBg(finalAccent));
      host.style.setProperty("--rf-dw-radius", radiusPx);
      return host;
    }

    host = document.createElement("div");
    host.id = "refina-pdp-drawer";
    host.className = "refina-dw-host";
    host.innerHTML = `
      <div class="refina-dw-backdrop" data-close></div>
      <aside class="refina-dw" role="dialog" aria-modal="true" aria-labelledby="rf-dw-title" tabindex="-1">

        <header class="refina-dw-head">
          <div class="refina-dw-icon" aria-hidden="true">
            <svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 2L10.5 6.5H15.5L11.5 9.2L13 14L9 11.3L5 14L6.5 9.2L2.5 6.5H7.5L9 2Z" fill="white" opacity="0.9"/>
            </svg>
          </div>
          <div class="refina-dw-copy">
            <h4 id="rf-dw-title" class="refina-dw-title"></h4>
            <div class="refina-dw-sub" data-sub></div>
          </div>
          <button type="button" class="refina-dw-close" data-close aria-label="Close">
            <svg viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M1 1l9 9M10 1L1 10"/>
            </svg>
          </button>
        </header>

        <div class="refina-dw-context" data-context>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3">
            <circle cx="6" cy="6" r="5"/>
            <path d="M6 4.5v2.5M6 8.2v.8"/>
          </svg>
          <span data-context-text></span>
        </div>

        <div class="refina-dw-body">

          <section class="refina-dw-results" aria-live="polite">
            <div class="refina-dw-results-head">
              <div class="refina-dw-results-title">Similar options</div>
              <div class="refina-dw-results-sub" data-results-sub>Finding the best matches…</div>
            </div>
            <div class="refina-dw-results-list" data-results></div>
          </section>

          <div class="refina-dw-divider"></div>

          <div class="refina-dw-rank-title">Refine these picks</div>
          <div class="refina-dw-chips" data-chips></div>

        </div>

        <footer class="refina-dw-foot">
          <div class="refina-dw-foot-note">
            <strong>Want a deeper recommendation?</strong>
            <span>Tell me what matters most to you</span>
          </div>
          <textarea
            class="refina-dw-input"
            data-input
            rows="2"
            placeholder="e.g. sensitive skin, no fragrance, under $40…"
          ></textarea>
          <button type="button" class="refina-dw-continue" data-continue>
            Open chat
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M2 6h8M7 3l3 3-3 3"/>
            </svg>
          </button>
        </footer>

      </aside>
    `;

    document.body.appendChild(host);

    host.style.setProperty("--rf-dw-radius", radiusPx);
    if (primaryHex) host.style.setProperty("--rf-primary", primaryHex);

    // Determine the winning accent: explicit accentHex > primaryHex fallback
    const resolvedAccent = accentHex || primaryHex;
    if (resolvedAccent) {
      host.style.setProperty("--rf-accent", resolvedAccent);
      host.style.setProperty("--rf-accent-light", hexToLightBg(resolvedAccent));
    }

    return host;
  }

  // Derive a light tint from a hex colour for the context strip + hover backgrounds
  function hexToLightBg(hex) {
    try {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, 0.10)`;
    } catch {
      return "rgba(45, 74, 62, 0.10)";
    }
  }

  // ─────────────────────────────────────────────
  // Open drawer
  // ─────────────────────────────────────────────
  function openDrawerFrom(root, basePayload) {
    const radiusPx   = root?.dataset?.styleRadius || "14px";
    const accentName = root?.dataset?.styleAccent || "neutral";
    const accentHex  = resolveAccentHex(accentName);

    // Read merchant primary from the inline CSS var set by Liquid
    const cardEl = root.querySelector(".refina-pdp-assist__card");
    const primaryHex = cardEl
      ? getComputedStyle(cardEl).getPropertyValue("--rf-pdp-primary").trim() || null
      : null;

    const host = ensureDrawer(radiusPx, accentHex, primaryHex);

    const aside    = host.querySelector(".refina-dw");
    const input    = host.querySelector("[data-input]");
    const chipsBox = host.querySelector("[data-chips]");
    const titleEl  = host.querySelector(".refina-dw-title");
    const subEl    = host.querySelector("[data-sub]");
    const ctxEl    = host.querySelector("[data-context-text]");
    const ctxWrap  = host.querySelector("[data-context]");
    const ctaBtn   = host.querySelector("[data-continue]");

    basePayload.contextId = basePayload.contextId || uuid();

    host.classList.add("is-open");
    try { aside && aside.focus(); } catch {}

    if (!input || !chipsBox || !titleEl || !subEl || !ctxEl || !ctaBtn) return;

    titleEl.textContent =
      (basePayload.drawerHeading && basePayload.drawerHeading.trim()) ||
      (basePayload.headline && basePayload.headline.trim()) ||
      "Similar options";
    subEl.textContent =
      (basePayload.drawerSubheading && basePayload.drawerSubheading.trim()) ||
      "";

    // Context strip
    if (basePayload.productTitle) {
      ctxEl.textContent = `Using "${basePayload.productTitle}" as context`;
      ctxWrap.removeAttribute("data-hidden");
    } else {
      ctxWrap.setAttribute("data-hidden", "");
    }

    input.value = "";

    // Rank chips with icons
    const rankChips = [
      { label: "Best value", icon: "◎" },
      { label: "Cheaper",    icon: "↓" },
      { label: "Upgrade pick", icon: "↑" },
    ];
    chipsBox.innerHTML = "";
    rankChips.forEach(({ label, icon }, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "refina-dw-chip";

      const iconEl = document.createElement("span");
      iconEl.className = "refina-dw-chip-icon";
      iconEl.textContent = icon;

      const labelEl = document.createElement("span");
      labelEl.textContent = label;

      b.appendChild(iconEl);
      b.appendChild(labelEl);

      b.addEventListener("click", () => {
        chipsBox.querySelectorAll(".refina-dw-chip").forEach(c => c.classList.remove("is-active"));
        b.classList.add("is-active");

        const intent = getIntentForDrawerChip(root, i, label);
        if (intent) basePayload.intent = intent;

        const existing = host.__rfPeekCandidates || [];
        if (!existing.length) return;

        const sub = host.querySelector("[data-results-sub]");
        const ranked = rankCandidatesByIntent(existing, intent);
        const final  = applyRankWhy(ranked, intent);

        try {
          renderDrawerCandidates(host, basePayload, final);
          if (sub) {
            const labelTxt = getRankLabel(intent);
            sub.textContent = labelTxt ? `Ranked by: ${labelTxt}` : "Ranked picks.";
          }
        } catch {}
      });

      chipsBox.appendChild(b);
    });

    // Initial peek fetch
    try { hydrateDrawerPeek(host, basePayload); } catch {}

    // Enter to re-fetch with custom query
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        basePayload.refineText = (input.value || "").trim();
        try { hydrateDrawerPeek(host, basePayload); } catch {}
      }
    });

    // Close handlers
    const close = () => host.classList.remove("is-open");
    const onEsc = (ev) => { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
    host.querySelector("[data-close]").onclick = close;
    host.querySelector(".refina-dw-close").onclick = close;
    document.addEventListener("keydown", onEsc);

    // Continue → open full concierge
    host.querySelector("[data-continue]").addEventListener("click", () => {
      const finalPrefill = (input.value || "").trim() || basePayload.prefill;
      const liveVariantId = findCurrentVariantId() || basePayload.variantId;
      const ds = root.dataset || {};
      const refreshed = {
        ...basePayload,
        prefill: finalPrefill,
        variantId: liveVariantId,
        variantTitle: ds.selectedVariantTitle || basePayload.variantTitle || null,
        available: String(ds.selectedVariantAvailable || "").toLowerCase() === "true",
        price: coerceInt(ds.priceCents),
        compareAtPrice: coerceInt(ds.compareAtPriceCents),
        currency: ds.currency || basePayload.currency || null,
        intent: basePayload.intent || null,
      };

      sendAnalyticsBeacon({
        storeId: refreshed.shop,
        type: "concern",
        event: "drawer_confirm",
        concern: finalPrefill,
        productId: refreshed.productId || null,
        contextId: refreshed.contextId || null,
        intent: refreshed.intent || null
      });

      openConcierge(refreshed);
      close();
    }, { once: true });

    sendAnalyticsBeacon({
      storeId: basePayload.shop,
      type: "concern",
      event: "drawer_open",
      productId: basePayload.productId || null,
      contextId: basePayload.contextId || null
    });
  }

  // ─────────────────────────────────────────────
  // Verdict (disabled per original)
  // ─────────────────────────────────────────────
  function hydrateVerdictAndPeek(root) {
    const verdictEl = root.querySelector(".refina-pdp-assist__verdict");
    if (!verdictEl) return;
    verdictEl.textContent = "";
    verdictEl.style.display = "none";
  }

  // ─────────────────────────────────────────────
  // Click delegation
  // ─────────────────────────────────────────────
  document.addEventListener(
    "click",
    (ev) => {
      const root = ev.target.closest("[data-refina-pdp-assist]");
      if (!root) return;

      const btn  = ev.target.closest(".refina-pdp-assist__button");
      const chip = ev.target.closest(".refina-pdp-assist__chip");
      if (!btn && !chip) return;

      const base = getPayload(root);

      if (btn) {
        base.prefill = "";
        base.intent  = null;
      }

      if (chip) {
        const chipText = (chip.textContent || "").trim();
        base.refineText = chipText || "";
        const intent = getIntentForPdpChip(root, chip);
        if (intent) base.intent = intent;
        if (intent === "alt-cheaper" && !base.priceCap) {
          const rawCap = (root.dataset.priceCap || "").trim();
          if (rawCap) base.priceCap = rawCap;
        }
      }

      hydrateVerdictAndPeek(root);
      openDrawerFrom(root, base);
    },
    { passive: true }
  );

  document.addEventListener("DOMContentLoaded", () => {
    const root = document.querySelector("[data-refina-pdp-assist]");
    if (root) hydrateVerdictAndPeek(root);
  });

})();