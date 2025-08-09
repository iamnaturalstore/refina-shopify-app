import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

export async function fetchStoreSettings(storeId = "demo") {
  if (!storeId || storeId === "undefined") return {
    plan: "free",
    category: "Beauty",
    tone: "helpful",
  };

  try {
    const ref = doc(db, "storeSettings", storeId); // ✅ must include storeId
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data();
    } else {
      return {
        plan: "free",
        category: "Beauty",
        tone: "helpful",
      };
    }
  } catch (error) {
    console.error("❌ Failed to fetch store settings:", error);
    return {
      plan: "free",
      category: "Beauty",
      tone: "helpful",
    };
  }
}
