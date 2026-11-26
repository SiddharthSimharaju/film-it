// Verifies a Google Sign-In ID token (RS256 JWT) on the server. The browser's claim of who someone is is never trusted.
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const MAX_AGE_S = 600;      // a sign-in token must be fresh: it is exchanged for a session immediately after Google issues it

const b64uToBytes = s => { const b = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(b + '='.repeat((4 - b.length % 4) % 4)), c => c.charCodeAt(0)); };
const parsePart = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

let jwksCache = { at: 0, keys: null };
export async function googleKeys(fetchImpl = fetch) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600000) return jwksCache.keys;
  const r = await fetchImpl(JWKS_URL); if (!r.ok) throw new Error('jwks fetch failed');
  const { keys } = await r.json(); jwksCache = { at: Date.now(), keys }; return keys;
}

/** @returns {Promise<{sub:string,email:string,name:string,picture:string}|null>} null for anything that does not verify */
export async function verifyGoogleToken(token, { aud, keys, now = Date.now() }) {
  try {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.'); if (parts.length !== 3) return null;
    const header = parsePart(parts[0]), p = parsePart(parts[1]);
    if (header.alg !== 'RS256') return null;
    const jwk = (keys || []).find(k => k.kid === header.kid && k.kty === 'RSA'); if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const t = Math.floor(now / 1000);
    if (p.aud !== aud || !ISSUERS.has(p.iss)) return null;
    if (!(p.exp > t - 60) || !(p.iat <= t + 60) || t - p.iat > MAX_AGE_S) return null;
    if (p.email_verified !== true && p.email_verified !== 'true') return null;
    if (typeof p.sub !== 'string' || !/^[0-9]{1,40}$/.test(p.sub) || typeof p.email !== 'string') return null;
    const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);
    const pic = typeof p.picture === 'string' && /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//i.test(p.picture) ? p.picture.slice(0, 500) : '';
    return { sub: p.sub, email: clean(p.email, 200).toLowerCase(), name: clean(p.name || p.email, 100), picture: pic };
  } catch { return null; }
}
