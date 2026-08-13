/* Refina Theme App Embed — Launcher (vanilla JS, editor-safe)
   - Renders floating button
   - Live storefront: opens in-page modal (iframe)
   - Theme Editor/Admin: opens concierge in a new tab (no cross-origin issues)
   - Smart Popup: optional "Need a hand?" nudge with configurable delay/frequency
*/
(() => {
  // === Namespaced + soft guard (immune to proxy bundle's shared flag) ===
  if (window.__REFINA_THEME_LAUNCHER_LOADED__) {
    return; // this same vanilla file already ran
  }
  window.__REFINA_THEME_LAUNCHER_LOADED__ = true;

  // If any launcher UI is already mounted, bow out quietly (prevents doubles).
  const __alreadyMounted =
    document.querySelector('[data-refina-launcher][data-initialized="true"]') ||
    document.querySelector('.refina-launcher-btn') ||
    document.querySelector('.refina-modal');

  if (__alreadyMounted) {
    return;
  }

  // Deeplink/open state
  window.__RefinaPrimary = window.__RefinaPrimary || null;   // which instance handles open
  window.__RefinaDeeplinkPending = window.__RefinaDeeplinkPending || false;
  window.__RefinaOpenSource = "launcher";                    // default attribution

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

  // ─────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────
  // Non-destructive read (keep until ACK)
  function readRefinaPrefill() {
    try {
      const raw = sessionStorage.getItem("refina_prefill");
      if (!raw) return null;
      const p = JSON.parse(raw);
      return (p && typeof p === "object") ? p : null;
    } catch { return null; }
  }
  // Clear only after iframe ACK or on modal close (fallback)
  function clearRefinaPrefill() {
    try { sessionStorage.removeItem("refina_prefill"); } catch { }
  }

  const kebab = (s) => String(s || "").replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

  function hashWantsRefina() {
    const h = (location.hash || "").toLowerCase();
    return h.startsWith("#refina") || h === "#open-refina";
  }

  function handleHashOnceAndClean() {
    if (!hashWantsRefina()) return;

    // Stash hash payload; do NOT clear here (we'll clear on ACK/close)
    try {
      const q = location.hash.replace(/^#refina\??/i, "");
      const params = new URLSearchParams(q);
      const payload = {};
      params.forEach((v, k) => (payload[k] = v));
      // Normalize source to canonical "pdp" if it smells like pdp-assist
      if (payload.source && /pdp/i.test(payload.source)) payload.source = "pdp";
      if (Object.keys(payload).length) {
        sessionStorage.setItem("refina_prefill", JSON.stringify(payload));
      }
    } catch { }

    window.__RefinaDeeplinkPending = true;
    window.__RefinaOpenSource = "deeplink";

    // Signal any initialized instance; only the primary will act
    document.dispatchEvent(new Event("refina:open"));

    // Clean hash so refresh/back doesn't re-open
    try { history.replaceState(null, "", location.pathname + location.search); } catch { }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleHashOnceAndClean, { once: true });
  } else {
    handleHashOnceAndClean();
  }
  window.addEventListener("hashchange", handleHashOnceAndClean, { passive: true });

  // Editor/Admin hints (no cross-origin access to window.top)
  const IN_THEME_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  let IN_ADMIN = false;
  try {
    const h = new URL(document.referrer || "", location.href).hostname || "";
    IN_ADMIN = /(^|\.)admin\.shopify\.com$/i.test(h);
  } catch { IN_ADMIN = false; }

  // ─────────────────────────────────────
  // Init
  // ─────────────────────────────────────
  function initAll() {
    $$("[data-refina-launcher]").forEach(initOne);
  }

  function initOne(root) {
    if (!root || root.dataset.initialized === "true") return;

    const settings = root.dataset;

    // Text: prefer new fields, fall back to legacy
    const launcherText = settings.launcherText || settings.ctaText || "Ask Refina";

    // Appearance / placement
    const radiusMap = { none: "0px", sm: "8px", md: "12px", lg: "16px", "2xl": "24px" };
    const launcherRadius = radiusMap[settings.borderRadius] || "16px";
    const side = settings.side === "left" ? "left" : "right";

    // Behaviour & positioning
    const triggerMethod = (settings.triggerMethod || "launcher").toLowerCase();
    const launcherOrientation = (settings.launcherOrientation || "horizontal").toLowerCase();
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

    // Shared with refina-pdp-assist.js's add-to-cart watcher: same key/shape,
    // localStorage so it survives "Buy Now" opening the PDP in a new tab.
    const REFINA_ENGAGEMENT_KEY = "refina_recent_engagement";
    const REFINA_ENGAGEMENT_WINDOW_MS = 30 * 60 * 1000;
    function recordRefinaEngagement(productId) {
      if (!productId) return;
      try {
        const now = Date.now();
        let list = [];
        try { list = JSON.parse(localStorage.getItem(REFINA_ENGAGEMENT_KEY) || "[]"); } catch {}
        if (!Array.isArray(list)) list = [];
        list = list.filter((e) => e && e.ts && now - e.ts < REFINA_ENGAGEMENT_WINDOW_MS);
        list.push({ productId: String(productId), ts: now });
        if (list.length > 10) list = list.slice(-10);
        localStorage.setItem(REFINA_ENGAGEMENT_KEY, JSON.stringify(list));
      } catch {}
    }

    const cssColor = (value, fallback) => {
      const v = String(value || "").trim();
      return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)
        ? v
        : fallback;
    };

    const primaryColor = cssColor(settings.primaryColor, "#111827");
    const accentColor = cssColor(settings.accentColor, "#10B981");
    const buttonTextColor = cssColor(settings.buttonTextColor, "#FFFFFF");
    const widgetBackgroundColor = cssColor(settings.widgetBackgroundColor, "#FFFFFF");
    const widgetTextColor = cssColor(settings.widgetTextColor, "#111827");
    const inputBackgroundColor = cssColor(settings.inputBackgroundColor, "#FFFFFF");
    const zIndex = 2147483646;

    // Button-only guards; keep deeplinks working even if button hidden
    const buttonAllowed = !(
      (hideOnProduct && pageType === "product") ||
      (hideOnCart && pageType === "cart") ||
      (!showMobile && isMobile())
    );

    // Primary instance claim + unified open handler (robust re-claim)
    {
      const primaryEl = window.__RefinaPrimary;
      const primaryIsLive = primaryEl && document.contains(primaryEl);
      if (!primaryIsLive) {
        window.__RefinaPrimary = root;
        document.addEventListener("refina:open", () => {
          if (IN_THEME_EDITOR || IN_ADMIN) {
            const url = buildIframeUrl();
            try { window.open(url, "_blank", "noopener"); }
            catch { location.href = url; }
          } else {
            openModalFromDeeplink();
          }
        });
      }
    }

    // Prefill bridge (payload only; non-destructive; clear on ACK)
    (function attachPrefillBridgeOnce() {
      if (window.__REFINA_PREFILL_BRIDGE__) return;
      window.__REFINA_PREFILL_BRIDGE__ = true;

      document.addEventListener("refina:prefill:request", () => {
        const saved = readRefinaPrefill();
        if (saved) {
          document.dispatchEvent(new CustomEvent("refina:prefill", { detail: saved }));
        }
      });

      document.addEventListener("refina:prefill:ack", () => {
        clearRefinaPrefill();
      });
    })();

    // Cross-frame ACK from the iframe (/apps/refina) via postMessage
    window.addEventListener("message", (e) => {
      console.log('[Concierge] Message received:', e.data);
      try {
        if (e && e.data && e.data.type === "refina:prefill:ack") {
          clearRefinaPrefill();
        }
      } catch { }
    });

    // One-time styles
    if (!$("#refina-launcher-style")) {
      const style = document.createElement("style");
      style.id = "refina-launcher-style";
      style.textContent = `
        :root {
          --refina-safe-bottom: env(safe-area-inset-bottom, 0px);
          --refina-safe-top: env(safe-area-inset-top, 0px);

          --rf-primary-color: ${primaryColor};
          --rf-color-primary: ${primaryColor};
          --rf-accent-color: ${accentColor};
          --rf-color-accent: ${accentColor};

          --rf-button-text-color: ${buttonTextColor};
          --rf-on-primary: ${buttonTextColor};

          --rf-widget-background-color: ${widgetBackgroundColor};
          --rf-widget-bg: ${widgetBackgroundColor};
          --rf-page-bg: ${widgetBackgroundColor};

          --rf-widget-text-color: ${widgetTextColor};
          --rf-color-text: ${widgetTextColor};

          --rf-input-background-color: ${inputBackgroundColor};
          --rf-input-bg: ${inputBackgroundColor};
        }

        .refina-launcher-btn {
          position: fixed;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px 14px;
          border-radius: 9999px;
          font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, sans-serif;
          font-weight: 600;
          font-size: 14px;
          color: var(--rf-button-text-color);
          background: var(--rf-color-primary);
          border: 0;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0,0,0,.18);
          z-index: ${zIndex};
        }

        .refina-launcher-btn:focus {
          outline: 2px solid var(--rf-color-accent);
          outline-offset: 2px;
        }

        .refina-launcher-btn--vertical {
          width: 48px;
          padding: 0;
          min-height: 120px;
          max-height: 260px;
          writing-mode: horizontal-tb;
        }

        .refina-launcher-btn--vertical > span {
          display: inline-block;
          transform: rotate(-90deg);
          white-space: nowrap;
        }

        .refina-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,.6);
          z-index: ${zIndex};
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .refina-modal {
          position: relative;
          width: min(92vw, 980px);
          height: min(92vh, 720px);
          background: var(--rf-widget-background-color);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0,0,0,.35);
        }

        .refina-modal iframe {
          width: 100%;
          height: 100%;
          border: 0;
          display: block;
          background: var(--rf-widget-background-color);
        }

        .refina-modal-close {
  position: absolute;
  top: calc(12px + var(--refina-safe-top));
  right: 12px;
  width: 36px;
  height: 36px;
  background: rgba(248, 250, 252, 0.95);
  color: #334155;
  border: 1px solid rgba(15, 18, 34, 0.08);
  border-radius: 50%;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.refina-modal-close:hover {
  background: #f1f5f9;
  transform: scale(1.08);
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
}

.refina-modal-close:active {
  transform: scale(1.02);
}

        @media (max-width: 640px) {
          .refina-launcher-btn {
            padding: 10px 12px;
          }

          .refina-launcher-btn--vertical {
            width: 48px;
          }

          .refina-modal-overlay {
            align-items: flex-start;
            justify-content: center;
            padding: calc(54px + var(--refina-safe-top)) 10px calc(16px + var(--refina-safe-bottom));
            box-sizing: border-box;
          }

          .refina-modal {
            width: 100%;
            height: min(82dvh, 720px);
            max-height: calc(100dvh - 76px - var(--refina-safe-bottom));
            border-radius: 24px;
          }

          .refina-modal-close {
  top: calc(12px + var(--refina-safe-top));
  right: 12px;  /* Force top-right on mobile too */
}
        }
      `;
      document.head.appendChild(style);
    }

    // Button (if triggerMethod === 'launcher' and allowed)
    let btn = null;

    const autosizeVerticalTab = (btnEl) => {
      try {
        const span = btnEl.querySelector("span"); if (!span) return;
        const cs = window.getComputedStyle(btnEl);
        const font = `${cs.fontWeight || 600} ${cs.fontSize || "14px"} ${cs.fontFamily || "system-ui"}`;
        const canvas = autosizeVerticalTab.__canvas || (autosizeVerticalTab.__canvas = document.createElement("canvas"));
        const ctx = canvas.getContext("2d"); ctx.font = font;
        const textWidth = ctx.measureText(span.textContent || "").width;
        const PAD = 16, minH = 120, maxH = 260;
        const targetHeight = Math.max(minH, Math.min(Math.ceil(textWidth + PAD * 2), maxH));
        btnEl.style.height = `${targetHeight}px`;
      } catch { btnEl.style.height = "200px"; }
    };

    if (triggerMethod === "launcher" && buttonAllowed) {
      btn = document.createElement("button");
      btn.className = "refina-launcher-btn";
      if (launcherOrientation === "vertical") btn.classList.add("refina-launcher-btn--vertical");
      btn.type = "button";
      btn.setAttribute("aria-label", "Open shopping concierge");
      btn.innerHTML = `<span>${launcherText}</span>`;
      document.body.appendChild(btn);

      btn.style.borderRadius = launcherRadius;

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

      btn.addEventListener("click", () => {
        if (IN_THEME_EDITOR || IN_ADMIN) {
          try {
            const url = buildIframeUrl();
            try { window.open(url, "_blank", "noopener"); }
            catch { location.href = url; }
          } catch (e) {
            openModal();
          }
        } else {
          window.__RefinaOpenSource = "launcher";
          openModal();
        }
      });
    }

    // ─────────────────────────────────────
    // Modal
    // ─────────────────────────────────────
    let overlay = null;
    let lastFocus = null;

    function buildIframeUrl() {
      let base;
      try {
        if (shopDomain && typeof shopDomain === "string" && shopDomain.indexOf(".") !== -1) {
          base = new URL("https://" + shopDomain + "/apps/refina");
        } else {
          base = new URL("/apps/refina", location.origin);
        }
      } catch {
        base = new URL("/apps/refina", location.origin);
      }
      try {
        if (shopDomain) base.searchParams.set("shop", String(shopDomain));
      } catch { }

      const p = readRefinaPrefill();
      if (p) {
        if (p.source && /pdp/i.test(p.source)) p.source = "pdp";
        const fields = [
          "prefill", "productId", "productTitle", "productType",
          "variantId", "variantTitle", "available",
          "price", "compareAtPrice", "currency", "priceCap",
          "intent", "source", "contextId", "chips"
        ];
        for (const k of fields) {
          const v = p[k];
          if (v == null) continue;
          if (Array.isArray(v)) base.searchParams.set(k, v.join(","));
          else base.searchParams.set(k, String(v));
        }
      }

      for (const key in settings) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
        const val = settings[key];
        if (val == null || val === "") continue;
        base.searchParams.set(kebab(key), String(val));
      }

      base.searchParams.set("source", (p && p.source) || window.__RefinaOpenSource || "launcher");

      try { if (localStorage.getItem("refinaDev") === "1") base.searchParams.set("dev", "1"); } catch { }
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
      close.textContent = "✕";
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
      clearRefinaPrefill();
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      else if (btn && typeof btn.focus === "function") btn.focus();
    }

    function openModalFromDeeplink() {
      window.__RefinaOpenSource = "deeplink";
      openModal();
      window.__RefinaDeeplinkPending = false;
      try { history.replaceState(null, "", location.pathname + location.search); } catch { }
    }

    if (openOnLoad && !(IN_THEME_EDITOR || IN_ADMIN)) {
      setTimeout(openModal, 0);
    }

    if (window.__RefinaPrimary === root && window.__RefinaDeeplinkPending && !(IN_THEME_EDITOR || IN_ADMIN)) {
      openModalFromDeeplink();
    }

    // ─────────────────────────────────────
    // Smart Popup
    // ─────────────────────────────────────
    const popupEnabled = String(settings.popupEnabled).toLowerCase() === "true";
    const popupDelay = Math.max(0, parseInt(settings.popupDelay || "5", 10)) * 1000;
    const popupHeadline = settings.popupHeadline || "Need a hand choosing?";
    const popupSubhead = settings.popupSubheading || "I can find your perfect match in seconds — just tell me what you're looking for.";
    const popupYesText = settings.popupYesText || "Yes please";
    const popupNoText = settings.popupNoText || "No, I'm good thanks";
    const popupFooter = settings.popupFooter || "I'm here whenever you need me — tap the button at the bottom right, or the helper on any product page.";
    const popupFrequency = settings.popupFrequency || "session";

    const POPUP_KEY = `refina_popup_dismissed_${shopDomain}`;

    function popupAlreadyDismissed() {
      try {
        if (popupFrequency === "always") return false;
        if (popupFrequency === "session") {
          return !!sessionStorage.getItem(POPUP_KEY);
        }
        if (popupFrequency === "day") {
          const ts = localStorage.getItem(POPUP_KEY);
          if (!ts) return false;
          return Date.now() - Number(ts) < 86400000; // 24h
        }
      } catch { }
      return false;
    }

    function markPopupDismissed() {
      try {
        if (popupFrequency === "session") sessionStorage.setItem(POPUP_KEY, "1");
        if (popupFrequency === "day") localStorage.setItem(POPUP_KEY, String(Date.now()));
      } catch { }
    }

    function showPopup() {
      if (!popupEnabled) return;
      if (IN_THEME_EDITOR || IN_ADMIN) return;
      if (popupAlreadyDismissed()) return;
      if (overlay) return; // don't show popup if modal is already open

      // Inject popup styles once
      if (!document.getElementById("refina-popup-style")) {
        const s = document.createElement("style");
        s.id = "refina-popup-style";
        s.textContent = `
          .rf-popup-overlay {
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.45);
            z-index: ${zIndex};
            display: flex; align-items: center; justify-content: center;
            padding: 16px;
            animation: rfPopupFadeIn 0.25s ease;
          }
          .rf-popup {
            background: #fff;
            border-radius: 20px;
            padding: 32px 28px 24px;
            width: min(92vw, 420px);
            box-shadow: 0 24px 64px rgba(0,0,0,0.22);
            position: relative;
            animation: rfPopupSlideUp 0.3s cubic-bezier(0.34,1.56,0.64,1);
            font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
          }
          .rf-popup-close {
            position: absolute; top: 14px; right: 16px;
            background: none; border: none;
            font-size: 20px; color: #94a3b8;
            cursor: pointer; line-height: 1;
            padding: 4px 8px; border-radius: 6px;
            transition: color 0.15s, background 0.15s;
          }
          .rf-popup-close:hover { color: #334155; background: #f1f5f9; }
          .rf-popup-icon {
            width: 48px; height: 48px; border-radius: 14px;
            background: ${primaryColor};
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 16px;
            font-size: 22px;
          }
          .rf-popup-headline {
            font-size: 20px; font-weight: 700;
            color: #0f172a; margin-bottom: 8px;
            letter-spacing: -0.3px; line-height: 1.3;
          }
          .rf-popup-subhead {
            font-size: 14px; color: #64748b;
            line-height: 1.6; margin-bottom: 24px;
          }
          .rf-popup-actions {
            display: flex; flex-direction: column; gap: 10px;
            margin-bottom: 20px;
          }
          .rf-popup-yes {
            padding: 14px 20px;
            border-radius: 12px; border: none;
            background: ${primaryColor}; color: #fff;
            font-size: 15px; font-weight: 600;
            cursor: pointer; font-family: inherit;
            transition: opacity 0.15s, transform 0.12s;
            box-shadow: 0 4px 14px rgba(0,0,0,0.15);
          }
          .rf-popup-yes:hover  { opacity: 0.9; }
          .rf-popup-yes:active { transform: translateY(1px); }
          .rf-popup-no {
            padding: 12px 20px;
            border-radius: 12px;
            border: 1px solid #e2e8f0;
            background: #f8fafc; color: #475569;
            font-size: 14px; font-weight: 500;
            cursor: pointer; font-family: inherit;
            transition: background 0.15s, border-color 0.15s;
          }
          .rf-popup-no:hover { background: #f1f5f9; border-color: #cbd5e1; }
          .rf-popup-divider {
            height: 1px; background: #f1f5f9; margin-bottom: 16px;
          }
          .rf-popup-footer {
            font-size: 12px; color: #94a3b8;
            line-height: 1.6; text-align: center;
          }
          @keyframes rfPopupFadeIn {
            from { opacity: 0; } to { opacity: 1; }
          }
          @keyframes rfPopupSlideUp {
            from { opacity: 0; transform: translateY(24px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0)   scale(1); }
          }
          @media (max-width: 640px) {
            .rf-popup { padding: 28px 20px 20px; }
            .rf-popup-headline { font-size: 18px; }
          }
        `;
        document.head.appendChild(s);
      }

      const popupOverlay = document.createElement("div");
      popupOverlay.className = "rf-popup-overlay";

      const popup = document.createElement("div");
      popup.className = "rf-popup";
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-modal", "true");
      popup.setAttribute("aria-label", popupHeadline);

      function closePopup(andOpen) {
        markPopupDismissed();
        popupOverlay.style.opacity = "0";
        popupOverlay.style.transition = "opacity 0.2s ease";
        setTimeout(() => {
          popupOverlay.remove();
          if (andOpen) {
            window.__RefinaOpenSource = "popup";
            openModal();
          }
        }, 200);
      }

      popup.innerHTML = `
        <button class="rf-popup-close" aria-label="Close">✕</button>
        <div class="rf-popup-icon">👋</div>
        <div class="rf-popup-headline">${popupHeadline}</div>
        <p class="rf-popup-subhead">${popupSubhead}</p>
        <div class="rf-popup-actions">
          <button class="rf-popup-yes">${popupYesText}</button>
          <button class="rf-popup-no">${popupNoText}</button>
        </div>
        <div class="rf-popup-divider"></div>
        <p class="rf-popup-footer">${popupFooter}</p>
      `;

      popup.querySelector(".rf-popup-close").addEventListener("click", () => closePopup(false));
      popup.querySelector(".rf-popup-yes").addEventListener("click", () => closePopup(true));
      popup.querySelector(".rf-popup-no").addEventListener("click", () => closePopup(false));
      popupOverlay.addEventListener("click", (e) => { if (e.target === popupOverlay) closePopup(false); });

      popupOverlay.appendChild(popup);
      document.body.appendChild(popupOverlay);
    }

    if (popupEnabled && !IN_THEME_EDITOR && !IN_ADMIN) {
      setTimeout(showPopup, popupDelay);
    }

    // ─────────────────────────────────────
    // Product Modal (parent-level)
    // ─────────────────────────────────────
    let productModal = null;

    // Listen for product open requests from iframe
    window.addEventListener("message", (e) => {
      try {
        if (!e.data || e.data.type !== "refina:product:open") return;

        const { product, context } = e.data;
        if (!product || !product.id) return;

        openProductModal(product, context);
      } catch (err) {
        console.error("[Refina] Product modal error:", err);
      }
    });

    function openProductModal(product, context = {}) {
      // Close existing modal if any
      if (productModal) closeProductModal();

      // Inject styles once
      if (!document.getElementById("refina-product-modal-style")) {
        const s = document.createElement("style");
        s.id = "refina-product-modal-style";
        s.textContent = `
  .rf-product-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 18, 34, 0.4);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    z-index: ${zIndex + 1};
    display: flex;
    align-items: center;
    justify-content: center;
    animation: rfProductBackdropFade 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .rf-product-overlay.closing {
    animation: rfProductBackdropFadeOut 0.2s cubic-bezier(0.4, 0, 1, 1);
  }

  .rf-product-modal {
    background: #fff;
    border-radius: 20px;
    width: min(92%, 560px);
    max-height: 85vh;
    overflow-y: auto;
    position: relative;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    animation: rfProductSlideUp 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .rf-product-overlay.closing .rf-product-modal {
    animation: rfProductSlideDown 0.25s cubic-bezier(0.4, 0, 1, 1);
  }

  .rf-product-header {
    position: sticky;
    top: 0;
    z-index: 2;
    background: #fff;
    padding: 20px 20px 16px;
    border-bottom: 1px solid rgba(15, 18, 34, 0.06);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .rf-product-heading-group {
    flex: 1;
    min-width: 0;
  }

  .rf-product-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: #111827;
    margin: 0;
    line-height: 1.3;
  }

  .rf-product-context {
    font-size: 0.875rem;
    color: #6b7280;
    margin: 6px 0 0;
  }

  .rf-product-close {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid rgba(15, 18, 34, 0.08);
    background: #f8fafc;
    color: #334155;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .rf-product-close:hover {
    background: #f1f5f9;
    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    transform: scale(1.05);
  }

  .rf-product-image {
    width: 100%;
    max-height: 50vh;
    object-fit: contain;
    display: block;
    padding: 0 20px;
    margin: 16px 0;
  }

  .rf-product-body {
    padding: 0 20px 20px;
    color: #111827;
    font-size: 0.9375rem;
    line-height: 1.6;
  }

  .rf-product-price {
    font-size: 1.5rem;
    font-weight: 700;
    color: #111827;
    margin-bottom: 16px;
  }

  .rf-product-actions {
    position: sticky;
    bottom: 0;
    padding: 16px 20px;
    background: linear-gradient(180deg, rgba(255,255,255,0.8), #fff 40%);
    border-top: 1px solid rgba(15, 18, 34, 0.06);
  }

  .rf-product-buy {
    display: block;
    width: 100%;
    padding: 14px 20px;
    border-radius: 12px;
    border: none;
    background: ${primaryColor};
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 4px 14px rgba(0,0,0,0.15);
  }

  .rf-product-buy:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0,0,0,0.2);
  }

  .rf-product-buy:active {
    transform: translateY(0);
  }

  /* Entrance animations */
  @keyframes rfProductBackdropFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes rfProductSlideUp {
    from {
      opacity: 0;
      transform: translateY(32px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Exit animations - ensure they override entrance */
.rf-product-overlay.closing {
  animation: rfProductBackdropFadeOut 0.25s cubic-bezier(0.4, 0, 1, 1) forwards !important;
}

.rf-product-overlay.closing .rf-product-modal {
  animation: rfProductSlideDown 0.3s cubic-bezier(0.4, 0, 1, 1) forwards !important;
}

@keyframes rfProductBackdropFadeOut {
  from { opacity: 1; backdrop-filter: blur(8px); }
  to { opacity: 0; backdrop-filter: blur(0px); }
}

@keyframes rfProductSlideDown {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(20px) scale(0.98);
  }
}

  /* Mobile: bottom sheet */
  @media (max-width: 640px) {
    .rf-product-modal {
      width: 100%;
      max-width: none;
      max-height: 85dvh;
      border-radius: 24px 24px 0 0;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      animation: rfProductSlideUpMobile 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .rf-product-overlay.closing .rf-product-modal {
      animation: rfProductSlideDownMobile 0.3s cubic-bezier(0.4, 0, 1, 1);
    }

    @keyframes rfProductSlideUpMobile {
      from {
        transform: translateY(100%);
      }
      to {
        transform: translateY(0);
      }
    }

    @keyframes rfProductSlideDownMobile {
      from {
        transform: translateY(0);
      }
      to {
        transform: translateY(100%);
      }
    }

    .rf-product-overlay {
      align-items: flex-end;
    }

    .rf-product-image {
      max-height: 40vh;
    }
  }
`;
        document.head.appendChild(s);
      }

      // Build modal
      const overlay = document.createElement("div");
      overlay.className = "rf-product-overlay";

      const modal = document.createElement("div");
      modal.className = "rf-product-modal";

      const header = document.createElement("div");
      header.className = "rf-product-header";

      const headingGroup = document.createElement("div");
      headingGroup.className = "rf-product-heading-group";

      const title = document.createElement("h2");
      title.className = "rf-product-title";
      title.textContent = product.name || product.title || "Product";

      const contextText = document.createElement("p");
      contextText.className = "rf-product-context";
      contextText.textContent = context.query
        ? `Why this fits — "${context.query}"`
        : "Product details";

      const closeBtn = document.createElement("button");
      closeBtn.className = "rf-product-close";
      closeBtn.innerHTML = "✕";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.addEventListener("click", closeProductModal);

      headingGroup.appendChild(title);
      headingGroup.appendChild(contextText);
      header.appendChild(headingGroup);
      header.appendChild(closeBtn);

      const img = document.createElement("img");
      img.className = "rf-product-image";
      img.src = product.image;
      img.alt = product.name || product.title || "";
      img.onerror = () => {
        img.src = "https://cdn.shopify.com/s/images/admin/no-image-compact.gif";
      };

      const body = document.createElement("div");
      body.className = "rf-product-body";

      if (product.price) {
        const price = document.createElement("div");
        price.className = "rf-product-price";
        price.textContent = `$${Number(product.price).toFixed(2)}`;
        body.appendChild(price);
      }

      if (product.description) {
        const desc = document.createElement("div");
        desc.innerHTML = sanitizeHtml(product.description);
        body.appendChild(desc);
      }

      const actions = document.createElement("div");
      actions.className = "rf-product-actions";

      const buyBtn = document.createElement("a");
      buyBtn.className = "rf-product-buy";
      buyBtn.href = product.url || product.link || "#";
      buyBtn.target = "_blank";
      buyBtn.rel = "noopener noreferrer";
      buyBtn.textContent = "Buy Now";
      buyBtn.addEventListener("click", () => {
        try {
          const qs = new URLSearchParams({
            storeId: shopDomain || "",
            type: "concern",
            event: "product_click",
            productId: String(product.id),
          });
          if (context.query) qs.set("concern", context.query);
          fetch(`/apps/refina/v1/analytics/ingest?${qs.toString()}`, {
            method: "POST",
            keepalive: true,
          });
        } catch {}
        recordRefinaEngagement(product.id);
      });

      actions.appendChild(buyBtn);

      modal.appendChild(header);
      modal.appendChild(img);
      modal.appendChild(body);
      modal.appendChild(actions);
      // ─────────────────────────────────────
      // Touch gestures for mobile dismiss
      // ─────────────────────────────────────
      if (window.matchMedia("(max-width: 640px)").matches) {
        let startY = 0;
        let currentY = 0;
        let isDragging = false;
        let startTime = 0;

        const handleTouchStart = (e) => {
          // Only allow drag from header area
          if (!e.target.closest('.rf-product-header')) return;

          startY = e.touches[0].clientY;
          currentY = startY;
          startTime = Date.now();
          isDragging = false;
          modal.style.transition = 'none';
        };

        const handleTouchMove = (e) => {
          if (startY === 0) return;

          currentY = e.touches[0].clientY;
          const deltaY = currentY - startY;

          // Only allow dragging down, not up
          if (deltaY > 0) {
            isDragging = true;
            e.preventDefault(); // Prevent scroll while dragging

            // Apply transform with slight resistance
            const resistance = Math.min(deltaY / 3, 200); // Max 200px drag
            modal.style.transform = `translateY(${resistance}px)`;

            // Fade backdrop as user drags
            const fadeAmount = Math.max(0, 1 - (resistance / 200));
            overlay.style.opacity = fadeAmount;
          }
        };

        const handleTouchEnd = () => {
          if (!isDragging) {
            startY = 0;
            return;
          }

          const deltaY = currentY - startY;
          const deltaTime = Date.now() - startTime;
          const velocity = deltaY / deltaTime; // px per ms

          // Dismiss if dragged >100px or fast swipe (velocity > 0.5)
          const shouldDismiss = deltaY > 100 || velocity > 0.5;

          if (shouldDismiss) {
            // Animate out
            modal.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 1, 1)';
            modal.style.transform = 'translateY(100%)';
            overlay.style.transition = 'opacity 0.2s ease';
            overlay.style.opacity = '0';

            // Clean up directly (don't call closeProductModal - it conflicts)
            if (productModal && productModal.__escapeHandler) {
              document.removeEventListener("keydown", productModal.__escapeHandler);
            }

            setTimeout(() => {
              if (productModal) {
                productModal.remove();
                productModal = null;
              }
            }, 300);
          } else {
            // Spring back
            modal.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
            modal.style.transform = 'translateY(0)';
            overlay.style.transition = 'opacity 0.2s ease';
            overlay.style.opacity = '1';
          }

          startY = 0;
          isDragging = false;
        };

        modal.addEventListener('touchstart', handleTouchStart, { passive: false });
        modal.addEventListener('touchmove', handleTouchMove, { passive: false });
        modal.addEventListener('touchend', handleTouchEnd);
        modal.addEventListener('touchcancel', handleTouchEnd);
      }
      overlay.appendChild(modal);

      // Close on overlay click
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeProductModal();
      });

      // Close on Escape
      const handleEscape = (e) => {
        if (e.key === "Escape") closeProductModal();
      };
      document.addEventListener("keydown", handleEscape);
      overlay.__escapeHandler = handleEscape;

      document.body.appendChild(overlay);
      productModal = overlay;

      // Focus close button
      setTimeout(() => closeBtn.focus(), 100);
    }

    function closeProductModal() {
      if (!productModal) return;

      // Trigger exit animation
      productModal.classList.add('closing');

      // Remove escape listener immediately
      if (productModal.__escapeHandler) {
        document.removeEventListener("keydown", productModal.__escapeHandler);
      }

      // Wait for animation to complete before removing
      // Use requestAnimationFrame to ensure class is applied before removal
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (productModal) {
            productModal.remove();
            productModal = null;
          }
        }, 350); // Slightly longer to ensure animation completes
      });
    }

    // Simple HTML sanitizer
    function sanitizeHtml(html) {
      const div = document.createElement("div");
      div.innerHTML = html;
      div.querySelectorAll("script, style, iframe").forEach(el => el.remove());
      return div.innerHTML;
    }

    // ─────────────────────────────────────
    root.dataset.initialized = "true";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll, { once: true });
  } else {
    initAll();
  }
})();