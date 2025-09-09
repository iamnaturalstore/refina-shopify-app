// Unified Firestore shim for routes.
// Re-export BFF helpers (db, getDocSafe, setDocSafe, nowTs)
// AND admin-only exports (dbAdmin, FieldValue).

export { db, getDocSafe, setDocSafe, nowTs } from "../bff/lib/firestore.js";
export { dbAdmin, FieldValue } from "../firebaseAdmin.js";
