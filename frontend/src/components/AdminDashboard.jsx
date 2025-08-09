import React, { useEffect, useState } from "react"
import { db } from "../firebase"
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore"

function AdminDashboard({ storeId }) {
  const [logs, setLogs] = useState([])
  const [plan, setPlan] = useState("")
  const [style, setStyle] = useState({
    primaryColor: "#0070f3",
    font: "sans-serif",
    borderRadius: "16px",
    theme: "light",
  })

  useEffect(() => {
    if (!storeId) return

    const fetchLogs = async () => {
      try {
        const logsRef = collection(db, "conversations", storeId, "logs")
        const snapshot = await getDocs(logsRef)
        const parsedLogs = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
        setLogs(parsedLogs)
      } catch (err) {
        console.error("❌ Failed to fetch logs:", err.message)
      }
    }

    const fetchPlanAndStyle = async () => {
      try {
        const docRef = doc(db, "storeSettings", storeId)
        const docSnap = await getDoc(docRef)
        if (docSnap.exists()) {
          const data = docSnap.data()
          setPlan(data.plan || "free")
          setStyle({
            ...style,
            ...data.style,
          })
        } else {
          setPlan("free")
        }
      } catch (err) {
        console.error("❌ Failed to fetch settings:", err.message)
        setPlan("free")
      }
    }

    fetchLogs()
    fetchPlanAndStyle()
  }, [storeId])

  const handleUpgrade = () => {
    const billingUrl = `https://refina.ngrok.app/api/billing/start?shop=${storeId}`
    window.location.href = billingUrl
  }

  const handleStyleChange = (e) => {
    const { name, value } = e.target
    setStyle((prev) => ({ ...prev, [name]: value }))
  }

  const saveStyleSettings = async () => {
    try {
      const settingsRef = doc(db, "storeSettings", storeId)
      await updateDoc(settingsRef, {
        style: style,
      })
      alert("✅ Styling settings saved!")
    } catch (err) {
      console.error("❌ Failed to save style settings:", err.message)
      alert("Failed to save settings")
    }
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h2>🛠️ Refina Admin Dashboard</h2>
      <p>
        <strong>Current Plan:</strong> {plan}
      </p>

      {plan !== "pro" ? (
        <div style={upgradeBox}>
          <p>
            <strong>Upgrade to Pro+</strong> to unlock full Gemini
            recommendations, analytics, and styling tools.
          </p>
          <button onClick={handleUpgrade} style={upgradeButton}>
            Upgrade to Pro+
          </button>
        </div>
      ) : (
        <div style={successBox}>
          <strong>🎉 Welcome to Pro+!</strong> You now have access to enhanced
          analytics, AI tone controls, and styling tools.
        </div>
      )}

      <h3 style={{ marginTop: "2rem" }}>📊 Customer Logs</h3>
      {logs.length === 0 ? (
        <p>No logs found yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
          <thead>
            <tr style={{ backgroundColor: "#f3f3f3" }}>
              <th style={cellStyle}>Concern</th>
              <th style={cellStyle}>Matched Products</th>
              <th style={cellStyle}>Gemini Response</th>
              <th style={cellStyle}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td style={cellStyle}>{log.concern}</td>
                <td style={cellStyle}>{log.matchedProducts?.join(", ")}</td>
                <td style={{ ...cellStyle, maxWidth: "300px" }}>
                  {log.aiResponse?.slice(0, 120)}...
                </td>
                <td style={cellStyle}>
                  {log.timestamp?.toDate().toLocaleString() || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {plan === "pro" && (
        <>
          <h3 style={{ marginTop: "3rem" }}>🎨 Styling Controls</h3>
          <div style={{ marginBottom: "1rem" }}>
            <label>Primary Color:</label><br />
            <input type="color" name="primaryColor" value={style.primaryColor} onChange={handleStyleChange} />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label>Font Family:</label><br />
            <select name="font" value={style.font} onChange={handleStyleChange}>
              <option value="sans-serif">Sans Serif</option>
              <option value="serif">Serif</option>
              <option value="monospace">Monospace</option>
            </select>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label>Border Radius:</label><br />
            <input
              type="text"
              name="borderRadius"
              value={style.borderRadius}
              onChange={handleStyleChange}
              placeholder="e.g. 8px, 12px"
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label>Theme:</label><br />
            <select name="theme" value={style.theme} onChange={handleStyleChange}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <button onClick={saveStyleSettings} style={saveButton}>
            Save Styling Settings
          </button>
        </>
      )}
    </div>
  )
}

const upgradeBox = {
  margin: "1rem 0",
  padding: "1rem",
  background: "#f9f9f9",
  border: "1px solid #ddd",
  borderRadius: "8px",
}

const upgradeButton = {
  marginTop: "0.5rem",
  padding: "0.5rem 1.25rem",
  backgroundColor: "#0070f3",
  color: "white",
  border: "none",
  borderRadius: "5px",
  cursor: "pointer",
}

const successBox = {
  padding: "1rem",
  background: "#e6ffed",
  border: "1px solid #b7eb8f",
  borderRadius: "8px",
  margin: "1rem 0",
}

const saveButton = {
  marginTop: "1rem",
  padding: "0.5rem 1.25rem",
  backgroundColor: "#28a745",
  color: "white",
  border: "none",
  borderRadius: "5px",
  cursor: "pointer",
}

const cellStyle = {
  padding: "0.5rem",
  border: "1px solid #ddd",
  verticalAlign: "top",
}

export default AdminDashboard
