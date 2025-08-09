import React, { useEffect, useState } from "react"
import { db } from "../firebase"
import { doc, getDoc } from "firebase/firestore"

export default function AdminDashboard({ storeId }) {
  const [plan, setPlan] = useState("loading")
  const [upgrading, setUpgrading] = useState(false)

  useEffect(() => {
    const fetchPlan = async () => {
      try {
        const docRef = doc(db, "billing", storeId)
        const docSnap = await getDoc(docRef)
        if (docSnap.exists()) {
          const data = docSnap.data()
          setPlan(data.plan || "free")
        } else {
          setPlan("free")
        }
      } catch (err) {
        console.error("❌ Failed to fetch plan:", err)
        setPlan("error")
      }
    }

    fetchPlan()
  }, [storeId])

  const handleUpgrade = async () => {
    setUpgrading(true)
    try {
      const res = await fetch("/api/billing/upgrade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ storeId }),
      })

      const data = await res.json()
      if (data.confirmationUrl) {
        window.top.location.href = data.confirmationUrl
      } else {
        console.error("No confirmation URL returned.")
      }
    } catch (err) {
      console.error("Error upgrading plan:", err)
    } finally {
      setUpgrading(false)
    }
  }

  return (
    <div style={{ padding: "2rem" }}>
      <h2>Refina Admin Settings</h2>
      <p><strong>Plan:</strong> {plan}</p>

      {plan === "free" && (
        <button onClick={handleUpgrade} disabled={upgrading}>
          {upgrading ? "Redirecting..." : "Upgrade to Pro+"}
        </button>
      )}
    </div>
  )
}
