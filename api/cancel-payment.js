const { authenticatedUser, body, json, method, rpc, supabase, supabaseReady } = require('../lib/server');
const { listPayments } = require('../lib/razorpay');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = async function cancelPaymentAttempt(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Payment cancellation is temporarily unavailable.' });
  let user;
  try { user = await authenticatedUser(req); }
  catch { return json(res, 503, { error: 'We could not confirm your account. Check My orders before changing payment methods.' }); }
  if (!user) return json(res, 401, { error: 'Sign in again before changing your payment method.' });

  let input;
  try { input = await body(req, 2_000); }
  catch { return json(res, 400, { error: 'The payment attempt could not be identified.' }); }
  const orderId = String(input.orderId || '');
  if (!UUID.test(orderId)) return json(res, 400, { error: 'The order ID is invalid.' });

  try {
    const allowed = await rpc('consume_store_rate_limit', { p_key: `cancel-payment:${user.id}`, p_limit: 8, p_window_seconds: 60 });
    if (!allowed) return json(res, 429, { error: 'Wait a moment before trying to change payment methods again.' });
    const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id,payment_status,payment_provider,razorpay_order_id`);
    const order = rows?.[0];
    if (!order) return json(res, 404, { error: 'We could not find this order in your account.' });
    if (order.payment_status !== 'pending' || order.payment_provider !== 'razorpay' || !order.razorpay_order_id) {
      return json(res, 409, { error: 'This online payment attempt is no longer waiting to be cancelled. Check My orders for its latest status.' });
    }
    const payments = await listPayments(order.razorpay_order_id);
    const activePayment = payments.some(payment => ['created', 'authorized', 'captured'].includes(payment.status));
    if (activePayment) return json(res, 409, { error: 'Razorpay still has a payment in progress. Wait for it to finish, then check My orders.' });
    if (payments.some(payment => payment.order_id !== order.razorpay_order_id || payment.currency !== 'INR')) {
      return json(res, 409, { error: 'Razorpay returned payment details that need review. Check My orders before switching methods.' });
    }
    const released = await rpc('release_pending_checkout_after_cancel', {
      p_order_id: order.id,
      p_razorpay_order_id: order.razorpay_order_id
    });
    if (!released) return json(res, 409, { error: 'The payment status changed while you were switching methods. Check My orders and try again.' });
    return json(res, 200, { cancelled: true, canSwitchToCod: true });
  } catch {
    return json(res, 503, { error: 'We could not verify the earlier payment yet. Check My orders before trying another payment method.' });
  }
};
