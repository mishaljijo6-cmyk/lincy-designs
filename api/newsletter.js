const { createHash } = require('node:crypto');
const { body, json, method, rpc, supabase, supabaseReady } = require('../lib/server');

module.exports = async function newsletter(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Newsletter sign-up is not available yet.' });
  let input;
  try { input = await body(req, 2_000); }
  catch { return json(res, 400, { error: 'Please enter a valid email address.' }); }
  const email = String(input.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 400, { error: 'Please enter a valid email address.' });
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
  try {
    const ipAllowed = await rpc('consume_store_rate_limit', { p_key: `newsletter-ip:${digest(ip)}`, p_limit: 10, p_window_seconds: 3600 });
    const emailAllowed = await rpc('consume_store_rate_limit', { p_key: `newsletter-email:${digest(email)}`, p_limit: 3, p_window_seconds: 86400 });
    if (!ipAllowed || !emailAllowed) return json(res, 429, { error: 'Too many sign-up attempts. Please try again later.' });
  } catch { return json(res, 503, { error: 'Newsletter sign-up is temporarily unavailable. Please try again later.' }); }
  try {
    await supabase('newsletter_subscribers?on_conflict=email', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ email })
    });
    return json(res, 201, { subscribed: true });
  } catch (error) {
    return json(res, error.status === 404 ? 503 : 500, {
      error: error.status === 404 ? 'Newsletter sign-up is being connected. Please try again soon.' : 'We could not save your sign-up. Please try again.'
    });
  }
};
