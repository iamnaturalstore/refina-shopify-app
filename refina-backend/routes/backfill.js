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
import { enrichmentRouter } from "./enrichment.js";
import { resolveAdminSession } from "../utils/shopSession.js";
import { nowTs } from "../bff/lib/firestore.js";
import { Timestamp } from "@google-cloud/firestore";

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
    shopifyUpdatedAt: raw.updated_at || raw.updatedAt || null,
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
// BACKFILL HELPERS (paste into refina-backend/routes/backfill.js)
// Place these ABOVE: export default function mountBackfillRoutes(app) { ... }
// ───────────────────────────────────────────────────────────

function computeEligibilityFromGqlProduct(p) {
  // Admin GraphQL Product.status is typically: ACTIVE | DRAFT | ARCHIVED
  const statusRaw = String(p?.status || "");
  const shopifyStatus = statusRaw.toLowerCase(); // "active" | "draft" | "archived" (or "")

  // publishedAt often null if unpublished
  const published = Boolean(p?.publishedAt);

  // Variants presence (baseline sellable signal)
  const variants = Array.isArray(p?.variants?.nodes) ? p.variants.nodes : [];
  const hasVariant = variants.length > 0;

  // "availableForSale" is not always available on Admin Product, so compute baseline:
  // active + published + hasVariant
  const availableForSale = shopifyStatus === "active" && published && hasVariant;

  // Canonical flag used everywhere downstream
  const isActive = availableForSale;

  return { shopifyStatus, published, availableForSale, isActive };
}

function productShapeFromGql(p, shop, syncAt, FieldValue) {
  // Preserve numeric id used by existing Firestore docs
  const numericId =
    p?.legacyResourceId != null
      ? String(p.legacyResourceId)
      : String((p?.id || "").match(/\d+$/)?.[0] || "");

  const imgUrl =
    p?.featuredImage?.url ||
    (Array.isArray(p?.images?.nodes) && p.images.nodes[0]?.url) ||
    "";

  // price: handle both Money-like { amount } and plain decimal string
  const var0 = Array.isArray(p?.variants?.nodes) ? p.variants.nodes[0] : null;
  let priceNum = null;
  if (var0 && var0.price != null) {
    if (typeof var0.price === "object" && var0.price.amount != null) {
      priceNum = Number(var0.price.amount);
    } else {
      priceNum = Number(var0.price); // decimal string → number
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
    ingredients: [], // filled by later enrichment
    image: imgUrl,
    price,
    handle: p?.handle || "",
    link: p?.handle ? `/products/${p.handle}` : "#",

    // ── NEW: lifecycle + eligibility ─────────────────────────
    shopifyStatus,        // "active" | "draft" | "archived"
    published,            // boolean
    availableForSale,     // boolean
    isActive,             // canonical recommender filter
    lastSeenAt: syncAt,   // fixed timestamp for this run
    discontinuedAt: null, // set when tombstoned
    deletedInShopify: false,

    shopifyUpdatedAt: p?.updatedAt || p?.updated_at || null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function tombstoneUnseenProducts(dbAdmin, shop, syncAt) {
  const col = dbAdmin.collection("products").doc(shop).collection("items");

  // Active products that were not "seen" in the current run
  const snap = await col
    .where("isActive", "==", true)
    .where("lastSeenAt", "<", syncAt)
    .get();

  if (snap.empty) return { tombstoned: 0 };

  let batch = dbAdmin.batch();
  let opCount = 0;
  let tombstoned = 0;

  for (const doc of snap.docs) {
      batch.update(doc.ref, {
      deletedInShopify: false,      // explicitly not "deleted at source"
      published: false,
      isActive: false,
      availableForSale: false,
      shopifyStatus: "tombstoned",
      discontinuedAt: syncAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tombstoned++;
    opCount++;

    // Firestore batch limit (500). Keep buffer.
    if (opCount >= 450) {
      await batch.commit();
      batch = dbAdmin.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) await batch.commit();
  return { tombstoned };
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
   * Uses the OFFLINE session to fetch products via REST and upsert into:
   *   products/<shop>/items/<id>
   */
  // REPLACE the whole REST importer handler with this GraphQL version
adminRouter.post("/backfill-products", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-RF-Handler", "admin-backfill-products-gql");
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

    const apiVersion = shopify.config.apiVersion;
    const gqlUrl = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

    // Small helper for Admin GraphQL calls (cursor-paginated)
    async function gqlFetch(query, variables) {
      const r = await fetch(gqlUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        const err = new Error(`shopify_graphql_${r.status}: ${txt.slice(0, 300)}`);
        err.statusCode = 502;
        throw err;
      }
      const payload = await r.json();
      if (payload.errors) {
        const txt = JSON.stringify(payload.errors).slice(0, 300);
        const err = new Error(`shopify_graphql_errors: ${txt}`);
        err.statusCode = 502;
        throw err;
      }
      return payload.data;
    }

    // GraphQL: fetch products in pages of 250, mirroring your REST selection
    // NOTE: We use legacyResourceId to preserve your numeric id.
    // drop priceV2 from the query after 502 error
    const QUERY = `
  query ProductsPage($after: String) {
    products(first: 250, after: $after, sortKey: ID) {
      pageInfo { hasNextPage }
      edges { cursor }
      nodes {
        id
        legacyResourceId
        title
        descriptionHtml
        productType
        tags
        handle

        status
        publishedAt

        featuredImage { url }
        images(first: 1) { nodes { url } }
        variants(first: 1) {
          nodes {
            # In recent API versions, "price" is either Money-like ({amount})
            # or a decimal string. We handle both in JS.
            price
          }
        }
      }
    }
  }
`;

    const syncAt = Timestamp.now();

    let after = null;
    let total = 0;
    let pages = 0;

    while (true) {
      const data = await gqlFetch(QUERY, { after });
      const nodes = data?.products?.nodes || [];
      const edges  = data?.products?.edges  || [];
      const pageInfo = data?.products?.pageInfo || {};
      pages += 1;

      if (nodes.length) {
  const batch = dbAdmin.batch();

  for (const p of nodes) {
    const doc = productShapeFromGql(p, shop, syncAt, FieldValue);
    const ref = dbAdmin.doc(`products/${shop}/items/${doc.id}`);
    batch.set(ref, doc, { merge: true });
  }

  await batch.commit();
  total += nodes.length;
}

      if (!pageInfo?.hasNextPage) break;
      after = edges.length ? edges[edges.length - 1].cursor : null;
      if (!after) break;
    }

    const { tombstoned } = await tombstoneUnseenProducts(dbAdmin, shop, syncAt);
return res.json({ ok: true, shop, synced: total, pages, tombstoned });
  } catch (e) {
    console.error("backfill (gql) error:", e);
    return res.status(500).json({ ok: false, error: "backfill_failed" });
  }
});

  adminRouter.use("/enrichment", requireAdmin, enrichmentRouter);
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

// ───────────────────────────────────────────────────────────
  // NEW: Session-based starter for embedded Admin
  // POST /api/sync/start
  // - derives shop from OFFLINE (changed from previously incorrect ONLINE session call)
  // - enforces single-active & cooldown using indexerStatus/<shop>
  // - internally calls existing /api/backfill/queue?shop=...
  // Response: { ok, queued, reason?, shop }
  // ───────────────────────────────────────────────────────────
  app.post("/api/sync/start", express.json(), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // 1) Resolve shop from query (?shop=) — no ONLINE dependency
      const rawShop = String(req.query.shop || "").toLowerCase().trim();
      const shop = toMyshopifyDomain(rawShop);
      if (!shop) {
        return res.status(401).json({ ok: false, error: "no_shop_context" });
      }

      // 1.5) OFFLINE token preflight (importer relies on this)
      const offline = await loadOfflineSession(shop);
      if (!offline?.accessToken) {
        return res.status(401).json({ ok: false, error: "no_offline_session", shop });
      }

      // 2) Read current indexer status for guards
      const statusRef = dbAdmin.doc(`indexerStatus/${shop}`);
      const snap = await statusRef.get();
      const d = snap.exists ? (snap.data() || {}) : {};
      const phase = String(d.phase || "");
      const now = Date.now();
      const updatedMs =
        typeof d.updatedAt?.toMillis === "function"
          ? d.updatedAt.toMillis()
          : typeof d.updatedAt === "number"
          ? d.updatedAt
          : 0;
      const finishedMs =
        typeof d.finishedAt?.toMillis === "function"
          ? d.finishedAt.toMillis()
          : typeof d.finishedAt === "number"
          ? d.finishedAt
          : 0;

      // Guard A: already running (phase not terminal & recently updated)
      const TERMINAL = new Set(["complete", "error"]);
      const ACTIVE_WINDOW_MS = 90_000; // 90s
      const isActive = !TERMINAL.has(phase) && updatedMs && now - updatedMs < ACTIVE_WINDOW_MS;
      if (isActive) {
        return res.json({ ok: true, queued: false, reason: "already_running", shop });
      }

      // Guard B: cooldown after finish/fail
      const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
      const inCooldown = finishedMs && now - finishedMs < COOLDOWN_MS;
      if (inCooldown) {
        return res.json({ ok: true, queued: false, reason: "cooldown", shop, retryAfterSec: Math.max(0, Math.ceil((COOLDOWN_MS - (now - finishedMs)) / 1000)) });
      }

      // 3) Internal call to existing queue endpoint (admin-secret server-to-server)
      const scheme = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
      const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString();
      const url = `${scheme}://${host}/api/backfill/queue?shop=${encodeURIComponent(shop)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "x-admin-secret": process.env.ADMIN_SHARED_SECRET || "",
          "content-type": "application/json",
        },
        keepalive: true,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return res.status(502).json({ ok: false, error: `queue_failed_${r.status}`, detail: body.slice(0, 300) });
      }

      // 4) Optionally mark "queued at" for troubleshootability
      try {
        await statusRef.set({ phase: "queued", updatedAt: nowTs() }, { merge: true });
      } catch {}

      return res.status(202).json({ ok: true, queued: true, shop });
    } catch (e) {
      const msg = e?.message || "sync_start_failed";
      const code = e?.status || 500;
      return res.status(code).json({ ok: false, error: msg });
    }
  });
 }