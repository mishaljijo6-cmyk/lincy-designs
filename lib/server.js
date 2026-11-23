const crypto = require('node:crypto');


const supabaseUrl = () => process.env.SUPABASE_URL || 'https://fszzfniakuwiuzupfcue.supabase.co';
// Supabase's new sb_secret_* keys are opaque API keys, not JWTs. Keep the
// legacy service_role JWT supported for existing deployments, but prefer the
// new secret key when both are configured.
const serviceKey = () => process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const isSupabaseSecretKey = key => String(key || '').startsWith('sb_secret_');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function method(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    json(res, 405, { error: 'Method not allowed.' });
    return false;
  }
  return true;
}

async function body(req, maxBytes = 24_000) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > maxBytes) throw new Error('Request is too large.');
    return JSON.parse(req.body || '{}');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function supabaseReady() {
  return Boolean(serviceKey());
}

async function supabase(path, options = {}) {
  const key = serviceKey();
  if (!key) throw new Error('Server database credentials are not configured.');
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(isSupabaseSecretKey(key) ? {} : { Authorization: `Bearer ${key}` }),
    ...(options.headers || {})
  };
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...options,
    headers
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(typeof data === 'object' ? (data.message || data.hint || 'Database request failed.') : 'Database request failed.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function rpc(name, args) {
  return supabase(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
}

async function authenticatedUser(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+([A-Za-z0-9._~-]+)$/i);
  const key = serviceKey();
  if (!match || !key) return null;
  const response = await fetch(`${supabaseUrl().replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${match[1]}` }
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (/invalid api key/i.test(String(result.message || result.msg || ''))) {
      const error = new Error('The Supabase server key is not accepted by the configured project.');
      error.code = 'SUPABASE_API_KEY';
      throw error;
    }
    return null;
  }
  const user = await response.json();
  return user && user.id ? user : null;
}

function isConfirmedStoreAdmin(user) {
  return Boolean(user && (user.email_confirmed_at || user.confirmed_at)
    && user.app_metadata?.store_role === 'admin');
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signature(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

module.exports = { authenticatedUser, body, isConfirmedStoreAdmin, json, method, rpc, secureEqual, signature, supabase, supabaseReady, supabaseUrl };
