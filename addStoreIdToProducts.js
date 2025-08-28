// addStoreIdToProducts.js
// One-time migration helper: copy flat products → products/<shop>/items/* and stamp full-domain storeId.
// Usage:
//   FIREBASE_SERVICE_KEY='{"type":"service_account",...}' \
//   SHOP='refina-demo.myshopify.com' \
//   [DELETE_FLAT_AFTER=true] \
//   node addStoreIdToProducts.js
//
// NOTE: Prefer running /api/admin/backfill-products when possible. Use this only if you must migrate flat docs.

import admin from "firebase-admin";

if (!admin.apps.length) {
  const svc = process.env.FIREBASE_SERVICE_KEY;
  if (!svc) throw new Error("FIREBASE_SERVICE_KEY missing");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
}
const db = admin.firestore();

const shopEnv = String(process.env.SHOP || "").toLowerCase().trim();
if (!shopEnv.endsWith(".myshopify.com")) {
  throw new Error('SHOP must be a full "<shop>.myshopify.com" domain');
}
const SHOP = shopEnv;
const DELETE_FLAT_AFTER = /^true$/i.test(String(process.env.DELETE_FLAT_AFTER || ""));

(async () => {
  console.log(`🔎 Migrating flat products for ${SHOP} → products/${SHOP}/items/*`);
  const flatSnap = await db.collection("products").where("storeId", "in", [SHOP, SHOP.replace(/\.myshopify\.com$/i, "")]).get();

  if (flatSnap.empty) {
    console.log("No flat products found for this shop.");
    process.exit(0);
  }

  let migrated = 0;
  const batchSize = 400;
  let batch = db.batch();
  let inBatch = 0;

  for (const d of flatSnap.docs) {
    const data = d.data() || {};
    const itemRef = db.doc(`products/${SHOP}/items/${d.id}`);
    batch.set(itemRef, { ...data, storeId: SHOP }, { merge: true });
    inBatch += 1;
    migrated += 1;

    if (DELETE_FLAT_AFTER) {
      batch.delete(d.ref);
      inBatch += 1;
    }

    if (inBatch >= batchSize) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
      console.log(`…committed ${migrated} so far`);
    }
  }
  if (inBatch > 0) await batch.commit();

  console.log(`✅ Migrated ${migrated} products to products/${SHOP}/items/*${DELETE_FLAT_AFTER ? " and deleted flat docs" : ""}`);
  process.exit(0);
})().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
