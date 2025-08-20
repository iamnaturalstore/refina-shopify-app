// refina-backend/scripts/migrateStoreIdDeep.js
// Generic, safe migration: rewrites storeId fields and renames docs keyed by storeId.
// Usage:
//   node refina-backend/scripts/migrateStoreIdDeep.js iamnaturalstore refina-demo.myshopify.com [--dry]
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const saPath = path.join(__dirname, "..", "secure", "service-account.json");

if (!admin.apps.length) {
  if (!fs.existsSync(saPath)) {
    console.error("❌ No service-account file:", saPath);
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

const [fromId, toId, maybeDry] = process.argv.slice(2);
const DRY = maybeDry === "--dry";

if (!fromId || !toId) {
  console.error("Usage: node scripts/migrateStoreIdDeep.js <fromId> <toId> [--dry]");
  process.exit(1);
}

console.log(`🔁 Migrating storeId "${fromId}" → "${toId}" ${DRY ? "(DRY RUN)" : ""}`);

async function cloneDocWithSubcollections(oldRef, newRef) {
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) return 0;
  const data = oldSnap.data();

  if (!DRY) await newRef.set(data, { merge: true });

  // Copy subcollections (if any)
  const subs = await oldRef.listCollections();
  let count = 1;
  for (const sub of subs) {
    const subDocs = await sub.get();
    for (const d of subDocs.docs) {
      const dest = newRef.collection(sub.id).doc(d.id);
      if (!DRY) await dest.set(d.data(), { merge: true });
      count++;
    }
  }
  // Delete old AFTER clone
  if (!DRY) await oldRef.delete();
  return count;
}

async function rewriteStoreIdFieldEverywhere(col) {
  let total = 0;
  while (true) {
    const snap = await col.where("storeId", "==", fromId).limit(400).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach(doc => batch.update(doc.ref, { storeId: toId }));
    if (!DRY) await batch.commit();

    total += snap.size;
    console.log(`  • ${col.id}: updated ${total} docs (storeId field)`);
  }
}

async function renameDocIfMatches(col) {
  const oldRef = col.doc(fromId);
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) return 0;

  const newRef = col.doc(toId);
  console.log(`  • ${col.id}: renaming docId "${fromId}" → "${toId}"`);
  return await cloneDocWithSubcollections(oldRef, newRef);
}

async function main() {
  const rootCols = await db.listCollections();
  let changed = 0;

  for (const col of rootCols) {
    // 1) Update storeId field matches
    await rewriteStoreIdFieldEverywhere(col);

    // 2) If the doc id equals the store id, rename it (and move subcollections)
    const moved = await renameDocIfMatches(col);
    if (moved) changed += moved;
  }

  console.log(`✅ Migration complete. ${DRY ? "(dry run)" : ""} Moved/copied ~${changed} docs.`);
}

main().catch(e => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
