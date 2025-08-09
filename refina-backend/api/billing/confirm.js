// /api/billing/confirm.js
import { authenticate } from "../middleware/shopifyAuth";
import { adminDB } from "../lib/firebase.server";

export default async function handler(req, res) {
  const session = await authenticate(req, res);
  const storeId = session.shop;

  // ✅ Update Firebase plan
  await adminDB.collection("storeSettings").doc(storeId).set({
    plan: "pro"
  }, { merge: true });

  return res.redirect("/admin"); // Send back to your Admin dashboard
}
