// refina-backend/routes/backfill.js

import express from "express";
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

export default function mountBackfillRoutes(app) {
  const router = express.Router();

  // Simple admin guard (header or ?secret=)
  function requireAdmin(req, res, next) {
    const sec = req.get("x-admin-secret") || req.query.secret;
    if (!process.env.ADMIN_SHARED_SECRET || sec !== process.env.ADMIN_SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  }

  /**
   * POST /api/admin/backfill-products?shop=<full-domain>
   * Body (optional): { shop: "<full-domain>" }
   *
   * Uses the OFFLINE session to fetch products via REST and upsert into:
   *   products/<shop>/items/<id>
   */
  router.post("/backfill-products", requireAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-RF-Handler", "admin-backfill-products");

    try {
      const rawShop =
        String(req.query.shop || req.body?.shop || "").toLowerCase().trim();
      const shop = toMyshopifyDomain(rawShop);
      if (!shop) {
        return res
          .status(400)
          .json({ ok: false, error: "missing_or_invalid_shop" });
      }

      const session = await loadOfflineSession(shop);
      if (!session?.accessToken) {
        return res
          .status(401)
          .json({ ok: false, error: "no_offline_session" });
      }

      const apiVersion = shopify.config.apiVersion;
      let url = `https://${shop}/admin/api/${apiVersion}/products.json?limit=250&fields=id,title,body_html,product_type,handle,tags,images,image,variants`;
      let total = 0;
      let pages = 0;

      while (url) {
        const resp = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": session.accessToken,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });

        if (!resp.ok) {
          return res
            .status(502)
            .json({ ok: false, error: `shopify_${resp.status}` });
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
    } catch (e) {
      console.error("backfill error:", e);
      return res.status(500).json({ ok: false, error: "backfill_failed" });
    }
  });

  app.use("/api/admin", router);
}
