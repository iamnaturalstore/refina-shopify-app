// refina-backend/bff/lib/paths.js
export const shopKey = (x) => String(x).toLowerCase().trim(); // already full domain by the time it’s called

export const pathStoreSettings = (shop) => `storeSettings/${shopKey(shop)}`;
export const pathPlans         = (shop) => `plans/${shopKey(shop)}`;
export const colProducts       = (shop) => `products/${shopKey(shop)}/items`;
export const colConcerns       = (shop) => `commonConcerns/${shopKey(shop)}/items`;
export const docMapping        = (shop, norm) => `mappings/${shopKey(shop)}/concernToProducts/${norm}`;
