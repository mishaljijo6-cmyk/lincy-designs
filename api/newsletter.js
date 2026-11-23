const { body, json, method, supabase, supabaseReady } = require('../lib/server');

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
