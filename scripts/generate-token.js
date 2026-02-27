#!/usr/bin/env node
/**
 * Generate a MapKit JS JWT token for use in HOTROD.
 *
 * Usage:
 *   node scripts/generate-token.js --key path/to/AuthKey_XXXXXXXXXX.p8 \
 *                                  --team-id XXXXXXXXXX \
 *                                  --key-id XXXXXXXXXX
 *
 * Outputs a signed JWT valid for 180 days.
 * Paste the output into your .env as MAPKIT_TOKEN=<token>
 *
 * Requirements:
 *   npm install  (jsonwebtoken is in devDependencies)
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

// ─── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const keyPath  = getArg('--key');
const teamId   = getArg('--team-id');
const keyId    = getArg('--key-id');

if (!keyPath || !teamId || !keyId) {
  console.error(`
Usage:
  node scripts/generate-token.js \\
    --key    path/to/AuthKey_XXXXXXXXXX.p8 \\
    --team-id XXXXXXXXXX \\
    --key-id  XXXXXXXXXX

Where to find these values:
  --key      Path to the .p8 file you downloaded from Apple Developer portal
  --team-id  Your 10-character Apple Team ID (top-right of developer.apple.com)
  --key-id   The 10-character Key ID shown next to your key in the portal
`);
  process.exit(1);
}

// ─── Load private key ────────────────────────────────────────────────────────

let privateKey;
try {
  privateKey = readFileSync(resolve(keyPath), 'utf8');
} catch (err) {
  console.error(`Error reading key file: ${err.message}`);
  process.exit(1);
}

// ─── Sign JWT ────────────────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);
const expiry = now + 60 * 60 * 24 * 180; // 180 days

const payload = {
  iss: teamId,
  iat: now,
  exp: expiry,
  sub: 'maps-scope',
};

const token = jwt.sign(payload, privateKey, {
  algorithm: 'ES256',
  header: {
    kid: keyId,
    typ: 'JWT',
    alg: 'ES256',
  },
});

// ─── Output ──────────────────────────────────────────────────────────────────

console.log('\n✅ MapKit JS token generated successfully!\n');
console.log('Add this to your .env file:\n');
console.log(`MAPKIT_TOKEN=${token}`);
console.log(`\nToken expires: ${new Date(expiry * 1000).toLocaleDateString()}`);
