const { json, method, rpc, secureEqual, signature, supabase } = require('../lib/server');
const { customerConvenienceFeePolicy } = require('../lib/razorpay');

async function rawBody(req, limit = 1_000_000) {
  // Read the original request stream without touching req.body. Parsing the
  // body first changes the bytes Razorpay signed and makes verification fail.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function verifyWebhookSignature(secret, raw, provided) {
  if (!secret || !Buffer.isBuffer(raw) || !provided) return false;
  return secureEqual(signature(secret, raw), provided);
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
  const { enabled, maxBps } = customerConvenienceFeePolicy();
  const captureParams = {
    p_gateway_order_id: gatewayOrderId,
    p_payment_id: payment.id,
    p_amount_paise: payment.amount,
    p_currency: payment.currency
  };
  if (enabled) {
    captureParams.p_allow_customer_fee = true;
    captureParams.p_max_customer_fee_bps = maxBps;
  }
  const result = await rpc('record_razorpay_capture', captureParams);
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
  if (!verifyWebhookSignature(secret, raw, provided)) {
    console.warn('razorpay_webhook_signature_invalid', {
      requestId: req.headers['x-vercel-id'] || req.headers['x-request-id'] || 'unknown',
      hasSignature: Boolean(provided)
    });
    return json(res, 401, { error: 'Invalid webhook signature.' });
  }
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
      // Razorpay permits another payment attempt on the same order. A failed
      // attempt is not a failed store order and must not release its stock.
      // Still look for a capture in case events arrived out of order.
      const payments = await paymentList(payment.order_id);
      const captured = payments.find(item => item.status === 'captured');
      if (captured) await markCaptured(captured, payment.order_id);
      return json(res, 200, { received: true });
    }

    if (['refund.processed', 'refund.failed'].includes(event.event) && refund?.payment_id) {
      let rows = await supabase(`store_orders?payment_reference=eq.${encodeURIComponent(refund.payment_id)}&select=id,total,payment_status,payment_reference,refund_reference,refund_attempt_key,refund_status`);
      let isSecondaryRefund = false;
      if (!rows?.length) {
        rows = await supabase(`store_orders?refund_payment_reference=eq.${encodeURIComponent(refund.payment_id)}&select=id,total,payment_status,payment_reference,refund_reference,refund_attempt_key,refund_status`);
        isSecondaryRefund = true;
      }
      const order = rows?.[0];
      if (order) {
        const eventAttemptKey = String(refund.notes?.refund_attempt_key || '');
        if ((order.refund_attempt_key && eventAttemptKey && eventAttemptKey !== order.refund_attempt_key)
          || (order.refund_reference && order.refund_reference !== refund.id && eventAttemptKey !== order.refund_attempt_key)) {
          // Ignore a delayed event from an older failed attempt after the
          // admin has already submitted a new, separately keyed refund.
          return json(res, 200, { received: true, stale: true });
        }
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
            refund_attempt_key: eventAttemptKey || order.refund_attempt_key || null,
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
module.exports.rawBody = rawBody;
module.exports.verifyWebhookSignature = verifyWebhookSignature;
