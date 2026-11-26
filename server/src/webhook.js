// Turns verified Dodo webhook events into plan changes. Rule: the webhook body only says WHICH object changed; the facts
// (status, product, dates) are re-read from Dodo's API with our own key, so a malformed or replayed body cannot grant anything.
import { planForProduct } from './plans.js';
import { subFromDodo } from './entitlement.js';

const SUB_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ms = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : Date.now(); };

/** Who does this Dodo object belong to? The `sub` we put in checkout metadata, else a customer id we have seen before. */
async function resolveSub({ kv }, obj) {
  const m = obj && obj.metadata && obj.metadata.sub;
  if (typeof m === 'string' && SUB_RE.test(m)) return m;
  const cid = obj && obj.customer && obj.customer.customer_id;
  if (cid) { const s = await kv.get(`c:${cid}`); if (s && SUB_RE.test(s)) return s; }
  return null;
}

async function bind(deps, sub, obj) {            // remember customer -> account, so later events without metadata still resolve
  const cid = obj && obj.customer && obj.customer.customer_id;
  if (!cid) return;
  await deps.accountFor(sub).setCustomer(cid);
  await deps.kv.put(`c:${cid}`, sub);
}

async function syncSubscription(deps, subObj) {
  const plan = planForProduct(deps.env, subObj.product_id);
  if (!plan || plan === 'lifetime') return { ignored: 'not one of our subscription products' };
  const sub = await resolveSub(deps, subObj);
  if (!sub) { await deps.kv.put(`o:${subObj.subscription_id}`, JSON.stringify({ at: Date.now(), kind: 'subscription' }), { expirationTtl: 30 * 86400 }); return { ignored: 'unmapped subscription' }; }
  await bind(deps, sub, subObj);
  await deps.accountFor(sub).setSub(subFromDodo(subObj, plan));
  return { sub, plan, status: subObj.status };
}

async function onSubscription(deps, data) {
  if (!data.subscription_id) return { ignored: 'no subscription id' };
  return syncSubscription(deps, await deps.api.getSubscription(deps.env, data.subscription_id));
}

async function onPaymentSucceeded(deps, data) {
  if (!data.payment_id) return { ignored: 'no payment id' };
  const pay = await deps.api.getPayment(deps.env, data.payment_id);
  if (pay.status !== 'succeeded') return { ignored: `payment is ${pay.status}` };
  let plan, subObj = null;
  if (pay.subscription_id) {
    subObj = await deps.api.getSubscription(deps.env, pay.subscription_id);
    plan = planForProduct(deps.env, subObj.product_id);
  } else {
    for (const item of pay.product_cart || []) { plan = planForProduct(deps.env, item.product_id); if (plan) break; }
  }
  if (!plan) return { ignored: 'not one of our products' };
  const sub = await resolveSub(deps, pay) || (subObj && await resolveSub(deps, subObj));
  if (!sub) { await deps.kv.put(`o:${pay.payment_id}`, JSON.stringify({ at: Date.now(), kind: 'payment' }), { expirationTtl: 30 * 86400 }); return { ignored: 'unmapped payment' }; }
  await bind(deps, sub, pay);
  const acct = deps.accountFor(sub);
  await acct.recordPayment({ id: pay.payment_id, plan, amount: Number(pay.total_amount || 0) / 100, currency: String(pay.currency || 'INR'), at: ms(pay.created_at), status: 'succeeded', subId: pay.subscription_id || null });
  if (subObj) await syncSubscription(deps, subObj);
  if (plan === 'lifetime') {
    await acct.grantLifetime({ paymentId: pay.payment_id, at: ms(pay.created_at) });
    const cur = await acct.raw();                         // a Lifetime buyer should not keep paying for a subscription
    if (cur.sub && cur.sub.id && cur.sub.status === 'active' && !cur.sub.cancelAtPeriodEnd) {
      try { await deps.api.setCancelAtPeriodEnd(deps.env, cur.sub.id, true); } catch { /* best effort: support can cancel it by hand */ }
    }
  }
  return { sub, plan };
}

async function onPaymentReversed(deps, data, kind) {       // refund.succeeded / dispute.* : find the payment, mark it, take Lifetime away if it was that one
  const id = data.payment_id; if (!id) return { ignored: 'no payment id' };
  const pay = await deps.api.getPayment(deps.env, id);
  const sub = await resolveSub(deps, pay); if (!sub) return { ignored: 'unmapped payment' };
  const acct = deps.accountFor(sub);
  await acct.setPaymentStatus(id, kind);
  await acct.revokeLifetime(id);
  return { sub, payment: id, kind };
}

/** @returns {Promise<object>} a small result for the log; throws on a transient failure so Dodo retries the delivery */
export async function processEvent(event, deps) {
  const type = String(event && event.type || ''), data = (event && event.data) || {};
  if (type.startsWith('subscription.')) return onSubscription(deps, data);
  if (type === 'payment.succeeded') return onPaymentSucceeded(deps, data);
  if (type === 'refund.succeeded') return onPaymentReversed(deps, data, 'refunded');
  if (type === 'dispute.lost' || type === 'dispute.accepted' || type === 'dispute.opened') return onPaymentReversed(deps, data, type === 'dispute.opened' ? 'disputed' : 'chargeback');
  return { ignored: type || 'unknown' };
}
