// What can be bought. The Dodo product ids live in wrangler.jsonc ([vars]) so test mode and live mode can differ.
export const PLANS = {
  monthly:  { name: 'Pro Monthly', recurring: true },
  yearly:   { name: 'Pro Yearly',  recurring: true },
  lifetime: { name: 'Lifetime',    recurring: false },
};

export const FREE_DAILY_DOWNLOADS = 10;   // keep in step with LIMITS.free.downloadsPerDay in index.html

export const productIds = env => ({ monthly: env.PRODUCT_MONTHLY, yearly: env.PRODUCT_YEARLY, lifetime: env.PRODUCT_LIFETIME });

export function planForProduct(env, productId) {
  if (typeof productId !== 'string' || !productId) return null;
  for (const [plan, id] of Object.entries(productIds(env))) if (id && id === productId) return plan;
  return null;
}
