/**
 * Signs short-lived MapKit JS tokens on demand so the deployed app never ships
 * a baked-in JWT that silently expires (a 180-day build-time token is what
 * left the map blank once it lapsed).
 *
 * Required env (Vercel project env vars / Worker secrets / .env):
 *   MAPKIT_PRIVATE_KEY  contents of the AuthKey_XXXXXXXXXX.p8 file (PEM; "\n" escapes ok)
 *   MAPKIT_TEAM_ID      10-char Apple Team ID
 *   MAPKIT_KEY_ID       10-char Key ID
 *
 * Uses WebCrypto only, so it runs on Node 18+, Vercel and Cloudflare Workers.
 */

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; MapKit re-requests via authorizationCallback

let cachedKey = null;
let cachedKeyPem = null;
let cachedToken = null; // { token, exp, origin }

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function importKey(pem) {
  if (cachedKey && cachedKeyPem === pem) return cachedKey;
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  cachedKey = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  cachedKeyPem = pem;
  return cachedKey;
}

export function readMapkitEnv(env = {}) {
  const pe = typeof process !== 'undefined' && process.env ? process.env : {};
  return {
    privateKey: env.MAPKIT_PRIVATE_KEY || pe.MAPKIT_PRIVATE_KEY || '',
    teamId:     env.MAPKIT_TEAM_ID     || pe.MAPKIT_TEAM_ID     || '',
    keyId:      env.MAPKIT_KEY_ID      || pe.MAPKIT_KEY_ID      || '',
  };
}

/** Returns a signed JWT, or null if signing credentials aren't configured. */
export async function getMapkitToken(env, origin) {
  const { privateKey, teamId, keyId } = readMapkitEnv(env);
  if (!privateKey || !teamId || !keyId) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.origin === (origin || '') && cachedToken.exp - now > 300) {
    return cachedToken.token;
  }

  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: teamId, iat: now, exp: now + TOKEN_TTL_SECONDS, sub: 'maps-scope' };
  if (origin) payload.origin = origin;

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await importKey(privateKey);
  // WebCrypto ECDSA output is already the raw r||s form that JWS ES256 expects.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput),
  ));
  const token = `${signingInput}.${b64url(sig)}`;
  cachedToken = { token, exp: payload.exp, origin: origin || '' };
  return token;
}
