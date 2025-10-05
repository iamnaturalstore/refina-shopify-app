// Unified Firestore shim for routes.
// refina-backend/lib/firestore.js
// Re-export everything from the single initializer to avoid double-inits.

export {
  db,
  dbAdmin,
  FieldValue,
  nowTs,
  getDocSafe,
  setDocSafe,
  projectId,
} from "../bff/lib/firestore.js";
