/* Refina — PDP Assist client
   - Side Drawer presets UX + handoff to main concierge
   - Saves a prefill payload to sessionStorage
   - Opens the launcher (live storefront) or new tab (Theme Editor/Admin)
*/

(() => {
  if (window.__REFINA_PDP_ASSIST__) return;
  window.__REFINA_PDP_ASSIST__ = true;

  const STORAGE_KEY = "refina_prefill";

  // Detect Theme Editor/Admin (no in-page modal)
  const IN_THEME_EDITOR = !!(window.Shopify && window.Shopify.designMode);
  let IN_ADMIN = false;
  try {
    const refHost = new URL(document.referrer || "", location.href).hostname || "";
    IN_ADMIN = /(^|\.)admin\.shopify\.com$/i.test(refHost);
  } catch {}

  // ─────────────────────────────────────────────────────────────
  // Tiny CSS (injected once) — inherits your violet/amber glass look
  // ─────────────────────────────────────────────────────────────
  (function injectDrawerCssOnce() {
    if (document.getElementById("refina-pdp-drawer-css")) return;
    const css = `
      .refina-dw-host { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; }
      .refina-dw-host.is-open { pointer-events: auto; }
      .refina-dw-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); opacity: 0; transition: opacity .22s ease; }
      .refina-dw-host.is-open .refina-dw-backdrop { opacity: 1; }
      .refina-dw { position: absolute; top: 0; right: 0; height: 100%; width: min(420px, 92vw);
        background: color-mix(in srgb, var(--color-background, #0b0b0e) 92%, white 8%);
        border-left: 1px solid color-mix(in srgb, var(--color-foreground, #ffffff) 12%, transparent);
        box-shadow: -20px 0 60px rgba(0,0,0,.35);
        transform: translateX(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1);
        display: grid; grid-template-rows: auto 1fr auto; border-top-left-radius: var(--rfina-dw-radius, 16px);
        border-bottom-left-radius: var(--rfina-dw-radius, 16px); overflow: hidden;
      }
      .refina-dw-host.is-open .refina-dw { transform: translateX(0); }
      .refina-dw-head { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 14px 14px 12px; }
      .refina-dw-title { font-weight: 600; }
      .refina-dw-close { border: 1px solid rgba(255,255,255,.18); background: transparent; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
      .refina-dw-body { padding: 0 14px 14px; overflow: auto; }
      .refina-dw-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
      .refina-dw-chip { padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18); background: transparent; cursor: pointer; font-size: .9em; }
      .refina-dw-label { display: block; font-size: .9em; opacity: .85; margin-bottom: 6px; }
      .refina-dw-input { width: 100%; min-height: 80px; padding: 10px 12px; border-radius: 12px;
        border: 1px solid rgba(255,255,255,.18); background: color-mix(in srgb, var(--color-accent, #7A5CFF) 10%, transparent);
        color: inherit; resize: vertical; }
      .refina-dw-foot { padding: 12px 14px 14px; display: grid; gap: 8px; }
      .refina-dw-continue {
        width: 100%; padding: 10px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18);
        background: color-mix(in srgb, var(--color-accent, #7A5CFF) 18%, transparent);
        font-weight: 600; cursor: pointer;
      }
      @media (max-width: 640px) {
        .refina-dw { width: 100vw; }
      }
    `;
    const el = document.createElement("style");
    el.id = "refina-pdp-drawer-css";
    el.textContent = css;
    document.head.appendChild(el);
  })();

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  function getPayload(root, overrides = {}) {
    const ds = root.dataset || {};
    const chips = [ds.chip1, ds.chip2, ds.chip3, ds.chip4].filter(Boolean).map(s => s.trim());

    const priceCap = (overrides.priceCap ?? ds.priceCap ?? "").toString().trim();
    const productTitle = (overrides.productTitle ?? ds.productTitle ?? "").toString().trim();

    const defaultPrefill =
      (productTitle ? `I’m looking at “${productTitle}”. Can you suggest better fits for me?`
                    : `Can you suggest the best fit for me from this store?`);

    const prefill = (overrides.prefill && overrides.prefill.trim()) || defaultPrefill;

    return {
      source: "pdp-assist",
      shop: ds.shop || (window.Shopify && (Shopify.shop || Shopify.permanent_domain)) || "",
      productId: ds.productId || null,
      productTitle,
      priceCap: priceCap || null,
      chips,
      prefill,
    };
  }

  function savePrefill(payload) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
  }

  function openConcierge(payload) {
    // Save payload for concierge.js → buildIframeUrl()
    savePrefill(payload);

    // Launcher API (future-proof; if you ever expose it)
    if (window.RefinaLauncher && typeof window.RefinaLauncher.open === "function") {
      window.RefinaLauncher.open({
        source: payload.source,
        prefill: payload.prefill,
        context: {
          productId: payload.productId,
          productTitle: payload.productTitle,
          priceCap: payload.priceCap,
          chips: payload.chips
        }
      });
      return;
    }

    // Admin/Editor → open new tab with query string
    if (IN_THEME_EDITOR || IN_ADMIN) {
      const shop = payload.shop || (window.Shopify && (Shopify.shop || Shopify.permanent_domain)) || "";
      if (!shop) return;
      const url = new URL(`https://${shop}/apps/refina`);
      url.searchParams.set("prefill", payload.prefill);
      if (payload.productId)    url.searchParams.set("productId", payload.productId);
      if (payload.productTitle) url.searchParams.set("productTitle", payload.productTitle);
      if (payload.priceCap)     url.searchParams.set("priceCap", payload.priceCap);
      if (payload.chips?.length)url.searchParams.set("chips", payload.chips.join(","));
      try { window.open(url.toString(), "_blank", "noopener"); } catch { location.href = url.toString(); }
      return;
    }

    // Live storefront → hash signal + event dispatch
    const params = new URLSearchParams({ refina: "1", source: "pdp" });
    if (payload.productId) params.set("productId", payload.productId);
    if (payload.priceCap)  params.set("priceCap", payload.priceCap);
    try { history.replaceState(null, "", location.pathname + location.search + "#refina?" + params.toString()); }
    catch { location.hash = "#refina?" + params.toString(); }

    document.dispatchEvent(new CustomEvent("refina:open", {
      detail: {
        source: "pdp",
        prefill: payload.prefill,
        context: {
          productId: payload.productId,
          productTitle: payload.productTitle,
          priceCap: payload.priceCap,
          chips: payload.chips
        }
      }
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // Drawer creation / UX
  // ─────────────────────────────────────────────────────────────
  function ensureDrawer(radiusPx = "16px") {
    let host = document.getElementById("refina-pdp-drawer");
    if (host) return host;

    host = document.createElement("div");
    host.id = "refina-pdp-drawer";
    host.className = "refina-dw-host";
    host.innerHTML = `
      <div class="refina-dw-backdrop" data-close></div>
      <aside class="refina-dw" role="dialog" aria-modal="true" aria-labelledby="rf-dw-title" tabindex="-1">
        <header class="refina-dw-head">
          <h3 id="rf-dw-title" class="refina-dw-title">Fine-tune your ask</h3>
          <button type="button" class="refina-dw-close" data-close aria-label="Close">✕</button>
        </header>
        <div class="refina-dw-body">
          <div class="refina-dw-chips" data-chips></div>
          <label class="refina-dw-label">Message to Refina</label>
          <textarea class="refina-dw-input" data-input rows="3" placeholder="Add details (skin type, budget, goals)…"></textarea>
        </div>
        <footer class="refina-dw-foot">
          <button type="button" class="refina-dw-continue" data-continue>Continue</button>
        </footer>
      </aside>
    `;
    document.body.appendChild(host);
    // inherit radius from block setting
    host.style.setProperty("--rfina-dw-radius", radiusPx);
    return host;
  }

  function openDrawerFrom(root, basePayload) {
    const radiusPx = root?.dataset?.styleRadius || "16px";
    const host = ensureDrawer(radiusPx);
    const aside = host.querySelector(".refina-dw");
    const input = host.querySelector("[data-input]");
    const chipsBox = host.querySelector("[data-chips]");

    // Seed input with payload.prefill
    input.value = basePayload.prefill || "";

    // Render chips (reuse from block settings)
    chipsBox.innerHTML = "";
    (basePayload.chips || []).forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "refina-dw-chip";
      b.textContent = c;
      b.addEventListener("click", () => {
        const ctx = basePayload.productTitle ? ` — “${basePayload.productTitle}”` : "";
        input.value = input.value ? `${input.value} ${c}${ctx}` : `${c}${ctx}`;
        input.focus();
      });
      chipsBox.appendChild(b);
    });

    // Open drawer
    host.classList.add("is-open");
    try { aside.focus(); } catch {}

    // Close handlers (backdrop / × button / ESC)
    const close = () => host.classList.remove("is-open");
    const backdrop = host.querySelector("[data-close]");
    backdrop.addEventListener("click", close, { once: true });
    host.querySelector(".refina-dw-close").addEventListener("click", close, { once: true });
    const escHandler = (ev) => { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
    document.addEventListener("keydown", escHandler);

    // Continue → save + open
    host.querySelector("[data-continue]").addEventListener("click", () => {
      const finalPrefill = (input.value || "").trim() || basePayload.prefill;
      const payload = { ...basePayload, prefill: finalPrefill };
      // analytics (best-effort)
      try {
        navigator.sendBeacon?.("/apps/refina/v1/analytics/ingest",
          new Blob([JSON.stringify({
            storeId: basePayload.shop,
            type: "concern",
            event: "drawer_confirm",
            concern: finalPrefill,
            productId: basePayload.productId || null
          })], { type: "application/json" })
        );
      } catch {}
      openConcierge(payload);
      close();
    }, { once: true });

    // Analytics: drawer_open
    try {
      navigator.sendBeacon?.("/apps/refina/v1/analytics/ingest",
        new Blob([JSON.stringify({
          storeId: basePayload.shop,
          type: "concern",
          event: "drawer_open",
          productId: basePayload.productId || null
        })], { type: "application/json" })
      );
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────
  // Click delegate (button + chips) → open drawer
  // ─────────────────────────────────────────────────────────────
  document.addEventListener("click", (ev) => {
    const root = ev.target.closest("[data-refina-pdp-assist]");
    if (!root) return;

    const btn  = ev.target.closest(".refina-pdp-assist__button");
    const chip = ev.target.closest(".refina-pdp-assist__chip");
    if (!btn && !chip) return;

    // Base payload from block
    const base = getPayload(root);

    // If chip clicked, prefer chip text + product context as seed
    if (chip) {
      const chipText = (chip.textContent || "").trim();
      const withChip = chipText
        ? (base.productTitle ? `${chipText} — “${base.productTitle}”` : chipText)
        : base.prefill;
      base.prefill = withChip;
    }

    // Open the drawer instead of launching immediately
    openDrawerFrom(root, base);
  }, { passive: true });

})();
