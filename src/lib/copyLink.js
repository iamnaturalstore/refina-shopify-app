export async function copyCurrentDeepLink() {
  const url = window.location.href; // already includes #/route
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch (_) {}
  // Fallback
  const ta = document.createElement("textarea");
  ta.value = url;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    return true;
  } finally {
    document.body.removeChild(ta);
  }
}
