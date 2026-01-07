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

  // Detect Theme Editor/Admin (open in new tab)
  const IN_THEME_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  let IN_ADMIN = false;
  try {
    const refHost = new URL(document.referrer || "", location.href).hostname || "";
    IN_ADMIN = /(^|\.)admin\.shopify\.com$/i.test(refHost);
  } catch {}

  // Minimal CSS for drawer (glass look) + header/subcopy/micro-prompt
  (function injectDrawerCssOnce() {
    if (document.getElementById("refina-pdp-drawer-css")) return;
    const css = `
  .refina-dw-host { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; }
  .refina-dw-host.is-open { pointer-events: auto; }

  /* Force light scheme locally + safe fallbacks */
  .refina-dw-host {
    --color-background: #ffffff;
    --color-foreground: #111111;
    --refina-border: rgba(17,17,17,.10);
    color-scheme: light;
    isolation: isolate;
  }

  .refina-dw-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); opacity: 0; transition: opacity .22s ease; }
  .refina-dw-host.is-open .refina-dw-backdrop { opacity: 1; }

  .refina-dw { position: absolute; top: 0; right: 0; height: 100%; width: min(420px, 92vw);
    /* was falling back to #0b0b0e → dark */
    background: color-mix(in srgb, var(--color-background, #ffffff) 100%, transparent);
    border-left: 1px solid var(--refina-border);
    box-shadow: -20px 0 60px rgba(0,0,0,.35);
    transform: translateX(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1);
    display: grid; grid-template-rows: auto 1fr auto; border-top-left-radius: var(--rfina-dw-radius, 16px);
    border-bottom-left-radius: var(--rfina-dw-radius, 16px); overflow: hidden;
    color: var(--color-foreground);
  }
  .refina-dw-host.is-open .refina-dw { transform: translateX(0); }

  .refina-dw-head { display: grid; grid-template-columns: 1fr auto; align-items: start; gap: 12px; padding: 14px 14px 10px; }
  .refina-dw-copy { display: grid; gap: 4px; }
  .refina-dw-title { font-weight: 600; line-height: 1.25; }
  .refina-dw-sub { opacity: .85; font-size: .92em; line-height: 1.35; }
  .refina-dw-micro { opacity: .7; font-size: .85em; line-height: 1.3; }

  .refina-dw-close {
    border: 1px solid rgba(17,17,17,.14);
    background: transparent;
    border-radius: 8px; padding: 6px 10px; cursor: pointer; color: var(--color-foreground);
  }

  .refina-dw-body { padding: 0 14px 14px; overflow: auto; }
  .refina-dw-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }

  .refina-dw-chip {
    padding: 6px 10px; border-radius: 999px;
    border: 1px solid rgba(17,17,17,.12);
    background: transparent; cursor: pointer; font-size: .9em; color: var(--color-foreground);
  }

  .refina-dw-context { opacity: .75; font-size: .85em; margin-bottom: 6px; }
  .refina-dw-label { display: block; font-size: .9em; opacity: .85; margin-bottom: 6px; }

  .refina-dw-input {
    width: 100%; min-height: 80px; padding: 10px 12px; border-radius: 12px;
    border: 1px solid rgba(17,17,17,.14);
    background: color-mix(in srgb, var(--color-accent, #7A5CFF) 10%, transparent);
    color: var(--color-foreground); resize: vertical;
  }

  .refina-dw-foot { padding: 12px 14px 14px; display: grid; gap: 8px; }

  .refina-dw-continue {
    width: 100%; padding: 10px 12px; border-radius: 999px;
    border: 1px solid rgba(17,17,17,.14);
    background: color-mix(in srgb, var(--color-accent, #7A5CFF) 18%, transparent);
    font-weight: 600; cursor: pointer; color: var(--color-foreground);
  }

  @media (max-width: 640px) { .refina-dw { width: 100vw; } }
`;

    const el = document.createElement("style");
    el.id = "refina-pdp-drawer-css";
    el.textContent = css;
    document.head.appendChild(el);
  })();

  // Helpers
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
    const chips = [ds.chip1, ds.chip2, ds.chip3, ds.chip4].filter(Boolean).map(s => s.trim());

    const priceCap = (overrides.priceCap ?? ds.priceCap ?? "").toString().trim();
    const productTitle = (overrides.productTitle ?? ds.productTitle ?? "").toString().trim();
    const productType = (overrides.productType ?? ds.productType ?? "").toString().trim();

    const defaultPrefill =
      (productTitle ? `I’m looking at “${productTitle}”. Can you suggest better fits for me?`
                    : `Can you suggest the best fit for me from this store?`);
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
      // NEW: carry through drawer text & CTA from block
      headline: ds.headline || "",
      subcopy: ds.subcopy || "",
      buttonText: ds.buttonText || ""
    };
  }

  function resolveAccentHex(name) {
  switch ((name || "").toLowerCase()) {
    case "amber": return "#FFC466";
    case "teal":  return "#17E6C3";
    default:      return "#7A5CFF"; // violet (default)
  }
}

  function mapChipToIntent(chip) {
    const s = String(chip || "").toLowerCase();
    if (s.includes("compare")) return "compare-3";
    if (s.includes("under")) return "alt-cheaper";
    if (s.includes("sensitive")) return "verify";
    if (s.includes("fragrance")) return "avoid-eo";
    return null;
  }

  function savePrefill(payload) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
  }

  function openConcierge(payload) {
    // Save payload for concierge.js → buildIframeUrl() (which now reads ONCE and clears)
    savePrefill(payload);

    if (window.RefinaLauncher && typeof window.RefinaLauncher.open === "function") {
      window.RefinaLauncher.open({ source: payload.source, prefill: payload.prefill, context: payload });
      return;
    }

    if (IN_THEME_EDITOR || IN_ADMIN) {
      const shop = payload.shop || (window.Shopify && (Shopify.shop || Shopify.permanent_domain)) || "";
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

    try { history.replaceState(null, "", location.pathname + location.search + "#refina?" + params.toString()); }
    catch { location.hash = "#refina?" + params.toString(); }

    document.dispatchEvent(new CustomEvent("refina:open", { detail: payload }));
  }

  // Drawer creation / UX
  function ensureDrawer(radiusPx = "16px", accentName = "violet") {
  let host = document.getElementById("refina-pdp-drawer");
  if (host) return host;

  host = document.createElement("div");
  host.id = "refina-pdp-drawer";
  host.className = "refina-dw-host";
  host.innerHTML = `
      <div class="refina-dw-backdrop" data-close></div>
      <aside class="refina-dw" role="dialog" aria-modal="true" aria-labelledby="rf-dw-title" tabindex="-1">
        <header class="refina-dw-head">
          <div class="refina-dw-copy">
            <h3 id="rf-dw-title" class="refina-dw-title"></h3>
            <div class="refina-dw-sub" data-sub></div>
            <div class="refina-dw-micro"></div>
          </div>
          <button type="button" class="refina-dw-close" data-close aria-label="Close">✕</button>
        </header>
        <div class="refina-dw-body">
          <div class="refina-dw-context" data-context></div>
          <div class="refina-dw-chips" data-chips></div>
          <label class="refina-dw-label" id="rf-dw-label">Message Refina (You can add your age, skin type, budget or goals for smarter picks. Or ask me any other question.)</label>
          <textarea class="refina-dw-input" data-input rows="3" aria-describedby="rf-dw-label"
            placeholder="Ask a question…"></textarea>
        </div>
        <footer class="refina-dw-foot">
          <button type="button" class="refina-dw-continue" data-continue>Continue</button>
        </footer>
      </aside>
  `;
  document.body.appendChild(host);

  // NEW: set radius + accent CSS vars (this is the only addition here)
  host.style.setProperty("--rfina-dw-radius", radiusPx);
  host.style.setProperty("--color-accent", resolveAccentHex(accentName));

  return host;
}

  function openDrawerFrom(root, basePayload) {
    const radiusPx = root?.dataset?.styleRadius || "16px";
    const accentName = root?.dataset?.styleAccent || "violet";
    const host = ensureDrawer(radiusPx);
    const aside = host.querySelector(".refina-dw");
    const input = host.querySelector("[data-input]");
    const chipsBox = host.querySelector("[data-chips]");
    const titleEl = host.querySelector(".refina-dw-title");
    const subEl = host.querySelector("[data-sub]");
    const ctxEl = host.querySelector("[data-context]");
    const ctaBtn = host.querySelector("[data-continue]");

    // Mint contextId at drawer open
    basePayload.contextId = basePayload.contextId || uuid();

    // Header copy (from block)
    titleEl.textContent =
      (basePayload.headline && basePayload.headline.trim()) ||
      "Tell us a bit more";
    subEl.textContent = (basePayload.subcopy || "").trim();

    // CTA label from block (fallback to "Continue")
    ctaBtn.textContent =
      (basePayload.buttonText && basePayload.buttonText.trim()) ||
      "Continue";

    // Context hint (product)
    ctxEl.textContent = basePayload.productTitle
      ? `Using “${basePayload.productTitle}” as context`
      : "";

    // Seed input with payload.prefill
    // Start with an empty message (no prefilled context)
       input.value = "";

    // Render chips (merchant chips from block)
    chipsBox.innerHTML = "";
    (basePayload.chips || []).forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "refina-dw-chip";
      b.textContent = c;
      b.addEventListener("click", () => {
        const ctx = basePayload.productTitle ? ` — “${basePayload.productTitle}”` : "";
        input.value = input.value ? `${input.value} ${c}${ctx}` : `${c}${ctx}`;
        const maybeIntent = mapChipToIntent(c);
        if (maybeIntent) basePayload.intent = maybeIntent;
        input.focus();
      });
      chipsBox.appendChild(b);
    });

    // Open drawer
    host.classList.add("is-open");
    try { aside.focus(); } catch {}

    // Close handlers
    const close = () => host.classList.remove("is-open");
    const backdrop = host.querySelector("[data-close]");
    const onEsc = (ev) => { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
    backdrop.addEventListener("click", close, { once: true });
    host.querySelector(".refina-dw-close").addEventListener("click", close, { once: true });
    document.addEventListener("keydown", onEsc);

    // Continue → Option B: Refresh live PDP details, then open concierge
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

      // best-effort analytics
      try {
        navigator.sendBeacon?.("/apps/refina/v1/analytics/ingest",
          new Blob([JSON.stringify({
            storeId: refreshed.shop,
            type: "concern",
            event: "drawer_confirm",
            concern: finalPrefill,
            productId: refreshed.productId || null,
            contextId: refreshed.contextId || null,
            intent: refreshed.intent || null
          })], { type: "application/json" })
        );
      } catch {}

      openConcierge(refreshed);
      close();
    }, { once: true });

    // Analytics: drawer_open
    try {
      navigator.sendBeacon?.("/apps/refina/v1/analytics/ingest",
        new Blob([JSON.stringify({
          storeId: basePayload.shop,
          type: "concern",
          event: "drawer_open",
          productId: basePayload.productId || null,
          contextId: basePayload.contextId || null
        })], { type: "application/json" })
      );
    } catch {}
  }

  // ─────────────────────────────────────────────
  // Verdict + Quick-peek (PDP fast paths)
  // ─────────────────────────────────────────────
  async function hydrateVerdictAndPeek(root) {
    const ds = root.dataset || {};
    const verdictEl = root.querySelector(".refina-pdp-assist__verdict");
    if (!verdictEl) return;

    const storeId = ds.shop || (window.Shopify && (Shopify.shop || Shopify.permanent_domain)) || "";
    if (!storeId) return;

    const qs = new URLSearchParams({
      mode: "verdict",
      storeId,
      productId: ds.productId || "",
      price: String(ds.priceCents || ""),
      compareAtPrice: String(ds.compareAtPriceCents || ""),
      available: String(ds.selectedVariantAvailable || ""),
      currency: ds.currency || ""
    });

    try {
      const resp = await fetch(`/apps/refina/v1/recommend?${qs.toString()}`, { credentials: "same-origin" });
      if (!resp.ok) return;
      const data = await resp.json();
      const chips = Array.isArray(data.chips) ? data.chips : [];
      const verdict = (data.verdict || "Maybe").toUpperCase();

      verdictEl.textContent = `${verdict}${chips.length ? " • " + chips.slice(0,3).join(" • ") : ""}`;
    } catch {}

    // Quick-peek (optional, safe to be empty)
    const qs2 = new URLSearchParams({ mode: "peek", storeId });
    try { await fetch(`/apps/refina/v1/recommend?${qs2.toString()}`, { credentials: "same-origin" }); } catch {}
  }

  // Click delegate (button + chips) → open drawer
  document.addEventListener("click", (ev) => {
    const root = ev.target.closest("[data-refina-pdp-assist]");
    if (!root) return;

    const btn  = ev.target.closest(".refina-pdp-assist__button");
    const chip = ev.target.closest(".refina-pdp-assist__chip");
    if (!btn && !chip) return;

    const base = getPayload(root);

    if (chip) {
      const chipText = (chip.textContent || "").trim();
      base.prefill = chipText
        ? (base.productTitle ? `${chipText} — “${base.productTitle}”` : chipText)
        : base.prefill;
      const maybeIntent = mapChipToIntent(chipText);
      if (maybeIntent) base.intent = maybeIntent;
      if (maybeIntent === "alt-cheaper" && !base.priceCap) {
        const rawCap = (root.dataset.priceCap || "").trim();
        if (rawCap) base.priceCap = rawCap;
      }
    }

    // Seed verdict/peek (first time the shopper clicks)
    hydrateVerdictAndPeek(root);

    // Open the drawer instead of launching immediately
    openDrawerFrom(root, base);
  }, { passive: true });

  // On load, pre-hydrate verdict (no blocking)
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.querySelector("[data-refina-pdp-assist]");
    if (root) hydrateVerdictAndPeek(root);
  });

})();

