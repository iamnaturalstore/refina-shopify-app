// refina-backend/firebaseAdmin.js

/**
 * DEPRECATED: Pass-through to the unified Firestore initializer.
 * Do NOT call admin.initializeApp() here.
 */
export {
  db as dbAdmin,   // legacy alias
  FieldValue,
  nowTs,
  projectId,
} from "../bff/lib/firestore.js"; // adjust path to ../bff/... or ./bff/... as needed

import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tryInit() {
  if (admin.apps.length) return;

  // 1) GOOGLE_APPLICATION_CREDENTIALS wins (standard)
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && fs.existsSync(gac)) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(gac, "utf8"))) });
    console.log("🔐 Firebase: GOOGLE_APPLICATION_CREDENTIALS ->", gac);
    return;
  }

  // 2) Local file (repo-standard): refina-backend/secure/service-account.json
  const saPath = path.join(__dirname, "secure", "service-account.json");
  if (fs.existsSync(saPath)) {
    const json = JSON.parse(fs.readFileSync(saPath, "utf8"));
    admin.initializeApp({ credential: admin.credential.cert(json) });
    console.log("🔐 Firebase: service-account file ->", saPath);
    return;
  }

  // 3) FIREBASE_SERVICE_KEY (stringified JSON in env)
  if (process.env.FIREBASE_SERVICE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_KEY)),
    });
    console.log("🔐 Firebase: FIREBASE_SERVICE_KEY from env");
    return;
  }

  throw new Error("No Firebase credentials found. Set GOOGLE_APPLICATION_CREDENTIALS, provide secure/service-account.json, or FIREBASE_SERVICE_KEY.");
}

tryInit();

const dbAdmin = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

export { admin, dbAdmin, FieldValue };
