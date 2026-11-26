import test from 'node:test';
import assert from 'node:assert/strict';
import { effective, newRecord, subFromDodo, istDay, RENEWAL_GRACE_MS } from '../src/entitlement.js';
import { processEvent } from '../src/webhook.js';

const DAY = 86400000, now = Date.UTC(2026, 10, 26, 12);
const withSub = sub => ({ ...newRecord(), sub });
const sub = o => ({ id: 'sub_1', plan: 'monthly', status: 'active', nextBillingDate: now + 10 * DAY, cancelAtPeriodEnd: false, endsAt: null, ...o });

// ---------- who is Pro right now ----------
test('plan: nothing recorded means Free', () => assert.equal(effective(newRecord(), now).plan, 'free'));
test('plan: an active subscription is Pro until the renewal date', () => assert.equal(effective(withSub(sub()), now).plan, 'monthly'));
test('plan: lifetime wins over everything', () => assert.equal(effective({ ...withSub(sub({ status: 'expired' })), lifetime: { paymentId: 'p', at: 1 } }, now).plan, 'lifetime'));
test('plan: cancelled-at-period-end stays Pro until the date, then drops (even if the webhook is late)', () => {
  const s = sub({ cancelAtPeriodEnd: true, nextBillingDate: now + DAY });
  assert.deepEqual([effective(withSub(s), now).plan, effective(withSub(s), now).canceled], ['monthly', true]);
  assert.equal(effective(withSub(s), now + 2 * DAY).plan, 'free');
});
test('plan: a renewal a little late keeps Pro; a long-lapsed one does not', () => {
  const s = sub({ nextBillingDate: now - DAY }); assert.equal(effective(withSub(s), now).plan, 'monthly');
  assert.equal(effective(withSub(s), now + RENEWAL_GRACE_MS + 2 * DAY).plan, 'free');
});
test('plan: on_hold, failed, expired, pending and paused are Free', () => {
  for (const status of ['on_hold', 'failed', 'expired', 'pending', 'paused', 'garbage', '']) assert.equal(effective(withSub(sub({ status })), now).plan, 'free', status);
});
test('plan: past_due keeps Pro only until the grace deadline', () => {
  assert.equal(effective(withSub(sub({ status: 'past_due', endsAt: now + DAY })), now).plan, 'monthly');
  assert.equal(effective(withSub(sub({ status: 'past_due', endsAt: now - 1 })), now).plan, 'free');
  assert.equal(effective(withSub(sub({ status: 'past_due', endsAt: null })), now).plan, 'free');
});
test('plan: cancelled with a paid-through date is Pro until then', () => {
  assert.equal(effective(withSub(sub({ status: 'cancelled', endsAt: now + DAY })), now).plan, 'monthly');
  assert.equal(effective(withSub(sub({ status: 'cancelled', endsAt: now - DAY })), now).plan, 'free');
  assert.equal(effective(withSub(sub({ status: 'cancelled', endsAt: null })), now).plan, 'free');
});
test('plan: a stored sub with a bad plan name never grants Pro', () => assert.equal(effective(withSub(sub({ plan: 'lifetime' })), now).plan, 'free'));
test('day: the download day rolls over at midnight India time', () => {
  assert.equal(istDay(Date.UTC(2026, 10, 26, 18, 29)), '2026-11-26'); assert.equal(istDay(Date.UTC(2026, 10, 26, 18, 31)), '2026-11-27');
});
test('subFromDodo: reads dates and the cancel flag, tolerates missing fields', () => {
  const s = subFromDodo({ subscription_id: 'sub_9', status: 'active', next_billing_date: '2026-12-26T00:00:00Z', cancel_at_next_billing_date: true }, 'yearly');
  assert.deepEqual([s.id, s.plan, s.cancelAtPeriodEnd, s.nextBillingDate], ['sub_9', 'yearly', true, Date.parse('2026-12-26T00:00:00Z')]);
  assert.equal(subFromDodo({ subscription_id: 's' }, 'monthly').nextBillingDate, null);
});

// ---------- webhook processing against a fake Dodo + fake account store ----------
const ENV = { PRODUCT_MONTHLY: 'pdt_m', PRODUCT_YEARLY: 'pdt_y', PRODUCT_LIFETIME: 'pdt_l' };
function world({ subs = {}, payments = {} } = {}) {
  const store = new Map(), kv = new Map(), calls = [];
  const acct = sub => { if (!store.has(sub)) store.set(sub, newRecord()); const r = store.get(sub);
    return {
      raw: async () => r, setCustomer: async c => { r.customerId = c; }, setSub: async s => { r.sub = s; },
      grantLifetime: async i => { r.lifetime = i; }, revokeLifetime: async id => { if (!id || (r.lifetime && r.lifetime.paymentId === id)) r.lifetime = null; },
      recordPayment: async p => { r.payments = [p, ...r.payments.filter(x => x.id !== p.id)]; }, setPaymentStatus: async (id, st) => { const p = r.payments.find(x => x.id === id); if (p) p.status = st; return !!p; },
    }; };
  const deps = { env: ENV, kv: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } }, accountFor: acct,
    api: { getSubscription: async (e, id) => subs[id], getPayment: async (e, id) => payments[id], setCancelAtPeriodEnd: async (e, id, on) => { calls.push(['cancel', id, on]); } } };
  return { deps, store, kv, calls, plan: sub => effective(store.get(sub) || newRecord(), now).plan };
}
const cust = { customer_id: 'cus_1', email: 'a@b.test' };

test('webhook: subscription.active grants the plan to the account named in the metadata', async () => {
  const w = world({ subs: { sub_1: { subscription_id: 'sub_1', product_id: 'pdt_m', status: 'active', next_billing_date: new Date(now + 5 * DAY).toISOString(), metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'subscription.active', data: { subscription_id: 'sub_1' } }, w.deps);
  assert.equal(w.plan('u1'), 'monthly'); assert.equal(w.kv.get('c:cus_1'), 'u1');
});
test('webhook: the event body is not trusted, only what Dodo\'s API says', async () => {
  const w = world({ subs: { sub_1: { subscription_id: 'sub_1', product_id: 'pdt_m', status: 'on_hold', metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'subscription.active', status: 'active', data: { subscription_id: 'sub_1', status: 'active', product_id: 'pdt_l' } }, w.deps);
  assert.equal(w.plan('u1'), 'free');
});
test('webhook: a product that is not ours grants nothing', async () => {
  const w = world({ subs: { sub_1: { subscription_id: 'sub_1', product_id: 'pdt_OTHER', status: 'active', next_billing_date: new Date(now + DAY).toISOString(), metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'subscription.active', data: { subscription_id: 'sub_1' } }, w.deps); assert.equal(w.plan('u1'), 'free');
});
test('webhook: metadata that is not a valid account id is ignored', async () => {
  const w = world({ subs: { sub_1: { subscription_id: 'sub_1', product_id: 'pdt_m', status: 'active', next_billing_date: new Date(now + DAY).toISOString(), metadata: { sub: '../x' }, customer: cust } } });
  const r = await processEvent({ type: 'subscription.active', data: { subscription_id: 'sub_1' } }, w.deps); assert.match(r.ignored, /unmapped/); assert.equal(w.store.size, 0);
});
test('webhook: a later event without metadata still finds the account through the customer id', async () => {
  const w = world({ subs: { sub_1: { subscription_id: 'sub_1', product_id: 'pdt_m', status: 'active', next_billing_date: new Date(now + DAY).toISOString(), metadata: { sub: 'u1' }, customer: cust }, sub_2: { subscription_id: 'sub_2', product_id: 'pdt_y', status: 'active', next_billing_date: new Date(now + DAY).toISOString(), metadata: {}, customer: cust } } });
  await processEvent({ type: 'subscription.active', data: { subscription_id: 'sub_1' } }, w.deps);
  await processEvent({ type: 'subscription.renewed', data: { subscription_id: 'sub_2' } }, w.deps); assert.equal(w.plan('u1'), 'yearly');
});
test('webhook: a succeeded one-time payment for Lifetime grants Lifetime and records the payment', async () => {
  const w = world({ payments: { pay_1: { payment_id: 'pay_1', status: 'succeeded', total_amount: 349900, currency: 'INR', created_at: new Date(now).toISOString(), product_cart: [{ product_id: 'pdt_l', quantity: 1 }], metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps);
  const r = w.store.get('u1'); assert.equal(w.plan('u1'), 'lifetime'); assert.deepEqual([r.payments[0].amount, r.payments[0].plan, r.payments[0].status], [3499, 'lifetime', 'succeeded']);
});
test('webhook: replaying the same payment twice records it once', async () => {
  const w = world({ payments: { pay_1: { payment_id: 'pay_1', status: 'succeeded', total_amount: 349900, currency: 'INR', product_cart: [{ product_id: 'pdt_l' }], metadata: { sub: 'u1' }, customer: cust } } });
  for (let i = 0; i < 3; i++) await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps); assert.equal(w.store.get('u1').payments.length, 1);
});
test('webhook: a payment that did not succeed grants nothing', async () => {
  const w = world({ payments: { pay_1: { payment_id: 'pay_1', status: 'failed', product_cart: [{ product_id: 'pdt_l' }], metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps); assert.equal(w.plan('u1'), 'free');
});
test('webhook: a subscription payment syncs the subscription and is recorded under its plan', async () => {
  const w = world({ subs: { sub_1: { subscription_id: 'sub_1', product_id: 'pdt_y', status: 'active', next_billing_date: new Date(now + 300 * DAY).toISOString(), metadata: { sub: 'u1' }, customer: cust } },
    payments: { pay_2: { payment_id: 'pay_2', status: 'succeeded', total_amount: 149900, currency: 'INR', subscription_id: 'sub_1', metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_2' } }, w.deps); assert.equal(w.plan('u1'), 'yearly'); assert.equal(w.store.get('u1').payments[0].plan, 'yearly');
});
test('webhook: buying Lifetime while subscribed schedules the subscription to end', async () => {
  const w = world({ payments: { pay_1: { payment_id: 'pay_1', status: 'succeeded', total_amount: 349900, product_cart: [{ product_id: 'pdt_l' }], metadata: { sub: 'u1' }, customer: cust } } });
  await w.deps.accountFor('u1').setSub({ id: 'sub_1', plan: 'monthly', status: 'active', nextBillingDate: now + DAY, cancelAtPeriodEnd: false });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps); assert.deepEqual(w.calls, [['cancel', 'sub_1', true]]);
});
test('webhook: a refund takes Lifetime away; a refund of some other payment does not', async () => {
  const pay = { payment_id: 'pay_1', status: 'succeeded', total_amount: 349900, product_cart: [{ product_id: 'pdt_l' }], metadata: { sub: 'u1' }, customer: cust };
  const w = world({ payments: { pay_1: pay, pay_9: { ...pay, payment_id: 'pay_9' } } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps);
  await processEvent({ type: 'refund.succeeded', data: { payment_id: 'pay_9' } }, w.deps); assert.equal(w.plan('u1'), 'lifetime');
  await processEvent({ type: 'refund.succeeded', data: { payment_id: 'pay_1' } }, w.deps); assert.equal(w.plan('u1'), 'free'); assert.equal(w.store.get('u1').payments[0].status, 'refunded');
});
test('webhook: a lost dispute revokes Lifetime', async () => {
  const w = world({ payments: { pay_1: { payment_id: 'pay_1', status: 'succeeded', total_amount: 349900, product_cart: [{ product_id: 'pdt_l' }], metadata: { sub: 'u1' }, customer: cust } } });
  await processEvent({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } }, w.deps);
  await processEvent({ type: 'dispute.lost', data: { payment_id: 'pay_1' } }, w.deps); assert.equal(w.plan('u1'), 'free');
});
test('webhook: unknown event types and empty bodies are ignored without error', async () => {
  const w = world(); for (const e of [{ type: 'license_key.created', data: {} }, {}, null, { type: 'subscription.active', data: {} }]) await processEvent(e, w.deps);
  assert.equal(w.store.size, 0);
});
