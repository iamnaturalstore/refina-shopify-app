// app/lib/firebase.server.js
import admin from 'firebase-admin'

let app

if (!admin.apps.length) {
  app = admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_KEY)
    ),
  })
} else {
  app = admin.app()
}

export const adminDB = admin.firestore()

// Optional helper: fetch store settings from Firestore
export async function getStoreSettings(storeId) {
  const doc = await adminDB.collection('storeSettings').doc(storeId).get()
  return doc.exists ? doc.data() : null
}
