const { authenticatedUser, body, json, method, secureEqual, signature, supabase } = require('../lib/server');

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
  catch (error) {
    return json(res, 503, { error: error.code === 'SUPABASE_API_KEY'
      ? 'The store account connection needs its Supabase server key checked in Vercel Production.'
      : 'Account verification is temporarily unavailable. Please check My orders in a moment.' });
  }
  if (!user) return json(res, 401, { error: 'Your sign-in expired. Sign in again, then check your order status.' });
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
      rows = await supabase(`store_orders?id=eq.${encodeURIComponent(storeOrderId)}&select=id,user_id,order_number,total,payment_status,razorpay_order_id,payment_reference`);
    } catch (error) {
      if (error.status === 400 && /user_id|column|schema cache/i.test(error.message || '')) {
        return json(res, 503, { error: 'Payment confirmation needs the latest order database update. Your payment is not marked complete yet; contact the store before retrying.' });
      }
      throw error;
    }
    const order = rows?.[0];
    if (!order || !order.razorpay_order_id) return json(res, 404, { error: 'We could not match this payment to your order.' });
    if (order.user_id !== user.id) return json(res, 403, { error: 'This order belongs to a different account.' });
    if (order.payment_status === 'paid' && order.payment_reference === paymentId) {
      return json(res, 200, { verified: true, orderNumber: order.order_number, storeOrderId: order.id, total: order.total });
    }
    if (order.payment_status !== 'pending') return json(res, 409, { error: 'This order is no longer awaiting payment.' });

    const expected = signature(process.env.RAZORPAY_KEY_SECRET, `${order.razorpay_order_id}|${paymentId}`);
    if (!secureEqual(expected, supplied)) return json(res, 400, { error: 'Payment could not be verified. Please contact the store before retrying.' });

    const payment = await razorpayFetch(`payments/${encodeURIComponent(paymentId)}`);
    if (payment.order_id !== order.razorpay_order_id || payment.amount !== order.total * 100 || payment.currency !== 'INR') {
      return json(res, 409, { error: 'Payment details did not match this order. Please contact the store.' });
    }
    if (payment.status !== 'captured') return json(res, 202, { verified: false, status: payment.status, orderNumber: order.order_number });

    const updated = await supabase(`store_orders?id=eq.${encodeURIComponent(storeOrderId)}&payment_status=eq.pending&razorpay_order_id=eq.${encodeURIComponent(order.razorpay_order_id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ payment_status: 'paid', payment_provider: 'razorpay', payment_reference: paymentId })
    });
    if (!updated?.length) {
      const current = await supabase(`store_orders?id=eq.${encodeURIComponent(storeOrderId)}&select=payment_status,payment_reference`);
      if (current?.[0]?.payment_status !== 'paid' || current[0].payment_reference !== paymentId) {
        return json(res, 409, { error: 'Payment status changed. Please contact the store.' });
      }
    }
    return json(res, 200, { verified: true, orderNumber: order.order_number, storeOrderId: order.id, total: order.total });
  } catch {
    return json(res, 502, { error: 'We received your payment response but could not confirm it yet. Please try again shortly.' });
  }
};
