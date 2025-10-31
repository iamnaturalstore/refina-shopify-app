/* Refina Theme App Embed — Launcher (vanilla JS, editor-safe)
   - Renders floating button
   - Live storefront: opens in-page modal (iframe)
   - Theme Editor/Admin: opens concierge in a new tab (no cross-origin issues)
*/

(() => {
  if (window.__REFINA_LAUNCHER_LOADED__) return;
  window.__REFINA_LAUNCHER_LOADED__ = true;

  // ─────────────────────────────────────────────────────────────
  // Deep-link router (#refina) → dispatch open signal (Phase 1)
  // ─────────────────────────────────────────────────────────────
  window.__RefinaPrimary = window.__RefinaPrimary || null;          // which instance handles open
  window.__RefinaDeeplinkPending = window.__RefinaDeeplinkPending || false;
  window.__RefinaOpenSource = "launcher";                            // default attribution

  function hashWantsRefina() {
    const h = (location.hash || "").toLowerCase();
    return h.startsWith("#refina") || h === "#open-refina";
  }

  function handleHashOnceAndClean() {
    // Editor/Admin guard is respected later by the primary instance
    if (hashWantsRefina()) {
      window.__RefinaDeeplinkPending = true;
      window.__RefinaOpenSource = "deeplink";
      // Signal any initialized instance
      document.dispatchEvent(new Event("refina:open"));
      // Clean the URL so refresh/back doesn't re-open
      try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    }
  }

  // On load & on hash changes
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleHashOnceAndClean, { once: true });
  } else {
    handleHashOnceAndClean();
  }
  window.addEventListener("hashchange", handleHashOnceAndClean, { passive: true });

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

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

    // Radius mapping for the **launcher bubble only**
    const radiusMap = { none: "0px", sm: "8px", md: "12px", lg: "16px", "2xl": "24px" };
    const launcherRadius = radiusMap[settings.borderRadius] || "16px";
    const side = settings.side === "left" ? "left" : "right";

    // NEW: behaviour & positioning settings
    const triggerMethod = (settings.triggerMethod || "launcher").toLowerCase(); // 'launcher' | 'menu'
    const launcherOrientation = (settings.launcherOrientation || "horizontal").toLowerCase(); // 'horizontal' | 'vertical'
    const bottomOffset = Math.max(0, parseInt(settings.offset || "24", 10)); // primary vertical offset (bottom)
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

    // Early checks
    if (!shopDomain) {
      root.dataset.initialized = "true";
      return;
    }

    // Important: button-only guards. Do NOT return; we still want deep-link to work.
    const buttonAllowed = !(
      (hideOnProduct && pageType === "product") ||
      (hideOnCart && pageType === "cart") ||
      (!showMobile && isMobile())
    );

    // Primary instance claim: first initialized handles deep-link open
    if (!window.__RefinaPrimary) {
      window.__RefinaPrimary = root;
      document.addEventListener("refina:open", () => {
        // Respect Editor/Admin behavior: deep-link is ignored in editor/admin
        if (IN_THEME_EDITOR || IN_ADMIN) return;
        openModalFromDeeplink();
      });
    }

    // ─────────────────────────────────────────────────────────────
// Refina PDP Assist → Prefill bridge (hash + event, no launcher API)
// ─────────────────────────────────────────────────────────────
(function attachRefinaPrefillBridge() {
  if (window.__REFINA_PREFILL_BRIDGE__) return;
  window.__REFINA_PREFILL_BRIDGE__ = true;

  function parseRefinaHash() {
    if (!location.hash || !location.hash.toLowerCase().startsWith('#refina')) return null;
    const q = location.hash.replace(/^#refina\??/i, '');
    const params = new URLSearchParams(q);
    // accept either "#refina" or "#refina?refina=1"
    if (params.has('refina') === false && q.length > 0) {
      // ok: querystring present but no explicit refina=1; still treat as valid
    }
    return {
      source: params.get('source') || 'unknown',
      shop: params.get('shop') || null,
      productId: params.get('productId') || null,
      productTitle: params.get('productTitle') || null,
      priceCap: params.get('priceCap') || null,
      chips: (params.get('chips') || '').split(',').filter(Boolean),
      prefill: params.get('prefill') || ''
    };
  }

  function maybeEmitPrefillAndOpen() {
    const payload = parseRefinaHash();
    if (!payload) return;

    // Let the concierge UI prefill the input
    try {
      document.dispatchEvent(new CustomEvent('refina:prefill', { detail: payload }));
      sessionStorage.setItem('refina_prefill', JSON.stringify(payload));
    } catch {}

    // Ask the existing launcher to open (your listener already calls openModalFromDeeplink)
    document.dispatchEvent(new Event('refina:open'));

    // Optional: clear the hash to avoid re-trigger on refresh/back
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  }

  window.addEventListener('load',       maybeEmitPrefillAndOpen);
  window.addEventListener('hashchange', maybeEmitPrefillAndOpen);

  // Allow late consumers to request the last payload (e.g., SPA mount order)
  document.addEventListener('refina:prefill:request', () => {
    const saved = sessionStorage.getItem('refina_prefill');
    if (!saved) return;
    try {
      const payload = JSON.parse(saved);
      if (payload) document.dispatchEvent(new CustomEvent('refina:prefill', { detail: payload }));
    } catch {}
  });
})();

// ─────────────────────────────────────────────────────────────
// Drawer → Prefill ingress API (callable or event-based)
// Lets the drawer push a prefill into the widget without
// modifying concierge.js anywhere else.
// Usage (drawer):
//   window.RefinaPrefill({ source:'drawer', prefill:'...', chips:['...'], priceCap:'40', productId:'123', productTitle:'...' })
// or:
//   document.dispatchEvent(new CustomEvent('refina:drawer:submit', { detail: { prefill:'...' } }))
// ─────────────────────────────────────────────────────────────
(function attachRefinaDrawerIngress() {
  if (window.__REFINA_DRAWER_INGRESS__) return;
  window.__REFINA_DRAWER_INGRESS__ = true;

  function normalizePayload(x = {}) {
    const out = {
      source: String(x.source || 'drawer'),
      prefill: String(x.prefill || ''),
      productId: x.productId ? String(x.productId) : null,
      productTitle: x.productTitle ? String(x.productTitle) : null,
      priceCap: x.priceCap ? String(x.priceCap) : null,
      chips: Array.isArray(x.chips) ? x.chips.filter(Boolean).map(String) : []
    };
    return out;
  }

  function writeAndSignal(payload) {
    const p = normalizePayload(payload);
    try {
      sessionStorage.setItem('refina_prefill', JSON.stringify(p));
    } catch {}
    // Let any mounted UI (drawer/widget) prefill immediately
    try {
      document.dispatchEvent(new CustomEvent('refina:prefill', { detail: p }));
    } catch {}
    // Ask the launcher to open; primary instance will enforce editor/admin guards
    document.dispatchEvent(new Event('refina:open'));
    return true;
  }

  // 1) Global helper callable from the drawer
  window.RefinaPrefill = function(payload) {
    return writeAndSignal(payload || {});
  };

  // 2) Event-based ingress (if you prefer not to touch globals)
  document.addEventListener('refina:drawer:submit', (ev) => {
    const payload = (ev && ev.detail) || {};
    writeAndSignal(payload);
  });
})();


    // One-time style (add vertical tab support)
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
        .refina-launcher-btn--vertical {
          width: 48px; padding: 0;
          /* Height is set dynamically by JS based on label length */
          min-height: 120px;  /* guardrails so it still looks like a tab */
          max-height: 260px;  /* adjust if you prefer */
          writing-mode: horizontal-tb; /* keep normal; rotate inner text */
        }
        .refina-launcher-btn--vertical > span {
          display: inline-block; transform: rotate(-90deg);
          white-space: nowrap;
        }
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

    // Button (only if trigger_method === 'launcher' AND button is allowed on this context)
    let btn = null;
    if (triggerMethod === "launcher" && buttonAllowed) {
      btn = document.createElement("button");
      btn.className = "refina-launcher-btn";
      if (launcherOrientation === "vertical") {
        btn.classList.add("refina-launcher-btn--vertical");
      }
      btn.type = "button";
      btn.setAttribute("aria-label", "Open shopping concierge");
      btn.innerHTML = `<span>${launcherText}</span>`;
      document.body.appendChild(btn);

      // Apply theme-selected radius to the launcher bubble only (override 9999px for horizontal)
      btn.style.borderRadius = launcherRadius;

      // If vertical, auto-size height to the label
      if (launcherOrientation === "vertical") {
        autosizeVerticalTab(btn);
      }

      // Positioning & visibility on resize (Bottom offset + side-specific offset)
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
    const span = btnEl.querySelector('span');
    if (!span) return;

    const cs = window.getComputedStyle(btnEl);
    const font = `${cs.fontWeight || 600} ${cs.fontSize || '14px'} ${cs.fontFamily || 'system-ui'}`;

    const canvas = autosizeVerticalTab.__canvas || (autosizeVerticalTab.__canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = font;

    const text = span.textContent || '';
    const textWidth = ctx.measureText(text).width;

    // Visual padding along the long axis (top+bottom after rotation)
    const PAD = 16;              // adjust for cushier tabs if you like
    const minH = 120, maxH = 260;

    const targetHeight = Math.max(minH, Math.min(Math.ceil(textWidth + PAD * 2), maxH));
    btnEl.style.height = `${targetHeight}px`;
  } catch {
    btnEl.style.height = '200px'; // safe fallback
  }
}


      // Click behavior: editor/admin → new tab; live storefront → modal
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
  // — Safe base URL (handles missing/empty shopDomain) —
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

  // — Carry prefill + PDP context from drawer (all guards applied) —
  try {
    let raw = null;
    try {
      raw = (window && window.sessionStorage) ? sessionStorage.getItem("refina_prefill") : null;
    } catch (_) { raw = null; }

    if (raw) {
      let p = {};
      try { p = JSON.parse(raw || "{}") || {}; } catch (_) { p = {}; }

      if (p.prefill)      base.searchParams.set("prefill", String(p.prefill));
      if (p.productId)    base.searchParams.set("productId", String(p.productId));
      if (p.productTitle) base.searchParams.set("productTitle", String(p.productTitle));
      if (p.priceCap)     base.searchParams.set("priceCap", String(p.priceCap));
      if (p.source)       base.searchParams.set("source", String(p.source));
      if (Array.isArray(p.chips) && p.chips.length) {
        base.searchParams.set("chips", p.chips.join(","));
      }

      // Hand off once per open (comment out to keep for SPA reuse)
      try { sessionStorage.removeItem("refina_prefill"); } catch (_) {}
    }
  } catch (_) {}

  // — Pass all theme settings as URL params (camelCase dataset → kebab-case query) —
  for (const key in settings) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    base.searchParams.set(kebab(key), settings[key]);
  }

  // — Explicit params for back-compat / clarity —
  if (widgetCtaText) base.searchParams.set("widget-cta-text", widgetCtaText); // new, in-widget
  if (launcherText)  base.searchParams.set("launcher-text", launcherText);    // optional (if iframe wants to display)
  if (launcherText)  base.searchParams.set("cta-text", launcherText);         // legacy many widgets read

  base.searchParams.set("source", window.__RefinaOpenSource || "launcher");
  try {
    if (localStorage.getItem("refinaDev") === "1") base.searchParams.set("dev", "1");
  } catch {}

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

      // Trivial focus loop
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
      // ensure pending is cleared (e.g., if event arrived before init)
      window.__RefinaDeeplinkPending = false;
    }

    if (openOnLoad && !(IN_THEME_EDITOR || IN_ADMIN)) {
      setTimeout(openModal, 0);
    }

    // Phase 1: Auto-open once if deep-link arrived before init (primary only)
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
