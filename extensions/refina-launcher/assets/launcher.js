(() => {
  const q = (s, r=document) => r.querySelector(s);
  const qa = (s, r=document) => Array.from(r.querySelectorAll(s));

  function initAll(){ qa('[data-refina-launcher]').forEach(initOne); }

  function initOne(root){
    if (!root || root.dataset.initialized === 'true') return;

    const side = root.dataset.side === 'left' ? 'left' : 'right';
    const offset = Math.max(0, parseInt(root.dataset.offset || '24', 10));
    const brand = root.dataset.brandColor || '#d10000';
    const showMobile = root.dataset.showMobile !== 'false';
    const pageType = (root.dataset.pageType || '').toLowerCase();
    const hideOnProduct = root.dataset.hideOnProduct === 'true';
    const hideOnCart = root.dataset.hideOnCart === 'true';
    const shopDomain = root.dataset.shop || (window.Shopify && window.Shopify.shop) || '';
    const proxyPath = (root.dataset.proxyPath || 'apps/refina').replace(/^\/+/, '');
    const zIndex = parseInt(root.dataset.zIndex || '2147483646', 10);
    const openOnLoad = root.dataset.openOnLoad === 'true';

    if (!shopDomain) { root.dataset.initialized = 'true'; return; }
    if ((hideOnProduct && pageType === 'product') || (hideOnCart && pageType === 'cart')) {
      root.dataset.initialized = 'true'; return;
    }

    const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
    if (!showMobile && isMobile()) { root.dataset.initialized = 'true'; return; }

    if (!q('#refina-launcher-style')) {
      const style = document.createElement('style');
      style.id = 'refina-launcher-style';
      style.textContent = `
        :root { --refina-safe-bottom: env(safe-area-inset-bottom, 0px); --refina-safe-top: env(safe-area-inset-top, 0px); }
        .refina-launcher-btn{
          position:fixed;${side}:16px;bottom:calc(${offset}px + var(--refina-safe-bottom));display:inline-flex;align-items:center;gap:8px;
          padding:10px 14px;border-radius:9999px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen,Ubuntu,sans-serif;
          font-weight:600;font-size:14px;color:#fff;background:${brand};border:0;cursor:pointer;
          box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:${zIndex}
        }
        .refina-launcher-btn:focus{outline:2px solid #000;outline-offset:2px}
        .refina-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:${zIndex};display:flex;align-items:center;justify-content:center}
        .refina-modal{position:relative;width:min(92vw,980px);height:min(92vh,720px);background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)}
        .refina-modal iframe{width:100%;height:100%;border:0;display:block;background:#fff}
        .refina-modal-close{position:absolute;top:calc(10px + var(--refina-safe-top));${side==='left'?'right':'left'}:10px;background:rgba(17,17,17,.75);color:#fff;border:0;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
        @media (max-width:640px){.refina-launcher-btn{${side}:12px;padding:10px 12px}.refina-modal{width:100vw;height:100vh;border-radius:0}.refina-modal-close{top:calc(12px + var(--refina-safe-top));${side==='left'?'right':'left'}:12px}}
      `;
      document.head.appendChild(style);
    }

    const btn = document.createElement('button');
    btn.className = 'refina-launcher-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label','Open shopping concierge');
    btn.innerHTML = `<span>Refina</span>`;
    document.body.appendChild(btn);

    const applyPos = () => {
      btn.style.bottom = `calc(${offset}px + var(--refina-safe-bottom))`; btn.style[side] = '16px';
      btn.style.display = (!showMobile && isMobile()) ? 'none' : 'inline-flex';
    };
    applyPos(); window.addEventListener('resize', applyPos);

    let overlay=null, lastFocus=null;

    function buildIframeUrl() {
      const base = new URL(`https://${shopDomain}/${proxyPath}`);
      base.searchParams.set('source', 'launcher');
      // Optional dev toggle: set localStorage.refinaDev = "1" to append &dev=1
      try { if (localStorage.getItem('refinaDev') === '1') base.searchParams.set('dev', '1'); } catch {}
      return base.toString();
    }

    function openModal(){
      if (overlay) return;
      lastFocus = document.activeElement;

      overlay = document.createElement('div');
      overlay.className = 'refina-modal-overlay';
      overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true');

      const modal = document.createElement('div'); modal.className = 'refina-modal';

      const close = document.createElement('button');
      close.className = 'refina-modal-close'; close.type='button';
      close.textContent='Close ✕'; close.setAttribute('aria-label','Close concierge');
      close.addEventListener('click', closeModal);

      const iframe = document.createElement('iframe');
      iframe.src = buildIframeUrl();

      overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
      // Note: ESC won't fire here when focus is inside the iframe; rely on Close + overlay.

      modal.appendChild(close); modal.appendChild(iframe);
      overlay.appendChild(modal); document.body.appendChild(overlay);
      setTimeout(() => close.focus(), 0);

      // Light focus trap between Close and iframe
      overlay.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const focusables = [close, iframe];
        const idx = focusables.indexOf(document.activeElement);
        if (e.shiftKey && (idx <= 0)) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
        else if (!e.shiftKey && (idx === focusables.length - 1)) { e.preventDefault(); focusables[0].focus(); }
      });
    }

    function closeModal(){
      if (!overlay) return;
      overlay.remove(); overlay=null;
      if (lastFocus && typeof lastFocus.focus==='function') lastFocus.focus(); else btn.focus();
    }

    btn.addEventListener('click', openModal);
    if (openOnLoad) setTimeout(openModal, 0);

    root.dataset.initialized = 'true';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
