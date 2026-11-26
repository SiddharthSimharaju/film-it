// Dodo Payments: a tiny REST client and Standard Webhooks signature verification (no SDK, so nothing extra to bundle or audit).
export const dodoBase = env => env.DODO_BASE || (env.DODO_ENV === 'live_mode' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com');

export class DodoError extends Error { constructor(status, body) { super(`Dodo ${status}`); this.status = status; this.body = body; } }

async function call(env, method, path, body, raw = false) {
  const r = await fetch(dodoBase(env) + path, {
    method, headers: { authorization: `Bearer ${env.DODO_API_KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new DodoError(r.status, (await r.text().catch(() => '')).slice(0, 500));
  return raw ? r : r.json();
}

export const createCheckout = (env, body) => call(env, 'POST', '/checkouts', body);
export const getSubscription = (env, id) => call(env, 'GET', `/subscriptions/${encodeURIComponent(id)}`);
export const getPayment = (env, id) => call(env, 'GET', `/payments/${encodeURIComponent(id)}`);
export const setCancelAtPeriodEnd = (env, id, on) => call(env, 'PATCH', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_next_billing_date: !!on });
export const portalLink = (env, customerId, returnUrl) => call(env, 'POST', `/customers/${encodeURIComponent(customerId)}/customer-portal/session`, returnUrl ? { return_url: returnUrl } : undefined);
export const invoicePdf = (env, paymentId) => call(env, 'GET', `/invoices/payments/${encodeURIComponent(paymentId)}`, null, true);

// ---- Standard Webhooks (https://www.standardwebhooks.com): HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` ----
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const TOLERANCE_S = 300;

/** True only if the request was signed with our webhook secret and is recent. `rawBody` must be the exact bytes received, as text. */
export async function verifyWebhook(secret, rawBody, headers, now = Date.now()) {
  try {
    const id = headers.get('webhook-id'), ts = headers.get('webhook-timestamp'), sigs = headers.get('webhook-signature');
    if (!secret || !id || !ts || !sigs) return false;
    if (!/^\d{1,12}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > TOLERANCE_S) return false;      // replay protection
    const key = await crypto.subtle.importKey('raw', b64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const data = new TextEncoder().encode(`${id}.${ts}.${rawBody}`);
    for (const part of sigs.split(' ')) {
      const [ver, sig] = part.split(',');
      if (ver !== 'v1' || !sig) continue;
      let bytes; try { bytes = b64ToBytes(sig); } catch { continue; }
      if (await crypto.subtle.verify('HMAC', key, bytes, data)) return true;                          // verify() compares in constant time
    }
    return false;
  } catch { return false; }
}
