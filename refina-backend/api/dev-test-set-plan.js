// server/api/test-set-plan.js
import { json } from "@remix-run/node"
import { setStorePlan } from "../../lib/firebase.server"

export const loader = async () => {
  try {
    await setStorePlan("demo-store", "pro")
    return json({ status: "✅ plan set to pro for demo-store" })
  } catch (err) {
    console.error(err)
    return json({ error: "Failed to update plan" }, { status: 500 })
  }
}
