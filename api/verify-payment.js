const { authenticatedUser, body, json, method, rpc, secureEqual, signature, supabase } = require('../lib/server');
const { markCaptured } = require('./razorpay-webhook');

async function razorpayFetch(path) {
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Razorpay payment status check failed.');
  return result;
}

module.exports = async function verifyPayment(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return json(res, 503, { error: 'Razorpay verification is not configured.' });
  let user;
  try { user = await authenticatedUser(req); }
  catch {
    return json(res, 503, { error: 'Account verification is temporarily unavailable. Please check My orders in a moment.' });
  }
  if (!user) return json(res, 401, { error: 'Your sign-in expired. Sign in again, then check your order status.' });
  try {
    if (!await rpc('consume_store_rate_limit', { p_key: `payment-verify:${user.id}`, p_limit: 20, p_window_seconds: 60 })) {
      return json(res, 429, { error: 'Payment status is being checked too often. Wait a moment and try again.' });
    }
  } catch { return json(res, 503, { error: 'Payment confirmation is temporarily unavailable. Check My orders again shortly.' }); }
  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Payment verification failed.' }); }

  const storeOrderId = String(input.storeOrderId || '');
  const paymentId = String(input.razorpay_payment_id || '');
  const supplied = String(input.razorpay_signature || '');
  if (!/^[0-9a-f-]{36}$/i.test(storeOrderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/i.test(supplied)) {
    return json(res, 400, { error: 'Payment details are incomplete.' });
  }

  try {
    let rows;
    try {
      rows = await supabase(`store_orders?id=eq.${encodeURIComponent(storeOrderId)}&select=id,user_id,order_number,total,payment_status,razorpay_order_id,payment_reference,coupon_code`);
    } catch (error) {
      if (error.status === 400 && /user_id|column|schema cache/i.test(error.message || '')) {
        return json(res, 503, { error: 'Payment confirmation is temporarily unavailable. Do not pay again yet; check My orders shortly.' });
      }
      throw error;
    }
    const order = rows?.[0];
    if (!order || !order.razorpay_order_id) return json(res, 404, { error: 'We could not match this payment to your order.' });
    if (order.user_id !== user.id) return json(res, 403, { error: 'This order belongs to a different account.' });
    if (['paid', 'refunded'].includes(order.payment_status) && order.payment_reference === paymentId) {
      return json(res, 200, { verified: true, orderNumber: order.order_number, storeOrderId: order.id, total: order.total });
    }

    const expected = signature(process.env.RAZORPAY_KEY_SECRET, `${order.razorpay_order_id}|${paymentId}`);
    if (!secureEqual(expected, supplied)) return json(res, 400, { error: 'Payment could not be verified. Please contact the store before retrying.' });

    const payment = await razorpayFetch(`payments/${encodeURIComponent(paymentId)}`);
    if (payment.order_id !== order.razorpay_order_id || payment.amount !== order.total * 100 || payment.currency !== 'INR') {
      return json(res, 409, { error: 'Payment details did not match this order. Please contact the store.' });
    }
    if (payment.status !== 'captured') return json(res, 202, { verified: false, status: payment.status, orderNumber: order.order_number });

    const recorded = await markCaptured(payment, order.razorpay_order_id);
    if (recorded.refundReview) {
      return json(res, 202, {
        verified: false,
        status: 'refund_review',
        refundReviewType: recorded.latePayment ? 'late' : 'duplicate',
        orderNumber: order.order_number,
        storeOrderId: order.id,
        total: order.total
      });
    }
    if (!recorded.updated && !recorded.duplicate) {
      const current = await supabase(`store_orders?id=eq.${encodeURIComponent(storeOrderId)}&select=payment_status,payment_reference`);
      if (!['paid', 'refunded'].includes(current?.[0]?.payment_status) || current[0].payment_reference !== paymentId) {
        return json(res, 202, { verified: false, status: 'pending', orderNumber: order.order_number, storeOrderId: order.id, total: order.total });
      }
    }
    return json(res, 200, { verified: true, orderNumber: order.order_number, storeOrderId: order.id, total: order.total });
  } catch {
    return json(res, 502, { error: 'We received your payment response but could not confirm it yet. Please try again shortly.' });
  }
};
