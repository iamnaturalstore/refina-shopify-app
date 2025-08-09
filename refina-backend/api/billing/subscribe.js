// /api/billing/subscribe.js
import { authenticate } from "../middleware/shopifyAuth";
import shopify from "../lib/shopify";

const plan = {
  name: "Refina Pro+ Plan",
  price: 9.99,
  interval: "EVERY_30_DAYS",
  trial_days: 7,
  return_url: process.env.HOST + "/api/billing/confirm"
};

export default async function handler(req, res) {
  const session = await authenticate(req, res);
  const client = new shopify.api.clients.Graphql({ session });

  const mutation = `
    mutation {
      appSubscriptionCreate(
        name: "${plan.name}",
        returnUrl: "${plan.return_url}",
        test: true,  // REMOVE "test: true" when you go live
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: ${plan.price}, currencyCode: USD },
              interval: ${plan.interval},
              trialDays: ${plan.trial_days}
            }
          }
        }]
      ) {
        confirmationUrl
        userErrors { field message }
      }
    }
  `;

  const response = await client.query({ data: mutation });
  const confirmationUrl = response.body.data.appSubscriptionCreate.confirmationUrl;

  return res.redirect(confirmationUrl);
}
