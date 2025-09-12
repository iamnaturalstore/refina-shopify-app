// refina-backend/routes/catalog-fallback.js
// Helper to fetch a small set of products directly from Admin API when Firestore index is empty.
// Use inside your existing /proxy/refina/v1/recommend handler as a last-resort fallback.

export async function fetchFallbackProducts(shop, accessToken, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 25));
  const q = (opts.query || "").trim();

  // Prefer active + published products; add a soft text query if provided
  // Admin GraphQL product query supports filters like `status:active published_status:published`
  const filter = `status:active published_status:published${
    q ? ` "${q.replace(/"/g, '\\"')}"` : ""
  }`;

  const gql = `
    query FallbackProducts($first: Int!, $query: String!) {
      products(first: $first, query: $query) {
        edges {
          node {
            id
            title
            handle
            onlineStoreUrl
            featuredImage { url altText }
            status
            publishedOnCurrentPublication
          }
        }
      }
    }
  `;

  const resp = await fetch(`https://${shop}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: gql, variables: { first: limit, query: filter } }),
  });
  const data = await resp.json();
  if (!resp.ok || data?.errors) {
    const msg =
      data?.errors?.map?.((e) => e.message).join("; ") ||
      data?.error ||
      resp.statusText;
    throw new Error(msg || "GraphQL error");
  }
  const items =
    data?.data?.products?.edges?.map((e) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      url: e.node.onlineStoreUrl || null,
      image: e.node.featuredImage?.url || null,
    })) || [];
  return items;
}
