// refina-backend/bff/lib/firestore.js
// Unified Firebase Admin initializer (ESM). One app, one project.

import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";
import os from "os";

// ───────── helpers
function resolveAbsolute(p) {
  if (!p) return "";
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith(".")) return path.join(process.cwd(), p);
  return p;
}
function loadFirebaseCred() {
  const b64 = process.env.FIREBASE_SERVICE_KEY_BASE64;
  const json = process.env.FIREBASE_SERVICE_KEY;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (b64) return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (json) return JSON.parse(json);
  if (credPath) {
    const abs = resolveAbsolute(credPath);
    if (!fs.existsSync(abs)) throw new Error(`GOOGLE_APPLICATION_CREDENTIALS not found at: ${abs}`);
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  }
  throw new Error("No Firebase credentials found (set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_KEY[_BASE64]).");
}

// ───────── single Admin app
let app;
let projectId = "(unknown-project)";
if (!admin.apps.length) {
  const cred = loadFirebaseCred();
  projectId = cred.project_id || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "(unknown-project)";
  app = admin.initializeApp({
    credential: admin.credential.cert(cred),
    projectId,
  });
  console.log(`[Firebase] Admin initialized for project ${projectId}`);
} else {
  app = admin.app();
}

// ───────── Firestore handle(s)
export const db = getFirestore(app);
db.settings?.({ ignoreUndefinedProperties: true });

// Alias "admin" face to same app (so nothing double-inits elsewhere)
export const dbAdmin = db;
export { FieldValue };
export function nowTs() {
  return FieldValue.serverTimestamp();
}
export { projectId };

// convenience
export async function getDocSafe(ref) {
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}
export async function setDocSafe(ref, data) {
  await ref.set(data, { merge: true });
}
