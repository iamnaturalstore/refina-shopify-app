// refina-backend/routes/backfill.js
import express from "express";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

function productShapeFromShopify(raw, shop) {
  const price = Number(raw?.variants?.[0]?.price ?? NaN);
  const image = raw?.image?.src || raw?.images?.[0]?.src || "";
  const tags = String(raw?.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    id: String(raw.id),
    storeId: shop, // full domain
    name: raw.title || "",
    title: raw.title || "",
    description: raw.body_html || "",
    tags,
    productType: raw.product_type || "",
    category: raw.product_type || "",
    ingredients: [],
    image,
    price: Number.isFinite(price) ? price : null,
    handle: raw.handle || "",
    link: raw.handle ? `/products/${raw.handle}` : "#",
    updatedAt: FieldValue.serverTimestamp(),
  };
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

  // POST /api/admin/backfill-products?shop=<full-domain>
  router.post("/backfill-products", requireAdmin, async (req, res) => {
    try {
      const shop = String(req.query.shop || req.body?.shop || "").toLowerCase();
      if (!shop.endsWith(".myshopify.com")) return res.status(400).json({ ok: false, error: "missing_or_invalid_shop" });

      const api = shopify.api;
      const offlineId = api.session.getOfflineId(shop);
      const session = await api.sessionStorage.loadSession(offlineId);
      if (!session?.accessToken) return res.status(401).json({ ok: false, error: "no_offline_session" });

      let url = `https://${shop}/admin/api/${shopify.config.apiVersion}/products.json?limit=250&fields=id,title,body_html,product_type,handle,tags,images,image,variants`;
      let total = 0;
      let pages = 0;

      while (url) {
        const resp = await fetch(url, { headers: { "X-Shopify-Access-Token": session.accessToken } });
        if (!resp.ok) return res.status(502).json({ ok: false, error: `shopify_${resp.status}` });

        const data = await resp.json();
        const products = data.products || [];

        const batch = dbAdmin.batch();
        for (const raw of products) {
          const doc = productShapeFromShopify(raw, shop);
          batch.set(dbAdmin.doc(`products/${shop}/items/${doc.id}`), doc, { merge: true });
        }
        await batch.commit();

        total += products.length;
        pages += 1;

        // Pagination via Link header
        const link = resp.headers.get("link") || resp.headers.get("Link");
        let nextUrl = null;
        if (link) {
          const nextPart = link
            .split(",")
            .map((s) => s.trim())
            .find((s) => /rel="?next"?/.test(s));
          if (nextPart) {
            const m = nextPart.match(/<([^>]+)>/);
            if (m) nextUrl = m[1];
          }
        }
        url = nextUrl;
      }

      return res.json({ ok: true, synced: total, pages, shop });
    } catch (e) {
      console.error("backfill error:", e);
      return res.status(500).json({ ok: false, error: "backfill_failed" });
    }
  });

  app.use("/api/admin", router);
}
