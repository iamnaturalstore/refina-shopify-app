// Usage:
// node refina-backend/scripts/seedSemanticMarkers.js <STORE_ID> [LIMIT] [--dry-run]
//
// Examples:
// node refina-backend/scripts/seedSemanticMarkers.js i-am-natural-shopify-trial.myshopify.com
// node refina-backend/scripts/seedSemanticMarkers.js i-am-natural-shopify-trial.myshopify.com 50
// node refina-backend/scripts/seedSemanticMarkers.js i-am-natural-shopify-trial.myshopify.com 50 --dry-run

import crypto from "crypto";
import { dbAdmin, FieldValue } from "../bff/lib/firestore.js";

const SEMANTIC_SOURCE_VERSION = "product-semantics-v1";

const [, , STORE_ID, LIMIT_ARG, ...REST] = process.argv;
const DRY_RUN = REST.includes("--dry-run");

if (!STORE_ID) {
  console.error(
    "Usage: node refina-backend/scripts/seedSemanticMarkers.js <STORE_ID> [LIMIT] [--dry-run]"
  );
  process.exit(1);
}

const LIMIT =
  LIMIT_ARG && !String(LIMIT_ARG).startsWith("--")
    ? Number(LIMIT_ARG)
    : null;

function stripHtml(input) {
  return String(input || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSemanticText(v, cap = 4000) {
  return stripHtml(v).replace(/\s+/g, " ").trim().slice(0, cap);
}

function normalizeSemanticTags(tags, cap = 64) {
  const arr = Array.isArray(tags)
    ? tags
    : typeof tags === "string"
      ? tags.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  return Array.from(
    new Set(
      arr
        .map((t) => String(t || "").trim().toLowerCase())
        .filter(Boolean)
    )
  )
    .sort()
    .slice(0, cap);
}

function buildSemanticSnapshot(product) {
  return {
    _v: SEMANTIC_SOURCE_VERSION,
    title: normalizeSemanticText(product?.title || product?.name || "", 300),
    description: normalizeSemanticText(
      product?.description || product?.body_html || "",
      8000
    ),
    tags: normalizeSemanticTags(product?.tags, 64),
    productType: normalizeSemanticText(
      product?.productType || product?.product_type || "",
      120
    ),
    category: normalizeSemanticText(product?.category || "", 120),
    handle: normalizeSemanticText(product?.handle || "", 160),
  };
}

function buildSemanticHash(product) {
  const snapshot = buildSemanticSnapshot(product);
  const semanticHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot), "utf8")
    .digest("hex");

  return { snapshot, semanticHash };
}

async function main() {
  let query = dbAdmin.collection(`products/${STORE_ID}/items`);

  if (LIMIT && Number.isFinite(LIMIT) && LIMIT > 0) {
    query = query.limit(LIMIT);
  }

  const snap = await query.get();
  if (snap.empty) {
    console.log(`No products found for ${STORE_ID}`);
    return;
  }

  let scanned = 0;
  let eligible = 0;
  let seeded = 0;
  let skippedNoKb = 0;
  let skippedAlreadySeeded = 0;

  let batch = dbAdmin.batch();
  let batchOps = 0;

  for (const doc of snap.docs) {
    scanned++;

    const p = doc.data() || {};
    const productId = doc.id;

    const kbLastEnrichedAt = p.kbLastEnrichedAt || null;
    //const alreadySeeded =
    //  String(p.semanticHash || "").trim() &&
    //  String(p.indexedFromSemanticHash || "").trim();

    // Only seed products that have historical enrichment evidence.
    if (!kbLastEnrichedAt) {
      skippedNoKb++;
      continue;
    }

    // Keep this conservative: don't overwrite already seeded records.
    //if (alreadySeeded) {
    //  skippedAlreadySeeded++;
    //  continue;
    //}

    eligible++;

    const { semanticHash } = buildSemanticHash(p);

    const patch = {
      semanticHash,
      semanticSourceVersion: SEMANTIC_SOURCE_VERSION,
      lastSemanticSyncAt: FieldValue.serverTimestamp(),
      indexedFromSemanticHash: semanticHash,
      lastIndexedAt: kbLastEnrichedAt || FieldValue.serverTimestamp(),
      indexedFromShopifyUpdatedAt: p.shopifyUpdatedAt || null,
    };

    if (DRY_RUN) {
      console.log(
        JSON.stringify(
          {
            productId,
            name: p.name || p.title || "",
            wouldSeed: true,
            patch,
          },
          null,
          2
        )
      );
      seeded++;
      continue;
    }

    batch.set(doc.ref, patch, { merge: true });
    batchOps++;
    seeded++;

    if (batchOps >= 400) {
      await batch.commit();
      batch = dbAdmin.batch();
      batchOps = 0;
    }
  }

  if (!DRY_RUN && batchOps > 0) {
    await batch.commit();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        storeId: STORE_ID,
        dryRun: DRY_RUN,
        scanned,
        eligible,
        seeded,
        skippedNoKb,
        skippedAlreadySeeded,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});