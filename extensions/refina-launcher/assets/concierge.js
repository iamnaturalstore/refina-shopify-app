/* Refina Theme App Embed — Launcher (vanilla JS, editor-safe)
   - Renders floating button
   - Live storefront: opens in-page modal (iframe)
   - Theme Editor/Admin: opens concierge in a new tab (no cross-origin issues)
*/

(() => {
  if (window.__REFINA_LAUNCHER_LOADED__) return;
  window.__REFINA_LAUNCHER_LOADED__ = true;

  // Deep-link router (#refina) → dispatch open signal (one-shot)
  window.__RefinaPrimary = window.__RefinaPrimary || null;          // which instance handles open
  window.__RefinaDeeplinkPending = window.__RefinaDeeplinkPending || false;
  window.__RefinaOpenSource = "launcher";                            // default attribution

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function readRefinaPrefill() {
    try {
      const raw = sessionStorage.getItem('refina_prefill');
      if (!raw) return null;
      const p = JSON.parse(raw);
      return (p && typeof p === 'object') ? p : null;
    } catch {
      return null; // guards Safari ITP / blocked storage
    }
  }

  function hashWantsRefina() {
    const h = (location.hash || "").toLowerCase();
    return h.startsWith("#refina") || h === "#open-refina";
  }

  function handleHashOnceAndClean() {
    if (hashWantsRefina()) {
      // stash payload for late consumers; the buildIframeUrl() will read session
      try {
        const q = location.hash.replace(/^#refina\??/i, '');
        const params = new URLSearchParams(q);
        const payload = {};
        params.forEach((v, k) => payload[k] = v);
        if (Object.keys(payload).length) {
          sessionStorage.setItem('refina_prefill', JSON.stringify(payload));
        }
      } catch {}
      window.__RefinaDeeplinkPending = true;
      window.__RefinaOpenSource = "deeplink";
      // signal any initialized instance; only primary will act
      document.dispatchEvent(new Event("refina:open"));
      // clean hash so refresh/back doesn't re-open
      try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleHashOnceAndClean, { once: true });
  } else {
    handleHashOnceAndClean();
  }
  window.addEventListener("hashchange", handleHashOnceAndClean, { passive: true });

  const kebab = (s) => String(s || "").replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

  // Editor/Admin hints (no cross-origin access to window.top)
  const IN_THEME_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  let IN_ADMIN = false;
  try {
    const h = new URL(document.referrer || "", location.href).hostname || "";
    IN_ADMIN = /(^|\.)admin\.shopify\.com$/i.test(h);
  } catch (_) {
    IN_ADMIN = false;
  }

  function initAll() {
    $$("[data-refina-launcher]").forEach(initOne);
  }

  function initOne(root) {
    if (!root || root.dataset.initialized === "true") return;

    const settings = root.dataset;

    // Text: prefer new fields, fall back to legacy
    const launcherText = settings.launcherText || settings.ctaText || "Ask Refina";
    const widgetCtaText = settings.widgetButtonText || settings.ctaText || "";

    const radiusMap = { none: "0px", sm: "8px", md: "12px", lg: "16px", "2xl": "24px" };
    const launcherRadius = radiusMap[settings.borderRadius] || "16px";
    const side = settings.side === "left" ? "left" : "right";

    // New behaviour & positioning
    const triggerMethod = (settings.triggerMethod || "launcher").toLowerCase(); // 'launcher' | 'menu'
    const launcherOrientation = (settings.launcherOrientation || "horizontal").toLowerCase(); // 'horizontal' | 'vertical'
    const bottomOffset = Math.max(0, parseInt(settings.offset || "24", 10));
    const leftOffset = Math.max(0, parseInt(settings.leftOffset || "16", 10));
    const rightOffset = Math.max(0, parseInt(settings.rightOffset || "16", 10));
    const sideOffset = side === "left" ? leftOffset : rightOffset;

    const showMobile = String(settings.showMobile).toLowerCase() !== "false";

    const pageType = String(settings.pageType || "").toLowerCase();
    const hideOnProduct = String(settings.hideOnProduct).toLowerCase() === "true";
    const hideOnCart = String(settings.hideOnCart).toLowerCase() === "true";
    const shopDomain =
      settings.shop ||
      (window.Shopify && (window.Shopify.shop || window.Shopify.permanent_domain)) ||
      "";
    const openOnLoad = String(settings.openOnLoad).toLowerCase() === "true";

    const primaryColor = settings.primaryColor || "#111827";
    const zIndex = 2147483646;

    if (!shopDomain) {
      root.dataset.initialized = "true";
      return;
    }

    // Button-only guards; keep deeplinks working even if button hidden
    const buttonAllowed = !(
      (hideOnProduct && pageType === "product") ||
      (hideOnCart && pageType === "cart") ||
      (!showMobile && isMobile())
    );

    // Primary instance claim
    if (!window.__RefinaPrimary) {
      window.__RefinaPrimary = root;
      document.addEventListener("refina:open", () => {
        if (IN_THEME_EDITOR || IN_ADMIN) return; // Admin/editor uses new-tab path only
        openModalFromDeeplink();
      });
    }

    // Prefill bridge (payload only; do not open here)
    (function attachPrefillBridgeOnce() {
      if (window.__REFINA_PREFILL_BRIDGE__) return;
      window.__REFINA_PREFILL_BRIDGE__ = true;

      document.addEventListener('refina:prefill:request', () => {
        const saved = readRefinaPrefill();
        if (saved) document.dispatchEvent(new CustomEvent('refina:prefill', { detail: saved }));
      });
    })();

    // One-time styles
    if (!$("#refina-launcher-style")) {
      const style = document.createElement("style");
      style.id = "refina-launcher-style";
      style.textContent = `
        :root {
          --refina-safe-bottom: env(safe-area-inset-bottom, 0px);
          --refina-safe-top: env(safe-area-inset-top, 0px);
          --rf-primary-color: ${primaryColor};
        }
        .refina-launcher-btn {
          position: fixed;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          padding: 10px 14px; border-radius: 9999px;
          font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, sans-serif;
          font-weight: 600; font-size: 14px; color: #fff; background: var(--rf-primary-color);
          border: 0; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.18); z-index: ${zIndex};
        }
        .refina-launcher-btn:focus { outline: 2px solid var(--rf-primary-color); outline-offset: 2px; }
        .refina-launcher-btn--vertical { width: 48px; padding: 0; min-height: 120px; max-height: 260px; writing-mode: horizontal-tb; }
        .refina-launcher-btn--vertical > span { display: inline-block; transform: rotate(-90deg); white-space: nowrap; }
        .refina-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: ${zIndex}; display: flex; align-items: center; justify-content: center; }
        .refina-modal { position: relative; width: min(92vw, 980px); height: min(92vh, 720px); background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
        .refina-modal iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
        .refina-modal-close { position: absolute; top: calc(10px + var(--refina-safe-top)); ${side === "left" ? "right" : "left"}: 10px; background: rgba(17,17,17,.75); color: #fff; border: 0; border-radius: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
        @media (max-width: 640px) {
          .refina-launcher-btn { padding: 10px 12px; }
          .refina-launcher-btn--vertical { width: 48px; }
          .refina-modal { width: 100vw; height: 100vh; border-radius: 0; }
          .refina-modal-close { top: calc(12px + var(--refina-safe-top)); ${side === "left" ? "right" : "left"}: 12px; }
        }
      `;
      document.head.appendChild(style);
    }

    // Button (if triggerMethod === 'launcher' and allowed)
    let btn = null;
    if (triggerMethod === "launcher" && buttonAllowed) {
      btn = document.createElement("button");
      btn.className = "refina-launcher-btn";
      if (launcherOrientation === "vertical") btn.classList.add("refina-launcher-btn--vertical");
      btn.type = "button";
      btn.setAttribute("aria-label", "Open shopping concierge");
      btn.innerHTML = `<span>${launcherText}</span>`;
      document.body.appendChild(btn);

      btn.style.borderRadius = launcherRadius;

      if (launcherOrientation === "vertical") autosizeVerticalTab(btn);

      const applyPos = () => {
        btn.style.top = "";
        btn.style.bottom = `calc(${bottomOffset}px + var(--refina-safe-bottom))`;
        btn.style.left = ""; btn.style.right = "";
        btn.style[side] = `${sideOffset}px`;
        btn.style.display = (!showMobile && isMobile()) ? "none" : "inline-flex";
        if (launcherOrientation === "vertical") autosizeVerticalTab(btn);
      };
      applyPos();
      window.addEventListener("resize", applyPos, { passive: true });

      function autosizeVerticalTab(btnEl) {
        try {
          const span = btnEl.querySelector('span'); if (!span) return;
          const cs = window.getComputedStyle(btnEl);
          const font = `${cs.fontWeight || 600} ${cs.fontSize || '14px'} ${cs.fontFamily || 'system-ui'}`;
          const canvas = autosizeVerticalTab.__canvas || (autosizeVerticalTab.__canvas = document.createElement('canvas'));
          const ctx = canvas.getContext('2d'); ctx.font = font;
          const textWidth = ctx.measureText(span.textContent || '').width;
          const PAD = 16, minH = 120, maxH = 260;
          const targetHeight = Math.max(minH, Math.min(Math.ceil(textWidth + PAD * 2), maxH));
          btnEl.style.height = `${targetHeight}px`;
        } catch { btnEl.style.height = '200px'; }
      }

      // Click: editor/admin → new tab; live storefront → modal
      btn.addEventListener("click", () => {
        const url = buildIframeUrl();
        if (IN_THEME_EDITOR || IN_ADMIN) {
          try { window.open(url, "_blank", "noopener"); }
          catch (_) { location.href = url; }
        } else {
          window.__RefinaOpenSource = "launcher";
          openModal();
        }
      });
    }

    let overlay = null;
    let lastFocus = null;

    function buildIframeUrl() {
      // Base URL
      let base;
      try {
        if (shopDomain && typeof shopDomain === "string" && shopDomain.indexOf(".") !== -1) {
          base = new URL("https://" + shopDomain + "/apps/refina");
        } else {
          base = new URL("/apps/refina", location.origin);
        }
      } catch (_) {
        base = new URL("/apps/refina", location.origin);
      }

      // Canonical payload from session (Option B already applied upstream)
      const p = readRefinaPrefill();
      if (p) {
        // Only set canonical fields (avoid theme-setting collisions)
        const fields = [
          "prefill","productId","productTitle","productType",
          "variantId","variantTitle","available",
          "price","compareAtPrice","currency","priceCap",
          "intent","source","contextId","chips"
        ];
        for (const k of fields) {
          const v = p[k];
          if (v == null) continue;
          if (Array.isArray(v)) base.searchParams.set(k, v.join(","));
          else base.searchParams.set(k, String(v));
        }
      }

      // --- Forward ALL relevant Theme Editor settings to the iframe (safe whitelist) ---
const THEME_PARAM_MAP = {
  // content
  heading:              "heading",
  subheading:           "subheading",
  launcherText:         "launcher-text",
  widgetButtonText:     "widget-cta-text",
  ctaText:              "cta-text",

  // appearance
  primaryColor:         "primary-color",
  accentColor:          "accent-color",
  borderRadius:         "border-radius",
  buttonStyle:          "button-style",
  gridColumns:          "grid-columns",

  // behaviour & positioning
  triggerMethod:        "trigger-method",
  launcherOrientation:  "launcher-orientation",
  side:                 "side",
  offset:               "offset",
  leftOffset:           "left-offset",
  rightOffset:          "right-offset",
  showMobile:           "show-mobile",
  hideOnProduct:        "hide-on-product",
  hideOnCart:           "hide-on-cart",
  openOnLoad:           "open-on-load",
  showBadges:           "show-badges",
  showPrices:           "show-prices",
};

for (const [datasetKey, paramName] of Object.entries(THEME_PARAM_MAP)) {
  const v = settings[datasetKey];
  if (v == null || v === "") continue;
  base.searchParams.set(paramName, String(v));
}

      base.searchParams.set("source", window.__RefinaOpenSource || (p?.source || "launcher"));
      try { if (localStorage.getItem("refinaDev") === "1") base.searchParams.set("dev", "1"); } catch {}

      return base.toString();
    }

    function openModal() {
      if (overlay) return;
      lastFocus = document.activeElement;

      overlay = document.createElement("div");
      overlay.className = "refina-modal-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");

      const modal = document.createElement("div");
      modal.className = "refina-modal";

      const close = document.createElement("button");
      close.className = "refina-modal-close";
      close.type = "button";
      close.textContent = "Close ✕";
      close.setAttribute("aria-label", "Close concierge");
      close.addEventListener("click", closeModal);

      const iframe = document.createElement("iframe");
      iframe.src = buildIframeUrl();
      iframe.title = "Refina concierge";

      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

      modal.appendChild(close);
      modal.appendChild(iframe);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      setTimeout(() => close.focus(), 0);

      // Simple focus loop
      overlay.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const focusables = [close, iframe];
        const idx = focusables.indexOf(document.activeElement);
        if (e.shiftKey && (idx <= 0)) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
        else if (!e.shiftKey && (idx === focusables.length - 1)) { e.preventDefault(); focusables[0].focus(); }
      });
    }

    function closeModal() {
      if (!overlay) return;
      overlay.remove();
      overlay = null;
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      else if (btn && typeof btn.focus === "function") btn.focus();
    }

    // Wrapper for deeplink opens: guard + attribution
    function openModalFromDeeplink() {
      window.__RefinaOpenSource = "deeplink";
      openModal();
      window.__RefinaDeeplinkPending = false;
    }

    if (openOnLoad && !(IN_THEME_EDITOR || IN_ADMIN)) {
      setTimeout(openModal, 0);
    }

    // Auto-open once if deep-link arrived before init (primary only)
    if (window.__RefinaPrimary === root && window.__RefinaDeeplinkPending && !(IN_THEME_EDITOR || IN_ADMIN)) {
      openModalFromDeeplink();
    }

    root.dataset.initialized = "true";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll, { once: true });
  } else {
    initAll();
  }
})();
