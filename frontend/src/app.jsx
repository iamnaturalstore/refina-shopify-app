import React from "react"
import { Routes, Route, HashRouter } from "react-router-dom"
import CustomerRecommender from "./components/CustomerRecommender.jsx";
import AdminDashboard from "./components/AdminDashboard"
import { AppProvider as PolarisProvider } from "@shopify/polaris"
import "@shopify/polaris/build/esm/styles.css"

function RouterWithStore({ storeId }) {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<CustomerRecommender storeId={storeId} />} />
        <Route path="/admin" element={<AdminDashboard storeId={storeId} />} />
      </Routes>
    </HashRouter>
  )
}

function App() {
  const [storeId, setStoreId] = React.useState("")

  React.useEffect(() => {
    async function fetchStore() {
      try {
        const res = await fetch("/api/session")
        const json = await res.json()
        setStoreId(json.storeId)
      } catch (err) {
        console.warn("⚠️ Falling back to query param storeId")
        const fallbackId =
          new URLSearchParams(window.location.search).get("storeId") || "default-store"
        setStoreId(fallbackId)
      }
    }
    fetchStore()
  }, [])

  return (
    <PolarisProvider>
      <RouterWithStore storeId={storeId} />
    </PolarisProvider>
  )
}

export default App
