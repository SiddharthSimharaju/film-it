// One Durable Object per signed-in user. It is the ONLY writer of that user's plan and download count, so concurrent webhooks and
// concurrent download requests are serialised (KV alone cannot do atomic updates).
import { DurableObject } from 'cloudflare:workers';
import { FREE_DAILY_DOWNLOADS, PLANS } from './plans.js';
import { effective, istDay, newRecord } from './entitlement.js';

const MAX_PAYMENTS = 50;

export class Account extends DurableObject {
  async #load() { return (await this.ctx.storage.get('rec')) || newRecord(); }
  async #save(rec) { await this.ctx.storage.put('rec', rec); return rec; }

  /** Everything the app needs to draw the account screens. Never contains secrets. */
  async view(now = Date.now()) {
    const rec = await this.#load(), eff = effective(rec, now), day = istDay(now);
    return {
      profile: rec.profile, joined: rec.joined,
      plan: eff.plan, status: eff.status, renewsAt: eff.renewsAt, canceled: eff.canceled,
      hasSubscription: !!(rec.sub && rec.sub.id && (eff.plan === 'monthly' || eff.plan === 'yearly')),
      scheduledPlan: rec.sub && rec.sub.scheduled && (eff.plan === 'monthly' || eff.plan === 'yearly') ? rec.sub.scheduled.plan : null,
      scheduledAt: rec.sub && rec.sub.scheduled ? rec.sub.scheduled.at : null,
      invoices: rec.payments.map(p => ({ id: p.id, date: p.at, plan: p.plan, name: PLANS[p.plan]?.name || p.plan, amount: p.amount, currency: p.currency, status: p.status })),
      usage: { day, down: rec.usage.day === day ? rec.usage.down : 0, cap: eff.plan === 'free' ? FREE_DAILY_DOWNLOADS : 0 },
    };
  }

  /** Raw record for server-side decisions (never sent to the browser as is). */
  async raw() { return this.#load(); }

  async upsertProfile(profile, now = Date.now()) {
    const rec = await this.#load(); rec.profile = profile; rec.joined = rec.joined || now; await this.#save(rec);
  }
  async setCustomer(customerId) { const rec = await this.#load(); if (customerId && rec.customerId !== customerId) { rec.customerId = customerId; await this.#save(rec); } }

  async setSub(sub) { const rec = await this.#load(); rec.sub = sub; await this.#save(rec); }
  async grantLifetime(info) { const rec = await this.#load(); rec.lifetime = { paymentId: info.paymentId, at: info.at }; await this.#save(rec); }
  async revokeLifetime(paymentId) {
    const rec = await this.#load();
    if (rec.lifetime && (!paymentId || rec.lifetime.paymentId === paymentId)) { rec.lifetime = null; await this.#save(rec); }
  }
  /** Insert or update a payment (idempotent per payment id). */
  async recordPayment(p) {
    const rec = await this.#load(), i = rec.payments.findIndex(x => x.id === p.id);
    if (i >= 0) rec.payments[i] = { ...rec.payments[i], ...p }; else rec.payments.unshift(p);
    rec.payments = rec.payments.slice(0, MAX_PAYMENTS); await this.#save(rec);
  }
  async setPaymentStatus(id, status) {
    const rec = await this.#load(), p = rec.payments.find(x => x.id === id); if (!p) return false;
    p.status = status; await this.#save(rec); return true;
  }
  async ownsPayment(id) { return (await this.#load()).payments.some(p => p.id === id); }

  /** Count `n` downloads against today's allowance. Paid plans are unlimited and are not counted. Atomic: the whole body runs without interleaving. */
  async consumeDownloads(n, now = Date.now()) {
    n = Number.isInteger(n) && n >= 1 && n <= 100 ? n : 1;
    const rec = await this.#load(), eff = effective(rec, now), day = istDay(now);
    if (eff.plan !== 'free') return { allowed: true, unlimited: true, used: 0, remaining: Infinity };
    if (rec.usage.day !== day) rec.usage = { day, down: 0 };
    if (rec.usage.down + n > FREE_DAILY_DOWNLOADS) return { allowed: false, unlimited: false, used: rec.usage.down, remaining: Math.max(0, FREE_DAILY_DOWNLOADS - rec.usage.down) };
    rec.usage.down += n; await this.#save(rec);
    return { allowed: true, unlimited: false, used: rec.usage.down, remaining: FREE_DAILY_DOWNLOADS - rec.usage.down };
  }

  async destroy() { await this.ctx.storage.deleteAll(); }
}
