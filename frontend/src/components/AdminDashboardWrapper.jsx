import React from "react"
import { useSearchParams } from "react-router-dom"
import AdminDashboard from "./AdminDashboard"

function AdminDashboardWrapper() {
  const [searchParams] = useSearchParams()
  const storeId = searchParams.get("shop")

  if (!storeId) {
    return (
      <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h2>⚠️ Missing store ID</h2>
        <p>This page must be accessed from the embedded Shopify Admin.</p>
      </div>
    )
  }

  return <AdminDashboard storeId={storeId} />
}

export default AdminDashboardWrapper
