const { authenticatedUser, body, json, method, rpc, supabase, supabaseReady } = require('../lib/server');
const { calculateQuote } = require('../lib/coupons');
const {
  customerConvenienceFeePaise,
  findOrderByReceipt,
  getOrder,
  listPayments,
  paymentAmountMatchesOrder,
  razorpayOrderAmountPaise
} = require('../lib/razorpay');
const { markCaptured } = require('./razorpay-webhook');

function normalizeIndianPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return '';
}

function validIndianPhone(value) { return Boolean(normalizeIndianPhone(value)); }

function normalizedOption(value) {
  const option = String(value || '').trim();
  return option.toLowerCase() === 'one size' ? '' : option;
}

function normalizedCheckoutLines(lines) {
  return lines.map(line => ({
    productId: String(line.productId ?? line.product_id ?? ''),
    quantity: Number(line.quantity ?? line.qty),
    size: normalizedOption(line.size ?? line.selected_size),
    color: String(line.color ?? line.selected_color ?? '').trim()
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function sameCheckoutLines(left, right) {
  return JSON.stringify(normalizedCheckoutLines(left)) === JSON.stringify(normalizedCheckoutLines(right));
}

function checkoutHoldExpired(createdAt) {
  const created = Date.parse(createdAt || '');
  return Number.isFinite(created) && Date.now() - created >= 45 * 60 * 1000;
}

async function checkOtherPendingOrders(userId, idempotencyKey) {
  const pending = await supabase(`store_orders?user_id=eq.${encodeURIComponent(userId)}&payment_status=eq.pending&select=id,idempotency_key,order_number,payment_provider,razorpay_order_id,total,created_at&order=created_at.asc&limit=50`);
  for (const order of pending) {
    if (order.idempotency_key === idempotencyKey) continue;
    if (order.payment_provider !== 'razorpay') {
      return { status: 409, orderId: order.id, error: 'Another order is still being prepared. Check My orders before placing a second order.' };
    }
    if (!order.razorpay_order_id) {
      if (!checkoutHoldExpired(order.created_at)) {
        return { status: 409, orderId: order.id, error: 'An earlier online order is still being set up. Check My orders before placing a second order.' };
      }
      const released = await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null });
      if (!released) return { status: 409, orderId: order.id, error: 'The earlier order changed while it was checked. Check My orders before continuing.' };
      continue;
    }
    const [gatewayOrder, payments] = await Promise.all([
      getOrder(order.razorpay_order_id),
      listPayments(order.razorpay_order_id)
    ]);
    if (gatewayOrder.id !== order.razorpay_order_id || gatewayOrder.currency !== 'INR'
      || !paymentAmountMatchesOrder(gatewayOrder.amount, order.total)
      || (gatewayOrder.notes?.store_order_id && gatewayOrder.notes.store_order_id !== order.id)) {
      return { status: 409, orderId: order.id, error: `Earlier order ${order.order_number} does not match its Razorpay order. Check My orders before continuing.` };
    }
    const captures = payments.filter(payment => payment.status === 'captured'
      && payment.order_id === order.razorpay_order_id
      && paymentAmountMatchesOrder(payment.amount, order.total)
      && payment.currency === 'INR');
    if (captures.length) {
      for (const capture of captures) await markCaptured(capture, order.razorpay_order_id);
      return { status: 409, orderId: order.id, error: `Payment for earlier order ${order.order_number} was received. Check My orders before placing another order.` };
    }
    if (gatewayOrder.status === 'paid' || Number(gatewayOrder.amount_paid || 0) > 0) {
      return { status: 202, orderId: order.id, error: `Razorpay reports money received for order ${order.order_number}. Confirmation is in progress; do not pay again yet.` };
    }
    if (payments.some(payment => ['created', 'authorized'].includes(payment.status))) {
      return { status: 409, orderId: order.id, error: `Earlier order ${order.order_number} still has a payment in progress. Finish it or close that payment before starting another checkout.` };
    }
    if (payments.some(payment => payment.order_id !== order.razorpay_order_id || payment.currency !== 'INR' || payment.status !== 'failed')) {
      return { status: 409, orderId: order.id, error: `Earlier order ${order.order_number} has a payment that needs review. Check My orders before continuing.` };
    }
    if (!checkoutHoldExpired(order.created_at)) {
      return { status: 409, orderId: order.id, error: `Earlier order ${order.order_number} is still reserved. Wait for its 45-minute payment hold to end before starting another checkout.` };
    }
    const released = await rpc('release_pending_checkout_after_cancel', {
      p_order_id: order.id,
      p_razorpay_order_id: order.razorpay_order_id
    });
    if (!released) {
      return { status: 409, orderId: order.id, error: `Earlier order ${order.order_number} changed while payment was checked. Check My orders before continuing.` };
    }
  }
  return null;
}

module.exports = async function checkout(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Checkout is being connected. Please try again later.' });
  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Please check your checkout details and try again.' }); }
  let user;
  try { user = await authenticatedUser(req); }
  catch {
    return json(res, 503, { error: 'We could not confirm your account right now. Your bag is saved; please try again shortly.' });
  }
  if (!user) return json(res, 401, { error: 'Sign in to place and track your order.' });
  try {
    if (!await rpc('consume_store_rate_limit', { p_key: `checkout:${user.id}`, p_limit: 12, p_window_seconds: 60 })) {
      return json(res, 429, { error: 'Too many checkout attempts. Wait a minute, then try again.' });
    }
  } catch {
    return json(res, 503, { error: 'Checkout is temporarily unavailable. Your bag is saved; please try again shortly.' });
  }

  let provider = input.provider === 'cod' ? 'cod' : 'razorpay';
  const customer = { ...(input.customer || {}), phone: normalizeIndianPhone(input.customer?.phone), note: String(input.customer?.note || '').trim().slice(0, 500) };
  const items = Array.isArray(input.items) ? input.items : [];
  const idempotencyKey = String(input.idempotencyKey || '').slice(0, 100);
  if (!idempotencyKey || !items.length || items.length > 20) return json(res, 400, { error: 'Your cart is empty or invalid.' });
  if (!validIndianPhone(customer.phone)) return json(res, 400, { error: 'Enter a valid Indian mobile number with 10 digits.' });

  // Reprice items and validate any coupon against server-side catalogue data.
  let quote;
  try {
    quote = await calculateQuote(items, input.couponCode || '', user.id, idempotencyKey);
  } catch (error) {
    if (error.status === 400) return json(res, 400, { error: error.message });
    if (/store_coupons|store_coupon_redemptions|schema cache|coupon_code|discount_amount|per_user_limit/i.test(error.message || '')) {
      return json(res, 503, { error: 'Discount codes are temporarily unavailable. Your bag is saved; please try again later.' });
    }
    const status = error.status === 401 || error.status === 403 || error.status === 404 ? 503 : 502;
    return json(res, status, { error: 'Checkout is temporarily unavailable while the store connection is being fixed. Your bag is still saved.' });
  }
  const requestedQuote = {
    subtotal: Number(input.expectedSubtotal),
    shipping: Number(input.expectedShipping),
    gstAmount: Number(input.expectedGstAmount),
    deliveryDiscount: Number(input.expectedDeliveryDiscount || 0),
    total: Number(input.expectedTotal)
  };
  const quoteChanged = ['subtotal', 'shipping', 'gstAmount', 'deliveryDiscount', 'total'].some(key => requestedQuote[key] !== quote[key]) ||
    (input.expectedDiscountAmount != null && Number(input.expectedDiscountAmount) !== quote.discountAmount) ||
    (String(input.couponCode || '').trim().toUpperCase() || null) !== quote.couponCode;
  if (quoteChanged) {
    return json(res, 409, {
      error: 'A price, coupon, or delivery charge changed. Review the updated breakdown before paying.',
      quote
    });
  }
  if (quote.total === 0) provider = 'razorpay';
  else if (input.provider === 'coupon') return json(res, 400, { error: 'This discount does not cover the full order.' });
  if (provider === 'razorpay' && quote.total > 0 && (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)) {
    return json(res, 503, { error: 'Online payment is temporarily unavailable. Please try again later.' });
  }
  const onlineFeePaise = provider === 'razorpay' ? customerConvenienceFeePaise(quote.total) : 0;
  const expectedRazorpayAmount = provider === 'razorpay' ? razorpayOrderAmountPaise(quote.total) : 0;

  // Resolve the idempotent attempt before invoking the database RPC. Keep an
  // open reservation attached to its original provider until payment is
  // reconciled; a failed UPI attempt may still be retried on the same order.
  try {
  const priorSelect = 'id,user_id,payment_status,payment_provider,order_number,total,subtotal,shipping,created_at,razorpay_order_id,razorpay_order_creation_token,gateway_amount_paise,coupon_code,discount_amount,delivery_discount';
    const priorRows = await supabase(`store_orders?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=${priorSelect}`);
    const prior = priorRows?.[0];
    const requestedProvider = quote.total === 0 ? 'coupon' : provider;
    if (prior && prior.user_id !== user.id) {
      return json(res, 409, { error: 'This checkout belongs to another account. Start again from your own bag.' });
    }
    if (prior) {
      const storedLines = await supabase(`store_order_items?order_id=eq.${encodeURIComponent(prior.id)}&select=product_id,quantity,selected_size,selected_color`);
      if (!storedLines.length || !sameCheckoutLines(items, storedLines)) {
        return json(res, 409, { error: 'This checkout is already tied to a different bag. Check My orders before starting another payment.' });
      }
      const priorQuoteMatches = Number(prior.subtotal) === quote.subtotal
        && Number(prior.shipping) === quote.shipping
        && Number(prior.total) === quote.total
        && (prior.discount_amount == null || Number(prior.discount_amount) === quote.discountAmount)
        && (prior.delivery_discount == null || Number(prior.delivery_discount) === quote.deliveryDiscount)
        && (prior.coupon_code || null) === (quote.couponCode || null);
      if (!priorQuoteMatches && ['paid', 'cod', 'failed'].includes(prior.payment_status)) {
        return json(res, 409, { error: 'This checkout is already tied to an earlier total or coupon. Review the latest breakdown and start a fresh checkout.', quote, restartCheckout: true });
      }
      if (!priorQuoteMatches && prior.payment_status === 'pending') {
        return json(res, 409, { error: 'A payment is already open for an earlier total or coupon. Check My orders and finish or cancel that attempt before starting again.' });
      }
    }
    if (prior && ['paid', 'cod'].includes(prior.payment_status)
      && prior.payment_provider !== requestedProvider) {
      return json(res, 409, { error: 'This order is already confirmed with a different payment method. Open My orders to review it.' });
    }
    if (prior?.payment_status === 'failed' && prior.payment_provider !== provider) {
      return json(res, 409, { error: 'This earlier checkout has ended. Review the current total and start a new checkout with your preferred payment method.', quote, restartCheckout: true });
    }
    if (prior?.payment_status === 'failed' && prior.payment_provider === 'razorpay' && prior.razorpay_order_id) {
      let gatewayOrder, payments;
      try {
        [gatewayOrder, payments] = await Promise.all([
          getOrder(prior.razorpay_order_id),
          listPayments(prior.razorpay_order_id)
        ]);
      }
      catch { return json(res, 503, { error: 'We could not confirm the earlier payment yet. Check My orders before trying again.' }); }
      if (gatewayOrder.id !== prior.razorpay_order_id || gatewayOrder.currency !== 'INR'
        || !paymentAmountMatchesOrder(gatewayOrder.amount, prior.total)
        || (gatewayOrder.notes?.store_order_id && gatewayOrder.notes.store_order_id !== prior.id)) {
        return json(res, 409, { error: 'The earlier Razorpay order does not match this store order. Contact the store before trying again.' });
      }
      if (gatewayOrder.status === 'paid' || Number(gatewayOrder.amount_paid || 0) > 0) {
        return json(res, 202, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: 'pending', total: prior.total });
      }
      const captures = payments.filter(payment => payment.status === 'captured'
        && payment.order_id === prior.razorpay_order_id
        && paymentAmountMatchesOrder(payment.amount, prior.total)
        && payment.currency === 'INR');
      if (captures.length) {
        let refundReview = false, refundReviewType = null;
        for (const capture of captures) {
          const outcome = await markCaptured(capture, prior.razorpay_order_id);
          refundReview = outcome.refundReview || refundReview;
          if (outcome.latePayment) refundReviewType = 'late';
          else if (outcome.duplicatePayment) refundReviewType = 'duplicate';
        }
        return json(res, 200, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: refundReview ? 'review' : 'paid', refundReview, refundReviewType, total: prior.total, gatewayAmountPaise: captures[0].amount, ...quote });
      }
      if (payments.some(payment => payment.status !== 'failed')) {
        return json(res, 409, { error: 'The earlier Razorpay order still has a payment in progress. Check My orders before retrying.' });
      }
    }
    if (prior?.payment_status === 'failed') {
      return json(res, 409, { error: 'The earlier reservation has ended. Review the latest total and start a fresh checkout before paying again.', quote, restartCheckout: true });
    }
    if (prior?.payment_status === 'pending' && prior.payment_provider !== provider) {
      if (prior.payment_provider === 'razorpay' && !prior.razorpay_order_id) {
        if (checkoutHoldExpired(prior.created_at)) {
          const released = await rpc('fail_checkout_order', { p_order_id: prior.id, p_razorpay_order_id: null });
          if (released) return json(res, 409, { error: 'The online setup reservation has ended. Review the latest total and start a fresh checkout.', quote, restartCheckout: true });
        }
        return json(res, 409, { error: 'The earlier online payment setup is still being confirmed. Reopen online checkout and check My orders before switching methods.' });
      }
      if (prior.payment_provider === 'razorpay' && prior.razorpay_order_id) {
        let gatewayOrder, payments;
        try {
          [gatewayOrder, payments] = await Promise.all([
            getOrder(prior.razorpay_order_id),
            listPayments(prior.razorpay_order_id)
          ]);
        }
        catch { return json(res, 503, { error: 'We could not confirm the earlier payment yet. Please wait and check My orders before trying another method.' }); }
        if (gatewayOrder.currency !== 'INR' || !paymentAmountMatchesOrder(gatewayOrder.amount, prior.total)
          || (gatewayOrder.notes?.store_order_id && gatewayOrder.notes.store_order_id !== prior.id)) {
          return json(res, 409, { error: 'The earlier Razorpay order does not match this store order. Please contact the store before changing payment methods.' });
        }
        const captures = payments.filter(payment => payment.status === 'captured' && payment.order_id === prior.razorpay_order_id && paymentAmountMatchesOrder(payment.amount, prior.total) && payment.currency === 'INR');
        if (captures.length) {
          let refundReview = false, refundReviewType = null;
          for (const capture of captures) {
            const outcome = await markCaptured(capture, prior.razorpay_order_id);
            refundReview = outcome.refundReview || refundReview;
            if (outcome.latePayment) refundReviewType = 'late';
            else if (outcome.duplicatePayment) refundReviewType = 'duplicate';
          }
          return json(res, 200, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: refundReviewType === 'late' ? 'review' : 'paid', refundReview, refundReviewType, total: prior.total, gatewayAmountPaise: captures[0].amount, ...quote });
        }
        if (gatewayOrder.status === 'paid' || Number(gatewayOrder.amount_paid || 0) > 0) {
          return json(res, 202, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: 'pending', total: prior.total });
        }
        if (payments.some(payment => payment.order_id !== prior.razorpay_order_id || payment.currency !== 'INR' || payment.status !== 'failed')) {
          return json(res, 409, { error: 'The earlier payment is still open. Finish it or wait for its 45-minute hold to end before changing methods.' });
        }
        if (!checkoutHoldExpired(prior.created_at)) {
          return json(res, 409, { error: 'The online payment can still be retried for this order. Reopen Pay online to try again, or wait until the 45-minute reservation ends before changing payment methods.' });
        }
        const released = await rpc('release_pending_checkout_after_cancel', {
          p_order_id: prior.id,
          p_razorpay_order_id: prior.razorpay_order_id
        });
        if (!released) return json(res, 409, { error: 'The payment status changed while you were switching methods. Check My orders before continuing.' });
        return json(res, 409, { error: 'The online reservation has ended. Review the latest breakdown and start a new checkout.', quote, restartCheckout: true });
      }
      const released = await rpc('fail_checkout_order', { p_order_id: prior.id, p_razorpay_order_id: null });
      if (released) return json(res, 409, { error: 'This payment reservation has ended. Reopen checkout and review your bag before placing another order.' });
      const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(prior.id)}&select=order_number,payment_status,payment_reference,total,gateway_amount_paise`);
      if (latest?.[0]?.payment_status === 'paid') {
        return json(res, 200, { orderNumber: latest[0].order_number, storeOrderId: prior.id, payment: 'paid', total: latest[0].total, gatewayAmountPaise: latest[0].gateway_amount_paise });
      }
      return json(res, 409, { error: 'The earlier payment attempt is still being confirmed. Please wait a moment and check My orders.' });
    }
    if (prior?.payment_status === 'pending' && provider === 'razorpay' && prior.razorpay_order_id) {
      let gatewayOrder, payments;
      try {
        [gatewayOrder, payments] = await Promise.all([
          getOrder(prior.razorpay_order_id),
          listPayments(prior.razorpay_order_id)
        ]);
      }
      catch { return json(res, 503, { error: 'We could not confirm the earlier payment yet. Check My orders before trying again.' }); }
      if (gatewayOrder.currency !== 'INR' || !paymentAmountMatchesOrder(gatewayOrder.amount, prior.total)
        || (gatewayOrder.notes?.store_order_id && gatewayOrder.notes.store_order_id !== prior.id)) {
        return json(res, 409, { error: 'The earlier Razorpay order does not match this store order. Check My orders before paying again.' });
      }
      const captures = payments.filter(payment => payment.status === 'captured' && payment.order_id === prior.razorpay_order_id && paymentAmountMatchesOrder(payment.amount, prior.total) && payment.currency === 'INR');
      if (captures.length) {
        let refundReview = false, refundReviewType = null;
        for (const capture of captures) {
          const outcome = await markCaptured(capture, prior.razorpay_order_id);
          refundReview = outcome.refundReview || refundReview;
          if (outcome.latePayment) refundReviewType = 'late';
          else if (outcome.duplicatePayment) refundReviewType = 'duplicate';
        }
        return json(res, 200, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: refundReviewType === 'late' ? 'review' : 'paid', refundReview, refundReviewType, total: prior.total, gatewayAmountPaise: captures[0].amount, ...quote });
      }
      if (payments.some(payment => ['created', 'authorized'].includes(payment.status))) {
        return json(res, 202, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: 'pending', total: prior.total });
      }
      if (gatewayOrder.status === 'paid' || Number(gatewayOrder.amount_paid || 0) > 0) {
        return json(res, 202, { orderNumber: prior.order_number, storeOrderId: prior.id, payment: 'pending', total: prior.total });
      }
      if (payments.some(payment => payment.status !== 'failed')) {
        return json(res, 409, { error: 'The earlier payment needs review before another attempt. Check My orders and do not pay again yet.' });
      }
      if (checkoutHoldExpired(prior.created_at)) {
        const released = await rpc('fail_checkout_order', { p_order_id: prior.id, p_razorpay_order_id: prior.razorpay_order_id });
        if (!released) return json(res, 409, { error: 'The payment reservation changed while it was checked. Open My orders before continuing.' });
        return json(res, 409, { error: 'The online reservation has ended. Review the current total and start a fresh checkout.', quote, restartCheckout: true });
      }
      // Failed Razorpay attempts do not close the order. Continue below with
      // the same gateway order so the shopper can retry without losing stock.
    }
  } catch (error) {
    const updateRequired = error.status === 400 && /user_id|column|schema cache/i.test(error.message || '');
    return json(res, 503, { error: updateRequired
      ? 'Checkout is temporarily unavailable. Your bag is saved; please try again shortly.'
      : 'We could not check the earlier checkout attempt. Your bag is saved; please retry shortly.' });
  }

  try {
    const otherPending = await checkOtherPendingOrders(user.id, idempotencyKey);
    if (otherPending) return json(res, otherPending.status, otherPending);
  } catch {
    return json(res, 503, { error: 'We could not verify an earlier payment. Check My orders before placing another order.' });
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
      return json(res, 503, { error: 'Checkout is temporarily unavailable. Your bag is saved; please try again shortly.' });
    }
    if (/could not find the function|schema cache|p_coupon_code/i.test(error.message || '') && [400, 404, 406].includes(error.status)) {
      return json(res, 503, { error: 'Discount codes are temporarily unavailable. Your bag is saved; please try again later.' });
    }
    if (/already has a pending order|pending order exists|already has a pending order using another payment method/i.test(error.message || '')) {
      try {
        const priorRows = await supabase(`store_orders?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,user_id,payment_status`);
        const prior = priorRows?.[0];
        if (prior?.user_id && prior.user_id !== user.id) return json(res, 409, { error: 'This checkout belongs to another account. Start again from your own bag.' });
        if (prior?.payment_status === 'pending') return json(res, 409, { error: 'The earlier checkout is still reserving this order. Continue with its existing payment method or check My orders before restarting.' });
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

  // The checkout RPC binds ownership atomically. Verify the saved cart and
  // total before returning a success response for an idempotent replay.
  try {
    const savedRows = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=id,user_id,payment_status,payment_provider,customer_name,email,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,gateway_amount_paise,coupon_code,discount_amount,delivery_discount`);
    const saved = savedRows?.[0];
    if (!saved?.user_id || saved.user_id !== user.id) {
      return json(res, 409, { error: 'This checkout belongs to a different account. Start checkout again from your own bag.' });
    }
    const savedLines = await supabase(`store_order_items?order_id=eq.${encodeURIComponent(order.id)}&select=product_id,quantity,selected_size,selected_color`);
    if (!savedLines.length || !sameCheckoutLines(items, savedLines)) {
      return json(res, 409, { error: 'This checkout is already tied to a different bag. Check My orders before starting another payment.' });
    }

    const hasStoredGst = saved.gst_amount !== undefined && saved.gst_amount !== null && Number.isInteger(Number(saved.gst_amount));
    const hasStoredDiscount = saved.discount_amount !== undefined && saved.discount_amount !== null && Number.isInteger(Number(saved.discount_amount));
    const hasStoredDeliveryDiscount = saved.delivery_discount !== undefined && saved.delivery_discount !== null && Number.isInteger(Number(saved.delivery_discount));
    const storedQuoteMatches = Number(saved.subtotal) === quote.subtotal
      && (!hasStoredGst || Number(saved.gst_amount) === quote.gstAmount)
      && (!hasStoredDiscount || Number(saved.discount_amount) === quote.discountAmount)
      && (!hasStoredDeliveryDiscount || Number(saved.delivery_discount) === quote.deliveryDiscount)
      && (!quote.couponCode || saved.coupon_code === quote.couponCode)
      && Number(saved.shipping) === quote.shipping
      && Number(saved.total) === quote.total;
    if (!storedQuoteMatches) {
      return json(res, 409, {
        error: ['paid', 'cod'].includes(saved.payment_status)
          ? 'This order was already confirmed using its saved total. Open My orders to review it.'
          : 'The saved checkout total no longer matches your bag. Review the current price and start a fresh checkout.',
        quote,
        restartCheckout: true
      });
    }

    const customerMatches = String(saved.customer_name || '').trim() === String(customer.name || '').trim()
      && String(saved.email || '').trim().toLowerCase() === String(customer.email || '').trim().toLowerCase()
      && String(saved.phone || '').trim() === customer.phone
      && String(saved.address || '').trim() === String(customer.address || '').trim()
      && String(saved.city || '').trim() === String(customer.city || '').trim()
      && String(saved.state || '').trim() === String(customer.state || '').trim()
      && String(saved.pincode || '').trim() === String(customer.pincode || '').trim();
    if (['paid', 'cod'].includes(saved.payment_status) && !customerMatches) {
      return json(res, 409, { error: 'This order is already confirmed with its saved delivery address. Open My orders or contact the store to update it.' });
    }
    if (saved.payment_status === 'pending' && !customerMatches) {
      const updated = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&user_id=eq.${encodeURIComponent(user.id)}&payment_status=eq.pending&payment_provider=eq.${encodeURIComponent(provider)}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          customer_name: String(customer.name || '').trim().slice(0, 100),
          email: String(customer.email || '').trim().toLowerCase().slice(0, 200),
          phone: customer.phone,
          address: String(customer.address || '').trim().slice(0, 300),
          city: String(customer.city || '').trim().slice(0, 100),
          state: String(customer.state || '').trim().slice(0, 100),
          pincode: String(customer.pincode || '').trim()
        })
      });
      if (!updated?.length) {
        return json(res, 409, { error: 'The order status changed while saving your delivery details. Check My orders before continuing.' });
      }
    }
  } catch {
    return json(res, 503, { error: 'We could not securely attach this order to your account. Please retry shortly.' });
  }

  // Older deployed order RPCs may not return gst_amount yet. The amount due is
  // still verified below from the live catalog; GST is calculated server-side
  // for the buyer. Once the GST migration is applied, also verify its stored
  // value to catch stale database functions.
  if (order.payment_status === 'paid') {
    if (order.payment_provider !== (quote.total === 0 ? 'coupon' : provider)) {
      return json(res, 409, { error: 'This checkout was already completed using a different payment method. Open My orders to review it.' });
    }
    return json(res, 200, { orderNumber: order.order_number, storeOrderId: order.id, payment: Number(order.total) === 0 && order.payment_provider === 'coupon' ? 'free' : 'paid', total: order.total, gatewayAmountPaise: saved.gateway_amount_paise, ...quote });
  }
  if (order.payment_status === 'cod') {
    if (order.payment_provider !== 'cod' || provider !== 'cod') {
      return json(res, 409, { error: 'This order is already confirmed for cash on delivery. Open My orders to review it.' });
    }
    return json(res, 201, {
    orderNumber: order.order_number,
    storeOrderId: order.id,
    ...quote,
    total: order.total,
    payment: 'cod'
    });
  }
  if (order.payment_status === 'pending' && order.payment_provider !== provider) {
    return json(res, 409, { error: 'This order is still reserved with its original payment method. Reopen that payment or check My orders before starting another method.' });
  }
  if (order.payment_status !== 'pending') {
    return json(res, 409, {
      error: 'This checkout has already ended. Review your total and start a fresh checkout.',
      quote,
      restartCheckout: true
    });
  }
  if (quote.total === 0) {
    try {
      const completed = await rpc('complete_free_checkout_order', { p_order_id: order.id, p_user_id: user.id });
      if (!completed) {
        const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=payment_status,payment_provider`);
        if (latest?.[0]?.payment_status !== 'paid' || latest?.[0]?.payment_provider !== 'coupon') {
          return json(res, 409, { error: 'This order is still being confirmed. Check My orders before continuing.' });
        }
      }
      return json(res, 201, { orderNumber: order.order_number, storeOrderId: order.id, payment: 'free', total: 0, ...quote });
    } catch {
      return json(res, 503, { error: 'The free order could not be confirmed. Your bag is saved; please check My orders.' });
    }
  }

  const respondWithRazorpayOrder = async suppliedOrder => {
    try {
      const gatewayOrder = typeof suppliedOrder === 'string' ? await getOrder(suppliedOrder) : suppliedOrder;
      if (!gatewayOrder?.id || gatewayOrder.currency !== 'INR'
        || !paymentAmountMatchesOrder(gatewayOrder.amount, order.total)
        || (gatewayOrder.notes?.store_order_id && gatewayOrder.notes.store_order_id !== order.id)) {
        return json(res, 409, { error: 'The earlier Razorpay order does not match this checkout. Check My orders before paying again.' });
      }

      if (Number(gatewayOrder.amount) !== expectedRazorpayAmount) {
        const payments = await listPayments(gatewayOrder.id);
        const captures = payments.filter(payment => payment.status === 'captured'
          && payment.order_id === gatewayOrder.id
          && paymentAmountMatchesOrder(payment.amount, order.total)
          && payment.currency === 'INR');
        if (captures.length) {
          let refundReview = false, refundReviewType = null;
          for (const capture of captures) {
            const outcome = await markCaptured(capture, gatewayOrder.id);
            refundReview = outcome.refundReview || refundReview;
            if (outcome.latePayment) refundReviewType = 'late';
            else if (outcome.duplicatePayment) refundReviewType = 'duplicate';
          }
          return json(res, 200, {
            orderNumber: order.order_number, storeOrderId: order.id,
            payment: refundReview ? 'review' : 'paid', refundReview, refundReviewType,
            total: order.total, gatewayAmountPaise: captures[0].amount, ...quote
          });
        }
        if (Number(gatewayOrder.amount_paid || 0) > 0 || gatewayOrder.status === 'paid') {
          return json(res, 202, { orderNumber: order.order_number, storeOrderId: order.id, payment: 'pending', total: order.total });
        }
        if (payments.some(payment => ['created', 'authorized'].includes(payment.status))) {
          return json(res, 202, { orderNumber: order.order_number, storeOrderId: order.id, payment: 'pending', total: order.total });
        }
        if (payments.some(payment => payment.order_id !== gatewayOrder.id || payment.currency !== 'INR' || payment.status !== 'failed')) {
          return json(res, 409, { error: 'The earlier payment needs review. Check My orders before trying again.' });
        }
        if (!checkoutHoldExpired(order.created_at)) {
          return json(res, 202, { orderNumber: order.order_number, storeOrderId: order.id, payment: 'pending', total: order.total });
        }
        const released = await rpc('release_pending_checkout_after_cancel', {
          p_order_id: order.id,
          p_razorpay_order_id: gatewayOrder.id
        });
        if (!released) return json(res, 409, { error: 'The previous payment is still being confirmed. Check My orders before starting another payment.' });
        return json(res, 409, {
          error: 'The previous payment was set up with an older amount. Review the updated online total and continue again.',
          quote,
          restartCheckout: true
        });
      }

      return json(res, 201, {
        orderNumber: order.order_number,
        storeOrderId: order.id,
        razorpayOrderId: gatewayOrder.id,
        keyId: process.env.RAZORPAY_KEY_ID,
        amount: Number(gatewayOrder.amount),
        onlineFeePaise,
        currency: 'INR',
        ...quote,
        total: order.total
      });
    } catch {
      return json(res, 503, { error: 'We could not safely confirm the earlier payment. Check My orders before retrying.' });
    }
  };
  if (order.razorpay_order_id) {
    return respondWithRazorpayOrder(order.razorpay_order_id);
  }

  let creationToken;
  let gatewayStateUncertain = false;
  let paymentOrder = null;
  try {
    creationToken = require('node:crypto').randomUUID();
    const claimed = await rpc('claim_razorpay_order', { p_order_id: order.id, p_token: creationToken });
    if (!claimed) {
      const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=razorpay_order_id,razorpay_order_creation_token`);
      const existingGatewayOrderId = latest?.[0]?.razorpay_order_id;
      if (existingGatewayOrderId) return respondWithRazorpayOrder(existingGatewayOrderId);
      return json(res, 409, { error: 'Secure payment setup is still running. Please tap Pay again in a moment.' });
    }
    // From this point onward, do not release stock on a generic network or DB
    // error. A prior order lookup or a timed-out create may have succeeded.
    gatewayStateUncertain = true;

    // Razorpay treats receipt as its idempotency key. Recover an order whose
    // first create response was lost before attempting another create.
    paymentOrder = await findOrderByReceipt(order.order_number, {
      amounts: [order.total * 100, expectedRazorpayAmount], currency: 'INR', storeOrderId: order.id
    });
    if (!paymentOrder) {
      try {
        const gateway = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            amount: expectedRazorpayAmount,
            currency: 'INR',
            receipt: order.order_number,
            notes: { store_order_id: order.id, store_order_number: order.order_number }
          }),
          signal: AbortSignal.timeout(10000)
        });
        const created = await gateway.json().catch(() => ({}));
        if (gateway.ok && created.id && created.amount === expectedRazorpayAmount && created.currency === 'INR') paymentOrder = created;
      } catch { /* recover by receipt below before allowing a retry */ }
      if (!paymentOrder) {
        try {
          paymentOrder = await findOrderByReceipt(order.order_number, {
            amounts: [order.total * 100, expectedRazorpayAmount], currency: 'INR', storeOrderId: order.id
          });
        } catch { /* keep the reservation until a later safe reconciliation */ }
      }
      if (!paymentOrder) return json(res, 503, {
        error: 'Payment setup is still being confirmed. Your bag and stock are held safely; check My orders before retrying.'
      });
    }

    const linked = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.pending&razorpay_order_id=is.null&razorpay_order_creation_token=eq.${encodeURIComponent(creationToken)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ razorpay_order_id: paymentOrder.id, razorpay_order_creation_token: null, razorpay_order_creating_at: null })
    });
    if (!linked?.length) {
      const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=razorpay_order_id`);
      if (latest?.[0]?.razorpay_order_id === paymentOrder.id) return respondWithRazorpayOrder(paymentOrder);
      return json(res, 503, { error: 'Payment setup is still being confirmed. Your bag is saved; check My orders before retrying.' });
    }
    return respondWithRazorpayOrder(paymentOrder);
  } catch {
    if (gatewayStateUncertain) {
      return json(res, 503, { error: 'Payment setup is still being confirmed. Your bag and stock are held safely; check My orders before retrying.' });
    }
    return json(res, 503, { error: 'Secure payment setup could not be confirmed. Your bag is saved; check My orders before trying again.' });
  }
};

module.exports.sameCheckoutLines = sameCheckoutLines;
