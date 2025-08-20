import admin from "firebase-admin";
import fs from "fs";
import path from "path";

function loadFirebaseCred() {
  const b64 = process.env.FIREBASE_SERVICE_KEY_BASE64;      // optional
  const json = process.env.FIREBASE_SERVICE_KEY;            // optional (minified JSON)
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS; // recommended

  if (b64) return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (json) return JSON.parse(json);

  if (credPath) {
  const absolute = credPath.startsWith(".")
    ? path.join(process.cwd(), credPath)
    : credPath;
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS not found at: ${absolute}. ` +
      `Tip: use an absolute path if you run scripts from a different directory.`
    );
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(loadFirebaseCred()) });
}

export const db = admin.firestore();
export default admin;
