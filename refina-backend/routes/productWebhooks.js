// refina-backend/routes/productWebhooks.js

import express from "express";
import crypto from "crypto";
import { FieldValue, db } from "../lib/firestore.js";
import { getWebhookAdminClient } from "../utils/shopSession.js";

const router = express.Router();

// Use raw body for HMAC verification, same pattern as privacy webhooks
const rawJson = express.raw({ type: "application/json" });

const PRODUCT_GQL = `
  query ProductWebhookProduct($id: ID!) {
    product(id: $id) {
      id
      legacyResourceId
      title
      handle
      status
      publishedAt
      updatedAt
      productType
      tags
      descriptionHtml
      featuredImage {
        url
      }
      images(first: 1) {
        nodes {
          url
        }
      }
      variants(first: 1) {
        nodes {
          price
        }
      }
    }
  }
`;

function verifyWebhookHmac(rawBody, hmacHeader) {
  const secret =
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    "";

  if (!rawBody || !hmacHeader || !secret) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(String(hmacHeader), "utf8")
    );
  } catch {
    return false;
  }
}

function shopDomainFromHeader(req) {
  return (
    req.get("x-shopify-shop-domain") ||
    req.get("X-Shopify-Shop-Domain") ||
    ""
  ).trim().toLowerCase();
}

function topicFromHeader(req) {
  return (
    req.get("x-shopify-topic") ||
    req.get("X-Shopify-Topic") ||
    ""
  ).trim().toLowerCase();
}

function getNumericIdFromGid(gid) {
  return String((gid || "").match(/\d+$/)?.[0] || "");
}

function getNumericIdFromPayload(body) {
  if (body?.admin_graphql_api_id) {
    const fromGid = getNumericIdFromGid(body.admin_graphql_api_id);
    if (fromGid) return fromGid;
  }
  if (body?.id != null) return String(body.id);
  return "";
}

function computeEligibilityFromGqlProduct(p) {
  const statusRaw = String(p?.status || "");
  const shopifyStatus = statusRaw.toLowerCase();

  const published = Boolean(p?.publishedAt);

  const variants = Array.isArray(p?.variants?.nodes) ? p.variants.nodes : [];
  const hasVariant = variants.length > 0;

  const availableForSale = shopifyStatus === "active" && published && hasVariant;
  const isActive = availableForSale;

  return { shopifyStatus, published, availableForSale, isActive };
}

function productShapeFromGql(p, shop, syncAt, FieldValue) {
  const numericId =
    p?.legacyResourceId != null
      ? String(p.legacyResourceId)
      : String((p?.id || "").match(/\d+$/)?.[0] || "");

  const imgUrl =
    p?.featuredImage?.url ||
    (Array.isArray(p?.images?.nodes) && p.images.nodes[0]?.url) ||
    "";

  const var0 = Array.isArray(p?.variants?.nodes) ? p.variants.nodes[0] : null;
  let priceNum = null;
  if (var0 && var0.price != null) {
    if (typeof var0.price === "object" && var0.price.amount != null) {
      priceNum = Number(var0.price.amount);
    } else {
      priceNum = Number(var0.price);
    }
  }
  const price = Number.isFinite(priceNum) ? priceNum : null;

  const { shopifyStatus, published, availableForSale, isActive } =
    computeEligibilityFromGqlProduct(p);

  return {
    id: numericId,
    storeId: shop,

    name: p?.title || "",
    title: p?.title || "",
    description: p?.descriptionHtml || "",
    tags: Array.isArray(p?.tags) ? p.tags.filter(Boolean) : [],
    productType: p?.productType || "",
    category: p?.productType || "",
    ingredients: [],
    image: imgUrl,
    price,
    handle: p?.handle || "",
    link: p?.handle ? `/products/${p.handle}` : "#",

    shopifyStatus,
    published,
    availableForSale,
    isActive,
    lastSeenAt: syncAt,
    lastWebhookAt: syncAt,
    discontinuedAt: null,
    deletedInShopify: false,

    shopifyUpdatedAt: p?.updatedAt || p?.updated_at || null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function fetchProductByNumericId(shop, numericId) {
  if (!shop || !numericId) return null;

  let admin;
  try {
    admin = await getWebhookAdminClient(shop);
  } catch (err) {
    const message = err?.message || String(err);

    console.warn("[product-webhook] skipping product fetch; no webhook admin client", {
      shop,
      numericId,
      message,
    });

    return { __refinaSkip: true, reason: "missing_admin_client", message };
  }

  if (!admin || typeof admin.query !== "function") {
    console.warn("[product-webhook] skipping product fetch; invalid webhook admin client", {
      shop,
      numericId,
    });

    return {
      __refinaSkip: true,
      reason: "invalid_admin_client",
      message: "Webhook admin client unavailable or invalid",
    };
  }

  const gid = `gid://shopify/Product/${numericId}`;

  const resp = await admin.query({
    data: {
      query: PRODUCT_GQL,
      variables: { id: gid },
    },
  });

  const payload =
    typeof resp?.body === "function"
      ? await resp.body()
      : resp?.body ?? resp;

  const product = payload?.data?.product || null;
  return product;
}

function productDocRef(shop, productId) {
  return db.collection("products").doc(shop).collection("items").doc(String(productId));
}

function buildDeletedProductPatch(shop, numericId, FieldValue) {
  return {
    id: String(numericId),
    storeId: shop,
    deletedInShopify: true,
    published: false,
    isActive: false,
    availableForSale: false,
    shopifyStatus: "deleted",
    discontinuedAt: FieldValue.serverTimestamp(),
    lastWebhookAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function buildWebhookTouchPatch(FieldValue) {
  return {
    lastWebhookAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}
router.post("/", rawJson, async (req, res) => {
  const rawBody = req.body?.toString?.("utf8") || "";

  const hmac =
    req.get("x-shopify-hmac-sha256") ||
    req.get("X-Shopify-Hmac-Sha256");

  if (!verifyWebhookHmac(rawBody, hmac)) {
    return res.status(401).send("Invalid webhook signature");
  }

  const topic = topicFromHeader(req);
  const shop = shopDomainFromHeader(req);

  if (!shop) return res.status(400).send("Missing shop domain");

  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  try {
    if (topic === "products/create" || topic === "products/update") {
      const numericId = getNumericIdFromPayload(body);
      if (!numericId) {
        return res.status(400).send("Missing product id");
      }

      const product = await fetchProductByNumericId(shop, numericId);

            // Store may be installed/partially onboarded without a usable offline session yet.
      // Do not fail webhook delivery in that state; Shopify will otherwise retry and log 500s.
      if (product?.__refinaSkip) {
        console.warn("[product-webhook] acknowledged without product sync", {
          topic,
          shop,
          numericId,
          reason: product.reason,
          message: product.message,
        });

        await productDocRef(shop, numericId).set(
          buildWebhookTouchPatch(FieldValue),
          { merge: true }
        );

        return res.status(200).send("OK");
      }

      // Product may have been deleted/hidden between webhook emit and fetch.
      if (!product) {
        await productDocRef(shop, numericId).set(
          buildDeletedProductPatch(shop, numericId, FieldValue),
          { merge: true }
        );

        return res.status(200).send("OK");
      }

      const syncAt = FieldValue.serverTimestamp();
      const doc = productShapeFromGql(product, shop, syncAt, FieldValue);

        await productDocRef(shop, numericId).set(
          {
            ...doc,
            ...buildWebhookTouchPatch(FieldValue),
          },
          { merge: true }
      );

      return res.status(200).send("OK");
    }

    if (topic === "products/delete") {
      const numericId = getNumericIdFromPayload(body);
      if (!numericId) {
        return res.status(400).send("Missing product id");
      }

        await productDocRef(shop, numericId).set(
          buildDeletedProductPatch(shop, numericId, FieldValue),
          { merge: true }
        );

      return res.status(200).send("OK");
    }

    return res.status(200).send("Ignored");
  } catch (err) {
    console.error("[product-webhook] failed", {
      topic,
      shop,
      message: err?.message || String(err),
    });
    return res.status(500).send("Webhook processing failed");
  }
});

export default router;