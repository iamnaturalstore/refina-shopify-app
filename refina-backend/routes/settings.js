import express from "express";
import { db } from "../firebaseAdmin.js";
import { getDocSafe, setDocSafe, nowTs } from "../lib/firestore.js";

const router = express.Router();

// A helper function to resolve the shop from the validated session
function resolveShop(res) {
  const { session } = res.locals.shopify;
  if (!session?.shop) {
    throw new Error("Could not resolve shop from session.");
  }
  return session.shop;
}

/**
 * GET /api/settings
 * Fetches the current settings for the store from Firestore.
 */
router.get("/", async (req, res) => {
  try {
    const shop = resolveShop(res);
    const ref = db.doc(`storeSettings/${shop}`);
    const snap = await getDocSafe(ref);

    if (!snap.exists) {
      // If no settings exist, create and return the default seed settings.
      const seed = {
        tone: (process.env.BFF_DEFAULT_TONE || "expert").toLowerCase(),
        category: process.env.BFF_DEFAULT_CATEGORY || "Generic",
        enabledPacks: (process.env.BFF_ENABLED_PACKS || "").split(",").map(s => s.trim()).filter(Boolean),
        domain: shop,
        createdAt: nowTs(),
        settingsVersion: 1,
      };
      await setDocSafe(ref, seed);
      return res.status(200).json({ settings: seed });
    }

    const data = snap.data() || {};
    // Ensure we always return a consistent shape
    const settings = {
      tone: data.tone || "expert",
      category: data.category || "Generic",
      domain: data.domain || shop,
      brandName: data.brandName || "", // Add any new fields here
      // Add other settings fields as you expand the UI
    };

    res.status(200).json({ settings });
  } catch (e) {
    console.error("GET /api/settings error:", e);
    res.status(500).json({ error: "Failed to fetch settings." });
  }
});

/**
 * POST /api/settings
 * Saves the updated settings for the store to Firestore.
 */
router.post("/", async (req, res) => {
  try {
    const shop = resolveShop(res);
    const { settings } = req.body;

    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "Invalid settings payload." });
    }

    const ref = db.doc(`storeSettings/${shop}`);

    // We use { merge: true } to avoid overwriting existing fields
    // that might not be included in the save payload.
    await setDocSafe(ref, { ...settings, updatedAt: nowTs() }, { merge: true });

    res.status(200).json({ ok: true, settings });
  } catch (e) {
    console.error("POST /api/settings error:", e);
    res.status(500).json({ error: "Failed to save settings." });
  }
});

export default router;
