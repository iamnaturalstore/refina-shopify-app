import React, { useEffect, useState } from "react"
import { db } from "../firebase"
import { doc, getDoc, setDoc } from "firebase/firestore"

function AdminSettings({ storeId }) {
  const [category, setCategory] = useState("")
  const [status, setStatus] = useState("")

  useEffect(() => {
    if (!storeId) return

    const fetchCategory = async () => {
      try {
        const docRef = doc(db, "storeSettings", storeId)
        const docSnap = await getDoc(docRef)
        if (docSnap.exists()) {
          setCategory(docSnap.data().category || "")
        }
      } catch (error) {
        console.error("❌ Failed to fetch category:", error.message)
      }
    }

    fetchCategory()
  }, [storeId])

  const handleSave = async () => {
    try {
      const docRef = doc(db, "storeSettings", storeId)
      await setDoc(docRef, { category }, { merge: true })
      setStatus("✅ Saved successfully")
    } catch (error) {
      console.error("❌ Failed to save category:", error.message)
      setStatus("❌ Save failed")
    }

    setTimeout(() => setStatus(""), 3000)
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h2>⚙️ Admin Settings</h2>
      <label>
        Product Category for Recommendations:
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g. Beauty, Garden, Fishing Gear"
          style={{
            margin: "0.5rem 0",
            padding: "0.5rem",
            width: "100%",
            maxWidth: "400px",
          }}
        />
      </label>
      <br />
      <button
        onClick={handleSave}
        style={{
          padding: "0.5rem 1rem",
          background: "#000",
          color: "#fff",
          border: "none",
          cursor: "pointer",
        }}
      >
        Save
      </button>
      {status && <p>{status}</p>}
    </div>
  )
}

export default AdminSettings
