// server/api/confirm-billing.js
import { json, redirect } from "@remix-run/node"
import { getSession } from "@shopify/shopify-app-remix/server"
import { setStorePlan } from "../../lib/firebase.server"

export const loader = async ({ request }) => {
  const session = await getSession(request)
  const shop = session.shop
  const client = new session.api.rest.Client({ session })

  try {
    const res = await client.get({
      path: "recurring_application_charges",
    })

    // Find the latest accepted charge
    const acceptedCharge = res.body.recurring_application_charges.find(
      (charge) => charge.status === "active"
    )

    if (!acceptedCharge) {
      console.warn("⚠️ No active charge found for", shop)
      return redirect("/?billing=cancelled")
    }

    // Update plan in Firestore
    await setStorePlan(shop, "pro")

    return redirect("/?billing=success")
  } catch (error) {
    console.error("❌ Error confirming billing", error)
    return json({ error: "Failed to confirm billing" }, { status: 500 })
  }
}
