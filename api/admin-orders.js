const { authenticatedUser, body, json, method, rpc, supabase, supabaseReady } = require('../lib/server');
const { createHash } = require('node:crypto');
const { createNormalRefund, getPayment, getRefund } = require('../lib/razorpay');

const ADMIN_EMAIL = String(process.env.STORE_ADMIN_EMAIL || 'mishalmj03@gmail.com').trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['new', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'complete', 'cancelled']);
const REFUNDS = new Set(['none', 'requested', 'approved', 'rejected', 'processed']);

module.exports = async function adminOrders(req, res) {
  if (!method(req, res, ['PATCH'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Order updates are temporarily unavailable.' });
  let user;
  try { user = await authenticatedUser(req); }
  catch { return json(res, 503, { error: 'Admin account verification is temporarily unavailable.' }); }
  if (!user) return json(res, 401, { error: 'Sign in again to manage orders.' });
  if (String(user.email || '').toLowerCase() !== ADMIN_EMAIL) return json(res, 403, { error: 'This account cannot manage store orders.' });
  try {
    if (!await rpc('consume_store_rate_limit', { p_key: `admin-order-write:${user.id}`, p_limit: 90, p_window_seconds: 60 })) {
      return json(res, 429, { error: 'Too many order updates. Wait a moment, then try again.' });
    }
  } catch { return json(res, 503, { error: 'Order updates are temporarily unavailable. Please try again shortly.' }); }

  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Check the order update and try again.' }); }
  const orderId = String(input.orderId || '');
  if (!UUID.test(orderId)) return json(res, 400, { error: 'The order ID is invalid.' });

  let update;
  if (input.action === 'status') {
    const status = String(input.status || '');
    if (!STATUSES.has(status)) return json(res, 400, { error: 'Choose a valid order status.' });
    let current;
    try {
      const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,status,payment_status,refund_status`);
      current = rows?.[0];
    } catch { return json(res, 503, { error: 'Order status could not be checked. Please try again.' }); }
    if (!current) return json(res, 404, { error: 'Order not found.' });
    if (status === current.status) return json(res, 200, { saved: true });
    const transitions = {
      new: ['processing', 'packed', 'cancelled'],
      processing: ['packed', 'cancelled'],
      packed: ['shipped', 'cancelled'],
      shipped: ['out_for_delivery', 'delivered'],
      out_for_delivery: ['delivered'],
      delivered: ['complete'],
      complete: [],
      cancelled: []
    };
    if (!transitions[current.status]?.includes(status)) return json(res, 409, { error: 'That order status change is not allowed. Refresh the order and try the next status.' });
    if (['shipped', 'out_for_delivery', 'delivered', 'complete'].includes(status) && !['paid', 'cod'].includes(current.payment_status)) {
      return json(res, 409, { error: 'This order cannot ship until its payment is confirmed.' });
    }
    if (['shipped', 'out_for_delivery', 'delivered', 'complete'].includes(status) && ['requested', 'approved'].includes(current.refund_status)) {
      return json(res, 409, { error: 'Resolve the open refund request before shipping this order.' });
    }
    if (status === 'cancelled') {
      try {
        const cancelled = await rpc('cancel_store_order', { p_order_id: orderId });
        return cancelled ? json(res, 200, { saved: true }) : json(res, 404, { error: 'Order not found.' });
      } catch (error) {
        const message = String(error.message || '');
        if (/pending|carrier|cancel/i.test(message)) return json(res, 409, { error: message });
        return json(res, 503, { error: 'The order could not be cancelled safely. Please refresh and review its payment status.' });
      }
    }
    try {
      const saved = await rpc('update_store_order_status', { p_order_id: orderId, p_status: status });
      return saved ? json(res, 200, { saved: true }) : json(res, 404, { error: 'Order not found.' });
    } catch (error) {
      const message = String(error.message || '');
      if (/not allowed|payment is confirmed|refund request/i.test(message)) return json(res, 409, { error: message });
      return json(res, 503, { error: /function|schema cache/i.test(message) ? 'Order status updates are temporarily unavailable. Please refresh and try again.' : 'The order status could not be saved safely. Please refresh and try again.' });
    }
  } else if (input.action === 'tracking') {
    const carrier = String(input.carrier || '').trim();
    const trackingNumber = String(input.trackingNumber || '').trim();
    const trackingUrl = String(input.trackingUrl || '').trim();
    if (carrier.length > 80 || trackingNumber.length > 120 || trackingUrl.length > 2000) return json(res, 400, { error: 'Tracking details are too long.' });
    if (trackingUrl) {
      try { if (new URL(trackingUrl).protocol !== 'https:') throw new Error(); }
      catch { return json(res, 400, { error: 'Tracking links must use HTTPS.' }); }
    }
    update = { shipping_carrier: carrier || null, tracking_number: trackingNumber || null, tracking_url: trackingUrl || null };
  } else if (input.action === 'refund') {
    const refundStatus = String(input.refundStatus || '');
    const note = String(input.adminNote || '').trim();
    if (!REFUNDS.has(refundStatus) || note.length > 1000) return json(res, 400, { error: 'Check the refund review details and try again.' });
    if (refundStatus === 'processed' && input.confirmRefund !== true) return json(res, 400, { error: 'Confirm that you sent the refund before marking it processed.' });

    if (refundStatus === 'processed') {
      let current;
      try {
        const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,order_number,status,payment_provider,payment_status,total,payment_reference,refund_payment_reference,refund_status,refund_reference,refund_amount_paise`);
        current = rows?.[0];
      } catch { return json(res, 503, { error: 'Refund details could not be checked. Please refresh and try again.' }); }
      if (!current) return json(res, 404, { error: 'Order not found.' });
      if (!['requested', 'approved'].includes(current.refund_status)) return json(res, 409, { error: 'Approve or request this refund before processing it.' });

      if (current.payment_provider === 'razorpay' && current.payment_status === 'paid') {
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return json(res, 503, { error: 'Razorpay refunds are not configured on the server.' });
        const paymentId = current.refund_payment_reference || current.payment_reference;
        if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId || ''))) return json(res, 409, { error: 'There is no verified Razorpay payment reference to refund.' });

        const amountNumber = Number(input.refundAmount);
        const amountPaise = Math.round(amountNumber * 100);
        if (!Number.isFinite(amountNumber) || !Number.isSafeInteger(amountPaise) || amountPaise < 100) {
          return json(res, 400, { error: 'Enter a refund amount of at least ₹1.00.' });
        }
        if (current.refund_amount_paise != null && Number(current.refund_amount_paise) !== amountPaise) {
          return json(res, 409, { error: 'A refund request is already saved for a different amount. Keep that amount and retry, or review the existing refund in Razorpay.' });
        }

        try {
          if (current.refund_reference) {
            const existing = await getRefund(current.refund_reference);
            if (existing.payment_id !== paymentId || Number(existing.amount) !== amountPaise) {
              return json(res, 409, { error: 'The saved Razorpay refund does not match this request. Review it in Razorpay before making another refund.' });
            }
            if (existing.status === 'failed') return json(res, 409, { error: 'Razorpay reports that this refund failed. Review the payment in Razorpay before retrying.' });
            const updated = await saveRazorpayRefund(current, paymentId, existing, note);
            return json(res, 200, { saved: true, refundId: existing.id, refundStatus: existing.status, amountPaise, alreadySubmitted: true, ...updated });
          }

          const payment = await getPayment(paymentId);
          if (payment.status !== 'captured' || payment.currency !== 'INR' || payment.id !== paymentId) {
            return json(res, 409, { error: 'Razorpay does not show this payment as captured in INR, so it cannot be refunded here.' });
          }
          const remainingPaise = Number(payment.amount) - Number(payment.amount_refunded || 0);
          if (!Number.isSafeInteger(remainingPaise) || amountPaise > remainingPaise) {
            return json(res, 409, { error: `The refund is greater than the remaining captured amount (${(Math.max(0, remainingPaise) / 100).toFixed(2)}).` });
          }

          // Reserve the chosen amount before calling Razorpay. If two admin
          // requests race, only the first amount is accepted and both retries
          // use the same provider idempotency key and request body.
          if (current.refund_amount_paise == null) {
            const reserved = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&refund_status=in.(requested,approved)&refund_reference=is.null&refund_amount_paise=is.null`, {
              method: 'PATCH', headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ refund_amount_paise: amountPaise })
            });
            if (!reserved?.length) {
              const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=refund_amount_paise,refund_reference,refund_status`);
              if (Number(latest?.[0]?.refund_amount_paise) !== amountPaise) return json(res, 409, { error: 'Another refund update is in progress. Refresh and review the saved amount before retrying.' });
              current.refund_amount_paise = amountPaise;
              current.refund_reference = latest?.[0]?.refund_reference || null;
            } else current.refund_amount_paise = amountPaise;
          }
          if (current.refund_reference) return json(res, 409, { error: 'A refund was submitted while this request was running. Refresh the order and review its refund reference.' });

          const digest = createHash('sha256').update(`${orderId}:${paymentId}:${amountPaise}`).digest('hex').slice(0, 32);
          const receipt = `LD-${String(current.order_number || orderId).replace(/[^A-Za-z0-9_-]/g, '').slice(-18)}-${digest.slice(0, 8)}`;
          const refund = await createNormalRefund(paymentId, amountPaise, `Lincy_${digest}`, receipt, {
            store_order_id: orderId,
            store_order_number: String(current.order_number || orderId).slice(0, 100)
          });
          if (refund.payment_id !== paymentId || Number(refund.amount) !== amountPaise || !/^rfnd_[A-Za-z0-9]+$/.test(String(refund.id || '')) || !['pending', 'processed', 'failed'].includes(refund.status)) {
            return json(res, 502, { error: 'Razorpay returned an unexpected refund response. Check the Razorpay dashboard before retrying.' });
          }
          if (refund.status === 'failed') {
            await saveRazorpayRefund(current, paymentId, refund, 'Razorpay returned a failed refund. Review the refund in Razorpay before retrying.');
            return json(res, 409, { error: 'Razorpay could not process this refund. Review the refund in Razorpay before retrying.' });
          }
          const saved = await saveRazorpayRefund(current, paymentId, refund, note);
          return json(res, 200, { saved: true, refundId: refund.id, refundStatus: refund.status, amountPaise, ...saved });
        } catch (error) {
          if (error.status === 400) return json(res, 409, { error: 'Razorpay rejected this refund. Check the payment and refund eligibility in Razorpay before trying again.' });
          if (error.status === 409) return json(res, 409, { error: 'Razorpay is already processing this refund request. Refresh this order before retrying.' });
          return json(res, 503, { error: 'Refund submission could not be confirmed. The amount is saved; retry the same amount or check Razorpay before taking another action.' });
        }
      }

      // COD refunds are recorded only after the store has returned the cash
      // separately. Coupon-only orders have no payment to return.
      if (current.payment_provider !== 'cod' || current.payment_status !== 'cod') {
        return json(res, 409, { error: 'This order has no refundable captured Razorpay or cash-on-delivery payment.' });
      }
    }

    try {
      const saved = await rpc('review_store_order_refund', {
        p_order_id: orderId,
        p_refund_status: refundStatus,
        p_admin_note: note || null,
        p_confirm_refund: input.confirmRefund === true
      });
      return saved ? json(res, 200, { saved: true }) : json(res, 404, { error: 'Order not found.' });
    } catch (error) {
      const message = String(error.message || '');
      if (/refund|captured|cash-on-delivery|sent the refund/i.test(message)) return json(res, 409, { error: message });
      return json(res, 503, { error: /function|schema cache/i.test(message) ? 'Refund reviews are temporarily unavailable. Please refresh and try again.' : 'The refund review could not be saved safely. Please refresh and try again.' });
    }
  } else return json(res, 400, { error: 'Choose a valid order action.' });

  try {
    const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(update)
    });
    if (!rows?.length) return json(res, 404, { error: 'Order not found.' });
    return json(res, 200, { saved: true });
  } catch (error) {
    const needsMigration = error.status === 400 && /column|schema cache|shipping_carrier|tracking_|refund_/i.test(error.message || '');
    return json(res, needsMigration ? 503 : error.status === 400 ? 400 : 502, {
      error: needsMigration
        ? 'Order tracking and refund fields need the latest order database update. Download and run the SQL update in Supabase.'
        : error.status === 400 ? 'The order update was rejected. Check the database migration and form values.' : 'The order update could not be saved. Retry and check the order status.'
    });
  }
};

async function saveRazorpayRefund(order, paymentId, refund, adminNote) {
  const isPrimaryPayment = paymentId === order.payment_reference;
  const fullyRefunded = isPrimaryPayment && refund.status === 'processed'
    && Number(refund.amount) >= Number(order.total) * 100;
  const patch = {
    refund_reference: refund.id,
    refund_amount_paise: Number(refund.amount),
    refund_status: refund.status === 'processed' ? 'processed' : 'approved',
    refund_resolved_at: refund.status === 'processed' ? new Date().toISOString() : null,
    refund_admin_note: adminNote || (refund.status === 'processed' ? 'Razorpay confirmed the refund.' : 'Refund submitted to Razorpay; awaiting provider confirmation.'),
    ...(isPrimaryPayment ? {} : { refund_payment_reference: paymentId }),
    ...(fullyRefunded ? { payment_status: 'refunded' } : {})
  };
  const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&refund_status=in.(requested,approved)&refund_reference=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  if (!rows?.length) {
    const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&select=refund_reference,refund_status,refund_amount_paise`);
    if (latest?.[0]?.refund_reference !== refund.id || Number(latest?.[0]?.refund_amount_paise) !== Number(refund.amount)) {
      throw new Error('Refund was submitted but the order record changed before it could be updated.');
    }
  }
  return { processed: refund.status === 'processed', pending: refund.status === 'pending' };
}
