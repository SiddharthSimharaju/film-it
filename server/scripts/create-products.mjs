// Creates Filmroom's three Dodo products in whichever Dodo account/mode the API key belongs to, and prints the wrangler.jsonc [vars] to use.
// Test and live accounts have SEPARATE products, so run this once per mode:
//   DODO_API_KEY=... DODO_ENV=test_mode node scripts/create-products.mjs
//   DODO_API_KEY=... DODO_ENV=live_mode node scripts/create-products.mjs
// The key needs the products:write permission. Prices are in paise and include GST, matching PLANS in ../index.html.
const key = process.env.DODO_API_KEY, env = process.env.DODO_ENV;
if (!key || !['test_mode', 'live_mode'].includes(env)) { console.error('Set DODO_API_KEY and DODO_ENV=test_mode|live_mode'); process.exit(1); }
const base = env === 'live_mode' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`); return JSON.parse(t);
};
const rec = (price, every) => ({ type: 'recurring_price', currency: 'INR', price, tax_inclusive: true, payment_frequency_count: 1, payment_frequency_interval: every, subscription_period_count: 10, subscription_period_interval: 'Year' });
const WANT = [
  ['monthly',  'Filmroom Pro Monthly', 'saas', 'All 14 film looks, original-size export, all formats, unlimited downloads.', rec(14900, 'Month')],
  ['yearly',   'Filmroom Pro Yearly',  'saas', 'All 14 film looks, up to 100 MP, original-size export, all formats.',        rec(149900, 'Year')],
  ['lifetime', 'Filmroom Lifetime',    'digital_products', 'Pay once, use Filmroom Pro forever. Largest files (150 MB / 120 MP).', { type: 'one_time_price', currency: 'INR', price: 349900, tax_inclusive: true }],
];
const existing = {};
for (let page = 0; ; page++) {                                  // reuse a product created by an earlier run instead of duplicating it
  const r = await call('GET', `/products?page_size=100&page_number=${page}`); const items = r.items || r;
  for (const p of items) if (p.metadata && p.metadata.plan && !existing[p.metadata.plan]) existing[p.metadata.plan] = p.product_id;
  if (items.length < 100) break;
}
const ids = {};
for (const [plan, name, tax_category, description, price] of WANT) {
  ids[plan] = existing[plan] || (await call('POST', '/products', { name, description, tax_category, price, metadata: { plan } })).product_id;
  console.log(`${existing[plan] ? 'found  ' : 'created'} ${plan.padEnd(8)} ${ids[plan]}`);
}
console.log(`\nPut these in server/wrangler.jsonc under "vars", and set "DODO_ENV": "${env}":\n`);
console.log(`    "PRODUCT_MONTHLY": "${ids.monthly}",\n    "PRODUCT_YEARLY": "${ids.yearly}",\n    "PRODUCT_LIFETIME": "${ids.lifetime}"`);
