// Decode Shopify host param to get the shop domain (e.g. "refina-demo.myshopify.com")
// We'll use the FULL shop domain as storeId to match your Firestore structure.
export function getStoreIdFromHost() {
  const params = new URLSearchParams(window.location.search);
  const host = params.get("host") || window.__SHOPIFY_DEV_HOST__ || "";
  try {
    const decoded = atob(host); // e.g. "refina-demo.myshopify.com/admin"
    const shopDomain = decoded.split("/")[0] || "demo-store.myshopify.com";
    return shopDomain; // use full domain as storeId
  } catch {
    // Fallback: let you still use the UI in dev
    return "demo-store.myshopify.com";
  }
}
 