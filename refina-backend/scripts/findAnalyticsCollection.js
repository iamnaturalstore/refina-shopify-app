// node refina-backend/scripts/findAnalyticsCollection.js iamnaturalstore
import { dbAdmin } from "../firebaseAdmin.js";

const [,, STORE] = process.argv;
if (!STORE) {
  console.error("Usage: node scripts/findAnalyticsCollection.js <STOREID>");
  process.exit(1);
}

(async () => {
  const cols = await dbAdmin.listCollections();
  if (!cols?.length) {
    console.log("No root collections found.");
    process.exit(0);
  }
  console.log(`Scanning ${cols.length} collections for storeId="${STORE}" ...`);

  let matches = [];
  for (const col of cols) {
    try {
      const snap = await col.where("storeId", "==", STORE).limit(5).get();
      if (!snap.empty) {
        const sample = snap.docs[0].data();
        matches.push({ name: col.id, count: snap.size, sample });
      }
    } catch (e) {
      // ignore collections that can't be queried like this
    }
  }

  if (!matches.length) {
    console.log("No collections contained docs with that storeId.");
  } else {
    for (const m of matches) {
      console.log("—");
      console.log("Collection:", m.name);
      console.log("Sample doc keys:", Object.keys(m.sample || {}));
      console.log("Sample doc:", JSON.stringify(m.sample, null, 2));
    }
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
