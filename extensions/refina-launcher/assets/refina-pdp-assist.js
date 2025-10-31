/* Refina PDP Assist — tiny pseudo-launcher handler
   - Reads data-* from the block
   - Builds a prefilled prompt
   - Opens existing Refina modal via:
       a) window.RefinaLauncher.open({ prefill }) if available, else
       b) location.hash = "#refina?refina=1&..." (your existing minimal hook)
*/

(() => {
  const root = document.querySelector('[data-refina-pdp-assist]');
  if (!root) return;

  const ds = (k, d = '') => root.getAttribute(k) || d;
  const productId      = ds('data-product-id');
  const productTitle   = ds('data-product-title');
  const productPrice   = ds('data-product-price');
  const shop           = ds('data-shop');
  const buttonText     = ds('data-button-text') || 'Ask about this product';
  const priceCap       = (ds('data-price-cap') || '').trim();
  const chipsRaw = [ds('data-chip-1'), ds('data-chip-2'), ds('data-chip-3'), ds('data-chip-4')].filter(Boolean);

  // Wire up the main CTA
  const btn = root.querySelector('.refina-pdp-assist__button');
  const chips = Array.from(root.querySelectorAll('.refina-pdp-assist__chip'));

  function openWithPrefill(prefill) {
    // Analytics (best-effort, non-blocking)
    try {
      fetch('/apps/refina/v1/analytics/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          event: 'pdp_assist_click',
          shop,
          productId,
          productTitle,
          priceCap: prefill.priceCap || null,
          chips: prefill.chips || [],
          source: 'pdp'
        }),
      }).catch(() => {});
    } catch (e) {}

    // Preferred: explicit launcher API if present
    if (window.RefinaLauncher && typeof window.RefinaLauncher.open === 'function') {
      window.RefinaLauncher.open({ source: 'pdp', ...prefill });
      return;
    }

    // Fallback: hash params (works with your minimal hook)
    const params = new URLSearchParams();
    params.set('refina', '1');
    params.set('source', 'pdp');
    if (shop) params.set('shop', shop);
    if (productId) params.set('productId', productId);
    if (productTitle) params.set('productTitle', productTitle);
    if (prefill.priceCap) params.set('priceCap', prefill.priceCap);
    if (prefill.chips?.length) params.set('chips', prefill.chips.join(','));
    if (prefill.prompt) params.set('prefill', prefill.prompt);

    try {
      // Ensure we notify any listeners immediately
      location.hash = `#refina?${params.toString()}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) {
      // Last resort: custom event some loaders listen for
      document.dispatchEvent(new CustomEvent('refina:open', { detail: { source: 'pdp', ...prefill }}));
    }
  }

  function buildPrompt({ chips = [], priceCap = '' } = {}) {
    const hints = [
      chips.length ? `Hints: ${chips.join(' • ')}` : null,
      priceCap ? `Budget: under ${priceCap}` : null
    ].filter(Boolean).join(' · ');

    return [
      `Is "${productTitle}" a good choice for me?`,
      hints ? ` ${hints}.` : '',
      ` If it isn’t ideal, suggest 2–3 better fits from this store with a one-line “why”.`
    ].join('');
  }

  function onCTA() {
    const prefill = {
      prompt: buildPrompt({ chips: [], priceCap }),
      chips: [],
      priceCap
    };
    openWithPrefill(prefill);
  }

  function onChip(e) {
    const chipText = (e.currentTarget?.textContent || '').trim();
    const selected = [chipText];
    const prefill = {
      prompt: buildPrompt({ chips: selected, priceCap }),
      chips: selected,
      priceCap
    };
    openWithPrefill(prefill);
  }

  if (btn) btn.addEventListener('click', onCTA);
  chips.forEach(ch => ch.addEventListener('click', onChip));
})();
