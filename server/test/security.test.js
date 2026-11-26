import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhook } from '../src/dodo.js';
import { verifyGoogleToken } from '../src/google.js';

const enc = new TextEncoder(), b64 = b => Buffer.from(b).toString('base64'), b64u = b => Buffer.from(b).toString('base64url');

// ---------- Dodo webhook signatures (Standard Webhooks) ----------
const SECRET_BYTES = crypto.getRandomValues(new Uint8Array(24)), SECRET = 'whsec_' + b64(SECRET_BYTES);
async function sign(id, ts, body, bytes = SECRET_BYTES) {
  const k = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'v1,' + b64(await crypto.subtle.sign('HMAC', k, enc.encode(`${id}.${ts}.${body}`)));
}
const hdr = (id, ts, sig) => new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sig });
const now = Date.now(), ts = Math.floor(now / 1000), body = '{"type":"payment.succeeded","data":{"payment_id":"pay_1"}}';

test('webhook: a correctly signed, fresh request is accepted', async () => {
  assert.equal(await verifyWebhook(SECRET, body, hdr('msg_1', ts, await sign('msg_1', ts, body)), now), true);
});
test('webhook: accepted when one of several space-separated signatures matches (secret rotation)', async () => {
  const good = await sign('msg_1', ts, body); assert.equal(await verifyWebhook(SECRET, body, hdr('msg_1', ts, 'v1,AAAA ' + good), now), true);
});
test('webhook: a changed body is rejected', async () => {
  assert.equal(await verifyWebhook(SECRET, body.replace('pay_1', 'pay_2'), hdr('msg_1', ts, await sign('msg_1', ts, body)), now), false);
});
test('webhook: a signature made with another secret is rejected', async () => {
  const other = crypto.getRandomValues(new Uint8Array(24));
  assert.equal(await verifyWebhook(SECRET, body, hdr('msg_1', ts, await sign('msg_1', ts, body, other)), now), false);
});
test('webhook: a different webhook-id than the signed one is rejected', async () => {
  assert.equal(await verifyWebhook(SECRET, body, hdr('msg_EVIL', ts, await sign('msg_1', ts, body)), now), false);
});
test('webhook: a request older than 5 minutes is rejected (replay)', async () => {
  const old = ts - 301; assert.equal(await verifyWebhook(SECRET, body, hdr('msg_1', old, await sign('msg_1', old, body)), now), false);
});
test('webhook: missing headers, no secret and junk signatures are rejected', async () => {
  assert.equal(await verifyWebhook(SECRET, body, new Headers(), now), false);
  assert.equal(await verifyWebhook('', body, hdr('msg_1', ts, await sign('msg_1', ts, body)), now), false);
  assert.equal(await verifyWebhook(SECRET, body, hdr('msg_1', ts, 'v1,!!!not-base64!!!'), now), false);
  assert.equal(await verifyWebhook(SECRET, body, hdr('msg_1', ts, 'v2,' + (await sign('msg_1', ts, body)).slice(3)), now), false);
});

// ---------- Google ID token verification ----------
const AUD = 'client-123.apps.googleusercontent.com';
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' }, KEYS = [jwk];
async function token(claims = {}, { header = { alg: 'RS256', kid: 'k1' }, key = kp.privateKey } = {}) {
  const p = { iss: 'https://accounts.google.com', aud: AUD, sub: '1234567890', email: 'a@b.test', email_verified: true, name: 'A B', iat: ts, exp: ts + 3600, ...claims };
  const h = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(p));
  return h + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(h)));
}
const verify = (t, over = {}) => verifyGoogleToken(t, { aud: AUD, keys: KEYS, now, ...over });

test('google: a valid token returns the verified profile', async () => {
  const u = await verify(await token()); assert.deepEqual([u.sub, u.email, u.name], ['1234567890', 'a@b.test', 'A B']);
});
test('google: wrong audience, wrong issuer, expired, stale and unverified email are all rejected', async () => {
  assert.equal(await verify(await token({ aud: 'someone-else' })), null);
  assert.equal(await verify(await token({ iss: 'https://evil.example' })), null);
  assert.equal(await verify(await token({ exp: ts - 3600, iat: ts - 7200 })), null);
  assert.equal(await verify(await token({ iat: ts - 3000 })), null, 'issued long ago: replay window');
  assert.equal(await verify(await token({ email_verified: false })), null);
});
test('google: a token signed with a different key is rejected', async () => {
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  assert.equal(await verify(await token({}, { key: other.privateKey })), null);
});
test('google: alg none / HS256 / unknown kid / tampered payload / junk are rejected', async () => {
  assert.equal(await verify(await token({}, { header: { alg: 'none', kid: 'k1' } })), null);
  assert.equal(await verify(await token({}, { header: { alg: 'HS256', kid: 'k1' } })), null);
  assert.equal(await verify(await token({}, { header: { alg: 'RS256', kid: 'nope' } })), null);
  const [h, , s] = (await token()).split('.'); assert.equal(await verify([h, b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: AUD, sub: '999', email: 'victim@x.test', email_verified: true, iat: ts, exp: ts + 3600 })), s].join('.')), null);
  for (const junk of ['', 'a.b', 'a.b.c', null, undefined, 42, 'x'.repeat(5000)]) assert.equal(await verify(junk), null);
});
test('google: a non-numeric subject is rejected and control characters are stripped from the name', async () => {
  assert.equal(await verify(await token({ sub: '../../admin' })), null);
  assert.equal((await verify(await token({ name: 'Eve\nTOTAL' }))).name, 'EveTOTAL');
});
