/* Refina Theme App Embed — Launcher (vanilla JS, editor-safe)
   - Renders floating button
   - Live storefront: opens in-page modal (iframe)
   - Theme Editor/Admin: opens concierge in a new tab (no cross-origin issues)
*/

(() => {
  if (window.__REFINA_LAUNCHER_LOADED__) return;
  window.__REFINA_LAUNCHER_LOADED__ = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const kebab = (s) => String(s || "").replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

  const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

  // Theme Editor flag is the only one we strictly need.
  // Avoid reading window.top.* (cross-origin). Use document.referrer if you also want to infer Admin.
  const IN_THEME_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  let IN_ADMIN = false;
  try {
    const h = new URL(document.referrer || "", location.href).hostname || "";
    IN_ADMIN = /(^|\.)admin\.shopify\.com$/i.test(h);
  } catch (_) {
    IN_ADMIN = false;
  }

  function initAll() {
    $("[data-refina-launcher]") // ensure at least one exists before running forEach
    $$("[data-refina-launcher]").forEach(initOne);
  }

  function initOne(root) {
    if (!root || root.dataset.initialized === "true") return;

    // Read all settings from data attributes
    const settings = root.dataset;

    const side = settings.side === "left" ? "left" : "right";
    const offset = Math.max(0, parseInt(settings.offset || "24", 10));
    const showMobile = String(settings.showMobile).toLowerCase() !== "false";
    const pageType = String(settings.pageType || "").toLowerCase();
    const hideOnProduct = String(settings.hideOnProduct).toLowerCase() === "true";
    const hideOnCart = String(settings.hideOnCart).toLowerCase() === "true";
    const shopDomain = settings.shop || (window.Shopify && window.Shopify.shop) || "";
    const openOnLoad = String(settings.openOnLoad).toLowerCase() === "true";

    const ctaText = settings.ctaText || "Ask Refina";
    const primaryColor = settings.primaryColor || "#111827";
    const zIndex = 2147483646;

    // Early exits
    if (!shopDomain) {
      root.dataset.initialized = "true";
      return;
    }
    if ((hideOnProduct && pageType === "product") || (hideOnCart && pageType === "cart")) {
      root.dataset.initialized = "true";
      return;
    }
    if (!showMobile && isMobile()) {
      root.dataset.initialized = "true";
      return;
    }

    // One-time style
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
          position: fixed; ${side}: 16px; bottom: calc(${offset}px + var(--refina-safe-bottom));
          display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 14px; border-radius: 9999px;
          font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, sans-serif;
          font-weight: 600; font-size: 14px; color: #fff; background: var(--rf-primary-color);
          border: 0; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.18); z-index: ${zIndex};
        }
        .refina-launcher-btn:focus { outline: 2px solid var(--rf-primary-color); outline-offset: 2px; }
        .refina-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: ${zIndex}; display: flex; align-items: center; justify-content: center; }
        .refina-modal { position: relative; width: min(92vw, 980px); height: min(92vh, 720px); background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
        .refina-modal iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
        .refina-modal-close { position: absolute; top: calc(10px + var(--refina-safe-top)); ${side === "left" ? "right" : "left"}: 10px; background: rgba(17,17,17,.75); color: #fff; border: 0; border-radius: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
        @media (max-width: 640px) {
          .refina-launcher-btn { ${side}: 12px; padding: 10px 12px; }
          .refina-modal { width: 100vw; height: 100vh; border-radius: 0; }
          .refina-modal-close { top: calc(12px + var(--refina-safe-top)); ${side === "left" ? "right" : "left"}: 12px; }
        }
      `;
      document.head.appendChild(style);
    }

    // Button
    const btn = document.createElement("button");
    btn.className = "refina-launcher-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Open shopping concierge");
    btn.innerHTML = `<span>${ctaText}</span>`;
    document.body.appendChild(btn);

    // Positioning & visibility on resize
    const applyPos = () => {
      btn.style.bottom = `calc(${offset}px + var(--refina-safe-bottom))`;
      btn.style[side] = "16px";
      btn.style.display = (!showMobile && isMobile()) ? "none" : "inline-flex";
    };
    applyPos();
    window.addEventListener("resize", applyPos, { passive: true });

    let overlay = null;
    let lastFocus = null;

    function buildIframeUrl() {
      const base = new URL(`https://${shopDomain}/apps/refina`);
      // Pass all theme settings as URL params (camelCase -> kebab-case)
      for (const key in settings) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
        base.searchParams.set(kebab(key), settings[key]);
      }
      base.searchParams.set("source", "launcher");
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

      // Tiny focus loop to keep tabbing within modal
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
      else btn.focus();
    }

    // Click behavior: editor/admin → new tab; live storefront → modal
    btn.addEventListener("click", () => {
      const url = buildIframeUrl();
      if (IN_THEME_EDITOR || IN_ADMIN) {
        try { window.open(url, "_blank", "noopener"); }
        catch (_) { location.href = url; }
      } else {
        openModal();
      }
    });

    if (openOnLoad && !(IN_THEME_EDITOR || IN_ADMIN)) {
      setTimeout(openModal, 0);
    }

    root.dataset.initialized = "true";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll, { once: true });
  } else {
    initAll();
  }
})();
