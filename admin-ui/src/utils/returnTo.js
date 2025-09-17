// admin-ui/src/utils/returnTo.js
// Restores an intended in-app path after Shopify/redirect flows, while preserving
// ?host (and ?shop if present). Works with HashRouter by checking both the
// top-level search and the hash query.
//
// Usage: in a Router context
//   import { consumeReturnTo } from "./utils/returnTo";
//   useEffect(() => consumeReturnTo(navigate), [navigate]);
//
// Behavior:
// - Looks for "return_to" in BOTH top-level search and the hash query.
// - Prefers the hash query value if both are present (SPA navigations).
// - Removes "return_to" from whichever segment it was found, without reloading.
// - Navigates to the target path, merging in current host/shop if missing.

function getSearchParams() {
  try {
    return new URLSearchParams(window.location.search || "");
  } catch {
    return new URLSearchParams();
  }
}

function getHashParams() {
  try {
    const raw = String(window.location.hash || "");
    const q = raw.includes("?") ? raw.split("?")[1] : "";
    return new URLSearchParams(q);
  } catch {
    return new URLSearchParams();
  }
}

function getReturnTo() {
  const hash = getHashParams();
  const search = getSearchParams();
  const fromHash = hash.get("return_to");
  if (fromHash) return { source: "hash", value: fromHash };
  const fromSearch = search.get("return_to");
  if (fromSearch) return { source: "search", value: fromSearch };
  return { source: "", value: "" };
}

function readHostShop() {
  const hash = getHashParams();
  const search = getSearchParams();
  // Prefer hash values (SPA has likely carried them forward there)
  const host = hash.get("host") || search.get("host") || "";
  const shop = hash.get("shop") || search.get("shop") || "";
  return { host, shop };
}

function removeReturnToFromUrl(source) {
  try {
    const url = new URL(window.location.href);

    if (source === "search") {
      url.searchParams.delete("return_to");
      window.history.replaceState({}, "", url.toString());
      return;
    }

    if (source === "hash") {
      const raw = String(url.hash || ""); // e.g., "#/setup?host=...&return_to=%2F..."
      const [hashPathPart, hashQueryPart] = raw.replace(/^#/, "").split("?");
      const params = new URLSearchParams(hashQueryPart || "");
      params.delete("return_to");
      const nextQuery = params.toString();
      const nextHash = nextQuery ? `#${hashPathPart}?${nextQuery}` : `#${hashPathPart}`;
      url.hash = nextHash;
      window.history.replaceState({}, "", url.toString());
      return;
    }
  } catch {
    // ignore
  }
}

function normalizePath(p) {
  let path = String(p || "").trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    // ignore bad encodings; use raw string
  }
  if (!path.startsWith("/")) path = `/${path}`;
  // strip accidental leading "#"
  if (path.startsWith("/#/")) path = path.slice(2); // "/#/x" -> "/x"
  return path;
}

function mergeQueryIntoPath(path, additions) {
  // Split incoming path into pathOnly + existing query
  let pathOnly = path;
  let existingQ = "";
  if (path.includes("?")) {
    const idx = path.indexOf("?");
    pathOnly = path.slice(0, idx);
    existingQ = path.slice(idx + 1);
  }
  const qs = new URLSearchParams(existingQ);

  // Only set host/shop if not already in the target path
  if (additions.host && !qs.get("host")) qs.set("host", additions.host);
  if (additions.shop && !qs.get("shop")) qs.set("shop", additions.shop);

  const outQ = qs.toString();
  return outQ ? `${pathOnly}?${outQ}` : pathOnly;
}

export function consumeReturnTo(navigate) {
  const { source, value } = getReturnTo();
  if (!value) return;

  const targetPath = normalizePath(value);
  const { host, shop } = readHostShop();
  const finalTarget = mergeQueryIntoPath(targetPath, { host, shop });

  // If we’re effectively already at the target (hash contents match), just clean up the URL.
  const currentHashPathAndQuery = (window.location.hash || "").replace(/^#/, "");
  if (currentHashPathAndQuery === finalTarget.replace(/^\/?/, "")) {
    removeReturnToFromUrl(source);
    return;
  }

  // Remove return_to from URL before navigating (silent, no reload)
  removeReturnToFromUrl(source);

  try {
    navigate(finalTarget, { replace: true });
  } catch {
    // Fallback: force hash to the right path (rare)
    window.location.hash = `#${finalTarget.replace(/^#?\/?/, "")}`;
  }
}