const { authenticatedUser, body, json, method, supabase, supabaseReady } = require('../lib/server');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function reconcilePayment(order) {
  if (order.payment_status !== 'pending' || order.payment_provider !== 'razorpay' || !order.razorpay_order_id || !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return order;
  try {
    const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(order.razorpay_order_id)}/payments`, {
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}` }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.items)) return order;
    const captured = result.items.find(payment => payment.status === 'captured' && payment.order_id === order.razorpay_order_id && payment.amount === Number(order.total) * 100 && payment.currency === 'INR');
    if (!captured) return order;
    await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&user_id=eq.${encodeURIComponent(order.user_id)}&payment_status=eq.pending&razorpay_order_id=eq.${encodeURIComponent(order.razorpay_order_id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ payment_status: 'paid', payment_provider: 'razorpay', payment_reference: captured.id })
    });
    return { ...order, payment_status: 'paid', payment_reference: captured.id };
  } catch { return order; }
}

async function currentUser(req) {
  try { return await authenticatedUser(req); }
  catch (error) {
    throw new Error(error.code === 'SUPABASE_API_KEY'
      ? 'The store account connection needs its Supabase server key checked in Vercel Production.'
      : 'Account verification is temporarily unavailable. Please retry shortly.');
  }
}

module.exports = async function orders(req, res) {
  if (!method(req, res, ['GET', 'POST'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Order history is temporarily unavailable.' });
  let user;
  try { user = await currentUser(req); }
  catch (error) { return json(res, 503, { error: error.message }); }
  if (!user) return json(res, 401, { error: 'Sign in to view or manage your orders.' });

  if (req.method === 'GET') {
    try {
      let orders = await supabase(`store_orders?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=created_at.desc&limit=50`);
      if (!orders.length) return json(res, 200, { orders: [] });
      orders = await Promise.all(orders.map(reconcilePayment));
      const ids = orders.map(order => order.id).filter(id => UUID.test(id));
      const items = ids.length ? await supabase(`store_order_items?order_id=in.(${ids.join(',')})&select=id,order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url&order=id.asc`) : [];
      const itemsByOrder = new Map(orders.map(order => [order.id, []]));
      for (const item of items) itemsByOrder.get(item.order_id)?.push(item);
      return json(res, 200, { orders: orders.map(({ user_id, razorpay_order_id, ...order }) => ({ ...order, items: itemsByOrder.get(order.id) || [] })) });
    } catch (error) {
      const updateRequired = error.status === 400 && /user_id|tracking_|refund_|column|schema cache/i.test(error.message || '');
      return json(res, updateRequired ? 503 : 502, {
        error: updateRequired
          ? 'Order tracking needs the latest store database update. Please contact the store owner.'
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
