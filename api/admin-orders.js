const { authenticatedUser, body, isConfirmedStoreAdmin, json, method, rpc, supabase, supabaseReady } = require('../lib/server');
const { createHash } = require('node:crypto');
const { createNormalRefund, getPayment, getRefund } = require('../lib/razorpay');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['new', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'complete', 'cancelled']);
const REFUNDS = new Set(['none', 'requested', 'approved', 'rejected', 'processed']);

function canRetryRefund(providerStatus) {
  return providerStatus === 'failed';
}

module.exports = async function adminOrders(req, res) {
  if (!method(req, res, ['PATCH'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Order updates are temporarily unavailable.' });
  let user;
  try { user = await authenticatedUser(req); }
  catch { return json(res, 503, { error: 'Admin account verification is temporarily unavailable.' }); }
  if (!user) return json(res, 401, { error: 'Sign in again to manage orders.' });
  if (!isConfirmedStoreAdmin(user)) return json(res, 403, { error: 'This confirmed account cannot manage store orders.' });
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
  if (input.action === 'cash-collected') {
    try {
      const saved = await rpc('mark_store_order_cash_collected', { p_order_id: orderId });
      return saved
        ? json(res, 200, { saved: true, cashCollected: true })
        : json(res, 409, { error: 'Cash can be recorded after a COD parcel is out for delivery or delivered.' });
    } catch (error) {
      const needsMigration = /function|schema cache/i.test(String(error.message || ''));
      return json(res, needsMigration ? 503 : 409, {
        error: needsMigration
          ? 'Cash collection recording needs the latest database update.'
          : 'Cash collection could not be recorded. Refresh the order and try again.'
      });
    }
  } else if (input.action === 'status') {
    const status = String(input.status || '');
    if (!STATUSES.has(status)) return json(res, 400, { error: 'Choose a valid order status.' });
    let current;
    try {
      const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,status,payment_status,refund_status,refund_amount_paise,total`);
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
    if (!transitions[current.status]?.includes(status)) {
      const nextStatuses = transitions[current.status] || [];
      return json(res, 409, {
        error: `Order is currently ${String(current.status || 'unknown').replaceAll('_', ' ')}. Refresh the list and choose one of its available next statuses.`,
        currentStatus: current.status,
        allowedStatuses: nextStatuses
      });
    }
    const fullyRefunded = current.payment_status === 'refunded'
      || (current.refund_status === 'processed' && Number(current.refund_amount_paise || 0) >= Math.round(Number(current.total || 0) * 100));
    if (status !== 'cancelled' && fullyRefunded) {
      return json(res, 409, { error: 'This order has been refunded and cannot move into fulfilment.' });
    }
    if (status !== 'cancelled' && !['paid', 'cod'].includes(current.payment_status)) {
      return json(res, 409, { error: 'This order cannot move into fulfilment until its payment is confirmed.' });
    }
    if (status !== 'cancelled' && ['requested', 'approved'].includes(current.refund_status)) {
      return json(res, 409, { error: 'Resolve the open refund request before changing fulfilment.' });
    }
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
      if (/not allowed/i.test(message)) {
        let latest;
        try {
          const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,status`);
          latest = rows?.[0];
        } catch {}
        if (latest && latest.status !== current.status) {
          return json(res, 409, { error: `The order changed to ${String(latest.status || 'unknown').replaceAll('_', ' ')} while you were viewing it. The list has been refreshed; choose the next available status.` });
        }
        return json(res, 503, { error: 'The database has older order-status rules. Apply the latest migration-orders-and-checkout.sql in Supabase, then refresh and retry.' });
      }
      if (/payment is confirmed|refund request/i.test(message)) return json(res, 409, { error: message });
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
  } else if (input.action === 'capture-refund') {
    const paymentId = String(input.paymentId || '');
    const attemptKey = String(input.attemptKey || '');
    const amountNumber = Number(input.refundAmount);
    const amountPaise = Math.round(amountNumber * 100);
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[A-Za-z0-9_-]{16,80}$/.test(attemptKey)
      || !Number.isFinite(amountNumber) || !Number.isSafeInteger(amountPaise) || amountPaise < 100) {
      return json(res, 400, { error: 'Choose a captured payment and a refund amount of at least ₹1.00.' });
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return json(res, 503, { error: 'Razorpay refunds are not configured on the server.' });
    }
    let order;
    try {
      const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,order_number,payment_provider`);
      order = rows?.[0];
    } catch { return json(res, 503, { error: 'Order details could not be checked. Refresh and try again.' }); }
    if (!order) return json(res, 404, { error: 'Order not found.' });
    if (order.payment_provider !== 'razorpay') return json(res, 409, { error: 'This order does not have a Razorpay capture to refund.' });

    let reservation;
    try {
      reservation = await rpc('reserve_store_capture_refund', {
        p_order_id: orderId, p_payment_id: paymentId, p_amount_paise: amountPaise, p_attempt_key: attemptKey
      });
    } catch (error) {
      const detail = String(error.message || '');
      if (/remaining captured amount|refund amount|attached to this order/i.test(detail)) return json(res, 409, { error: detail });
      return json(res, /function|schema cache/i.test(detail) ? 503 : 409, {
        error: /function|schema cache/i.test(detail)
          ? 'Capture refunds need the latest LINCY DESIGNS database update.'
          : 'The refund could not be reserved safely. Refresh this order and retry.'
      });
    }
    if (!reservation?.attempt_key || Number(reservation.amount_paise) !== amountPaise) {
      return json(res, 409, { error: 'A refund for this capture is already being processed. Refresh the order to see its status.' });
    }
    if (reservation.refund_status === 'failed') {
      return json(res, 409, { error: 'Razorpay marked the previous attempt failed. Refresh the order to start a new, safely tracked attempt.' });
    }
    if (reservation.refund_status === 'processed') {
      return json(res, 200, { saved: true, refundStatus: 'processed', refundId: reservation.razorpay_refund_id, amountPaise, alreadySubmitted: true });
    }

    let refund;
    try {
      if (reservation.razorpay_refund_id) {
        refund = await getRefund(reservation.razorpay_refund_id);
      } else {
        const payment = await getPayment(paymentId);
        if (payment.id !== paymentId || payment.status !== 'captured' || payment.currency !== 'INR') {
          return json(res, 409, { error: 'Razorpay does not show this payment as captured in INR, so it cannot be refunded here.' });
        }
        if (amountPaise > Number(payment.amount) - Number(payment.amount_refunded || 0)) {
          return json(res, 409, { error: 'The refund exceeds the remaining captured amount shown by Razorpay.' });
        }
        const receipt = `LDR-${reservation.attempt_key.slice(0, 28)}`;
        refund = await createNormalRefund(paymentId, amountPaise, reservation.attempt_key, receipt, {
          store_order_id: orderId,
          store_order_number: String(order.order_number || orderId).slice(0, 100),
          store_refund_attempt_key: reservation.attempt_key
        });
      }
      if (refund.payment_id !== paymentId || Number(refund.amount) !== amountPaise
        || !/^rfnd_[A-Za-z0-9]+$/.test(String(refund.id || ''))
        || !['pending', 'processed', 'failed'].includes(refund.status)) {
        return json(res, 502, { error: 'Razorpay returned an unexpected refund response. Check its dashboard before retrying.' });
      }
      const saved = await rpc('save_store_capture_refund_result', {
        p_attempt_key: reservation.attempt_key,
        p_refund_id: refund.id,
        p_status: refund.status,
        p_admin_note: refund.status === 'processed' ? 'Razorpay confirmed this capture refund.' : refund.status === 'failed' ? 'Razorpay reported this capture refund failed.' : 'Capture refund submitted; waiting for Razorpay confirmation.'
      });
      if (!saved?.saved) return json(res, 503, { error: 'Razorpay accepted the refund, but its status could not be saved. Refresh and check Razorpay before retrying.' });
      if (refund.status === 'failed') return json(res, 409, { error: 'Razorpay reports this refund attempt failed. Refresh the order to retry it safely.' });
      return json(res, 200, { saved: true, refundId: refund.id, refundStatus: saved.status || refund.status, amountPaise });
    } catch (error) {
      if (error.status === 400) return json(res, 409, { error: 'Razorpay rejected this refund. Check payment eligibility in Razorpay before trying again.' });
      if (error.status === 409) return json(res, 409, { error: 'Razorpay is already processing this refund. Refresh the order before retrying.' });
      return json(res, 503, { error: 'Refund submission could not be confirmed. Its idempotency key is saved; check Razorpay and retry the same attempt only after refreshing.' });
    }
  } else if (input.action === 'refund') {
    const refundStatus = String(input.refundStatus || '');
    const note = String(input.adminNote || '').trim();
    if (!REFUNDS.has(refundStatus) || note.length > 1000) return json(res, 400, { error: 'Check the refund review details and try again.' });
    if (refundStatus === 'processed' && input.confirmRefund !== true) return json(res, 400, { error: 'Confirm that you sent the refund before marking it processed.' });

    if (refundStatus === 'processed') {
      let current;
      try {
        const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,order_number,status,payment_provider,payment_status,total,payment_reference,refund_payment_reference,refund_status,refund_reference,refund_attempt_key,refund_amount_paise`);
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
        if (amountPaise > Number(current.total) * 100) {
          return json(res, 409, { error: 'The refund is capped at the store order total. The separate 2% online-payment fee is not refundable.' });
        }
        if (current.refund_amount_paise != null && Number(current.refund_amount_paise) !== amountPaise) {
          return json(res, 409, { error: 'A refund request is already saved for a different amount. Keep that amount and retry, or review the existing refund in Razorpay.' });
        }

        let previousRefundId = current.refund_reference || null;
        try {
          if (previousRefundId) {
            const existing = await getRefund(previousRefundId);
            if (existing.payment_id !== paymentId || Number(existing.amount) !== amountPaise) {
              return json(res, 409, { error: 'The saved Razorpay refund does not match this request. Review it in Razorpay before making another refund.' });
            }
            if (!canRetryRefund(existing.status)) {
              const updated = await saveRazorpayRefund(current, paymentId, existing, note, previousRefundId, current.refund_attempt_key || null);
              return json(res, 200, { saved: true, refundId: existing.id, refundStatus: existing.status, amountPaise, alreadySubmitted: true, ...updated });
            }
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
          const referenceFilter = previousRefundId ? `refund_reference=eq.${encodeURIComponent(previousRefundId)}` : 'refund_reference=is.null';
          if (current.refund_amount_paise == null) {
            const reserved = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&refund_status=in.(requested,approved)&${referenceFilter}&refund_amount_paise=is.null`, {
              method: 'PATCH', headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ refund_amount_paise: amountPaise })
            });
            if (!reserved?.length) {
              const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=refund_amount_paise,refund_reference,refund_status,refund_attempt_key`);
              if (Number(latest?.[0]?.refund_amount_paise) !== amountPaise) return json(res, 409, { error: 'Another refund update is in progress. Refresh and review the saved amount before retrying.' });
              current.refund_amount_paise = amountPaise;
              current.refund_reference = latest?.[0]?.refund_reference || null;
              current.refund_attempt_key = latest?.[0]?.refund_attempt_key || null;
            } else current.refund_amount_paise = amountPaise;
          }
          const digest = createHash('sha256').update(`${orderId}:${paymentId}:${amountPaise}`).digest('hex').slice(0, 32);
          // A retry after a provider-confirmed failure gets a new idempotency
          // key and receipt. If the response is lost, the same failed refund
          // remains saved, so this deterministic key safely recovers the retry.
          const attemptDigest = createHash('sha256').update(`${digest}:${previousRefundId || 'first'}`).digest('hex').slice(0, 24);
          const previousAttemptKey = current.refund_attempt_key || null;
          const attemptFilter = previousAttemptKey ? `refund_attempt_key=eq.${encodeURIComponent(previousAttemptKey)}` : 'refund_attempt_key=is.null';
          const attemptReservation = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&refund_status=in.(requested,approved)&${referenceFilter}&${attemptFilter}`, {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ refund_attempt_key: attemptDigest })
          });
          if (!attemptReservation?.length) {
            const latest = await supabase(`store_orders?id=eq.${encodeURIComponent(orderId)}&select=refund_attempt_key,refund_reference,refund_amount_paise`);
            if (latest?.[0]?.refund_attempt_key !== attemptDigest || Number(latest?.[0]?.refund_amount_paise) !== amountPaise) {
              return json(res, 409, { error: 'Another refund attempt is being recorded. Refresh this order before retrying.' });
            }
            current.refund_reference = latest?.[0]?.refund_reference || null;
          }
          current.refund_attempt_key = attemptDigest;
          const captureReservation = await rpc('reserve_store_capture_refund', {
            p_order_id: orderId, p_payment_id: paymentId, p_amount_paise: amountPaise, p_attempt_key: attemptDigest
          });
          if (captureReservation?.attempt_key !== attemptDigest || Number(captureReservation.amount_paise) !== amountPaise) {
            return json(res, 409, { error: 'A refund for this captured payment is already in progress. Refresh the order before retrying.' });
          }
          const receipt = `LD-${String(current.order_number || orderId).replace(/[^A-Za-z0-9_-]/g, '').slice(-18)}-${attemptDigest.slice(0, 8)}`;
          let refund = await createNormalRefund(paymentId, amountPaise, `Lincy_${attemptDigest}`, receipt, {
            store_order_id: orderId,
            store_order_number: String(current.order_number || orderId).slice(0, 100),
            refund_attempt_key: attemptDigest
          });
          if (refund.id && refund.status !== 'processed' && refund.status !== 'failed') {
            // A webhook can arrive before the response is stored. Read the
            // provider's latest state so that early webhook delivery cannot
            // leave the admin screen stuck at "approved".
            try { refund = await getRefund(refund.id); } catch {}
          }
          if (refund.payment_id !== paymentId || Number(refund.amount) !== amountPaise || !/^rfnd_[A-Za-z0-9]+$/.test(String(refund.id || '')) || !['pending', 'processed', 'failed'].includes(refund.status)) {
            return json(res, 502, { error: 'Razorpay returned an unexpected refund response. Check the Razorpay dashboard before retrying.' });
          }
          if (refund.status === 'failed') {
            await saveRazorpayRefund(current, paymentId, refund, 'Razorpay reported that this refund attempt failed. You can retry the same amount from this order.', previousRefundId, attemptDigest);
            return json(res, 409, { error: 'Razorpay reports that this refund attempt failed. The failure is recorded; retry the same amount here or review it in Razorpay.' });
          }
          const saved = await saveRazorpayRefund(current, paymentId, refund, note, previousRefundId, attemptDigest);
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

module.exports.canRetryRefund = canRetryRefund;

async function saveRazorpayRefund(order, paymentId, refund, adminNote, previousRefundId = null, attemptKey = null) {
  const ledgerAttemptKey = attemptKey || createHash('sha256').update(`${order.id}:${paymentId}:${refund.id || refund.amount}`).digest('hex').slice(0, 32);
  const ledgerResult = await rpc('record_store_payment_refund_event', {
    p_order_id: order.id,
    p_payment_id: paymentId,
    p_attempt_key: ledgerAttemptKey,
    p_refund_id: refund.id || null,
    p_amount_paise: Number(refund.amount),
    p_status: refund.status,
    p_admin_note: adminNote || null
  });
  if (!ledgerResult?.saved) throw new Error('The refund was sent, but its payment ledger could not be updated. Check Razorpay before retrying.');
  const isPrimaryPayment = paymentId === order.payment_reference;
  const fullyRefunded = isPrimaryPayment && refund.status === 'processed'
    && Number(refund.amount) >= Number(order.total) * 100;
  const patch = {
    refund_reference: refund.id,
    ...(attemptKey ? { refund_attempt_key: attemptKey } : {}),
    refund_amount_paise: Number(refund.amount),
    refund_status: refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'requested' : 'approved',
    refund_resolved_at: refund.status === 'processed' ? new Date().toISOString() : null,
    refund_admin_note: adminNote || (refund.status === 'processed' ? 'Razorpay confirmed the refund.' : 'Refund submitted to Razorpay; awaiting provider confirmation.'),
    ...(isPrimaryPayment ? {} : { refund_payment_reference: paymentId }),
    ...(fullyRefunded ? { payment_status: 'refunded' } : {})
  };
  const expectedReference = previousRefundId
    ? `refund_reference=eq.${encodeURIComponent(previousRefundId)}`
    : 'refund_reference=is.null';
  const expectedAttempt = attemptKey
    ? `refund_attempt_key=eq.${encodeURIComponent(attemptKey)}`
    : 'refund_attempt_key=is.null';
  const rows = await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&refund_status=in.(requested,approved)&${expectedReference}&${expectedAttempt}`, {
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
