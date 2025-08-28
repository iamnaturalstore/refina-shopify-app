// refina-backend/lib/planWriter.js
import admin from "firebase-admin";

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) throw new Error("Missing shop");
  // strip protocol + path if URL is passed
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const h = (u.hostname || "").toLowerCase();
      if (!h.endsWith(".myshopify.com")) throw new Error("Invalid shop domain");
      return h;
    }
  } catch {
    /* ignore */
  }
  if (s.endsWith(".myshopify.com")) return s;
  if (s.includes(".")) throw new Error("Invalid shop domain");
  return `${s}.myshopify.com`;
}

/** Write/merge billing state to plans/{<shop>.myshopify.com} */
export async function writePlan(shopOrStoreId, patch) {
  const shopFull = toMyshopifyDomain(shopOrStoreId);

  const db = admin.firestore();
  await db
    .collection("plans")
    .doc(shopFull)
    .set(
      {
        ...patch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return shopFull; // return canonical key
}
