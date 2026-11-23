function authorization() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) throw new Error('Razorpay is not configured.');
  return `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
}

async function findOrderByReceipt(receipt, expected = {}) {
  const query = new URLSearchParams({ receipt: String(receipt), count: '1' });
  const response = await fetch(`https://api.razorpay.com/v1/orders?${query}`, {
    headers: { Authorization: authorization() },
    signal: AbortSignal.timeout(7000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(result.items)) throw new Error('Razorpay order lookup failed.');
  const order = result.items.find(item => item.receipt === receipt);
  if (!order) return null;
  if ((expected.amount != null && Number(order.amount) !== Number(expected.amount))
    || (expected.currency && order.currency !== expected.currency)
    || (expected.storeOrderId && order.notes?.store_order_id && order.notes.store_order_id !== expected.storeOrderId)) {
    throw new Error('The existing Razorpay order does not match this store order.');
  }
  return order;
}

async function listPayments(gatewayOrderId) {
  const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`, {
    headers: { Authorization: authorization() },
    signal: AbortSignal.timeout(7000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(result.items)) throw new Error('Razorpay payment lookup failed.');
  return result.items;
}

async function razorpayRequest(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method,
    headers: {
      Authorization: authorization(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(result.error?.description || result.error?.reason || 'Razorpay could not complete the refund request.'));
    error.status = response.status;
    throw error;
  }
  return result;
}

async function getPayment(paymentId) {
  return razorpayRequest(`payments/${encodeURIComponent(paymentId)}`);
}

function customerConvenienceFeePolicy() {
  const enabled = String(process.env.RAZORPAY_CUSTOMER_PAYS_FEE || '').toLowerCase() === 'true';
  const maxBps = Number(process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS || 0);
  return { enabled: enabled && Number.isInteger(maxBps) && maxBps >= 1 && maxBps <= 5000, maxBps };
}

function paymentAmountMatchesOrder(paymentAmount, orderTotal) {
  const amount = Number(paymentAmount);
  const expected = Math.round(Number(orderTotal) * 100);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(expected) || expected < 1 || amount < expected) return false;
  if (amount === expected) return true;
  const { enabled, maxBps } = customerConvenienceFeePolicy();
  if (!enabled) return false;
  // Razorpay applies its configured convenience fee at checkout. Keep the
  // store order at its quoted amount and accept only the explicitly enabled,
  // bounded gateway surcharge. The actual amount is still verified by Razorpay.
  const maxFee = Math.ceil(expected * maxBps / 10000);
  return amount <= expected + maxFee;
}

async function getRefund(refundId) {
  return razorpayRequest(`refunds/${encodeURIComponent(refundId)}`);
}

async function createNormalRefund(paymentId, amountPaise, idempotencyKey, receipt, notes = {}) {
  return razorpayRequest(`payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: { 'X-Refund-Idempotency': idempotencyKey },
    body: { amount: amountPaise, speed: 'normal', receipt, notes }
  });
}

module.exports = { createNormalRefund, customerConvenienceFeePolicy, findOrderByReceipt, getPayment, getRefund, listPayments, paymentAmountMatchesOrder };
