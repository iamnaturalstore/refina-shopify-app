// admin-ui/src/utils/shareHref.js

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  // strip protocol + path if someone accidentally passes a URL
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const h = (u.hostname || "").toLowerCase();
      return h.endsWith(".myshopify.com") ? h : "";
    }
  } catch {
    /* ignore */
  }
  // only accept full myshopify domains; reject bare handles and wrong suffixes
  return s.endsWith(".myshopify.com") ? s : "";
}

export function buildShareHref({ shop, host /* storeId deprecated */ }) {
  // Canonicalize inputs
  const shopFull = toMyshopifyDomain(shop) || "";

  // Best-effort host: use provided, fallback to persisted (created by client.js)
  let hostVal = host || "";
  if (!hostVal) {
    try {
      hostVal = sessionStorage.getItem("shopify-host") || "";
    } catch {
      /* ignore */
    }
  }
  if (!shopFull || !hostVal) {
    throw new Error("buildShareHref: missing shop or host");
  }

  const url = new URL(window.location.href);
  url.pathname = "/admin-ui";
  const qs = url.searchParams;
  qs.set("shop", shopFull);
  qs.set("host", hostVal);

  // Preserve current hash path (/#/analytics etc)
  const hash = window.location.hash || "#/";
  return `${url.origin}${url.pathname}?${qs.toString()}${hash}`;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older Safari
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}
