// Dropship vendor free-shipping thresholds (AUD, inc. GST).
// Catch-all covers all IANS own-stock brands (Kahina, OSEA, Vitruvi, etc.)
// threshold: 0 = always free regardless of cart value.
const DEFAULT_CONFIG = {
  rules: [
    { vendor: "Beauty in Us",                threshold: 100 },
    { vendor: "CACTUS Melbourne",            threshold: 100 },
    { vendor: "Clémence Organics",           threshold: 100 },
    { vendor: "Dianne Caine Australia",      threshold: 100 },
    { vendor: "Edible Beauty Australia",     threshold:  50 },
    { vendor: "Euclove",                     threshold:  85 },
    { vendor: "Forest Super Foods",          threshold: 100 },
    { vendor: "House of Immortelle",         threshold:  90 },
    { vendor: "Ilo Wellness",               threshold: 100 },
    { vendor: "Jivana",                      threshold: 100 },
    { vendor: "Journey",                     threshold:  50 },
    { vendor: "Kylies Professional",         threshold: 100 },
    { vendor: "Mammae The Embodied Mother",  threshold: 150 },
    { vendor: "Merindah Botanicals",         threshold: 100 },
    { vendor: "Mokosh",                      threshold: 100 },
    { vendor: "Mud Organics",               threshold: 100 },
    { vendor: "Nada Organics",              threshold: 100 },
    { vendor: "Papermoon",                   threshold:  40 },
    { vendor: "Sleep On Silk",               threshold:   0 },
    { vendor: "Wildcrafted Organics",        threshold: 100 },
    { vendor: "Wildfire",                    threshold:  85 },
  ],
  catchAll: { threshold: 150 },
};

export function run(input) {
  let config = DEFAULT_CONFIG;
  const metafieldValue = input.discountNode?.metafield?.value;
  if (metafieldValue) {
    try {
      const parsed = JSON.parse(metafieldValue);
      if (parsed.rules || parsed.catchAll) config = parsed;
    } catch (_) {
      // malformed metafield — use defaults
    }
  }

  const rules = config.rules ?? [];
  const catchAll = config.catchAll ?? null;
  const discounts = [];

  for (const group of (input.cart.deliveryGroups ?? [])) {
    let groupSubtotal = 0;
    let groupVendor = null;

    for (const line of (group.cartLines ?? [])) {
      groupSubtotal += parseFloat(line.cost.subtotalAmount.amount);
      if (groupVendor === null && line.merchandise.__typename === "ProductVariant") {
        groupVendor = line.merchandise.product.vendor;
      }
    }

    // Find matching named vendor rule, then fall back to catch-all
    const rule = rules.find((r) => r.vendor === groupVendor) ?? catchAll;
    if (!rule || groupSubtotal < rule.threshold) continue;

    for (const option of (group.deliveryOptions ?? [])) {
      if (/express/i.test(option.title)) continue;
      discounts.push({
        value: { percentage: { value: "100.0" } },
        targets: [{ deliveryOption: { handle: option.handle } }],
      });
    }
  }

  return { discounts };
}
