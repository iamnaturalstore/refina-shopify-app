// refina-backend/routes/backfill.js
//
// Baseline importer (kept) + NEW queue endpoint that chains Import → Index.
// - Keeps existing POST /api/admin/backfill-products
// - Adds POST /api/backfill/queue?shop=<shop>.myshopify.com
//   which calls the importer and then spawns the indexer worker.
//
// Auth for both: header x-admin-secret === process.env.ADMIN_SHARED_SECRET
import express from "express";
import { spawn } from "node:child_process";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../lib/firestore.js";
import { toMyshopifyDomain } from "../utils/resolveStore.js";

/** Shape a minimal product doc for Firestore (subcollection). */
function productShapeFromShopify(raw, shop) {
  const price = Number(raw?.variants?.[0]?.price ?? NaN);
  const image = raw?.image?.src || raw?.images?.[0]?.src || "";
  const tags = String(raw?.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    id: String(raw.id),
    storeId: shop, // full <shop>.myshopify.com
    name: raw.title || "",
    title: raw.title || "",
    description: raw.body_html || "",
    tags,
    productType: raw.product_type || "",
    category: raw.product_type || "",
    ingredients: [], // filled by later enrichment
    image,
    price: Number.isFinite(price) ? price : null,
    handle: raw.handle || "",
    link: raw.handle ? `/products/${raw.handle}` : "#",
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Load OFFLINE session token (SDK-shape compatible). */
async function loadOfflineSession(shop) {
  const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
  const ids = [];
  try {
    if (shopify?.session?.getOfflineId) ids.push(shopify.session.getOfflineId(shop));
  } catch {}
  try {
    if (shopify?.api?.session?.getOfflineId) ids.push(shopify.api.session.getOfflineId(shop));
  } catch {}
  ids.push(`offline_${shop}`);

  const seen = new Set();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const sess = await storage.loadSession(id);
      if (sess?.accessToken) return sess;
    } catch {}
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// GraphQL helpers (Admin API) — keeps Firestore schema unchanged
// ───────────────────────────────────────────────────────────

/** Iterate all products via GraphQL with cursor paging. */
async function* iterateProductsGraphQL(session) {
  const client = new shopify.api.clients.Graphql({ session });
  let cursor = null;
  for (;;) {
    const query = `
      query Products($after: String) {
        products(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            productType
            tags
            bodyHtml
            images(first: 10) { nodes { url } }
            variants(first: 100) {
              nodes { id title price }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `;
    const resp = await client.query({ data: { query, variables: { after: cursor } } });
    const data = resp.body?.data?.products;
    if (!data) break;

    for (const node of data.nodes || []) {
      yield { node, client };
    }

    if (!data.pageInfo?.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
}

/** If a product has >100 variants, page the rest. Returns an array of {id,title,price}. */
async function fetchAllVariantsGraphQL(client, productGid, firstPage) {
  const out = [...(firstPage?.nodes || [])];
  let cursor = firstPage?.pageInfo?.endCursor || null;
  let hasNext = !!firstPage?.pageInfo?.hasNextPage;

  while (hasNext) {
    const q = `
      query Variants($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: 100, after: $after) {
            nodes { id title price }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    const r = await client.query({ data: { query: q, variables: { id: productGid, after: cursor } } });
    const v = r.body?.data?.product?.variants;
    if (!v) break;
    out.push(...(v.nodes || []));
    hasNext = !!v.pageInfo?.hasNextPage;
    cursor = v.pageInfo?.endCursor || null;
  }

  return out;
}

/** Map a GraphQL product node → "REST-ish" shape expected by productShapeFromShopify */
function restishFromGraphQLProduct(node, allVariantNodes) {
  const prodId = String(node.id).replace(/^gid:\/\/shopify\/Product\//, "");
  const variants = (allVariantNodes || []).map((v) => ({
    id: String(v.id).replace(/^gid:\/\/shopify\/ProductVariant\//, ""),
    title: v.title || "",
    price: v.price, // coerced downstream by productShapeFromShopify
  }));
  const images = (node.images?.nodes || []).map((n) => ({ src: n?.url || "" }));
  const image = images[0] || { src: "" };

  return {
    id: prodId,
    title: node.title || "",
    body_html: node.bodyHtml || "",
    product_type: node.productType || "",
    handle: node.handle || "",
    tags: Array.isArray(node.tags) ? node.tags.join(", ") : String(node.tags || ""),
    images,
    image,
    variants,
  };
}

export default function mountBackfillRoutes(app) {
  // ───────────────────────────────────────────────────────────
  // Shared admin guard
  // ───────────────────────────────────────────────────────────
  function requireAdmin(req, res, next) {
    const sec = req.get("x-admin-secret") || req.query.secret;
    if (!process.env.ADMIN_SHARED_SECRET || sec !== process.env.ADMIN_SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  }

  // ───────────────────────────────────────────────────────────
  // EXISTING ADMIN ROUTER: /api/admin/backfill-products (kept)
  // ───────────────────────────────────────────────────────────
  const adminRouter = express.Router();

  /**
   * POST /api/admin/backfill-products?shop=<full-domain>
   * Body (optional): { shop: "<full-domain>" }
   * Uses the OFFLINE session to fetch products and upsert into:
   *   products/<shop>/items/<id>
   */
  adminRouter.post("/backfill-products", requireAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-RF-Handler", "admin-backfill-products");
    try {
      const rawShop = String(req.query.shop || req.body?.shop || "").toLowerCase().trim();
      const shop = toMyshopifyDomain(rawShop);
      if (!shop) {
        return res.status(400).json({ ok: false, error: "missing_or_invalid_shop" });
      }

      const session = await loadOfflineSession(shop);
      if (!session?.accessToken) {
        return res.status(401).json({ ok: false, error: "no_offline_session" });
      }

      const mode = String(process.env.SHFY_FETCH_MODE || "rest").toLowerCase();
      let total = 0;
      let pages = 0;

      if (mode === "gql") {
        // ── GraphQL path (cursor paging), preserving Firestore schema ──
        const batchSize = 250;
        let inBatch = 0;
        let batch = dbAdmin.batch();

        for await (const { node, client } of iterateProductsGraphQL(session)) {
          // Collect all variants (page if >100)
          const firstPage = node.variants || { nodes: [], pageInfo: { hasNextPage: false } };
          const variantNodes = await fetchAllVariantsGraphQL(client, node.id, firstPage);

          // Map to REST-ish, then to Firestore doc via existing shaper
          const restish = restishFromGraphQLProduct(node, variantNodes);
          const doc = productShapeFromShopify(restish, shop);

          // Write batched (commit every 250)
          const ref = dbAdmin.doc(`products/${shop}/items/${doc.id}`);
          batch.set(ref, doc, { merge: true });
          inBatch += 1;
          total += 1;

          if (inBatch >= batchSize) {
            await batch.commit();
            pages += 1;
            batch = dbAdmin.batch();
            inBatch = 0;
          }
        }
        // flush any residue
        if (inBatch > 0) {
          await batch.commit();
          pages += 1;
        }

        return res.json({ ok: true, shop, synced: total, pages });
      } else {
        // ── Original REST path (unchanged for rollback) ──
        const apiVersion = shopify.config.apiVersion;
        let url = `https://${shop}/admin/api/${apiVersion}/products.json?limit=250&fields=id,title,body_html,product_type,handle,tags,images,image,variants`;

        while (url) {
          const resp = await fetch(url, {
            headers: {
              "X-Shopify-Access-Token": session.accessToken,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          });

          if (!resp.ok) {
            return res.status(502).json({ ok: false, error: `shopify_${resp.status}` });
          }

          const data = await resp.json();
          const products = Array.isArray(data?.products) ? data.products : [];

          if (products.length) {
            const batch = dbAdmin.batch();
            for (const raw of products) {
              const doc = productShapeFromShopify(raw, shop);
              const ref = dbAdmin.doc(`products/${shop}/items/${doc.id}`);
              batch.set(ref, doc, { merge: true });
            }
            await batch.commit();
          }

          total += products.length;
          pages += 1;

          // Pagination via Link header (RFC5988)
          const link = resp.headers.get("link") || resp.headers.get("Link");
          let nextUrl = null;
          if (link) {
            const nextPart = link
              .split(",")
              .map((s) => s.trim())
              .find((s) => /rel="?next"?/i.test(s));
            if (nextPart) {
              const m = nextPart.match(/<([^>]+)>/);
              if (m?.[1]) nextUrl = m[1];
            }
          }
          url = nextUrl;
        }

        return res.json({ ok: true, shop, synced: total, pages });
      }
    } catch (e) {
      console.error("backfill error:", e);
      return res.status(500).json({ ok: false, error: "backfill_failed" });
    }
  });

  app.use("/api/admin", adminRouter);

  // ───────────────────────────────────────────────────────────
  // NEW QUEUE ROUTER: /api/backfill/queue (import → index)
  // ───────────────────────────────────────────────────────────
  const queueRouter = express.Router();

  // Internal helper to call our importer via same host (reuses auth + logic)
  async function callInternalImporter(req, shop) {
    const scheme = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
    const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString();
    const url = `${scheme}://${host}/api/admin/backfill-products?shop=${encodeURIComponent(shop)}`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-admin-secret": req.get("x-admin-secret") || "",
      },
      keepalive: true,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      const err = new Error(`importer HTTP ${r.status}: ${txt.slice(0, 200)}`);
      err.statusCode = 502;
      throw err;
    }
    return r.json().catch(() => ({}));
  }

  // Fire-and-forget indexer worker spawn
  function spawnIndexer(shop) {
    const args = [
      "refina-backend/workers/indexer.mjs",
      "bootstrap",
      "--store",
      shop,
      "--commit",
    ];
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "inherit"], // keep stderr for logs
      detached: false,
      env: process.env,
    });
    child.on("exit", (code) => {
      console.error(`[backfill] indexer exit code=${code} shop=${shop}`);
    });
    return { pid: child.pid };
  }

  /**
   * POST /api/backfill/queue?shop=<full-domain>
   * Auth: x-admin-secret
   * Behavior: Import products (idempotent), then spawn indexer (non-blocking).
   * Response: 202 { ok:true, queued:true, shop, import:{...}, indexer:{pid} }
   */
  queueRouter.post("/queue", requireAdmin, express.json(), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const rawShop = String(req.query.shop || req.body?.shop || "").toLowerCase().trim();
      const shop = toMyshopifyDomain(rawShop);
      if (!shop) {
        return res.status(400).json({ ok: false, error: "missing_or_invalid_shop" });
      }

      // 1) Import
      const importResult = await callInternalImporter(req, shop);

      // 2) Index (fire-and-forget)
      const { pid } = spawnIndexer(shop);

      // 2.5) Enrich (fire-and-forget) — triggers the enrichment router after ingest/index
      try {
        const scheme = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
        const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString();
        const enrichUrl = `${scheme}://${host}/api/admin/enrichment/run`;
        // Do not await — let it run in the background
        fetch(enrichUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-secret": req.get("x-admin-secret") || "",
          },
          body: JSON.stringify({
            storeId: shop,
            rebuildMissingOnly: true,
            recomputeMappings: true,
          }),
          keepalive: true,
        }).catch(() => {});
      } catch {}

      // 3) 202 Accepted
      return res.status(202).json({
        ok: true,
        queued: true,
        shop,
        import: importResult || null,
        indexer: { pid },
      });
    } catch (err) {
      const code = err?.statusCode || 500;
      return res.status(code).json({ ok: false, error: String(err?.message || "queue_failed") });
    }
  });

  // ───────────────────────────────────────────────────────────
  // READ-ONLY: /api/indexer/status?shop=<full-domain>&fresh=1
  // Returns normalized shape for the Admin UI progress panel.
  // Auth: none (read-only progress).
  // ───────────────────────────────────────────────────────────
  app.get("/api/indexer/status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const rawShop = String(req.query.shop || "").toLowerCase().trim();
      const shop = toMyshopifyDomain(rawShop);
      if (!shop) {
        return res.status(400).json({ ok: false, error: "missing_or_invalid_shop" });
      }

      // Read top-level Firestore doc: indexerStatus/<shop>
      const ref = dbAdmin.doc(`indexerStatus/${shop}`);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.json({ ok: true, shop, indexer: null });
      }

      const d = snap.data() || {};
      // Normalize to what the UI expects
      const updatedAtIso =
        d.updatedAt?.toDate?.() ? d.updatedAt.toDate().toISOString() : (d.updatedAt || null);

      const indexer = {
        phase: String(d.phase || "preparing"),
        // prefer embedded/imported if you later split them; for now mirror done→both
        totalProducts: Number(d.total || 0),
        importedCount: Number((d.imported ?? d.done) || 0),
        embeddedCount: Number((d.embedded ?? d.done) || 0),
        pct: Number(d.pct || 0),
        updatedAt: updatedAtIso,
      };

      return res.json({ ok: true, shop, indexer });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "status_read_failed" });
    }
  });

  app.use("/api/backfill", queueRouter);
}
