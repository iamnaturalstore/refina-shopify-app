// refina-backend/bff/lib/firestore.js — self-contained ESM Firebase Admin init
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";

function loadFirebaseCred() {
  const b64 = process.env.FIREBASE_SERVICE_KEY_BASE64; // optional
  const json = process.env.FIREBASE_SERVICE_KEY;       // optional (minified JSON)
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS; // recommended

  if (b64) return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (json) return JSON.parse(json);

  if (credPath) {
    const absolute = credPath.startsWith(".") ? path.join(process.cwd(), credPath) : credPath;
    if (!fs.existsSync(absolute)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS not found at: ${absolute}`);
    }
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  }

  throw new Error(
    "No Firebase credentials found. Set GOOGLE_APPLICATION_CREDENTIALS (absolute path), " +
    "or FIREBASE_SERVICE_KEY / FIREBASE_SERVICE_KEY_BASE64."
  );
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(loadFirebaseCred()) });
}

export const db = getFirestore();
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
