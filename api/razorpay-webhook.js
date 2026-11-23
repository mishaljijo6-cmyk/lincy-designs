const { json, method, rpc, secureEqual, signature, supabase } = require('../lib/server');

async function rawBody(req, limit = 1_000_000) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) throw new Error('Payload too large.');
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > limit) throw new Error('Payload too large.');
    return Buffer.from(req.body);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function paymentList(gatewayOrderId) {
  const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`, {
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}` },
    signal: AbortSignal.timeout(7000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.items)) throw new Error('Payment reconciliation failed.');
  return data.items;
}

async function markCaptured(payment, gatewayOrderId) {
  if (!gatewayOrderId || !payment?.id || payment.status !== 'captured') return { ignored: true };
  const result = await rpc('record_razorpay_capture', {
    p_gateway_order_id: gatewayOrderId,
    p_payment_id: payment.id,
    p_amount_paise: payment.amount,
    p_currency: payment.currency
  });
  const outcome = Array.isArray(result) ? result[0] : result;
  return outcome && typeof outcome === 'object'
    ? outcome
    : { ignored: true };
}

module.exports = async function razorpayWebhook(req, res) {
  if (!method(req, res, ['POST'])) return;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return json(res, 503, { error: 'Webhook verification is not configured.' });
  let raw;
  try { raw = await rawBody(req); }
  catch { return json(res, 400, { error: 'Invalid webhook payload.' }); }

  const provided = req.headers['x-razorpay-signature'];
  if (!provided || !secureEqual(signature(secret, raw), provided)) return json(res, 401, { error: 'Invalid webhook signature.' });
  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, 400, { error: 'Invalid webhook payload.' }); }

  try {
    const payment = event.payload?.payment?.entity;
    const refund = event.payload?.refund?.entity;
    const gatewayOrderId = event.payload?.order?.entity?.id || payment?.order_id;

    if (['payment.captured', 'order.paid'].includes(event.event)) {
      let captured = payment?.status === 'captured' ? payment : null;
      if (!captured && gatewayOrderId) captured = (await paymentList(gatewayOrderId)).find(item => item.status === 'captured');
      if (captured) await markCaptured(captured, gatewayOrderId || captured.order_id);
      return json(res, 200, { received: true });
    }

    if (event.event === 'payment.failed' && payment?.order_id) {
      const rows = await supabase(`store_orders?razorpay_order_id=eq.${encodeURIComponent(payment.order_id)}&select=id,payment_status`);
      const order = rows?.[0];
      if (order?.payment_status === 'pending') {
        const payments = await paymentList(payment.order_id);
        const captured = payments.find(item => item.status === 'captured');
        if (captured) await markCaptured(captured, payment.order_id);
        else if (payments.length && payments.every(item => item.status === 'failed')) {
          await rpc('fail_checkout_order', { p_order_id: order.id, p_razorpay_order_id: payment.order_id });
        }
      }
      return json(res, 200, { received: true });
    }

    if (['refund.processed', 'refund.failed'].includes(event.event) && refund?.payment_id) {
      let rows = await supabase(`store_orders?payment_reference=eq.${encodeURIComponent(refund.payment_id)}&select=id,total,payment_status,payment_reference,refund_reference,refund_status`);
      let isSecondaryRefund = false;
      if (!rows?.length) {
        rows = await supabase(`store_orders?refund_payment_reference=eq.${encodeURIComponent(refund.payment_id)}&select=id,total,payment_status,payment_reference,refund_reference,refund_status`);
        isSecondaryRefund = true;
      }
      const order = rows?.[0];
      if (order) {
        const processed = event.event === 'refund.processed';
        // Razorpay may redeliver or reorder events. A late failure event for
        // an already-processed refund must not move it back to requested.
        if (!processed && order.refund_reference === refund.id && order.refund_status === 'processed') {
          return json(res, 200, { received: true, duplicate: true });
        }
        await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            refund_status: processed ? 'processed' : 'requested',
            payment_status: processed && !isSecondaryRefund && Number(refund.amount) >= Number(order.total) * 100 ? 'refunded' : order.payment_status,
            refund_reference: refund.id || null,
            refund_amount_paise: Number.isInteger(refund.amount) ? refund.amount : null,
            refund_resolved_at: processed ? new Date().toISOString() : null,
            refund_admin_note: processed ? 'Razorpay confirmed refund processing.' : 'Razorpay reported a refund failure. Review and retry in the Razorpay dashboard.'
          })
        });
      }
      return json(res, 200, { received: true });
    }

    return json(res, 200, { received: true, ignored: true });
  } catch {
    // Return non-2xx so Razorpay retries transient database or provider errors.
    return json(res, 500, { error: 'Webhook processing failed.' });
  }
};

// Razorpay signs the exact request bytes. This must be assigned after the
// handler because assigning module.exports replaces earlier properties.
module.exports.config = { api: { bodyParser: false } };
module.exports.markCaptured = markCaptured;
