// admin-ui/src/utils/returnTo.js
export function consumeReturnTo(navigate) {
  try {
    const url = new URL(window.location.href);
    const p = url.searchParams.get("return_to");
    if (!p) return;

    // remove it from the URL (keeps the rest of the params like shop/host)
    url.searchParams.delete("return_to");
    window.history.replaceState({}, "", url.toString());

    // navigate internally; ensure a leading slash
    const path = decodeURIComponent(p);
    if (path.startsWith("/")) {
      navigate(path);
    }
  } catch {}
}
