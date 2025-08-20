// admin-ui/src/utils/shareHref.js
export function buildShareHref({ shop, host, storeId }) {
  const url = new URL(window.location.href);
  url.pathname = "/admin-ui";
  url.searchParams.set("shop", shop);
  url.searchParams.set("host", host);
  url.searchParams.set("storeId", storeId);
  // Preserve current hash path (/#/analytics etc)
  const hash = window.location.hash || "#/";
  return `${url.origin}${url.pathname}?${url.searchParams.toString()}${hash}`;
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
