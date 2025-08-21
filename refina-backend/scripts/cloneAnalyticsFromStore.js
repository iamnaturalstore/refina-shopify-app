// node scripts/cloneAnalyticsFromStore.js iamnaturalstore refina-demo.myshopify.com 200
import { dbAdmin } from "../firebaseAdmin.js";

const [,, SRC, DEST, LIMIT = "200"] = process.argv;
if (!SRC || !DEST) {
  console.error("Usage: node scripts/cloneAnalyticsFromStore.js <SRC_STOREID> <DEST_STOREID> [LIMIT]");
  process.exit(1);
}

// Adjust this if your routes use a different collection name.
// Based on your /logs payload shape, this is the most likely one.
const COLLECTION = "analyticsLogs";

(async () => {
  const snap = await dbAdmin
    .collection(COLLECTION)
    .where("storeId", "==", SRC)
    .limit(Number(LIMIT))
    .get();

  if (snap.empty) {
    console.warn(`No docs found in ${COLLECTION} for storeId=${SRC}. Nothing cloned.`);
    process.exit(0);
  }

  console.log(`Cloning ${snap.size} docs from ${SRC} → ${DEST} (${COLLECTION})`);
  let i = 0;
  for (const doc of snap.docs) {
    const data = { ...doc.data(), storeId: DEST };
    // Optional: bump timestamps slightly so they show as recent
    if (data.createdAt && typeof data.createdAt === "string") {
      const d = new Date(data.createdAt);
      data.createdAt = new Date(d.getTime() + 1000 * (i + 1)).toISOString();
    }
    await dbAdmin.collection(COLLECTION).add(data);
    i++;
  }
  console.log(`Done. Cloned ${i} docs.`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
