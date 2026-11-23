const { authenticatedUser, body, json, method, rpc, supabase, supabaseReady } = require('../lib/server');
const { calculateQuote } = require('../lib/coupons');

async function razorpayPayments(orderId) {
  const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.items)) throw new Error('Could not safely check the earlier payment.');
  return data.items;
}

async function releaseAbandonedOrders() {
  try {
    const cutoff = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const pending = await supabase(`store_orders?payment_status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&select=id,total,razorpay_order_id&order=created_at.asc&limit=50`);
    for (const order of pending) {
      if (!order.razorpay_order_id) {
        await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null });
        continue;
      }
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) continue;
      const payments = await razorpayPayments(order.razorpay_order_id);
      const captured = payments.find(payment => payment.status === 'captured' && payment.order_id === order.razorpay_order_id && payment.amount === Number(order.total) * 100 && payment.currency === 'INR');
      if (captured) {
        await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.pending&razorpay_order_id=eq.${encodeURIComponent(order.razorpay_order_id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ payment_status: 'paid', payment_provider: 'razorpay', payment_reference: captured.id })
        });
        continue;
      }
      // Keep authorized or otherwise unresolved attempts reserved. Release only
      // after Razorpay confirms there is no successful payment for the order.
      if (payments.every(payment => ['failed', 'created'].includes(payment.status))) {
        await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: order.razorpay_order_id });
      }
    }
  } catch { /* Never block a new checkout because reconciliation is unavailable. */ }
}

module.exports = async function checkout(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Checkout is being connected. Please try again later.' });
  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Please check your checkout details and try again.' }); }
  let user;
  try { user = await authenticatedUser(req); }
  catch (error) {
    return json(res, 503, { error: error.code === 'SUPABASE_API_KEY'
      ? 'The store account connection needs its Supabase server key checked in Vercel Production. Your bag is saved.'
      : 'Account verification is temporarily unavailable. Please try again.' });
  }
  if (!user) return json(res, 401, { error: 'Sign in to place and track your order.' });
  await releaseAbandonedOrders();

  const provider = input.provider === 'cod' ? 'cod' : 'razorpay';
  const customer = input.customer || {};
  const items = Array.isArray(input.items) ? input.items : [];
  const idempotencyKey = String(input.idempotencyKey || '').slice(0, 100);
  if (!idempotencyKey || !items.length || items.length > 20) return json(res, 400, { error: 'Your cart is empty or invalid.' });
  if (provider === 'razorpay' && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)) {
    return json(res, 503, { error: 'Razorpay is not configured yet. Please choose Cash on Delivery.' });
  }

  // Reprice items and validate any coupon against server-side catalogue data.
  let quote;
  try {
    quote = await calculateQuote(items, input.couponCode || '');
  } catch (error) {
    if (error.status === 400) return json(res, 400, { error: error.message });
    if (/store_coupons|schema cache|coupon_code|discount_amount/i.test(error.message || '')) {
      return json(res, 503, { error: 'Coupon checkout needs the coupon database update. Your bag is saved.' });
    }
    const status = error.status === 401 || error.status === 403 || error.status === 404 ? 503 : 502;
    return json(res, status, { error: 'Checkout is temporarily unavailable while the store connection is being fixed. Your bag is still saved.' });
  }
  const requestedQuote = {
    subtotal: Number(input.expectedSubtotal),
    shipping: Number(input.expectedShipping),
    gstAmount: Number(input.expectedGstAmount),
    total: Number(input.expectedTotal)
  };
  const quoteChanged = ['subtotal', 'shipping', 'gstAmount', 'total'].some(key => requestedQuote[key] !== quote[key]) ||
    (input.expectedDiscountAmount != null && Number(input.expectedDiscountAmount) !== quote.discountAmount) ||
    (String(input.couponCode || '').trim().toUpperCase() || null) !== quote.couponCode;
  if (quoteChanged) {
    return json(res, 409, {
      error: 'A price, coupon, or delivery charge changed. Review the updated breakdown before paying.',
      quote
    });
  }

  // Resolve the idempotent attempt before invoking the database RPC. The RPC
  // deliberately rejects switching providers on a pending order; close and
  // release that attempt here so the shopper can review and retry safely.
  try {
    const priorSelect = quote.couponCode ? 'id,user_id,payment_status,payment_provider,order_number,total,razorpay_order_id,coupon_code,discount_amount' : 'id,user_id,payment_status,payment_provider,order_number,total,razorpay_order_id';
    const priorRows = await supabase(`store_orders?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=${priorSelect}`);
    const prior = priorRows?.[0];
    if (prior && prior.user_id !== user.id) {
      return json(res, 409, { error: 'This checkout belongs to another account. Start again from your own bag.' });
    }
    if (prior?.payment_status === 'pending' && prior.payment_provider !== provider) {
      if (prior.payment_provider === 'razorpay' && prior.razorpay_order_id) {
        let payments;
        try { payments = await razorpayPayments(prior.razorpay_order_id); }
        catch { return json(res, 503, { error: 'We could not confirm the earlier payment yet. Please wait and check My orders before trying another method.' }); }
        const captured = payments.find(payment => payment.status === 'captured' && payment.order_id === prior.razorpay_order_id && payment.amount === Number(prior.total) * 100 && payment.currency === 'INR');
        if (captured) {
          await supabase(`store_orders?id=eq.${encodeURIComponent(prior.id)}&payment_status=eq.pending&razorpay_order_id=eq.${encodeURIComponent(prior.razorpay_order_id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ payment_status: 'paid', payment_provider: 'razorpay', payment_reference: captured.id })
          });
          return json(res, 200, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: 'paid', total: prior.total, ...quote });
        }
        if (payments.some(payment => ['created', 'authorized'].includes(payment.status))) {
          return json(res, 409, { error: 'The earlier payment is still open. Finish it or wait for it to close, then check My orders before starting another payment.' });
        }
      }
      const released = await rpc('fail_checkout_order', { p_order_id: prior.id, p_razorpay_order_id: null });
      if (released) return json(res, 409, {
        error: 'The earlier payment attempt has been closed. Review the updated total, then continue with your selected payment method.',
        quote,
        restartCheckout: true
      });
      const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(prior.id)}&select=order_number,payment_status,payment_reference,total`);
      if (latest?.[0]?.payment_status === 'paid') {
        return json(res, 200, { orderNumber: latest[0].order_number, storeOrderId: prior.id, payment: 'paid', total: latest[0].total });
      }
      return json(res, 409, { error: 'The earlier payment attempt is still being confirmed. Please wait a moment and check My orders.' });
    }
  } catch (error) {
    const updateRequired = error.status === 400 && /user_id|column|schema cache/i.test(error.message || '');
    return json(res, 503, { error: updateRequired
      ? 'Checkout needs the latest order database update before orders can be placed. Your bag is saved.'
      : 'We could not check the earlier checkout attempt. Your bag is saved; please retry shortly.' });
  }

  let order;
  try {
    const rpcInput = {
      p_customer: customer,
      p_items: items,
      p_provider: provider,
      p_idempotency_key: idempotencyKey,
      p_user_id: user.id
    };
    // Preserve the old signature when no discount is requested, so existing
    // stores continue to check out until the optional coupon migration is run.
    if (quote.couponCode) rpcInput.p_coupon_code = quote.couponCode;
    order = await rpc('create_checkout_order', rpcInput);
  } catch (error) {
    if (/could not find the function|schema cache|p_user_id|create_checkout_order/i.test(error.message || '') && [400, 404, 406].includes(error.status)) {
      return json(res, 503, { error: 'Checkout needs the latest order database update before orders can be placed. Your bag is saved.' });
    }
    if (/could not find the function|schema cache|p_coupon_code/i.test(error.message || '') && [400, 404, 406].includes(error.status)) {
      return json(res, 503, { error: 'Coupon checkout needs the coupon database update. Your bag is saved.' });
    }
    if (/already has a pending order using another payment method/i.test(error.message || '')) {
      try {
        const priorRows = await supabase(`store_orders?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,user_id,payment_status`);
        const prior = priorRows?.[0];
        if (prior?.user_id && prior.user_id !== user.id) return json(res, 409, { error: 'This checkout belongs to another account. Start again from your own bag.' });
        if (prior?.payment_status === 'pending' && await rpc('fail_checkout_order', { p_order_id: prior.id, p_razorpay_order_id: null })) {
          return json(res, 409, { error: 'The earlier payment attempt has been closed. Review the updated total, then continue again.', quote, restartCheckout: true });
        }
      } catch { /* use the safe retry response below */ }
      return json(res, 409, { error: 'The earlier checkout is still being confirmed. Please retry in a moment.' });
    }
    const status = error.status === 401 || error.status === 403 || error.status === 404
      ? 503
      : (/invalid|insufficient|unavailable|quantity|size|color|delivery address|customer details/i.test(error.message) ? 400 : 502);
    return json(res, status, {
      error: status === 400
        ? error.message
        : 'We could not connect to the order service. Your bag is saved; please try again shortly.'
    });
  }

  // The checkout RPC binds ownership atomically. This extra read protects the
  // API response if an old or custom RPC is still installed.
  try {
    const ownership = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=id,user_id`);
    const savedUserId = ownership?.[0]?.user_id;
    if (!savedUserId || savedUserId !== user.id) {
      return json(res, 409, { error: 'This checkout belongs to a different account. Start checkout again from your own bag.' });
    }
  } catch {
    return json(res, 503, { error: 'We could not securely attach this order to your account. Please retry shortly.' });
  }

  // Older deployed order RPCs may not return gst_amount yet. The amount due is
  // still verified below from the live catalog; GST is calculated server-side
  // for the buyer. Once the GST migration is applied, also verify its stored
  // value to catch stale database functions.
  const hasStoredGst = order.gst_amount !== undefined && order.gst_amount !== null && Number.isInteger(Number(order.gst_amount));
  const hasStoredDiscount = order.discount_amount !== undefined && order.discount_amount !== null && Number.isInteger(Number(order.discount_amount));
  if (order.payment_status === 'paid') {
    return json(res, 200, { orderNumber: order.order_number, storeOrderId: order.id, payment: 'paid', total: order.total, ...quote });
  }
  if (order.payment_status === 'cod') return json(res, 201, {
    orderNumber: order.order_number,
    storeOrderId: order.id,
    ...quote,
    total: order.total,
    payment: 'cod'
  });
  if (order.payment_status === 'pending' && order.payment_provider !== provider) {
    let released = false;
    try {
      released = await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null });
    } catch {
      return json(res, 503, { error: 'An earlier checkout is still reserving this order. Please retry in a moment or contact the store.' });
    }
    if (released) {
      return json(res, 409, {
        error: 'We closed the earlier payment attempt. Review your total, then continue with the selected payment method.',
        quote,
        restartCheckout: true
      });
    }
    try {
      const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=order_number,payment_status,payment_reference`);
      if (latest?.[0]?.payment_status === 'paid') {
        return json(res, 200, { orderNumber: latest[0].order_number, payment: 'paid', total: order.total });
      }
      if (latest?.[0]?.payment_status === 'failed') {
        return json(res, 409, {
          error: 'The earlier attempt has ended. Review your total, then continue with the selected payment method.',
          quote,
          restartCheckout: true
        });
      }
    } catch {
      return json(res, 503, { error: 'We could not confirm the earlier checkout status. Please check your orders before trying again.' });
    }
    return json(res, 409, { error: 'This order is still being processed. Please wait before trying another payment method.' });
  }
  if (order.payment_status !== 'pending') {
    return json(res, 409, {
      error: 'This checkout has already ended. Review your total and start a fresh checkout.',
      quote,
      restartCheckout: true
    });
  }
  if (Number(order.subtotal) !== quote.subtotal || (hasStoredGst && Number(order.gst_amount) !== quote.gstAmount) || (hasStoredDiscount && Number(order.discount_amount) !== quote.discountAmount) || (quote.couponCode && order.coupon_code !== quote.couponCode) || Number(order.shipping) !== quote.shipping || Number(order.total) !== quote.total) {
    try {
      await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null });
    } catch {
      return json(res, 503, { error: 'The saved checkout could not be safely refreshed. Please contact the store before retrying.' });
    }
    return json(res, 409, {
      error: 'The store price changed before this order could be placed. Review the latest total and continue again.',
      quote,
      restartCheckout: true
    });
  }
  if (order.razorpay_order_id) {
    return json(res, 201, {
      orderNumber: order.order_number,
      storeOrderId: order.id,
      razorpayOrderId: order.razorpay_order_id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: order.total * 100,
      currency: 'INR',
      ...quote,
      total: order.total
    });
  }

  try {
    const gateway = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: order.total * 100,
        currency: 'INR',
        receipt: order.order_number,
        notes: { store_order_id: order.id, store_order_number: order.order_number }
      })
    });
    const paymentOrder = await gateway.json();
    if (!gateway.ok || !paymentOrder.id || paymentOrder.amount !== order.total * 100) throw new Error('Razorpay order could not be created.');

    await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.pending`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ razorpay_order_id: paymentOrder.id })
    });
    return json(res, 201, {
      orderNumber: order.order_number,
      storeOrderId: order.id,
      razorpayOrderId: paymentOrder.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: paymentOrder.amount,
      currency: paymentOrder.currency,
      ...quote,
      total: order.total
    });
  } catch {
    try { await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null }); } catch { /* keep the safe error response */ }
    return json(res, 502, { error: 'Secure Razorpay checkout could not be started. Reserved stock has been released; please try again.' });
  }
};
