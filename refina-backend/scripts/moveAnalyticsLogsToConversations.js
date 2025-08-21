// Move analyticsLogs (flat) -> conversations/{store}/logs (nested)
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

function usage() {
  console.log("Usage: node refina-backend/scripts/moveAnalyticsLogsToConversations.js <storeDomain> [--delete-after]");
  console.log('Example: node refina-backend/scripts/moveAnalyticsLogsToConversations.js refina-demo.myshopify.com --delete-after');
}

const store = (process.argv[2] || "").trim();
const del = process.argv.includes("--delete-after");

if (!store || !/^[a-z0-9-]+\.myshopify\.com$/i.test(store)) {
  usage();
  process.exit(1);
}

(async () => {
  console.log(`🔁 Moving analyticsLogs -> conversations/${store}/logs`);
  const srcSnap = await dbAdmin.collection("analyticsLogs").where("storeId", "==", store).get();
  console.log(`Found ${srcSnap.size} docs to move.`);

  const destColl = dbAdmin.collection("conversations").doc(store).collection("logs");

  let moved = 0;
  for (const doc of srcSnap.docs) {
    const data = doc.data() || {};

    // Ensure a createdAt exists (prefer existing fields)
    let createdAt = data.createdAt || data.timestamp || null;
    if (!createdAt) createdAt = FieldValue.serverTimestamp();

    // Copy to nested path with same id
    await destColl.doc(doc.id).set(
      {
        ...data,
        storeId: store,
        createdAt,
      },
      { merge: true }
    );

    if (del) await doc.ref.delete();
    moved++;
    if (moved % 50 === 0) console.log(`  …moved ${moved}/${srcSnap.size}`);
  }

  console.log(`✅ Done. Moved ${moved}/${srcSnap.size} docs to conversations/${store}/logs`);
  if (del) console.log("🧹 Source docs deleted (--delete-after).");
  process.exit(0);
})().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
