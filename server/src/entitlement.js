// Pure plan logic: given what the webhooks recorded, what plan does this account have right now?
// No I/O here, so it is unit-tested directly (test/entitlement.test.js).

const DAY = 86400000;
export const RENEWAL_GRACE_MS = 3 * DAY;   // a renewal that is a little late (webhook lag, bank retry) must not flip someone to Free

export const newRecord = () => ({
  profile: null, joined: null, customerId: null,
  lifetime: null,          // { paymentId, at } while a Lifetime purchase is valid
  sub: null,               // { id, plan, status, nextBillingDate (ms), cancelAtPeriodEnd, endsAt (ms) }
  payments: [],            // newest first, max 50: { id, plan, amount, currency, at, status, subId }
  usage: { day: '', down: 0 },
});

/** @returns {{plan:'free'|'monthly'|'yearly'|'lifetime', renewsAt:number|null, canceled:boolean, status:string}} */
export function effective(rec, now = Date.now()) {
  if (rec.lifetime) return { plan: 'lifetime', renewsAt: null, canceled: false, status: 'lifetime' };
  const s = rec.sub;
  if (!s || (s.plan !== 'monthly' && s.plan !== 'yearly')) return { plan: 'free', renewsAt: null, canceled: false, status: 'none' };
  const next = Number.isFinite(s.nextBillingDate) ? s.nextBillingDate : null;
  const ends = Number.isFinite(s.endsAt) ? s.endsAt : null;
  const paid = (renewsAt, canceled, status) => ({ plan: s.plan, renewsAt, canceled, status });
  switch (s.status) {
    case 'active':
      // Cancelled-at-period-end subscriptions stay "active" at Dodo until the period closes: enforce the end ourselves in case the webhook is late.
      if (s.cancelAtPeriodEnd) return next && now > next ? { plan: 'free', renewsAt: null, canceled: false, status: 'ended' } : paid(next, true, 'active');
      return next && now > next + RENEWAL_GRACE_MS ? { plan: 'free', renewsAt: null, canceled: false, status: 'lapsed' } : paid(next, false, 'active');
    case 'past_due':                       // renewal failed, Dodo is retrying: access until the grace deadline it reports
      return ends && now < ends ? paid(next, false, 'past_due') : { plan: 'free', renewsAt: null, canceled: false, status: 'lapsed' };
    case 'cancelled':                      // cancelled now or at period end: paid-through date, if Dodo gave one
      return ends && now < ends ? paid(ends, true, 'active') : { plan: 'free', renewsAt: null, canceled: false, status: 'ended' };
    default:                               // pending, on_hold, paused, failed, expired
      return { plan: 'free', renewsAt: null, canceled: false, status: s.status || 'none' };
  }
}

/** Calendar day in India (the app is priced in rupees); the Free daily download count resets at midnight there. */
export const istDay = now => new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);

/** Turn Dodo's lifecycle fields into the compact `sub` we store. Unknown/missing fields stay null. */
export function subFromDodo(d, plan) {
  const ms = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  return {
    id: d.subscription_id, plan, status: String(d.status || ''),
    nextBillingDate: ms(d.next_billing_date),
    scheduled: d.scheduled_change ? { plan: plan === 'yearly' ? 'monthly' : 'yearly', at: ms(d.next_billing_date) } : null,       // a plan switch Dodo will apply at the next billing date
    cancelAtPeriodEnd: d.cancel_at_next_billing_date === true,
    // when access really stops: the grace deadline of a failed renewal, an explicit expiry, or (for a cancelled sub) the end of the paid period
    endsAt: ms(d.past_due_ends_at) || ms(d.expires_at) || (d.status === 'cancelled' ? ms(d.next_billing_date) : null),
  };
}
