// Filmroom API (Cloudflare Worker). Owns identity, plans, billing and the Free daily download count.
// Browser -> this Worker (Authorization: Bearer <session>) -> Dodo Payments. Dodo -> /webhooks/dodo is the ONLY thing that grants a plan.
import * as dodo from './dodo.js';
import { googleKeys, verifyGoogleToken } from './google.js';
import { PLANS, productIds } from './plans.js';
import { subFromDodo } from './entitlement.js';
import { processEvent } from './webhook.js';
import { CID_RE, sendGa } from './analytics.js';
export { Account } from './account.js';

const SESSION_TTL_S = 30 * 86400;
const MAX_BODY = 8192;

// ---------- small helpers ----------
const allowedOrigins = env => new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
function corsHeaders(req, env) {
  const o = req.headers.get('origin'), h = { vary: 'origin' };
  if (o && allowedOrigins(env).has(o)) Object.assign(h, { 'access-control-allow-origin': o, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '86400', 'access-control-expose-headers': 'content-disposition' });
  return h;
}
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data, (k, v) => (v === Infinity ? null : v)), { status, headers: { 'content-type': 'application/json', ...SEC, ...extra } });
const fail = (status, error, message) => json({ error, message }, status);

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}
const sha256hex = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const newToken = () => 'fr_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Test mode and live mode keep SEPARATE accounts: a purchase made with a test card must never grant Pro once the site is live (and live
// accounts start empty). Test-mode ids stay unprefixed, so nothing that already exists moves.
const accountFor = env => sub => env.ACCOUNT.get(env.ACCOUNT.idFromName(env.DODO_ENV === 'live_mode' ? `live:${sub}` : sub));
const clientIp = req => req.headers.get('cf-connecting-ip') || 'unknown';
async function limited(env, name, key) { const rl = env[name]; if (!rl) return false; const { success } = await rl.limit({ key }); return !success; }

// ---------- sessions: opaque random tokens, only their hash is stored, revocable, 30 days ----------
// Test and live mode have separate sessions too (like separate accounts): a login from test mode is simply not valid once the API is live.
const sessionKey = (env, h) => `${env.DODO_ENV === 'live_mode' ? 'live:' : ''}s:${h}`;
const indexKey = (env, sub, h = '') => `${env.DODO_ENV === 'live_mode' ? 'live:' : ''}u:${sub}:${h}`;
async function startSession(env, sub) {
  const token = newToken(), h = await sha256hex(token);
  await env.KV.put(sessionKey(env, h), sub, { expirationTtl: SESSION_TTL_S });
  await env.KV.put(indexKey(env, sub, h), '1', { expirationTtl: SESSION_TTL_S });     // per-user index, so "delete account" can revoke every session
  return token;
}
async function authenticate(req, env) {
  const m = /^Bearer (fr_[A-Za-z0-9_-]{40,50})$/.exec(req.headers.get('authorization') || ''); if (!m) return null;
  const h = await sha256hex(m[1]), sub = await env.KV.get(sessionKey(env, h)); return sub ? { sub, hash: h } : null;
}
async function endSessions(env, sub) {
  let cursor; do {
    const l = await env.KV.list({ prefix: indexKey(env, sub), cursor });
    await Promise.all(l.keys.flatMap(k => [env.KV.delete(k.name), env.KV.delete(sessionKey(env, k.name.split(':').pop()))]));
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
}

const dodoErr = e => e instanceof dodo.DodoError ? fail(502, 'payment_provider', 'The payment provider could not complete that. Please try again.') : fail(500, 'server', 'Something went wrong. Please try again.');

// ---------- routes ----------
const routes = {
  'GET /health': async (req, env) => json({ ok: true, mode: env.DODO_ENV || 'test_mode' }),

  'POST /auth/google': async (req, env) => {
    if (await limited(env, 'RL', 'auth:' + clientIp(req))) return fail(429, 'rate_limited', 'Too many attempts. Try again in a minute.');
    const { credential } = await readJson(req);
    const u = await verifyGoogleToken(credential, { aud: env.GOOGLE_CLIENT_ID, keys: await googleKeys() });
    if (!u) return fail(401, 'bad_token', 'Could not verify that Google sign-in.');
    const acct = accountFor(env)(u.sub);
    await acct.upsertProfile({ name: u.name, email: u.email, picture: u.picture });
    return json({ token: await startSession(env, u.sub), account: await acct.view() });
  },

  'POST /auth/signout': async (req, env, a) => { await env.KV.delete(sessionKey(env, a.hash)); await env.KV.delete(indexKey(env, a.sub, a.hash)); return json({ ok: true }); },

  'GET /me': async (req, env, a) => json({ account: await accountFor(env)(a.sub).view() }),

  'DELETE /me': async (req, env, a) => {
    const acct = accountFor(env)(a.sub), v = await acct.view();
    if (v.hasSubscription && !v.canceled) return fail(409, 'active_subscription', 'Cancel your subscription first, then delete your account.');
    await acct.destroy(); await endSessions(env, a.sub);
    return json({ ok: true });
  },

  'POST /checkout': async (req, env, a) => {
    if (await limited(env, 'RL', 'co:' + a.sub)) return fail(429, 'rate_limited', 'Too many attempts. Try again in a minute.');
    const { plan } = await readJson(req);
    if (typeof plan !== 'string' || !Object.hasOwn(PLANS, plan)) return fail(400, 'bad_plan', 'Unknown plan.');
    const productId = productIds(env)[plan]; if (!productId) return fail(500, 'not_configured', 'This plan is not available right now.');
    const acct = accountFor(env)(a.sub), v = await acct.view();
    if (v.plan === 'lifetime') return fail(409, 'already_lifetime', 'You already have Lifetime access.');
    if (PLANS[plan].recurring && v.hasSubscription) return fail(409, 'already_subscribed', 'You already have a subscription. Cancel it first, then choose a new plan.');
    try {
      const s = await dodo.createCheckout(env, {
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: v.profile.email, name: v.profile.name },
        metadata: { sub: a.sub, plan },
        return_url: `${env.SITE_URL}/?checkout=done`,
      });
      if (!s.checkout_url || !/^https:\/\/(test\.)?checkout\.dodopayments\.com\//.test(s.checkout_url)) return fail(502, 'payment_provider', 'The payment provider did not return a checkout page.');
      return json({ url: s.checkout_url });
    } catch (e) { console.error('checkout failed', e.status, e.body); return dodoErr(e); }
  },

  'POST /billing/cancel': (req, env, a) => setCancel(env, a, true),
  'POST /billing/resume': (req, env, a) => setCancel(env, a, false),

  'POST /billing/change-plan/preview': (req, env, a) => changePlan(req, env, a, true),
  'POST /billing/change-plan': (req, env, a) => changePlan(req, env, a, false),
  'POST /billing/change-plan/cancel': async (req, env, a) => {
    const acct = accountFor(env)(a.sub), rec = await acct.raw();
    if (!rec.sub || !rec.sub.scheduled) return fail(409, 'nothing_scheduled', 'There is no plan switch scheduled.');
    try {
      await dodo.cancelScheduledChange(env, rec.sub.id);
      await acct.setSub(subFromDodo(await dodo.getSubscription(env, rec.sub.id), rec.sub.plan));
      return json({ account: await acct.view() });
    } catch (e) { console.error('unschedule failed', e.status, e.body); return dodoErr(e); }
  },

  // The page calls this ONLY after the person accepted analytics (cid = their Google Analytics client id), or with cid null to forget it.
  // With a cid on file, subscription events (started, renewed, ended, refunded) are sent to Google Analytics for that visitor; without one, nothing is.
  'POST /analytics/link': async (req, env, a) => {
    const { cid } = await readJson(req);
    if (cid !== null && !(typeof cid === 'string' && CID_RE.test(cid))) return fail(400, 'bad_cid', 'Invalid analytics id.');
    await accountFor(env)(a.sub).setGa(cid);
    return json({ ok: true });
  },

  'POST /billing/portal': async (req, env, a) => {
    const rec = await accountFor(env)(a.sub).raw();
    if (!rec.customerId) return fail(404, 'no_customer', 'There is no billing profile yet. It is created with your first purchase.');
    try { const r = await dodo.portalLink(env, rec.customerId, env.SITE_URL); return json({ url: r.link }); } catch (e) { console.error('portal failed', e.status, e.body); return dodoErr(e); }
  },

  'POST /usage/download': async (req, env, a) => {
    const { n } = await readJson(req);
    return json(await accountFor(env)(a.sub).consumeDownloads(n));
  },
};

// Monthly <-> Yearly for someone who already subscribes. Dodo's rules: a LONGER plan (monthly -> yearly) starts now, charging the new price minus credit for the
// unused time; a SHORTER plan (yearly -> monthly) can only start at the next billing date, so it is scheduled and nothing is charged now.
async function changePlan(req, env, a, previewOnly) {
  if (await limited(env, 'RL', 'cp:' + a.sub)) return fail(429, 'rate_limited', 'Too many attempts. Try again in a minute.');
  const { plan: to } = await readJson(req);
  const acct = accountFor(env)(a.sub), rec = await acct.raw(), v = await acct.view();
  if (to !== 'monthly' && to !== 'yearly') return fail(400, 'bad_plan', 'You can switch between Monthly and Yearly here.');
  if (!v.hasSubscription || !rec.sub || rec.sub.status !== 'active') return fail(409, 'no_subscription', 'You do not have an active subscription to switch.');
  if (v.canceled) return fail(409, 'cancelling', 'Your subscription is set to end. Resume it first, then switch plans.');
  const from = rec.sub.plan; if (from === to) return fail(409, 'same_plan', 'You are already on that plan.');
  const upgrade = from === 'monthly';                        // monthly -> yearly
  const body = { product_id: productIds(env)[to], quantity: 1, cancel_scheduled_change_plan: true,
    ...(upgrade ? { proration_billing_mode: 'prorated_immediately', effective_at: 'immediately', on_payment_failure: 'prevent_change', return_url: `${env.SITE_URL}/?checkout=done` }
                : { proration_billing_mode: 'full_immediately', effective_at: 'next_billing_date' }) };
  if (!body.product_id) return fail(500, 'not_configured', 'This plan is not available right now.');
  try {
    if (previewOnly) {
      if (!upgrade) return json({ kind: 'downgrade', from, to, effectiveAt: v.renewsAt });
      const p = await dodo.previewChangePlan(env, rec.sub.id, body), sum = p.immediate_charge && p.immediate_charge.summary || {};
      return json({ kind: 'upgrade', from, to, chargeNow: Number(sum.total_amount) / 100, currency: String(sum.currency || 'INR'), nextBillingDate: p.new_plan && Date.parse(p.new_plan.next_billing_date) || null });
    }
    const r = await dodo.changePlan(env, rec.sub.id, body);
    if (!upgrade) { await acct.setSub(subFromDodo(await dodo.getSubscription(env, rec.sub.id), from)); return json({ kind: 'downgrade', account: await acct.view() }); }
    const link = r && r.payment_link;                         // the saved card needs an extra step (for example a bank check): send them to finish it
    return json({ kind: 'upgrade', url: typeof link === 'string' && /^https:\/\/([a-z0-9-]+\.)*dodopayments\.com\//.test(link) ? link : null });
  } catch (e) { console.error('change plan failed', e.status, e.body); return dodoErr(e); }
}

async function setCancel(env, a, on) {
  const acct = accountFor(env)(a.sub), rec = await acct.raw(), v = await acct.view();
  if (!v.hasSubscription || !rec.sub) return fail(409, 'no_subscription', 'You do not have a subscription.');
  try {
    await dodo.setCancelAtPeriodEnd(env, rec.sub.id, on);
    const fresh = await dodo.getSubscription(env, rec.sub.id);                       // store what Dodo says, not what we hope happened
    await acct.setSub(subFromDodo(fresh, rec.sub.plan));
    return json({ account: await acct.view() });
  } catch (e) { console.error('cancel failed', e.status, e.body); return dodoErr(e); }
}

const dynamicRoutes = [
  [/^GET \/billing\/invoice\/(pay_[A-Za-z0-9_-]{1,64})$/, async (req, env, a, m) => {
    if (!(await accountFor(env)(a.sub).ownsPayment(m[1]))) return fail(404, 'not_found', 'No such invoice.');       // only invoices of payments recorded for THIS account
    try {
      const r = await dodo.invoicePdf(env, m[1]);
      return new Response(r.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="filmroom-invoice-${m[1]}.pdf"`, ...SEC } });
    } catch (e) { console.error('invoice failed', e.status, e.body); return dodoErr(e); }
  }],
];

// ---------- webhook (public URL, authenticated by signature only) ----------
async function webhook(req, env) {
  const raw = await req.text();
  if (raw.length > 1_000_000) return fail(413, 'too_large', 'Too large.');
  if (!(await dodo.verifyWebhook(env.DODO_WEBHOOK_SECRET, raw, req.headers))) return fail(401, 'bad_signature', 'Invalid signature.');
  const id = req.headers.get('webhook-id');
  if (await env.KV.get(`e:${id}`)) return json({ ok: true, duplicate: true });                 // Dodo retries: handle each delivery once
  let event; try { event = JSON.parse(raw); } catch { return fail(400, 'bad_json', 'Invalid JSON.'); }
  try {
    const result = await processEvent(event, { env, kv: env.KV, api: dodo, accountFor: accountFor(env), ga: sendGa });
    await env.KV.put(`e:${id}`, '1', { expirationTtl: 7 * 86400 });
    console.log('webhook', event.type, JSON.stringify(result));
    return json({ ok: true });
  } catch (e) { console.error('webhook failed', event && event.type, e.status || '', e.body || e.message); return fail(500, 'retry', 'Processing failed; please retry.'); }   // non-2xx makes Dodo retry
}

// ---------- local development only: enabled by ENABLE_DEV_ROUTES=1 in server/.dev.vars, which is never deployed ----------
async function devRoutes(req, env, url) {
  if (url.pathname === '/dev/login' && req.method === 'POST') {
    const { sub = 'dev-user', email = 'dev@example.com', name = 'Dev User' } = await readJson(req);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sub)) return fail(400, 'bad_sub', 'bad sub');
    const acct = accountFor(env)(sub); await acct.upsertProfile({ name: String(name).slice(0, 100), email: String(email).slice(0, 200), picture: '' });
    return json({ token: await startSession(env, sub), account: await acct.view() });
  }
  if (url.pathname === '/dev/reset' && req.method === 'POST') {            // wipe one test account (and its sessions) so each test starts clean
    const { sub = 'demo-google-user' } = await readJson(req);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sub)) return fail(400, 'bad_sub', 'bad sub');
    await accountFor(env)(sub).destroy(); await endSessions(env, sub); return json({ ok: true });
  }
  if (url.pathname === '/dev/grant' && req.method === 'POST') {
    const a = await authenticate(req, env); if (!a) return fail(401, 'unauthorized', 'Sign in first.');
    const { plan, nextBillingDate, cancelAtPeriodEnd = false, status = 'active' } = await readJson(req), acct = accountFor(env)(a.sub), now = Date.now();
    if (plan === 'lifetime') await acct.grantLifetime({ paymentId: 'pay_dev', at: now });
    else if (plan === 'monthly' || plan === 'yearly') await acct.setSub({ id: 'sub_dev', plan, status, nextBillingDate: Number.isFinite(nextBillingDate) ? nextBillingDate : now + 30 * 86400000, cancelAtPeriodEnd: !!cancelAtPeriodEnd, endsAt: null });
    else { await acct.revokeLifetime(); await acct.setSub(null); }
    if (PLANS[plan]) { await acct.setCustomer('cus_dev'); await acct.recordPayment({ id: 'pay_dev1', plan, amount: { monthly: 149, yearly: 1499, lifetime: 3499 }[plan], currency: 'INR', at: now, status: 'succeeded', subId: null }); }
    return json({ account: await acct.view() });
  }
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), cors = corsHeaders(req, env);
    const done = res => { for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); return res; };
    try {
      if (req.method === 'OPTIONS') return done(new Response(null, { status: 204, headers: SEC }));
      if (req.method === 'POST' && url.pathname === '/webhooks/dodo') return await webhook(req, env);          // server-to-server: no CORS
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/webhooks/dodo') return json({ ok: true, message: 'Dodo Payments posts signed events to this address.' });   // so an address check or a browser visit looks healthy
      if (env.ENABLE_DEV_ROUTES === '1' && url.pathname.startsWith('/dev/')) { const r = await devRoutes(req, env, url); if (r) return done(r); }
      const key = `${req.method} ${url.pathname}`;
      const open = key === 'GET /health' || key === 'POST /auth/google';
      let handler = routes[key], m = null;
      if (!handler) for (const [re, h] of dynamicRoutes) { m = re.exec(key); if (m) { handler = h; break; } }
      if (!handler) return done(fail(404, 'not_found', 'Not found.'));
      const origin = req.headers.get('origin');
      if (origin && !allowedOrigins(env).has(origin)) return done(fail(403, 'bad_origin', 'Origin not allowed.'));
      let a = null;
      if (!open) { a = await authenticate(req, env); if (!a) return done(fail(401, 'unauthorized', 'Please sign in again.')); }
      return done(await handler(req, env, a, m));
    } catch (e) {
      if (e && e.status) return done(fail(e.status, 'bad_request', e.message));
      console.error('unhandled', e && e.stack || e); return done(fail(500, 'server', 'Something went wrong.'));
    }
  },
};
