// refina-backend/routes/_mount-backfill.js
// Tiny helper you can import where you build your Express app.
// Usage (in your server bootstrap *after* `const app = express()`):
//   import mountBackfill from "./routes/_mount-backfill.js";
//   mountBackfill(app);

import backfillRouter from "./backfill.js";

export default function mountBackfill(app) {
  // Mount the new queue endpoint:
  // POST /api/backfill/queue?shop=<shop>.myshopify.com
  app.use("/api/backfill", backfillRouter);
}
