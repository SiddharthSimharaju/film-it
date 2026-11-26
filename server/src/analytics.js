// Subscription events for Google Analytics, sent from the SERVER (GA4 Measurement Protocol).
// Why: renewals, churn and refunds happen at Dodo, months after the browser visit, so only the server hears about them.
// Rules: (1) only for visitors who accepted analytics: the browser sends its analytics client id to /analytics/link, and without one nothing is sent;
// (2) only business facts (plan, amount, payment id), never a name, email or account id; (3) a failure here can never break a webhook (it is swallowed);
// (4) transitions only, so repeated webhooks for the same state send nothing.
import { PLANS } from './plans.js';

export const CID_RE = /^\d{4,12}\.\d{4,12}$/;                 // what GA4 puts in the _ga cookie: 1234567890.1700000000

const item = (plan, amount) => ({ item_id: plan, item_name: PLANS[plan] ? PLANS[plan].name : plan, price: amount, quantity: 1 });

/** Events for a payment that has just succeeded. `prev` is the account record BEFORE this payment was recorded; `pay` is { id, plan, amount, currency, subId }. */
export function paymentEvents(prev, pay) {
  if (prev.payments.some(x => x.id === pay.id)) return [];                       // a replay of a payment we already recorded
  const events = [{ name: 'purchase', params: { transaction_id: pay.id, value: pay.amount, currency: pay.currency, plan: pay.plan, items: [item(pay.plan, pay.amount)] } }];
  if (pay.subId) {
    const before = prev.payments.filter(x => x.subId === pay.subId);             // newest first
    const base = { plan: pay.plan, value: pay.amount, currency: pay.currency, transaction_id: pay.id };
    if (!before.length) events.push({ name: 'subscription_started', params: base });
    else if (before[0].plan !== pay.plan) events.push({ name: 'subscription_plan_changed', params: { ...base, from: before[0].plan, to: pay.plan } });
    else events.push({ name: 'subscription_renewed', params: base });
  }
  return events;
}

/** Events for a subscription whose state just changed (previous and next are the compact `sub` records). Same state again sends nothing. */
export function subscriptionEvents(prevSub, nextSub) {
  const was = prevSub && prevSub.status, now = nextSub && nextSub.status;
  if (!now || was === now) return [];
  const live = s => s === 'active' || s === 'past_due';
  if (live(was) && (now === 'cancelled' || now === 'expired')) return [{ name: 'subscription_churned', params: { plan: nextSub.plan, reason: now } }];   // the paid plan really ended
  if (was === 'active' && now === 'on_hold') return [{ name: 'subscription_on_hold', params: { plan: nextSub.plan } }];                                   // a renewal failed: churn risk
  return [];
}

/** A payment that was refunded or charged back. `p` is the stored payment record. */
export const reversalEvents = (p, kind) => [{ name: kind === 'refunded' ? 'refund' : 'chargeback', params: { transaction_id: p.id, value: p.amount, currency: p.currency, plan: p.plan } }];

/** POST the events to GA4. Resolves true/false and NEVER throws. Without a secret, a measurement id or a valid client id it does nothing. */
export async function sendGa(env, cid, events, fetchImpl = fetch) {
  if (!env.GA_API_SECRET || !env.GA_MEASUREMENT_ID || !CID_RE.test(cid || '') || !events || !events.length) return false;
  try {
    const url = `${env.GA_ENDPOINT || 'https://www.google-analytics.com/mp/collect'}?measurement_id=${encodeURIComponent(env.GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`;
    const r = await fetchImpl(url, { method: 'POST', body: JSON.stringify({ client_id: cid, timestamp_micros: Date.now() * 1000, events }), signal: AbortSignal.timeout(2500) });
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
}
