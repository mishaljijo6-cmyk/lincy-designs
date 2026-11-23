const { supabase } = require('./server');

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function calculateQuote(items, requestedCode = '') {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw badRequest('Your bag is empty or contains too many items.');
  }

  const catalog = await supabase('store_products?select=id,price,active&active=eq.true');
  const byId = new Map(catalog.map(product => [String(product.id), product]));
  let subtotal = 0;
  let gstAmount = 0;
  for (const item of items) {
    const product = byId.get(String(item?.productId || ''));
    const quantity = Number(item?.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw badRequest('A selected item is unavailable. Refresh the store and try again.');
    }
    const lineValue = Number(product.price) * quantity;
    if (!Number.isSafeInteger(lineValue) || lineValue < 0) throw badRequest('A selected item has an invalid price.');
    const rate = Number(product.price) <= 2500 ? 5 : 18;
    subtotal += lineValue;
    gstAmount += Math.round(lineValue * rate / (100 + rate));
  }

  const code = String(requestedCode || '').trim().toUpperCase();
  let discountAmount = 0;
  let couponCode = null;
  if (code) {
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw badRequest('Enter a valid coupon code.');
    const rows = await supabase(`store_coupons?code=eq.${encodeURIComponent(code)}&select=code,discount_type,discount_value,min_subtotal,max_discount,usage_limit,usage_count,starts_at,expires_at,active&limit=1`);
    const coupon = rows?.[0];
    const now = Date.now();
    if (!coupon || !coupon.active) throw badRequest('This coupon is invalid or inactive.');
    if (coupon.starts_at && Date.parse(coupon.starts_at) > now) throw badRequest('This coupon is not active yet.');
    if (coupon.expires_at && Date.parse(coupon.expires_at) <= now) throw badRequest('This coupon has expired.');
    if (coupon.usage_limit != null && Number(coupon.usage_count) >= Number(coupon.usage_limit)) throw badRequest('This coupon has reached its use limit.');
    if (subtotal < Number(coupon.min_subtotal || 0)) throw badRequest(`This coupon needs a minimum items subtotal of ₹${Number(coupon.min_subtotal).toLocaleString('en-IN')}.`);
    const rawDiscount = coupon.discount_type === 'percent'
      ? Math.round(subtotal * Number(coupon.discount_value) / 100)
      : Number(coupon.discount_value);
    discountAmount = Math.min(subtotal, rawDiscount, coupon.max_discount == null ? subtotal : Number(coupon.max_discount));
    couponCode = coupon.code;
  }

  const shipping = subtotal >= 2499 ? 0 : 99;
  return { subtotal, gstAmount, shipping, discountAmount, couponCode, total: subtotal + shipping - discountAmount };
}

module.exports = { calculateQuote };
