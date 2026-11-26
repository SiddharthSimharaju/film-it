import test from 'node:test';
import assert from 'node:assert/strict';
import { CID_RE, paymentEvents, reversalEvents, sendGa, subscriptionEvents } from '../src/analytics.js';
import { newRecord, effective } from '../src/entitlement.js';
import { processEvent } from '../src/webhook.js';

const DAY = 86400000, now = Date.UTC(2026, 10, 26, 12), CID = '1234567890.1700000000';
const rec = (payments = []) => ({ ...newRecord(), payments });
const pay = o => ({ id: 'pay_1', plan: 'monthly', amount: 149, currency: 'INR', subId: 'sub_1', ...o });
const names = evs => evs.map(e => e.name);

// ---------- which events a payment produces ----------
test('analytics: the first payment of a subscription is a purchase and a subscription start', () => {
  const e = paymentEvents(rec(), pay()); assert.deepEqual(names(e), ['purchase', 'subscription_started']);
  assert.deepEqual([e[0].params.transaction_id, e[0].params.value, e[0].params.currency, e[0].params.items[0].item_id], ['pay_1', 149, 'INR', 'monthly']);
});
test('analytics: a later payment on the same plan is a renewal', () => assert.deepEqual(names(paymentEvents(rec([pay({ id: 'pay_0' })]), pay({ id: 'pay_2' }))), ['purchase', 'subscription_renewed']));
test('analytics: a payment on a different plan is a plan change, with from and to', () => {
  const e = paymentEvents(rec([pay({ id: 'pay_0' })]), pay({ id: 'pay_2', plan: 'yearly', amount: 1350.99 })); assert.deepEqual(names(e), ['purchase', 'subscription_plan_changed']);
  assert.deepEqual([e[1].params.from, e[1].params.to], ['monthly', 'yearly']);
});
test('analytics: Lifetime is a purchase only (no subscription events)', () => assert.deepEqual(names(paymentEvents(rec(), pay({ plan: 'lifetime', subId: null, amount: 3499 }))), ['purchase']));
test('analytics: a payment we already recorded sends nothing (replay)', () => assert.deepEqual(paymentEvents(rec([pay()]), pay()), []));

// ---------- churn is a TRANSITION, so repeated webhooks cannot double count ----------
const sub = status => ({ id: 'sub_1', plan: 'yearly', status });
test('analytics: active to cancelled or expired is churn, once', () => {
  assert.deepEqual(names(subscriptionEvents(sub('active'), sub('cancelled'))), ['subscription_churned']);
  assert.equal(subscriptionEvents(sub('active'), sub('expired'))[0].params.reason, 'expired');
  assert.deepEqual(subscriptionEvents(sub('cancelled'), sub('cancelled')), [], 'the same state again');
  assert.deepEqual(subscriptionEvents(sub('cancelled'), sub('expired')), [], 'already churned');
});
test('analytics: a failed renewal (on hold) is its own event; starting up is not churn', () => {
  assert.deepEqual(names(subscriptionEvents(sub('active'), sub('on_hold'))), ['subscription_on_hold']);
  assert.deepEqual(subscriptionEvents(null, sub('active')), []); assert.deepEqual(subscriptionEvents(sub('pending'), sub('active')), []);
  assert.deepEqual(names(subscriptionEvents(sub('past_due'), sub('expired'))), ['subscription_churned']);
});
test('analytics: refunds and chargebacks are named separately', () => {
  assert.equal(reversalEvents(pay(), 'refunded')[0].name, 'refund'); assert.equal(reversalEvents(pay(), 'chargeback')[0].name, 'chargeback');
});

// ---------- sending: consent, secrets, failures ----------
const ENV = { GA_API_SECRET: 's3cret', GA_MEASUREMENT_ID: 'G-TEST123456' };
test('analytics: client id format', () => { assert.ok(CID_RE.test(CID)); for (const bad of ['', 'abc', '123', '1234567890', 'a.b', '1234567890.', null, undefined]) assert.equal(CID_RE.test(bad), false, String(bad)); });
test('analytics: nothing is sent without a secret, a measurement id, a valid client id or any event', async () => {
  let calls = 0; const f = async () => { calls++; return { status: 204 }; }, ev = [{ name: 'purchase', params: {} }];
  assert.equal(await sendGa({ GA_MEASUREMENT_ID: ENV.GA_MEASUREMENT_ID }, CID, ev, f), false);
  assert.equal(await sendGa({ GA_API_SECRET: 'x' }, CID, ev, f), false);
  assert.equal(await sendGa(ENV, null, ev, f), false); assert.equal(await sendGa(ENV, 'junk', ev, f), false); assert.equal(await sendGa(ENV, CID, [], f), false);
  assert.equal(calls, 0);
});
test('analytics: the request carries only the client id, a timestamp and the events (no email, name or account id)', async () => {
  let seen; const ok = await sendGa(ENV, CID, [{ name: 'purchase', params: { transaction_id: 'pay_1', value: 1 } }], async (u, o) => { seen = { u, body: JSON.parse(o.body), method: o.method }; return { status: 204 }; });
  assert.equal(ok, true); assert.equal(seen.method, 'POST'); assert.match(seen.u, /^https:\/\/www\.google-analytics\.com\/mp\/collect\?measurement_id=G-TEST123456&api_secret=s3cret$/);
  assert.deepEqual(Object.keys(seen.body).sort(), ['client_id', 'events', 'timestamp_micros']); assert.equal(seen.body.client_id, CID); assert.ok(!('user_id' in seen.body));
});
test('analytics: a network error or a non-2xx reply returns false and never throws', async () => {
  const ev = [{ name: 'x', params: {} }];
  assert.equal(await sendGa(ENV, CID, ev, async () => { throw new Error('boom'); }), false);
  assert.equal(await sendGa(ENV, CID, ev, async () => ({ status: 500 })), false);
});

// ---------- through the webhook handler ----------
const PROD = { PRODUCT_MONTHLY: 'pdt_m', PRODUCT_YEARLY: 'pdt_y', PRODUCT_LIFETIME: 'pdt_l' }, cust = { customer_id: 'cus_1', email: 'a@b.test' };
function world({ subs = {}, payments = {}, linked = true, ga } = {}) {
  const store = new Map(), kv = new Map(), sent = [];
  const acct = s => { if (!store.has(s)) store.set(s, { ...newRecord(), ga: linked ? { cid: CID, at: 1 } : null }); const r = store.get(s);
    return { raw: async () => r, setCustomer: async c => { r.customerId = c; }, setSub: async x => { r.sub = x; }, grantLifetime: async i => { r.lifetime = i; }, revokeLifetime: async () => { r.lifetime = null; },
      recordPayment: async p => { r.payments = [p, ...r.payments.filter(x => x.id !== p.id)]; }, setPaymentStatus: async (id, st) => { const p = r.payments.find(x => x.id === id); if (p) p.status = st; return !!p; } }; };
  const deps = { env: PROD, kv: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } }, accountFor: acct, ga: ga || (async (env, cid, events) => { sent.push({ cid, names: names(events), events }); return true; }),
    api: { getSubscription: async (e, id) => subs[id], getPayment: async (e, id) => payments[id], setCancelAtPeriodEnd: async () => {} } };
  return { deps, store, sent };
}
const subObj = (o = {}) => ({ subscription_id: 'sub_1', product_id: 'pdt_y', status: 'active', next_billing_date: new Date(now + 300 * DAY).toISOString(), metadata: { sub: 'u1' }, customer: cust, ...o });
const payObj = (o = {}) => ({ payment_id: 'pay_1', status: 'succeeded', total_amount: 149900, currency: 'INR', subscription_id: 'sub_1', metadata: { sub: 'u1' }, customer: cust, ...o });

test('analytics: a linked buyer produces purchase + subscription_started through the webhook, and a replay sends nothing', async () => {
  const w = world({ subs: { sub_1: subObj() }, payments: { pay_1: payObj() } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps);
  assert.deepEqual(w.sent.flatMap(s => s.names), ['purchase', 'subscription_started']); assert.equal(w.sent[0].cid, CID);
  const n = w.sent.length; await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps); assert.equal(w.sent.length, n, 'replay sends nothing');
});
test('analytics: someone who never accepted analytics (no linked id) produces no events at all', async () => {
  const w = world({ linked: false, subs: { sub_1: subObj() }, payments: { pay_1: payObj() } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps); await processEvent({ type: 'subscription.cancelled', data: { subscription_id: 'sub_1' } }, w.deps);
  assert.equal(w.sent.length, 0); assert.equal(effective(w.store.get('u1'), now).plan !== 'free', true, '...and the plan still works');
});
test('analytics: churn is sent exactly once even if Dodo sends the cancelled webhook three times', async () => {
  const subs = { sub_1: subObj() }, w = world({ subs, payments: { pay_1: payObj() } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps); w.sent.length = 0;
  subs.sub_1 = subObj({ status: 'cancelled' }); for (let i = 0; i < 3; i++) await processEvent({ type: 'subscription.updated', data: { subscription_id: 'sub_1' } }, w.deps);
  assert.deepEqual(w.sent.flatMap(s => s.names), ['subscription_churned']);
});
test('analytics: a refund is sent once; the payment is marked refunded', async () => {
  const w = world({ payments: { pay_L: payObj({ payment_id: 'pay_L', subscription_id: null, total_amount: 349900, product_cart: [{ product_id: 'pdt_l' }] }) } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_L' } }, w.deps); w.sent.length = 0;
  for (let i = 0; i < 2; i++) await processEvent({ type: 'refund.succeeded', data: { payment_id: 'pay_L' } }, w.deps);
  assert.deepEqual(w.sent.flatMap(s => s.names), ['refund']); assert.equal(w.store.get('u1').payments[0].status, 'refunded');
});
test('analytics: if Google is down or throws, the payment still grants the plan', async () => {
  const w = world({ subs: { sub_1: subObj() }, payments: { pay_1: payObj() }, ga: async () => { throw new Error('google down'); } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps);
  assert.equal(effective(w.store.get('u1'), now).plan, 'yearly'); assert.equal(w.store.get('u1').payments.length, 1);
});
