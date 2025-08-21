// node refina-backend/scripts/seedDemoFromApi.js iamnaturalstore refina-demo.myshopify.com 200 http://localhost:3000
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

const [,, SRC, DEST, LIMIT = "200", BASE = "http://localhost:3000"] = process.argv;
if (!SRC || !DEST) {
  console.error("Usage: node refina-backend/scripts/seedDemoFromApi.js <SRC_STOREID> <DEST_STOREID> [LIMIT] [BASE_URL]");
  process.exit(1);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const url = `${BASE}/api/admin/analytics/logs?storeId=${encodeURIComponent(SRC)}&limit=${encodeURIComponent(LIMIT)}`;
  console.log("Pulling source logs:", url);

  const data = await fetchJSON(url);
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) {
    console.log("No rows to copy from source. Done.");
    return;
  }

  console.log(`Seeding ${rows.length} events -> ${DEST}`);
  const batchSize = 400; // comfortable Firestore batch write size
  let written = 0;

  for (const r of rows) {
    // Normalize minimal fields your overview/logs already use
    const doc = {
      storeId: DEST,
      type: r.type || r.event || "concern",
      concern: r.concern || r.label || null,
      product: r.product || r.productTitle || null,
      productIds: Array.isArray(r.productIds) ? r.productIds : [],
      summary: r.summary || "",
      createdAt: r.createdAt || r.ts || r.timestamp || new Date().toISOString(),
      ts: FieldValue.serverTimestamp(),
      plan: r.plan || "unknown",
    };
    await dbAdmin.collection("analyticsLogs").add(doc);
    written++;
    // optional tiny throttle; remove if you like
    if (written % 50 === 0) await new Promise(r => setTimeout(r, 10));
  }

  console.log(`Done. Wrote ${written} docs to analyticsLogs for ${DEST}`);
}

main().catch(e => { console.error(e); process.exit(1); });
