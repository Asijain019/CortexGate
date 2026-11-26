import crypto from 'node:crypto';

/** Client key: `cg-` + 40 url-safe characters (30 random bytes, base64url). */
export function generateClientKey() {
  return `cg-${crypto.randomBytes(30).toString('base64url')}`;
}

/** Admin token: 32 random bytes as 64 hex chars. */
export function generateAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** CORTEX_SECRET_KEY: 32 random bytes as 64 hex chars (the gateway decodes hex keys directly). */
export function generateSecretKey() {
  return crypto.randomBytes(32).toString('hex');
}

export const CLIENT_KEY_RE = /^cg-[A-Za-z0-9_-]{40}$/;

/** `cg-abcd…wxyz` for display; never shows the middle of a secret. */
export function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 10) return '•'.repeat(v.length);
  const head = v.startsWith('cg-') ? v.slice(0, 7) : v.slice(0, 4);
  return `${head}…${v.slice(-4)}`;
}
