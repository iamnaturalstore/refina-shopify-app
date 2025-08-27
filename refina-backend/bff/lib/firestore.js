// refina-backend/bff/lib/firestore.js — self-contained ESM Firebase Admin init
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

/**
 * Resolve a possibly-relative or home-prefixed path to absolute.
 * - "./x.json" or "secure/x.json" → resolved against process.cwd()
 * - "~/x.json" → resolved against user home
 * - "/abs/x.json" → returned as-is
 */
function resolveAbsolute(p) {
  if (!p) return "";
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith(".")) return path.join(process.cwd(), p);
  return p;
}

/**
 * Load Firebase service account credentials from one of:
 * 1) FIREBASE_SERVICE_KEY_BASE64 (base64-encoded JSON)
 * 2) FIREBASE_SERVICE_KEY (minified JSON string)
 * 3) GOOGLE_APPLICATION_CREDENTIALS (absolute/relative path, "~" supported)
 */
function loadFirebaseCred() {
  const b64 = process.env.FIREBASE_SERVICE_KEY_BASE64; // optional
  const json = process.env.FIREBASE_SERVICE_KEY;       // optional (minified JSON)
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS; // recommended

  if (b64) {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  }
  if (json) {
    return JSON.parse(json);
  }

  if (credPath) {
    const absolute = resolveAbsolute(credPath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS not found at: ${absolute}`);
    }
    const raw = fs.readFileSync(absolute, "utf8");
    return JSON.parse(raw);
  }

  throw new Error(
    "No Firebase credentials found. Set GOOGLE_APPLICATION_CREDENTIALS (absolute or ~/… path), " +
      "or FIREBASE_SERVICE_KEY / FIREBASE_SERVICE_KEY_BASE64."
  );
}

// Single admin app init (safe under hot restarts)
let app;
if (!admin.apps.length) {
  const cred = loadFirebaseCred();
  app = admin.initializeApp({
    credential: admin.credential.cert(cred),
    // Ensure the project is set explicitly when present in the key
    projectId: cred.project_id || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT,
  });
  // Minimal, useful log without leaking file paths or secrets
  const pj = cred.project_id || "(unknown-project)";
  console.log(`[Firebase] Admin initialized for project ${pj}`);
} else {
  app = admin.app();
}

// Firestore (ignoreUndefinedProperties avoids accidental write errors)
export const db = getFirestore(app);
db.settings?.({ ignoreUndefinedProperties: true }); // no-op if not supported

// Safe helpers
export async function getDocSafe(ref) {
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}
export async function setDocSafe(ref, data) {
  await ref.set(data, { merge: true });
}
export function nowTs() {
  return FieldValue.serverTimestamp();
}
