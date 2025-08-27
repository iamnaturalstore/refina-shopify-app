/* Refina storefront bootstrap: fetch settings and apply CSS variables */
(function () {
  var ASSET_VER = "v1";

  function $(sel) { return document.querySelector(sel); }

  function findRoot() {
    var el = document.getElementById("root")
      || document.querySelector('[data-refina-root]')
      || document.body;
    if (el && !el.classList.contains("rf-root")) el.classList.add("rf-root");
    return el || document.body;
  }

  function applyTokens(el, tokens) {
    var root = el || findRoot();
    var style = root.style;
    var t = tokens || {};
    for (var k in t) {
      if (!Object.prototype.hasOwnProperty.call(t, k)) continue;
      if (k && k.charAt(0) === "-") {
        try { style.setProperty(k, String(t[k])); } catch (_) {}
      }
    }
  }

  function etagOf(obj) {
    try {
      var s = JSON.stringify(obj);
      var h = 0;
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return "rf-" + (h >>> 0).toString(16);
    } catch (_) {
      return "rf-" + Date.now().toString(16);
    }
  }

  async function fetchSettings() {
    // Called from the Shopify storefront domain. App Proxy forwards to our /proxy route.
    var url = "/apps/refina/v1/settings";
    var r = await fetch(url, {
      credentials: "omit",
      headers: { "Accept": "application/json" },
    });
    if (!r.ok) throw new Error("settings_fetch_failed:" + r.status);
    return r.json();
  }

  async function init() {
    try {
      var root = findRoot();
      var s = await fetchSettings();
      applyTokens(root, s && s.tokens);
      root.setAttribute("data-rf-preset", (s && s.presetId) || "minimal");
      root.setAttribute("data-rf-version", String((s && s.version) || 0));
      root.setAttribute("data-rf-etag", etagOf(s || {}));

      // Nice-to-have: respect reduced motion
      try {
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          root.style.setProperty("--rf-motion", "reduced");
        }
      } catch (_) {}
    } catch (e) {
      console.warn("[Refina] theme init failed:", (e && e.message) || e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
