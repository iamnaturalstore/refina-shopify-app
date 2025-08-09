// server/api/upgrade-plan.js
import { json } from "@remix-run/node"
import { getSession } from "@shopify/shopify-app-remix/server"
import { setStorePlan } from "../../lib/firebase.server"

const PLAN_NAME = "Refina Pro+"
const RETURN_URL = "https://your-app-url.com/api/confirm-billing" // 🔁 Update later if needed
const TEST_MODE = true // 🔁 Set to false in production

export const loader = async ({ request }) => {
  const session = await getSession(request)
  const shop = session.shop
  const client = new session.api.rest.Client({ session })

  try {
    const res = await client.post({
      path: "recurring_application_charges",
      data: {
        recurring_application_charge: {
          name: PLAN_NAME,
          price: 9.99,
          return_url: RETURN_URL,
          test: TEST_MODE,
        },
      },
      type: "application/json",
    })

    const confirmationUrl = res.body.recurring_application_charge.confirmation_url
    return json({ url: confirmationUrl })
  } catch (error) {
    console.error("❌ Billing upgrade failed", error)
    return json({ error: "Failed to initiate billing." }, { status: 500 })
  }
}
