const { authenticatedUser, body, json, method, supabaseReady } = require('../lib/server');
const { calculateQuote } = require('../lib/coupons');

module.exports = async function coupons(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Coupons are temporarily unavailable.' });
  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Enter a coupon code and try again.' }); }
  let user;
  try { user = await authenticatedUser(req); }
  catch { return json(res, 503, { error: 'Account verification is temporarily unavailable.' }); }
  if (!user) return json(res, 401, { error: 'Sign in to apply a coupon.' });
  try {
    const quote = await calculateQuote(input.items, input.code);
    return json(res, 200, { valid: true, ...quote });
  } catch (error) {
    if (error.status === 400) return json(res, 400, { error: error.message });
    if (/store_coupons|schema cache|column/i.test(error.message || '')) {
      return json(res, 503, { error: 'Coupon support needs the coupon database update. Please contact the store owner.' });
    }
    return json(res, 503, { error: 'We could not check that coupon right now. Please try again.' });
  }
};
