// Local end-to-end check of the whole purchase flow against `wrangler dev` with a MOCK Dodo (no network, no real money).
//   1. cd server && cp test/dev.vars.example .dev.vars && npx wrangler dev --port 8787     (in one terminal)
//   2. node test/e2e-local.mjs                                                              (in another)
import http from 'node:http';
import assert from 'node:assert/strict';

const API = 'http://localhost:8787', ORIGIN = 'http://localhost:8731';
const SECRET_B64 = 'bG9jYWxfdGVzdF9zZWNyZXRfMTIzNDU2Nzg5MDEyMzQ1';               // = DODO_WEBHOOK_SECRET in dev.vars.example, minus whsec_
const PROD = { monthly: 'pdt_0NsmAclo8rlbC3hkeYMhj', yearly: 'pdt_0NsmAcmhJy3KawECCqtXj', lifetime: 'pdt_0NsmAcoihd3lDphUHZFfX' };

// ---------- mock Dodo ----------
const db = { subs: {}, pays: {}, calls: [] };
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const m = p => req.url.match(p); db.calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== 'Bearer dummy_local_key') return send({ error: 'auth' }, 401);
    if (req.method === 'POST' && req.url === '/checkouts') { const b = JSON.parse(body); db.lastCheckout = b; return send({ session_id: 'cks_1', checkout_url: 'https://test.checkout.dodopayments.com/session/cks_1' }); }
    let x;
    if ((x = m(/^\/subscriptions\/([\w-]+)\/change-plan(\/preview|\/scheduled)?$/))) {
      const s = db.subs[x[1]]; if (!s) return send({}, 404);
      if (x[2] === '/preview') return send({ immediate_charge: { summary: { total_amount: 135099, currency: 'INR' } }, new_plan: { next_billing_date: future(365) } });
      if (x[2] === '/scheduled') { s.scheduled_change = null; db.calls.push('UNSCHEDULED'); res.writeHead(204); return res.end(); }
      const b = JSON.parse(body); db.lastChange = b; s.scheduled_change = b.effective_at === 'next_billing_date' ? { product_id: b.product_id } : null; return send({ payment_id: 'pay_chg' });
    }
    if ((x = m(/^\/subscriptions\/([\w-]+)$/))) {
      const s = db.subs[x[1]]; if (!s) return send({}, 404);
      if (req.method === 'PATCH') Object.assign(s, JSON.parse(body)); return send(s);
    }
    if ((x = m(/^\/payments\/([\w-]+)$/))) return db.pays[x[1]] ? send(db.pays[x[1]]) : send({}, 404);
    if ((x = m(/^\/invoices\/payments\/([\w-]+)$/))) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 mock'); }
    if (m(/^\/customers\/[\w-]+\/customer-portal\/session$/)) return send({ link: 'https://test.customer.dodopayments.com/p/abc' });
    send({}, 404);
  });
}).listen(8799);

// ---------- mock Google Analytics (Measurement Protocol) on :8798: records what the Worker would send ----------
const gaLog = [];
const gaMock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => { try { gaLog.push({ url: req.url, ...JSON.parse(body) }); } catch { /* ignore */ } res.writeHead(204); res.end(); });
}).listen(8798);

// ---------- helpers ----------
const enc = new TextEncoder();
async function webhook(type, data, { id = 'msg_' + Math.random().toString(36).slice(2), ts = Math.floor(Date.now() / 1000), tamper = false } = {}) {
  const body = JSON.stringify({ type, data, business_id: 'bus_x', timestamp: new Date().toISOString() });
  const key = await crypto.subtle.importKey('raw', Buffer.from(SECRET_B64, 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${body}`))).toString('base64');
  const r = await fetch(API + '/webhooks/dodo', { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': 'v1,' + sig }, body: tamper ? body.replace(/(sub|pay)_/, '$1_EVIL_') : body });
  return { status: r.status, body: await r.json() };
}
const call = async (path, { token, method = 'GET', json } = {}) => {
  const r = await fetch(API + path, { method, headers: { origin: ORIGIN, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const ct = r.headers.get('content-type') || ''; return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
};
const login = async (sub, email) => (await (await fetch(API + '/dev/login', { method: 'POST', body: JSON.stringify({ sub, email, name: sub }) })).json()).token;
const future = d => new Date(Date.now() + d * 86400000).toISOString();
let n = 0; const ok = m => console.log(`ok ${++n} - ${m}`);

try {
  // ---- checkout: server decides price/product and who it is for ----
  const t = await login('buyer1', 'buyer1@example.com');
  let r = await call('/checkout', { token: t, method: 'POST', json: { plan: 'yearly', product_id: 'pdt_FREE', amount: 1 } });
  assert.equal(r.status, 200); assert.match(r.body.url, /^https:\/\/test\.checkout\.dodopayments\.com\//);
  assert.equal(db.lastCheckout.product_cart[0].product_id, PROD.yearly, 'product comes from the server table, not the browser');
  assert.deepEqual(db.lastCheckout.metadata, { sub: 'buyer1', plan: 'yearly' }); assert.equal(db.lastCheckout.customer.email, 'buyer1@example.com');
  assert.equal(db.lastCheckout.return_url, 'https://filmroom.in/?checkout=done'); ok('checkout session is built entirely server-side from the verified account');

  // ---- the browser cannot grant itself a plan ----
  assert.equal((await call('/me', { token: t })).body.account.plan, 'free'); ok('before payment: Free');
  r = await call('/dev/grant', { token: t, method: 'POST', json: { plan: 'lifetime' } }); // dev route exists only because ENABLE_DEV_ROUTES=1 locally
  assert.equal(r.body.account.plan, 'lifetime'); await call('/dev/grant', { token: t, method: 'POST', json: { plan: 'free' } }); ok('(dev-only grant route works locally, and is absent in production config)');

  // ---- webhook security ----
  db.subs.sub_A = { subscription_id: 'sub_A', product_id: PROD.yearly, status: 'active', next_billing_date: future(365), metadata: { sub: 'buyer1' }, customer: { customer_id: 'cus_A', email: 'buyer1@example.com' } };
  assert.equal((await webhook('subscription.active', { subscription_id: 'sub_A' }, { tamper: true })).status, 401);
  assert.equal((await webhook('subscription.active', { subscription_id: 'sub_A' }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  r = await fetch(API + '/webhooks/dodo', { method: 'POST', body: '{"type":"subscription.active","data":{"subscription_id":"sub_A"}}' }); assert.equal(r.status, 401);
  assert.equal((await call('/me', { token: t })).body.account.plan, 'free'); ok('forged, replayed and unsigned webhooks change nothing');

  // ---- a real, signed event grants the plan ----
  r = await webhook('subscription.active', { subscription_id: 'sub_A' }, { id: 'msg_dup' }); assert.equal(r.status, 200);
  let a = (await call('/me', { token: t })).body.account; assert.deepEqual([a.plan, a.canceled, a.hasSubscription], ['yearly', false, true]); ok('signed subscription.active grants Pro Yearly');
  r = await webhook('subscription.active', { subscription_id: 'sub_A' }, { id: 'msg_dup' }); assert.equal(r.body.duplicate, true); ok('the same delivery twice is processed once');

  // ---- payment recorded, invoice is only for the owner ----
  db.pays.pay_A1 = { payment_id: 'pay_A1', status: 'succeeded', total_amount: 149900, currency: 'INR', created_at: new Date().toISOString(), subscription_id: 'sub_A', metadata: { sub: 'buyer1' }, customer: { customer_id: 'cus_A' } };
  assert.equal((await webhook('payment.succeeded', { payment_id: 'pay_A1' })).status, 200);
  a = (await call('/me', { token: t })).body.account; assert.deepEqual([a.invoices[0].id, a.invoices[0].amount, a.invoices[0].plan], ['pay_A1', 1499, 'yearly']); ok('payment recorded: ₹1,499 yearly');
  r = await call('/billing/invoice/pay_A1', { token: t }); assert.equal(r.status, 200); assert.match(r.body, /^%PDF/); assert.equal(r.headers.get('content-type'), 'application/pdf');
  const other = await login('stranger', 'stranger@example.com'); assert.equal((await call('/billing/invoice/pay_A1', { token: other })).status, 404); ok("someone else's invoice is not downloadable");

  // ---- one buyer cannot be given another buyer's plan ----
  assert.equal((await call('/me', { token: other })).body.account.plan, 'free'); ok('other accounts unaffected');

  // ---- cancel / resume / portal / double-subscribe ----
  r = await call('/checkout', { token: t, method: 'POST', json: { plan: 'monthly' } }); assert.equal(r.status, 409); assert.equal(r.body.error, 'already_subscribed'); ok('cannot start a second subscription');
  r = await call('/billing/cancel', { token: t, method: 'POST' }); assert.equal(r.status, 200); assert.deepEqual([r.body.account.canceled, r.body.account.plan], [true, 'yearly']);
  assert.equal(db.subs.sub_A.cancel_at_next_billing_date, true); ok('cancel sets cancel-at-period-end at Dodo and the app keeps Pro until the date');
  r = await call('/billing/resume', { token: t, method: 'POST' }); assert.equal(r.body.account.canceled, false); ok('resume undoes it');
  r = await call('/billing/portal', { token: t, method: 'POST' }); assert.match(r.body.url, /^https:\/\/test\.customer\.dodopayments\.com\//); ok('billing portal link comes from the stored customer');
  assert.equal((await call('/billing/cancel', { token: other, method: 'POST' })).status, 409); ok('cannot cancel a subscription you do not have');
  r = await call('/me', { token: t, method: 'DELETE' }); assert.equal(r.status, 409); ok('cannot delete the account with a live subscription');

  // ---- failed renewal drops access ----
  db.subs.sub_A.status = 'on_hold'; await webhook('subscription.on_hold', { subscription_id: 'sub_A' });
  assert.equal((await call('/me', { token: t })).body.account.plan, 'free'); ok('failed renewal (on_hold) returns the account to Free');
  db.subs.sub_A.status = 'active'; await webhook('subscription.renewed', { subscription_id: 'sub_A' }); assert.equal((await call('/me', { token: t })).body.account.plan, 'yearly'); ok('a later successful renewal restores it');

  // ---- lifetime purchase, refund, chargeback ----
  const t2 = await login('buyer2', 'buyer2@example.com');
  db.pays.pay_L1 = { payment_id: 'pay_L1', status: 'succeeded', total_amount: 349900, currency: 'INR', created_at: new Date().toISOString(), product_cart: [{ product_id: PROD.lifetime, quantity: 1 }], metadata: { sub: 'buyer2' }, customer: { customer_id: 'cus_B' } };
  await webhook('payment.succeeded', { payment_id: 'pay_L1' }); assert.equal((await call('/me', { token: t2 })).body.account.plan, 'lifetime'); ok('Lifetime granted from a signed payment.succeeded');
  assert.equal((await call('/checkout', { token: t2, method: 'POST', json: { plan: 'lifetime' } })).status, 409); ok('a Lifetime owner cannot buy again');
  assert.deepEqual((await call('/usage/download', { token: t2, method: 'POST', json: { n: 50 } })).body.unlimited, true); ok('paid plans are not download-capped');
  await webhook('refund.succeeded', { payment_id: 'pay_L1' }); a = (await call('/me', { token: t2 })).body.account; assert.equal(a.plan, 'free'); assert.equal(a.invoices[0].status, 'refunded'); ok('refund revokes Lifetime');

  // ---- an unmapped / foreign product never grants anything ----
  db.pays.pay_X = { payment_id: 'pay_X', status: 'succeeded', total_amount: 100, product_cart: [{ product_id: 'pdt_SOMETHING_ELSE' }], metadata: { sub: 'buyer2' }, customer: { customer_id: 'cus_B' } };
  await webhook('payment.succeeded', { payment_id: 'pay_X' }); assert.equal((await call('/me', { token: t2 })).body.account.plan, 'free'); ok('a payment for a product that is not ours grants nothing');

  // ---- sessions / account deletion ----
  const t3 = await login('leaver', 'leaver@example.com'); assert.equal((await call('/me', { token: t3, method: 'DELETE' })).status, 200);
  assert.equal((await call('/me', { token: t3 })).status, 401); ok('deleting an account ends every session');
  const t4 = await login('signer', 'signer@example.com'); await call('/auth/signout', { token: t4, method: 'POST' }); assert.equal((await call('/me', { token: t4 })).status, 401); ok('sign out revokes the session server-side');

  // ---- switching plans: Yearly -> Monthly is scheduled for the next billing date (nothing charged now) ----
  r = await call('/billing/change-plan/preview', { token: t, method: 'POST', json: { plan: 'monthly' } }); assert.equal(r.status, 200); assert.equal(r.body.kind, 'downgrade'); ok('preview of Yearly -> Monthly says it starts at the next billing date');
  r = await call('/billing/change-plan', { token: t, method: 'POST', json: { plan: 'monthly' } }); assert.equal(r.status, 200);
  assert.equal(db.lastChange.product_id, PROD.monthly); assert.equal(db.lastChange.proration_billing_mode, 'full_immediately'); assert.equal(db.lastChange.effective_at, 'next_billing_date');
  assert.deepEqual([r.body.account.plan, r.body.account.scheduledPlan], ['yearly', 'monthly']); ok('Yearly -> Monthly is scheduled at Dodo, the account stays Yearly and shows the pending switch');
  r = await call('/billing/change-plan/cancel', { token: t, method: 'POST' }); assert.equal(r.status, 200); assert.equal(r.body.account.scheduledPlan, null); ok('the scheduled switch can be cancelled');
  r = await call('/billing/change-plan', { token: t, method: 'POST', json: { plan: 'yearly' } }); assert.equal(r.status, 409); assert.equal(r.body.error, 'same_plan'); ok('switching to the plan you are already on is refused');
  r = await call('/billing/change-plan', { token: t, method: 'POST', json: { plan: 'lifetime' } }); assert.equal(r.status, 400); ok('Lifetime is bought through checkout, not switched');
  r = await call('/billing/change-plan', { token: other, method: 'POST', json: { plan: 'yearly' } }); assert.equal(r.status, 409); ok('someone without a subscription cannot switch');
  // ---- Monthly -> Yearly starts now with Dodo's own prorated amount ----
  const tm = await login('monthly1', 'monthly1@example.com');
  db.subs.sub_M = { subscription_id: 'sub_M', product_id: PROD.monthly, status: 'active', next_billing_date: future(20), metadata: { sub: 'monthly1' }, customer: { customer_id: 'cus_M', email: 'monthly1@example.com' } };
  await webhook('subscription.active', { subscription_id: 'sub_M' }); assert.equal((await call('/me', { token: tm })).body.account.plan, 'monthly');
  r = await call('/billing/change-plan/preview', { token: tm, method: 'POST', json: { plan: 'yearly' } }); assert.equal(r.status, 200);
  assert.deepEqual([r.body.kind, r.body.chargeNow, r.body.currency], ['upgrade', 1350.99, 'INR']); ok("preview of Monthly -> Yearly shows Dodo's prorated amount (₹1,350.99)");
  r = await call('/billing/change-plan', { token: tm, method: 'POST', json: { plan: 'yearly', product_id: 'pdt_FREE', proration_billing_mode: 'do_not_bill' } }); assert.equal(r.status, 200);
  assert.equal(db.lastChange.product_id, PROD.yearly); assert.equal(db.lastChange.proration_billing_mode, 'prorated_immediately'); assert.equal(db.lastChange.effective_at, 'immediately');
  ok('Monthly -> Yearly: product and proration come from the server, the browser cannot pick a cheaper mode');
  db.subs.sub_M.product_id = PROD.yearly; await webhook('subscription.plan_changed', { subscription_id: 'sub_M' }); assert.equal((await call('/me', { token: tm })).body.account.plan, 'yearly'); ok("Dodo's plan_changed webhook moves the account to Yearly");

  // ---- Google Analytics: subscription events are sent from the server, only for visitors who accepted analytics ----
  const CID = '1234567890.1700000000', link = (token, cid) => call('/analytics/link', { token, method: 'POST', json: { cid } }), sentNames = () => gaLog.flatMap(g => g.events.map(e => e.name));
  const ta = await login('gabuyer', 'gabuyer@example.com'), tb = await login('gaprivate', 'gaprivate@example.com');
  assert.equal((await link(ta, 'not-a-client-id')).status, 400); assert.equal((await link(ta, 12345)).status, 400); assert.equal((await link(ta, '123.456')).status, 400); ok('a malformed analytics id is refused');
  assert.equal((await call('/analytics/link', { method: 'POST', json: { cid: CID } })).status, 401); ok('linking needs a signed-in session');
  assert.equal((await link(ta, CID)).status, 200); assert.equal((await link(tb, CID)).status, 200); assert.equal((await link(tb, null)).status, 200); ok('a visitor who accepted links their id; one who declines (null) clears it');
  gaLog.length = 0;
  db.subs.sub_GA = { subscription_id: 'sub_GA', product_id: PROD.monthly, status: 'active', next_billing_date: future(30), metadata: { sub: 'gabuyer' }, customer: { customer_id: 'cus_GA', email: 'gabuyer@example.com' } };
  db.pays.pay_GA1 = { payment_id: 'pay_GA1', status: 'succeeded', total_amount: 14900, currency: 'INR', created_at: new Date().toISOString(), subscription_id: 'sub_GA', metadata: { sub: 'gabuyer' }, customer: { customer_id: 'cus_GA' } };
  await webhook('payment.succeeded', { payment_id: 'pay_GA1' }); await webhook('subscription.active', { subscription_id: 'sub_GA' });
  assert.deepEqual(sentNames(), ['purchase', 'subscription_started']); const g0 = gaLog[0];
  assert.equal(g0.client_id, CID); assert.match(g0.url, /measurement_id=G-TEST000000&api_secret=dev_secret/); assert.deepEqual(Object.keys(g0).filter(k => k !== 'url').sort(), ['client_id', 'events', 'timestamp_micros']);
  assert.deepEqual([g0.events[0].params.transaction_id, g0.events[0].params.value, g0.events[0].params.currency], ['pay_GA1', 149, 'INR']); ok('a first payment sends purchase + subscription_started to Google (id, amount, currency only)');
  assert.ok(!JSON.stringify(gaLog).match(/gabuyer|@example|"email"|"user_id"|"customer/i)); ok('nothing identifying (no email, name or account id) is sent');
  await webhook('payment.succeeded', { payment_id: 'pay_GA1' }, { id: 'msg_again' }); assert.deepEqual(sentNames(), ['purchase', 'subscription_started']); ok('the same payment delivered again sends nothing more');
  db.pays.pay_GA2 = { ...db.pays.pay_GA1, payment_id: 'pay_GA2' }; await webhook('payment.succeeded', { payment_id: 'pay_GA2' });
  assert.deepEqual(sentNames().slice(2), ['purchase', 'subscription_renewed']); ok('the next payment on the same plan is a renewal');
  db.subs.sub_GA.status = 'cancelled'; for (let i = 0; i < 3; i++) await webhook('subscription.cancelled', { subscription_id: 'sub_GA' });
  assert.equal(sentNames().filter(x => x === 'subscription_churned').length, 1); ok('churn (the plan really ended) is sent exactly once, even with repeated webhooks');
  db.pays.pay_GA2.status = 'succeeded'; await webhook('refund.succeeded', { payment_id: 'pay_GA2' }); await webhook('refund.succeeded', { payment_id: 'pay_GA2' }, { id: 'msg_refund2' });
  assert.equal(sentNames().filter(x => x === 'refund').length, 1); ok('a refund is sent once');
  const before = gaLog.length;
  db.subs.sub_GB = { subscription_id: 'sub_GB', product_id: PROD.monthly, status: 'active', next_billing_date: future(30), metadata: { sub: 'gaprivate' }, customer: { customer_id: 'cus_GB', email: 'gaprivate@example.com' } };
  db.pays.pay_GB1 = { payment_id: 'pay_GB1', status: 'succeeded', total_amount: 14900, currency: 'INR', subscription_id: 'sub_GB', metadata: { sub: 'gaprivate' }, customer: { customer_id: 'cus_GB' } };
  await webhook('payment.succeeded', { payment_id: 'pay_GB1' }); await webhook('subscription.active', { subscription_id: 'sub_GB' });
  assert.equal((await call('/me', { token: tb })).body.account.plan, 'monthly'); assert.equal(gaLog.length, before); ok('a visitor who declined analytics gets their plan and sends Google nothing');

  console.log(`\n${n} checks passed`);
} catch (e) { console.error('\nFAILED:', e.message, '\n', e.stack.split('\n').slice(0, 4).join('\n')); process.exitCode = 1; }
finally { mock.close(); gaMock.close(); }
