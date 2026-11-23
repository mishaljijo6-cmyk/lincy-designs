const { authenticatedUser, body, json, method, rpc, supabase, supabaseReady } = require('../lib/server');
const { findOrderByReceipt, listPayments, paymentAmountMatchesOrder, razorpayOrderAmountPaise } = require('../lib/razorpay');
const { markCaptured } = require('./razorpay-webhook');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep the customer response on columns guaranteed by the deployed order
// migration. customer_note is optional in older live schemas and must not make
// the entire order history unavailable when that optional column is absent.
const CUSTOMER_ORDER_COLUMNS = 'id,order_number,customer_name,email,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,gateway_amount_paise,payment_status,payment_provider,status,shipping_carrier,tracking_number,tracking_url,shipped_at,delivered_at,refund_status,refund_reason,refund_requested_at,refund_resolved_at,created_at,updated_at,coupon_code,discount_amount,delivery_discount';

async function reconcilePayment(order) {
  if (!['pending', 'failed'].includes(order.payment_status) || order.payment_provider !== 'razorpay' || !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return order;
  try {
    let gatewayOrderId = order.razorpay_order_id;
    if (!gatewayOrderId && order.order_number) {
      const recovered = await findOrderByReceipt(order.order_number, {
        amounts: [Number(order.total) * 100, razorpayOrderAmountPaise(order.total)], currency: 'INR', storeOrderId: order.id
      });
      if (recovered) {
        const linked = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.${encodeURIComponent(order.payment_status)}&razorpay_order_id=is.null`, {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ razorpay_order_id: recovered.id })
        });
        gatewayOrderId = linked?.[0]?.razorpay_order_id || recovered.id;
      } else if (order.payment_status === 'pending' && Date.now() - Date.parse(order.created_at || 0) >= 45 * 60 * 1000) {
        const released = await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null });
        if (released) return { ...order, payment_status: 'failed' };
        return order;
      } else return order;
    }
    if (!gatewayOrderId) return order;
    const payments = await listPayments(gatewayOrderId);
    const captures = payments.filter(payment => payment.status === 'captured' && payment.order_id === gatewayOrderId && paymentAmountMatchesOrder(payment.amount, order.total) && payment.currency === 'INR');
    if (captures.length) {
      for (const capture of captures) {
        await markCaptured(capture, gatewayOrderId);
      }
      const current = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=${CUSTOMER_ORDER_COLUMNS}`);
      return current?.[0] || order;
    }
    const holdExpired = Date.now() - Date.parse(order.created_at || 0) >= 45 * 60 * 1000;
    if (order.payment_status === 'pending' && holdExpired && payments.length > 0 && payments.every(payment => payment.status === 'failed')) {
      const released = await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: gatewayOrderId });
      if (released) return { ...order, payment_status: 'failed' };
    }
    return order;
  } catch { return order; }
}

async function currentUser(req) {
  try { return await authenticatedUser(req); }
  catch { throw new Error('Account verification is temporarily unavailable. Please retry shortly.'); }
}

module.exports = async function orders(req, res) {
  if (!method(req, res, ['GET', 'POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Order history is temporarily unavailable.' });
  let user;
  try { user = await currentUser(req); }
  catch (error) { return json(res, 503, { error: error.message }); }
  if (!user) return json(res, 401, { error: 'Sign in to view or manage your orders.' });
  try {
    const allowed = await rpc('consume_store_rate_limit', {
      p_key: `${req.method === 'POST' ? 'refund-request' : 'order-read'}:${user.id}`,
      p_limit: req.method === 'POST' ? 8 : 60,
      p_window_seconds: req.method === 'POST' ? 3600 : 60
    });
    if (!allowed) return json(res, 429, { error: 'Too many order requests. Wait a moment, then try again.' });
  } catch { return json(res, 503, { error: 'Order history is temporarily unavailable. Please try again shortly.' }); }

  if (req.method === 'GET') {
    try {
      const requestedOrderId = String(req.query?.orderId || new URL(req.url, 'https://store.invalid').searchParams.get('orderId') || '');
      let orders = requestedOrderId
        ? (UUID.test(requestedOrderId) ? await supabase(`store_orders?id=eq.${encodeURIComponent(requestedOrderId)}&user_id=eq.${encodeURIComponent(user.id)}&select=${CUSTOMER_ORDER_COLUMNS}&limit=1`) : [])
        : await supabase(`store_orders?user_id=eq.${encodeURIComponent(user.id)}&select=${CUSTOMER_ORDER_COLUMNS}&order=created_at.desc&limit=50`);
      if (requestedOrderId && !UUID.test(requestedOrderId)) return json(res, 400, { error: 'The order ID is invalid.' });
      if (!orders.length) return json(res, 200, { orders: [] });
      // Only reconcile a payment when the shopper explicitly checks one order.
      // Listing My Orders stays light and does not call Razorpay for every old hold.
      if (requestedOrderId) orders = [await reconcilePayment(orders[0])];
      const ids = orders.map(order => order.id).filter(id => UUID.test(id));
      const [items, captureRows, captureRefundRows] = ids.length ? await Promise.all([
        supabase(`store_order_items?order_id=in.(${ids.join(',')})&select=id,order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url&order=id.asc`),
        supabase(`store_order_payments?order_id=in.(${ids.join(',')})&select=order_id,razorpay_payment_id,amount_paise,currency,payment_status,needs_refund_review,refund_review_reason,captured_at&order=captured_at.asc`),
        supabase(`store_payment_refunds?order_id=in.(${ids.join(',')})&select=order_id,razorpay_payment_id,amount_paise,razorpay_refund_id,refund_status,created_at&order=created_at.asc`)
      ]) : [[], [], []];
      const itemsByOrder = new Map(orders.map(order => [order.id, []]));
      for (const item of items) itemsByOrder.get(item.order_id)?.push(item);
      const capturesByOrder = new Map(orders.map(order => [order.id, []]));
      const refundsByOrder = new Map(orders.map(order => [order.id, []]));
      for (const payment of captureRows) capturesByOrder.get(payment.order_id)?.push(payment);
      for (const refund of captureRefundRows) refundsByOrder.get(refund.order_id)?.push(refund);
      const safeOrders = orders.map(order => ({
        ...order,
        items: itemsByOrder.get(order.id) || [],
        payment_captures: capturesByOrder.get(order.id) || [],
        payment_refunds: refundsByOrder.get(order.id) || []
      }));
      return json(res, 200, { orders: safeOrders, ...(requestedOrderId ? { order: safeOrders[0] } : {}) });
    } catch (error) {
      const updateRequired = error.status === 400 && /user_id|tracking_|refund_|column|schema cache/i.test(error.message || '');
      return json(res, updateRequired ? 503 : 502, {
        error: updateRequired
          ? 'Order history is temporarily unavailable. Please try again shortly.'
          : 'We could not load your order history. Please try again shortly.'
      });
    }
  }

  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Enter a short reason for your refund request.' }); }
  const orderId = String(input.orderId || '');
  const reason = String(input.reason || '').trim();
  if (!UUID.test(orderId) || reason.length < 5 || reason.length > 1000) {
    return json(res, 400, { error: 'Enter a refund reason between 5 and 1,000 characters.' });
  }

  try {
    const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id,payment_status,status,refund_status`);
    const order = rows?.[0];
    if (!order) return json(res, 404, { error: 'We could not find that order in your account.' });
    const delivered = ['delivered', 'complete'].includes(order.status);
    const canRequest = order.payment_status === 'paid' || (order.payment_status === 'cod' && delivered);
    if (!canRequest || ['cancelled'].includes(order.status)) {
      return json(res, 409, { error: 'A refund request is available after a prepaid order is placed, or after a cash-on-delivery order is delivered.' });
    }
    if (!['none', 'rejected'].includes(order.refund_status)) {
      return json(res, 409, { error: 'A refund request for this order is already being reviewed or has been completed.' });
    }
    const updated = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&user_id=eq.${encodeURIComponent(user.id)}&refund_status=in.(none,rejected)`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ refund_status: 'requested', refund_reason: reason, refund_requested_at: new Date().toISOString(), refund_resolved_at: null, refund_admin_note: null })
    });
    if (!updated?.length) return json(res, 409, { error: 'This order’s refund status changed. Refresh your orders and try again.' });
    return json(res, 200, { submitted: true, refundStatus: 'requested' });
  } catch (error) {
    const updateRequired = error.status === 400 && /refund_|column|schema cache/i.test(error.message || '');
    return json(res, updateRequired ? 503 : 502, {
      error: updateRequired
        ? 'Refund requests need the latest store database update. Please contact the store owner.'
        : 'We could not submit that refund request. Please try again shortly.'
    });
  }
};
