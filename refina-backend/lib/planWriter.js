// refina-backend/lib/planWriter.js
import admin from "firebase-admin";

export function shopToStoreId(shop) {
  if (!shop) throw new Error("Missing shop");
  return String(shop).split(".")[0];
}

/** Write/merge billing state to plans/{storeId} */
export async function writePlan(shopOrStoreId, patch) {
  const storeId = (shopOrStoreId || "").includes(".myshopify.com")
    ? shopToStoreId(shopOrStoreId)
    : shopOrStoreId;

  const db = admin.firestore();
  await db
    .collection("plans")
    .doc(storeId)
    .set(
      {
        ...patch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return storeId;
}
