/* Refina Theme App Embed — Launcher (vanilla JS, editor-safe)
   - Renders floating button
   - Live storefront: opens in-page modal (iframe)
   - Theme Editor/Admin: opens concierge in a new tab (no cross-origin issues)
*/
(() => {
  if (window.__REFINA_LAUNCHER_LOADED__) return;
  window.__REFINA_LAUNCHER_LOADED__ = true;

  // --- storefront no-op guard (let the extension-owned concierge run) ---
  const __ref = document.referrer || "";
  let __host = "";
  try { __host = new URL(__ref, location.href).hostname || ""; } catch {}
  const __IN_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  const __IN_ADMIN  = /(^|\.)admin\.shopify\.com$/i.test(__host);
  const __IN_APP    = location.pathname.startsWith("/apps/refina");
  if (!(__IN_EDITOR || __IN_ADMIN || __IN_APP)) { return; }

  // Deeplink/open state
  window.__RefinaPrimary = window.__RefinaPrimary || null;   // which instance handles open
  window.__RefinaDeeplinkPending = window.__RefinaDeeplinkPending || false;
  window.__RefinaOpenSource = "launcher";                    // default attribution

  const $  = (s, r = document) => r.querySelector(s);
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
    try { sessionStorage.removeItem("refina_prefill"); } catch {}
  }

  const kebab = (s) => String(s || "").replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

  function hashWantsRefina() {
    const h = (location.hash || "").toLowerCase();
    return h.startsWith("#refina") || h === "#open-refina";
  }

  function handleHashOnceAndClean() {
    if (!hashWantsRefina()) return;

    // Stash hash payload; do NOT clear here (we’ll clear on ACK/close)
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
    } catch {}

    window.__RefinaDeeplinkPending = true;
    window.__RefinaOpenSource = "deeplink";

    // Signal any initialized instance; only the primary will act
    document.dispatchEvent(new Event("refina:open"));

    // Clean hash so refresh/back doesn’t re-open
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
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
  const triggerMethod       = (settings.triggerMethod || "launcher").toLowerCase();          // 'launcher' | 'menu'
  const launcherOrientation = (settings.launcherOrientation || "horizontal").toLowerCase();  // 'horizontal' | 'vertical'
  const bottomOffset = Math.max(0, parseInt(settings.offset      || "24", 10));
  const leftOffset   = Math.max(0, parseInt(settings.leftOffset  || "16", 10));
  const rightOffset  = Math.max(0, parseInt(settings.rightOffset || "16", 10));
  const sideOffset   = side === "left" ? leftOffset : rightOffset;

  const showMobile   = String(settings.showMobile).toLowerCase() !== "false";
  const pageType     = String(settings.pageType || "").toLowerCase();
  const hideOnProduct= String(settings.hideOnProduct).toLowerCase() === "true";
  const hideOnCart   = String(settings.hideOnCart).toLowerCase() === "true";
  const shopDomain   =
    settings.shop ||
    (window.Shopify && (window.Shopify.shop || window.Shopify.permanent_domain)) ||
    "";
  const openOnLoad   = String(settings.openOnLoad).toLowerCase() === "true";

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

  // Primary instance claim + unified open handler
if (!window.__RefinaPrimary) {
  window.__RefinaPrimary = root;
  document.addEventListener("refina:open", () => {
    if (IN_THEME_EDITOR || IN_ADMIN) {
      // Editor/Admin: open in a new tab (no modal)
      const url = buildIframeUrl(); // build here (one time) for editor/admin
      try { window.open(url, "_blank", "noopener"); }
      catch { location.href = url; }
    } else {
      // Storefront: open modal; iframe will call buildIframeUrl() exactly once
      openModalFromDeeplink();
    }
  });
}

// Prefill bridge (payload only; non-destructive; clear on ACK)
(function attachPrefillBridgeOnce() {
  if (window.__REFINA_PREFILL_BRIDGE__) return;
  window.__REFINA_PREFILL_BRIDGE__ = true;

  // Iframe can request latest payload (if query params were incomplete)
  document.addEventListener("refina:prefill:request", () => {
    const saved = readRefinaPrefill();
    if (saved) {
      document.dispatchEvent(new CustomEvent("refina:prefill", { detail: saved }));
    }
  });

  // Iframe ACKs when it has consumed params/event
  document.addEventListener("refina:prefill:ack", () => {
    clearRefinaPrefill();
  });
})();

// Cross-frame ACK from the iframe (/apps/refina) via postMessage
window.addEventListener("message", (e) => {
  try {
    if (e && e.data && e.data.type === "refina:prefill:ack") {
      clearRefinaPrefill();
    }
  } catch {}
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

    // Helper inside initOne to avoid leaking globals
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

      // Click: editor/admin → new tab; live storefront → modal
      btn.addEventListener("click", () => {
        const url = buildIframeUrl();
        if (IN_THEME_EDITOR || IN_ADMIN) {
          try { window.open(url, "_blank", "noopener"); }
          catch { location.href = url; }
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
      // Base URL
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

      // Canonical payload from session (NON-DESTRUCTIVE read)
      const p = readRefinaPrefill();
      if (p) {
        // Normalize source to "pdp" if present
        if (p.source && /pdp/i.test(p.source)) p.source = "pdp";
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

      // Liberal pass-through of all theme settings (baseline behavior)
      for (const key in settings) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
        const val = settings[key];
        if (val == null || val === "") continue;
        base.searchParams.set(kebab(key), String(val));
      }

      // Final source attribution (prefer payload, else launcher state)
      base.searchParams.set("source", (p && p.source) || window.__RefinaOpenSource || "launcher");

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
      // Fallback cleanup if iframe never ACKed
      clearRefinaPrefill();
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      else if (btn && typeof btn.focus === "function") btn.focus();
    }

    function openModalFromDeeplink() {
      window.__RefinaOpenSource = "deeplink";
      openModal();
      window.__RefinaDeeplinkPending = false;

      // Belt-and-braces: clean hash now too
      try { history.replaceState(null, "", location.pathname + location.search); } catch {}
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
