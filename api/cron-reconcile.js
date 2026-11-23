const { json, method, rpc, secureEqual, supabase } = require('../lib/server');
const { findOrderByReceipt, paymentAmountMatchesOrder } = require('../lib/razorpay');
const { markCaptured } = require('./razorpay-webhook');

async function paymentsFor(gatewayOrderId) {
  const authorization = `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(7000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.items)) throw new Error('Could not retrieve the order payments.');
  return data.items;
}

async function reconcile(order) {
  if (!order.razorpay_order_id) {
    if (!['pending', 'failed'].includes(order.payment_status) || !order.order_number) return false;
    const recovered = await findOrderByReceipt(order.order_number, {
      amount: Number(order.total) * 100, currency: 'INR', storeOrderId: order.id
    });
    if (recovered) {
      const linked = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.${encodeURIComponent(order.payment_status)}&razorpay_order_id=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ razorpay_order_id: recovered.id })
      });
      const gatewayOrderId = linked?.[0]?.razorpay_order_id || recovered.id;
      return reconcile({ ...order, razorpay_order_id: gatewayOrderId });
    }
    if (order.payment_status === 'pending'
      && Date.now() - Date.parse(order.created_at) >= 45 * 60 * 1000) {
      return await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: null });
    }
    return false;
  }
  const payments = await paymentsFor(order.razorpay_order_id);
  const captures = payments.filter(payment => payment.status === 'captured'
    && payment.order_id === order.razorpay_order_id
    && paymentAmountMatchesOrder(payment.amount, order.total)
    && payment.currency === 'INR');
  if (captures.length) {
    let outcome = false;
    for (const capture of captures) outcome = (await markCaptured(capture, order.razorpay_order_id)).updated || outcome;
    return outcome;
  }
  if (order.payment_status !== 'pending') return false;
  const expired = Date.now() - Date.parse(order.created_at) >= 45 * 60 * 1000;
  const allFailed = payments.length > 0 && payments.every(payment => payment.status === 'failed');
  if (expired && (allFailed || !payments.length)) {
    return await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: order.razorpay_order_id });
  }
  return false;
}

module.exports = async function cronReconcile(req, res) {
  if (!method(req, res, ['GET'])) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(res, 503, { error: 'Scheduled reconciliation is not configured.' });
  if (!secureEqual(req.headers.authorization || '', `Bearer ${secret}`)) return json(res, 401, { error: 'Unauthorized.' });
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return json(res, 503, { error: 'Payment reconciliation is not configured.' });

  try {
    let rateLimitRowsRemoved = 0;
    try { rateLimitRowsRemoved = Number(await rpc('cleanup_store_api_rate_limits', {})) || 0; } catch {}
    const now = Date.now();
    const checkoutCutoff = encodeURIComponent(new Date(now - 45 * 60 * 1000).toISOString());
    // Retry old pending and previously failed orders at most once per cron
    // interval. The timestamp is a rotating cursor, so old failures cannot
    // permanently occupy the first page and hide newer payment captures.
    const retryBefore = encodeURIComponent(new Date(now - 14 * 60 * 1000).toISOString());
    const PAGE_SIZE = 50, MAX_PAGES = 20, CONCURRENCY = 10;
    let checked = 0, reconciled = 0, errors = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await supabase(`store_orders?payment_status=in.(pending,failed)&payment_provider=eq.razorpay&created_at=lt.${checkoutCutoff}&or=(payment_reconciled_at.is.null,payment_reconciled_at.lt.${retryBefore})&select=id,order_number,created_at,total,payment_status,razorpay_order_id&order=payment_reconciled_at.asc.nullsfirst,created_at.asc,id.asc&limit=${PAGE_SIZE}`);
      if (!batch.length) break;
      checked += batch.length;
      for (let start = 0; start < batch.length; start += CONCURRENCY) {
        const slice = batch.slice(start, start + CONCURRENCY);
        const results = await Promise.allSettled(slice.map(async order => {
          try {
            return await reconcile(order);
          } finally {
            // Rotate even a transient Razorpay/API failure out of the current
            // batch. The status guard avoids stamping a concurrently changed
            // order; failed checks can be retried after the 14-minute window.
            await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.${encodeURIComponent(order.payment_status)}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ payment_reconciled_at: new Date().toISOString() })
            });
          }
        }));
        reconciled += results.filter(result => result.status === 'fulfilled' && result.value).length;
        errors += results.filter(result => result.status === 'rejected').length;
      }
    }
    return json(res, errors ? 207 : 200, { checked, reconciled, errors, rateLimitRowsRemoved });
  } catch {
    return json(res, 500, { error: 'Payment reconciliation failed. The next scheduled run will retry.' });
  }
};
