const { supabase } = require('./server');

function compareText(left, right) {
  const a = String(left || ''), b = String(right || '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function calculateQuote(items, requestedCode = '', userId = null, idempotencyKey = null) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw badRequest('Your bag is empty or contains too many items.');
  }

  const productIds = [...new Set(items.map(item => String(item?.productId || '')))];
  if (productIds.some(id => !/^[A-Za-z0-9_-]{1,100}$/.test(id))) {
    throw badRequest('A selected item is unavailable. Refresh the store and try again.');
  }
  const catalog = await supabase(`store_products?id=in.(${productIds.map(id => `"${id}"`).join(',')})&select=id,price,stock,active&active=eq.true`);
  const byId = new Map(catalog.map(product => [String(product.id), product]));
  const requestedById = new Map();
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!byId.has(String(item?.productId || '')) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw badRequest('A selected item is unavailable. Refresh the store and try again.');
    }
    const id = String(item.productId);
    requestedById.set(id, (requestedById.get(id) || 0) + quantity);
  }
  let prior = null;
  // A pending order created with this same idempotency key already holds its
  // stock. Add only that order's reservation back for the quote check so a
  // reload or a payment retry does not reject its own inventory hold.
  if (userId && idempotencyKey) {
    const existing = await supabase(`store_orders?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&user_id=eq.${encodeURIComponent(userId)}&select=id,payment_status,status,coupon_code&limit=1`);
    prior = existing?.[0] || null;
    if (prior && prior.payment_status === 'pending' && prior.status !== 'cancelled') {
      const held = await supabase(`store_order_items?order_id=eq.${encodeURIComponent(prior.id)}&select=product_id,quantity`);
      for (const line of held || []) {
        const id = String(line.product_id || '');
        if (requestedById.has(id) && byId.has(id)) {
          byId.get(id).stock = Number(byId.get(id).stock) + Number(line.quantity || 0);
        }
      }
    }
  }
  for (const [id, quantity] of requestedById) {
    if (quantity > Number(byId.get(id).stock)) throw badRequest('There is not enough stock for a selected piece. Update its quantity and try again.');
  }
  let subtotal = 0;
  const pricedLines = [];
  for (const [index, item] of items.entries()) {
    const product = byId.get(String(item?.productId || ''));
    const quantity = Number(item?.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw badRequest('A selected item is unavailable. Refresh the store and try again.');
    }
    const lineValue = Number(product.price) * quantity;
    if (!Number.isSafeInteger(lineValue) || lineValue < 0) throw badRequest('A selected item has an invalid price.');
    const rate = Number(product.price) <= 2500 ? 5 : 18;
    subtotal += lineValue;
    pricedLines.push({
      index,
      productId: String(item.productId),
      size: String(item.size || ''),
      color: String(item.color || ''),
      gross: lineValue,
      rate
    });
  }

  const code = String(requestedCode || '').trim().toUpperCase();
  let discountAmount = 0;
  let deliveryDiscount = 0;
  let couponCode = null;
  if (code) {
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw badRequest('Enter a valid coupon code.');
    const rows = await supabase(`store_coupons?code=eq.${encodeURIComponent(code)}&select=code,discount_type,discount_value,min_subtotal,max_discount,usage_limit,usage_count,per_user_limit,starts_at,expires_at,active&limit=1`);
    const coupon = rows?.[0];
    const now = Date.now();
    if (!coupon || !coupon.active) throw badRequest('This coupon is invalid or inactive.');
    if (coupon.starts_at && Date.parse(coupon.starts_at) > now) throw badRequest('This coupon is not active yet.');
    if (coupon.expires_at && Date.parse(coupon.expires_at) <= now) throw badRequest('This coupon has expired.');
    const currentOrderUsesCoupon = Boolean(prior && String(prior.coupon_code || '').toUpperCase() === code);
    let alreadyReservedUse = false;
    if (currentOrderUsesCoupon) {
      const redemption = await supabase(`store_coupon_redemptions?order_id=eq.${encodeURIComponent(prior.id)}&code=eq.${encodeURIComponent(code)}&status=in.(reserved,redeemed)&select=order_id&limit=1`);
      alreadyReservedUse = Boolean(redemption?.length);
    }
    const otherUses = Number(coupon.usage_count || 0) - (alreadyReservedUse ? 1 : 0);
    if (coupon.usage_limit != null && otherUses >= Number(coupon.usage_limit)) throw badRequest('This coupon has reached its use limit.');
    if (coupon.per_user_limit != null && userId) {
      const uses = await supabase(`store_coupon_redemptions?code=eq.${encodeURIComponent(code)}&user_id=eq.${encodeURIComponent(userId)}&status=in.(reserved,redeemed)&select=order_id`);
      const currentOrderId = prior?.id || null;
      const priorUses = (uses || []).filter(redemption => redemption.order_id !== currentOrderId).length;
      if (priorUses >= Number(coupon.per_user_limit)) throw badRequest('This coupon has reached your per-customer use limit.');
    }
    if (subtotal < Number(coupon.min_subtotal || 0)) throw badRequest(`This coupon needs a minimum items subtotal of ₹${Number(coupon.min_subtotal).toLocaleString('en-IN')}.`);
    if (coupon.discount_type === 'free_delivery') {
      const regularShipping = subtotal >= 2499 ? 0 : 99;
      if (!regularShipping) throw badRequest('This order already qualifies for free delivery.');
      deliveryDiscount = regularShipping;
    } else {
      const rawDiscount = coupon.discount_type === 'percent'
        ? Math.round(subtotal * Number(coupon.discount_value) / 100)
        : Number(coupon.discount_value);
      discountAmount = Math.min(subtotal, rawDiscount, coupon.max_discount == null ? subtotal : Number(coupon.max_discount));
    }
    couponCode = coupon.code;
  }

  // Discounts reduce the GST-inclusive taxable value. Allocate the exact
  // rupee discount proportionally using largest remainders; the SQL migration
  // uses the same stable tie-break order so the stored and displayed GST agree.
  pricedLines.sort((a, b) => compareText(a.productId, b.productId)
    || compareText(a.size, b.size) || compareText(a.color, b.color) || b.gross - a.gross);
  const shares = pricedLines.map(line => {
    const exact = subtotal ? line.gross * discountAmount / subtotal : 0;
    const base = Math.floor(exact);
    return { ...line, allocated: base, remainder: exact - base };
  });
  let unallocated = discountAmount - shares.reduce((sum, line) => sum + line.allocated, 0);
  for (const line of [...shares].sort((a, b) => b.remainder - a.remainder
    || compareText(a.productId, b.productId) || compareText(a.size, b.size)
    || compareText(a.color, b.color) || b.gross - a.gross)) {
    if (unallocated <= 0) break;
    line.allocated += 1;
    unallocated -= 1;
  }
  const lineItems = shares.map(line => ({
    index: line.index,
    gstAmount: Math.round((line.gross - line.allocated) * line.rate / (100 + line.rate))
  })).sort((a, b) => a.index - b.index);
  const gstAmount = lineItems.reduce((sum, line) => {
    return sum + line.gstAmount;
  }, 0);

  const shipping = subtotal >= 2499 ? 0 : 99;
  return { subtotal, gstAmount, lineItems, shipping, discountAmount, deliveryDiscount, couponCode, total: subtotal + shipping - discountAmount - deliveryDiscount };
}

module.exports = { calculateQuote };
