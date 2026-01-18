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

  .refina-dw { position: absolute; right: 0;
    top: 50%; transform: translateX(100%) translateY(-50%);
    height: auto; max-height: min(78vh, 720px);
    width: min(420px, 92vw);

    /* was falling back to #0b0b0e → dark */
    background: color-mix(in srgb, var(--color-background, #ffffff) 100%, transparent);
    border-left: 1px solid var(--refina-border);
    box-shadow: -20px 0 60px rgba(0,0,0,.35);
    transform: translateX(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1);
    display: grid; grid-template-rows: auto 1fr auto; border-top-left-radius: var(--rfina-dw-radius, 16px);
    border-bottom-left-radius: var(--rfina-dw-radius, 16px); overflow: hidden;
    color: var(--color-foreground);
  }
  .refina-dw-host.is-open .refina-dw { transform: translateX(0) translateY(-50%); }

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

  .refina-dw-update {
    width: 100%;
    margin-top: 8px;
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid rgba(17,17,17,.12);
    background: rgba(17,17,17,.06);
    font-weight: 600;
    cursor: pointer;
  }

  .refina-dw-update:active { transform: translateY(1px); }

  .refina-dw-context { opacity: .75; font-size: .85em; margin-bottom: 6px; }
  .refina-dw-label { display: block; font-size: .9em; opacity: .85; margin-bottom: 6px; }

    /* Step 4 — Results section */
  .refina-dw-results { margin: 6px 0 10px; }
  .refina-dw-results-head { display: grid; gap: 2px; margin-bottom: 8px; }
  .refina-dw-results-title { font-weight: 600; font-size: .95em; }
  .refina-dw-results-sub { opacity: .75; font-size: .85em; line-height: 1.25; }

  .refina-dw-results-list { display: grid; gap: 8px; }

  .refina-dw-result {
    display: grid;
    grid-template-columns: 44px 1fr;
    gap: 10px;
    align-items: center;
    padding: 10px;
    border-radius: 14px;
    border: 1px solid rgba(17,17,17,.12);
    background: color-mix(in srgb, var(--color-background, #ffffff) 92%, var(--color-accent, #7A5CFF) 8%);
    cursor: pointer;
    text-align: left;
  }

  .refina-dw-result:active { transform: translateY(1px); }

  .refina-dw-result-img {
    width: 44px; height: 44px;
    border-radius: 12px;
    object-fit: cover;
    background: rgba(17,17,17,.06);
  }

  .refina-dw-result-meta { display: grid; gap: 3px; min-width: 0; }
  .refina-dw-result-title {
    font-weight: 600;
    font-size: .92em;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .refina-dw-result-why {
    opacity: .75;
    font-size: .84em;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .refina-dw-empty {
    padding: 10px;
    border-radius: 14px;
    border: 1px dashed rgba(17,17,17,.18);
    opacity: .85;
    font-size: .88em;
    line-height: 1.25;
  }

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

    .refina-dw-foot-note {
    font-size: .85em;
    opacity: .75;
    line-height: 1.25;
    margin-bottom: 8px;
  }

  /* Step 7 — footer CTA is secondary */
  .refina-dw-continue {
    width: 100%;
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid rgba(17,17,17,.16);
    background: transparent;
    font-weight: 600;
    cursor: pointer;
  }

  .refina-dw-continue:active { transform: translateY(1px); }

    .refina-dw-empty-btn {
    padding: 8px 10px;
    border-radius: 999px;
    border: 1px solid rgba(17,17,17,.16);
    background: rgba(17,17,17,.04);
    font-weight: 600;
    cursor: pointer;
  }
  .refina-dw-empty-btn:active { transform: translateY(1px); }

  @media (max-width: 640px) {
    .refina-dw { top: 0; max-height: 100vh; height: 100%; transform: translateX(100%); }
    .refina-dw-host.is-open .refina-dw { transform: translateX(0); }
  }
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
  const chips = [ds.chip1, ds.chip2, ds.chip3, ds.chip4]
    .filter(Boolean)
    .map((s) => s.trim());

  const priceCap = (overrides.priceCap ?? ds.priceCap ?? "").toString().trim();
  const productTitle = (overrides.productTitle ?? ds.productTitle ?? "").toString().trim();
  const productType = (overrides.productType ?? ds.productType ?? "").toString().trim();

  const defaultPrefill = productTitle
    ? `I’m looking at “${productTitle}”. Can you suggest better fits for me?`
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

  // Universal/stable meaning driven by keys (merchant can rename chip copy safely)
  if (k === "compare") return "compare-3";
  if (k === "under-cap") return "alt-cheaper";
  if (k === "sensitive") return "verify";
  if (k === "fragrance-free") return "avoid-eo";

  return null;
}

function mapChipToIntent(chip) {
  // Fallback only (if keys are missing)
  const s = String(chip || "").toLowerCase();
  if (s.includes("compare")) return "compare-3";
  if (s.includes("under")) return "alt-cheaper";
  if (s.includes("sensitive")) return "verify";
  if (s.includes("fragrance")) return "avoid-eo";
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
  const keys = parseChipKeys(root);
  const key = keys && keys[chipIndex] ? keys[chipIndex] : null;
  return mapChipKeyToIntent(key) || mapChipToIntent(chipLabelText);
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

      // ─────────────────────────────────────────────
  // Step 4 — Drawer instant “Top alternatives”
  // Uses GET /apps/refina/v1/recommend?mode=peek (safe to be empty)
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
          (Array.isArray(p.images) &&
            p.images[0] &&
            (p.images[0].src || p.images[0].url)) ||
          p.image ||
          p.imageUrl ||
          "";

        const handle = p.handle || "";
        const url = p.url || (handle ? `/products/${handle}` : "");

        const priceCents =
          p.priceCents ??
          p.price_cents ??
          (typeof p.price === "number" ? Math.round(p.price) : null);

        return { id, title, why, image, url, priceCents };
      })
      .filter(Boolean)
      .slice(0, 3);
  }

  function renderDrawerCandidates(host, payload, candidates) {
    const list = host.querySelector("[data-results]");
    const sub = host.querySelector("[data-results-sub]");
    if (!list || !sub) return;

    list.innerHTML = "";

    if (!candidates || !candidates.length) {
  const hasRefine = !!(payload && payload.refineText && String(payload.refineText).trim());
  sub.textContent = hasRefine
    ? `No strong matches found for: “${payload.refineText}”.`
    : "No instant alternatives found for this item.";

  const wrap = document.createElement("div");
  wrap.className = "refina-dw-empty";

  const line1 = document.createElement("div");
  line1.textContent =
    "This may already be one of the best fits in this store.";

  const line2 = document.createElement("div");
  line2.style.marginTop = "6px";
  line2.textContent =
    "Try a different preference, or open the full assistant for deeper recommendations.";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.marginTop = "10px";
  actions.style.flexWrap = "wrap";

  const btnClosest = document.createElement("button");
  btnClosest.type = "button";
  btnClosest.className = "refina-dw-empty-btn";
  btnClosest.textContent = "Show closest matches";
  btnClosest.addEventListener("click", () => {
    try {
      payload.intent = "compare-3";
      hydrateDrawerPeek(document.querySelector(".refina-dw-host.is-open") || document.body, payload);
    } catch {}
  });

  actions.appendChild(btnClosest);
  wrap.appendChild(line1);
  wrap.appendChild(line2);
  wrap.appendChild(actions);

  list.appendChild(wrap);
  return;
}

    if (payload.refineText) {
  sub.textContent = `Updated for: “${payload.refineText}”`;
} else {
  sub.textContent = "Here are the closest matches to compare.";
}

    candidates.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "refina-dw-result";

      const img = document.createElement("img");
      img.className = "refina-dw-result-img";
      img.alt = p.title ? String(p.title) : "Alternative product";
      if (p.image) img.src = p.image;

      const meta = document.createElement("div");
      meta.className = "refina-dw-result-meta";

      const t = document.createElement("div");
      t.className = "refina-dw-result-title";

      const price =
        p.priceCents != null ? formatMoneyFromCents(p.priceCents, payload.currency) : "";
      t.textContent = price ? `${p.title} · ${price}` : p.title;

      const why = document.createElement("div");
      why.className = "refina-dw-result-why";
      why.textContent = p.why || "Tap to view this option.";

      meta.appendChild(t);
      meta.appendChild(why);

      btn.appendChild(img);
      btn.appendChild(meta);

      if (p.url) {
        btn.addEventListener("click", () => {
          try {
            window.location.href = p.url;
          } catch {}
        });
      }

      list.appendChild(btn);
    });
  }

  async function hydrateDrawerPeek(host, payload) {
    const sub = host.querySelector("[data-results-sub]");
    const list = host.querySelector("[data-results]");
    if (!sub || !list) return;

    const token = uuid();
    host.dataset.rfPeekToken = token;

    const hasRefine = !!String(payload.refineText || "").trim();
    sub.textContent = hasRefine ? "Updating matches…" : "Finding the best matches…";
    list.innerHTML = "";
    // NOTE: do not reference `candidates` here — it only exists after the fetch.

    const storeId = payload.shop || payload.storeId || "";
    if (!storeId) {
      renderDrawerCandidates(host, payload, []);
      return;
    }

    const refineText = String(payload.refineText || payload.prefill || "").trim().slice(0, 240);
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

    // Nice microcopy (only after we actually have results)
    if (candidates.length === 1) {
      sub.textContent = payload.refineText
        ? `Found 1 strong match for: “${payload.refineText}”.`
        : "Found 1 strong alternative to compare.";
    }

    renderDrawerCandidates(host, payload, candidates);

    } catch {
      if (host.dataset.rfPeekToken !== token) return;
      sub.textContent = "Quick alternatives are unavailable right now.";
      renderDrawerCandidates(host, payload, []);
    }
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
            <h4 id="rf-dw-title" class="refina-dw-title"></h4>
            <div class="refina-dw-sub" data-sub></div>
            <div class="refina-dw-micro"></div>
          </div>
          <button type="button" class="refina-dw-close" data-close aria-label="Close">✕</button>
        </header>
        <div class="refina-dw-body">
          <div class="refina-dw-context" data-context></div>
          <section class="refina-dw-results" aria-live="polite">
          <div class="refina-dw-results-head">
            <div class="refina-dw-results-title">Top alternatives</div>
            <div class="refina-dw-results-sub" data-results-sub>
              Finding the best matches…
            </div>
          </div>

          <div class="refina-dw-results-list" data-results></div>
        </section>

          <div class="refina-dw-chips" data-chips></div>
          <label class="refina-dw-label" id="rf-dw-label">Want to narrow it down? (Add budget, preferences, or what matters most to refine your picks.)</label>
          <textarea class="refina-dw-input" data-input rows="3" aria-describedby="rf-dw-label"
            placeholder="e.g. under $50, lightweight, best value, or most popular..."></textarea>
            <button type="button" class="refina-dw-update" data-update>Update alternatives</button>
        </div>
        <footer class="refina-dw-foot">
  <div class="refina-dw-foot-note">
    Need deeper help? Ask anything and I’ll recommend the best picks.
  </div>
  <button type="button" class="refina-dw-continue" data-continue>Open full assistant</button>
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

  // IMPORTANT: pass accentName into ensureDrawer
  const host = ensureDrawer(radiusPx, accentName);

  const aside = host.querySelector(".refina-dw");
  const input = host.querySelector("[data-input]");
  const updateBtn = host.querySelector("[data-update]");
  const chipsBox = host.querySelector("[data-chips]");
  const titleEl = host.querySelector(".refina-dw-title");
  const subEl = host.querySelector("[data-sub]");
  const ctxEl = host.querySelector("[data-context]");
  const ctaBtn = host.querySelector("[data-continue]");

  basePayload.contextId = basePayload.contextId || uuid();

  titleEl.textContent =
    (basePayload.headline && basePayload.headline.trim()) || "Tell us a bit more";
  subEl.textContent = (basePayload.subcopy || "").trim();

  ctaBtn.textContent =
    (basePayload.buttonText && basePayload.buttonText.trim()) || "Continue";

  // You can keep or remove this hint; it doesn't inject into the input.
  ctxEl.textContent = basePayload.productTitle ? `Using “${basePayload.productTitle}” as context` : "";

  // Start empty unless a chip provided a prefill
  input.value = (basePayload.prefill || "").trim();

  // Render chips (merchant chips from block)
chipsBox.innerHTML = "";
(basePayload.chips || []).forEach((c, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "refina-dw-chip";
  b.textContent = c;

  b.addEventListener("click", () => {
    // Only insert chip text; do NOT append PDP product title
    input.value = input.value ? `${input.value} ${c}` : `${c}`;

    // Use universal chip-keys by index (merchant can rename chip copy safely)
    const intent = getIntentForDrawerChip(root, i, c);
    if (intent) basePayload.intent = intent;

    // If this is the “under-cap”/cheaper intent and we have a cap, ensure it’s present
    if (intent === "alt-cheaper" && !basePayload.priceCap) {
      const rawCap = (root.dataset.priceCap || "").trim();
      if (rawCap) basePayload.priceCap = rawCap;
    }

    // Step 5: instantly refresh “Top alternatives”
    try {
      hydrateDrawerPeek(host, basePayload);
    } catch {}

    input.focus();
  });

  chipsBox.appendChild(b);
});
  // Open drawer
    // Open drawer
  host.classList.add("is-open");
  try { aside.focus(); } catch {}

  // Step 4: instantly populate “Top alternatives” (safe to be empty)
  try { hydrateDrawerPeek(host, basePayload); } catch {}

  function runRefineUpdate() {
  const text = (input.value || "").trim();
  basePayload.refineText = text;

  try {
    hydrateDrawerPeek(host, basePayload);
  } catch {}
}

if (updateBtn) {
  updateBtn.addEventListener("click", runRefineUpdate);
}

// Enter-to-update (Shift+Enter for a new line)
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runRefineUpdate();
  }
});


    // Close handlers
    const close = () => host.classList.remove("is-open");
    const backdrop = host.querySelector("[data-close]");
    const onEsc = (ev) => { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
    backdrop.onclick = close;
    host.querySelector(".refina-dw-close").onclick = close;
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

  document.addEventListener(
  "click",
  (ev) => {
    const root = ev.target.closest("[data-refina-pdp-assist]");
    if (!root) return;

    const btn = ev.target.closest(".refina-pdp-assist__button");
    const chip = ev.target.closest(".refina-pdp-assist__chip");
    if (!btn && !chip) return;

    const base = getPayload(root);

    // BUTTON: always open drawer with empty input
    if (btn) {
      base.prefill = "";
      base.intent = null;
    }

    // CHIP: open drawer with chip text only (no PDP title appended)
if (chip) {
  const chipText = (chip.textContent || "").trim();
  base.prefill = chipText || "";

  // Step 5: universal intent via chip index → chip key (merchant can rename chip copy)
  const intent = getIntentForPdpChip(root, chip);
  if (intent) base.intent = intent;

  // Preserve existing cheaper/price-cap behavior
  if (intent === "alt-cheaper" && !base.priceCap) {
    const rawCap = (root.dataset.priceCap || "").trim();
    if (rawCap) base.priceCap = rawCap;
  }
}

    // Seed verdict/peek (best-effort, non-blocking)
    hydrateVerdictAndPeek(root);

    // Open the drawer instead of launching immediately
    openDrawerFrom(root, base);
  },
  { passive: true }
);

  // On load, pre-hydrate verdict (no blocking)
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.querySelector("[data-refina-pdp-assist]");
    if (root) hydrateVerdictAndPeek(root);
  });

})();

