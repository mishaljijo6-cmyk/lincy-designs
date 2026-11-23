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

    if (event.event === 'payment.captured') {
      // This signed event already contains the authoritative captured payment.
      // Avoid a paginated provider lookup on the webhook's critical path; cron
      // reconciliation scans the order later for additional or missed captures.
      if (payment?.status === 'captured' && payment.order_id === gatewayOrderId) {
        const outcome = await markCaptured(payment, gatewayOrderId);
        if (outcome.ignored) console.error('razorpay_capture_not_applied', { gatewayOrderId, paymentId: payment.id });
      }
      return json(res, 200, { received: true });
    }

    if (event.event === 'order.paid') {
      // Some Razorpay payloads include the payment entity; use it directly.
      // If not, the scheduled reconciler finds the capture without delaying
      // this webhook response on multiple payment-list pages.
      if (payment?.status === 'captured' && payment.order_id === gatewayOrderId) {
        const outcome = await markCaptured(payment, gatewayOrderId);
        if (outcome.ignored) console.error('razorpay_capture_not_applied', { gatewayOrderId, paymentId: payment.id });
      }
      return json(res, 200, { received: true });
    }

    if (event.event === 'payment.failed' && payment?.order_id) {
      // Razorpay permits another payment attempt on the same order. A failed
      // attempt is not a failed store order and must not release its stock.
      // Capture and failed events may be delivered out of order. A failed
      // attempt never changes order state; payment.captured handles success
      // directly and cron reconciliation recovers missed capture events.
      return json(res, 200, { received: true });
    }

    if (['refund.processed', 'refund.failed'].includes(event.event) && refund?.payment_id) {
      const captureAttemptKey = String(refund.notes?.store_refund_attempt_key || '');
      let captureRefundRows = await supabase(`store_payment_refunds?razorpay_refund_id=eq.${encodeURIComponent(refund.id || '')}&select=order_id,attempt_key,razorpay_payment_id,amount_paise,refund_status`);
      if (!captureRefundRows?.length && captureAttemptKey) {
        captureRefundRows = await supabase(`store_payment_refunds?attempt_key=eq.${encodeURIComponent(captureAttemptKey)}&select=order_id,attempt_key,razorpay_payment_id,amount_paise,refund_status`);
      }
      const captureRefund = captureRefundRows?.[0];
      if (captureRefund) {
        if (captureRefund.razorpay_payment_id !== refund.payment_id || Number(captureRefund.amount_paise) !== Number(refund.amount)) {
          console.error('razorpay_capture_refund_mismatch', { refundId: refund.id, paymentId: refund.payment_id });
          return json(res, 200, { received: true, stale: true });
        }
        await rpc('record_store_payment_refund_event', {
          p_order_id: captureRefund.order_id,
          p_payment_id: captureRefund.razorpay_payment_id,
          p_attempt_key: captureRefund.attempt_key,
          p_refund_id: refund.id,
          p_amount_paise: Number(refund.amount),
          p_status: event.event === 'refund.processed' ? 'processed' : 'failed',
          p_admin_note: event.event === 'refund.processed' ? 'Razorpay confirmed this capture refund.' : 'Razorpay reported this capture refund failed.'
        });
        return json(res, 200, { received: true, captureRefund: true });
      }
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
        await rpc('record_store_payment_refund_event', {
          p_order_id: order.id,
          p_payment_id: refund.payment_id,
          p_attempt_key: eventAttemptKey || order.refund_attempt_key || `legacy_${refund.id}`,
          p_refund_id: refund.id,
          p_amount_paise: Number(refund.amount),
          p_status: processed ? 'processed' : 'failed',
          p_admin_note: processed ? 'Razorpay confirmed refund processing.' : 'Razorpay reported a refund failure.'
        });
        // Razorpay may redeliver or reorder events. A late failure event for
        // an already-processed refund must not move it back to requested.
        if (!processed && order.refund_reference === refund.id && order.refund_status === 'processed') {
          return json(res, 200, { received: true, duplicate: true });
        }
        const orderFilter = `store_orders?id=eq.${encodeURIComponent(order.id)}&refund_reference=${order.refund_reference ? `eq.${encodeURIComponent(order.refund_reference)}` : 'is.null'}&refund_attempt_key=${order.refund_attempt_key ? `eq.${encodeURIComponent(order.refund_attempt_key)}` : 'is.null'}`;
        const updated = await supabase(orderFilter, {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
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
        if (!updated?.length) {
          // A newer refund submission won the race after the read above.
          // Acknowledge this stale event without overwriting the newer state.
          return json(res, 200, { received: true, stale: true });
        }
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
