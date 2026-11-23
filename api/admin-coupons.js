const { authenticatedUser, body, json, method, supabase, supabaseReady } = require('../lib/server');

const ADMIN_EMAIL = String(process.env.STORE_ADMIN_EMAIL || 'mishalmj03@gmail.com').trim().toLowerCase();
const CODE = /^[A-Z0-9_-]{3,24}$/;

function normalize(input, partial = false) {
  const data = {};
  if (!partial || input.code !== undefined) {
    data.code = String(input.code || '').trim().toUpperCase();
    if (!CODE.test(data.code)) throw new Error('Coupon codes must be 3–24 letters, numbers, hyphens, or underscores.');
  }
  if (!partial || input.discount_type !== undefined || input.discountType !== undefined) {
    data.discount_type = String(input.discount_type || input.discountType || '').trim().toLowerCase();
    if (!['percent', 'fixed'].includes(data.discount_type)) throw new Error('Choose a percentage or fixed discount.');
  }
  if (!partial || input.discount_value !== undefined || input.discountValue !== undefined) {
    data.discount_value = Number(input.discount_value ?? input.discountValue);
    const maximum = data.discount_type === 'percent' ? 100 : 1000000;
    if (!Number.isInteger(data.discount_value) || data.discount_value < 1 || data.discount_value > maximum) throw new Error('Enter a valid discount value.');
  }
  const fields = [
    ['min_subtotal', 'minSubtotal', 0, 10000000],
    ['max_discount', 'maxDiscount', 1, 10000000],
    ['usage_limit', 'usageLimit', 1, 10000000]
  ];
  for (const [column, camel, min, max] of fields) {
    if (!partial || input[column] !== undefined || input[camel] !== undefined) {
      const raw = input[column] ?? input[camel];
      if (raw === '' || raw == null) data[column] = column === 'min_subtotal' ? 0 : null;
      else {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Enter a valid ${camel.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`)}.`);
        data[column] = value;
      }
    }
  }
  for (const [column, camel] of [['starts_at', 'startsAt'], ['expires_at', 'expiresAt']]) {
    if (!partial || input[column] !== undefined || input[camel] !== undefined) {
      const raw = input[column] ?? input[camel];
      if (!raw) data[column] = null;
      else {
        const date = new Date(raw);
        if (!Number.isFinite(date.getTime())) throw new Error('Enter valid coupon dates.');
        data[column] = date.toISOString();
      }
    }
  }
  if (data.starts_at && data.expires_at && Date.parse(data.expires_at) <= Date.parse(data.starts_at)) throw new Error('The expiry must be after the start date.');
  if (!partial || input.active !== undefined) data.active = input.active === undefined ? true : Boolean(input.active);
  return data;
}

module.exports = async function adminCoupons(req, res) {
  if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Coupon management is temporarily unavailable.' });
  let user;
  try { user = await authenticatedUser(req); }
  catch { return json(res, 503, { error: 'Account verification is temporarily unavailable.' }); }
  if (!user) return json(res, 401, { error: 'Sign in to manage coupons.' });
  if (String(user.email || '').toLowerCase() !== ADMIN_EMAIL) return json(res, 403, { error: 'This account cannot manage store coupons.' });

  try {
    if (req.method === 'GET') {
      const coupons = await supabase('store_coupons?select=*&order=created_at.desc');
      return json(res, 200, { coupons });
    }
    let input;
    try { input = await body(req); }
    catch { return json(res, 400, { error: 'Check the coupon details and try again.' }); }
    const code = String(input.code || '').trim().toUpperCase();
    if (!CODE.test(code)) return json(res, 400, { error: 'Enter a valid coupon code.' });
    if (req.method === 'DELETE') {
      const removed = await supabase(`store_coupons?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!removed?.length) return json(res, 404, { error: 'Coupon not found.' });
      return json(res, 200, { deleted: true });
    }
    let data;
    try { data = normalize(input, req.method === 'PATCH'); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const result = await supabase(`store_coupons?code=eq.${encodeURIComponent(code)}`, {
      method: req.method === 'POST' ? 'POST' : 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(data)
    });
    if (req.method === 'PATCH' && !result?.length) return json(res, 404, { error: 'Coupon not found.' });
    return json(res, req.method === 'POST' ? 201 : 200, { coupon: result?.[0] || null });
  } catch (error) {
    const status = error.status === 409 ? 409 : error.status === 400 ? 400 : 503;
    return json(res, status, { error: status === 409 ? 'A coupon with this code already exists.' : status === 400 ? error.message : 'Coupon support needs the coupon database update. Please run the coupon SQL migration, then try again.' });
  }
};
