// Unified Firestore shim for routes.
// Re-export EVERYTHING from the single initializer to avoid double-inits.
export {
  db,
  dbAdmin,
  getDocSafe,
  setDocSafe,
  nowTs,
  FieldValue,
  projectId,
} from "../bff/lib/firestore.js";
