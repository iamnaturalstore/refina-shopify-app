import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

const shop = process.argv[2];
const level = process.argv[3] || "pro";

if (!shop) {
  console.error("Usage: node setPlan.js <shop.myshopify.com> [level]");
  process.exit(1);
}

await dbAdmin.collection("plans").doc(shop).set(
  { level, status: "active", updatedAt: FieldValue.serverTimestamp() },
  { merge: true }
);

console.log(`✅ set plans/${shop} -> level=${level}, status=active`);
process.exit(0);
