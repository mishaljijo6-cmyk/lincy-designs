function authorization() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) throw new Error('Razorpay is not configured.');
  return `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
}

async function findOrderByReceipt(receipt, expected = {}) {
  const expectedAmounts = Array.isArray(expected.amounts)
    ? expected.amounts.map(Number)
    : expected.amount == null ? [] : [Number(expected.amount)];
  const candidates = [];
  const pageSize = 100;
  const maximumPages = 21;
  for (let page = 0; page < maximumPages; page++) {
    const query = new URLSearchParams({ receipt: String(receipt), count: String(pageSize), skip: String(page * pageSize) });
    const response = await fetch(`https://api.razorpay.com/v1/orders?${query}`, {
      headers: { Authorization: authorization() },
      signal: AbortSignal.timeout(7000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.items)) throw new Error('Razorpay order lookup failed.');
    candidates.push(...result.items.filter(item => item.receipt === String(receipt)));
    if (result.items.length < pageSize) break;
    if (page === maximumPages - 1) throw new Error('Razorpay returned too many orders to reconcile safely.');
  }
  if (!candidates.length) return null;
  const matching = candidates.filter(item => (!expectedAmounts.length || expectedAmounts.includes(Number(item.amount)))
    && (!expected.currency || item.currency === expected.currency)
    && (!expected.storeOrderId || !item.notes?.store_order_id || item.notes.store_order_id === expected.storeOrderId));
  if (!matching.length) throw new Error('The existing Razorpay order does not match this store order.');
  if (matching.length > 1) throw new Error('More than one Razorpay order matches this store receipt; payment needs review.');
  return matching[0];
}

async function listPayments(gatewayOrderId) {
  const payments = [];
  const pageSize = 100;
  // One extra empty page proves that exactly 2,000 attempts is the end rather
  // than silently treating a full last page as complete.
  const maximumPages = 21;
  for (let page = 0; page < maximumPages; page++) {
    const query = new URLSearchParams({ count: String(pageSize), skip: String(page * pageSize) });
    const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments?${query}`, {
      headers: { Authorization: authorization() },
      signal: AbortSignal.timeout(7000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.items)) throw new Error('Razorpay payment lookup failed.');
    payments.push(...result.items);
    if (result.items.length < pageSize) return payments;
  }
  // Do not make expiry/refund decisions with a silently truncated payment list.
  throw new Error('Razorpay returned too many payment attempts to reconcile safely.');
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

async function getOrder(orderId) {
  return razorpayRequest(`orders/${encodeURIComponent(orderId)}`);
}

function customerConvenienceFeePolicy() {
  // The store adds a disclosed 2% online-payment fee to the Razorpay order.
  // Do not depend on Razorpay's dashboard fee-bearer setting: it does not
  // change the amount sent by this integration and can otherwise double-charge.
  return { enabled: true, feeBps: 200, maxBps: 200 };
}

function customerConvenienceFeePaise(orderTotal) {
  const baseAmount = Math.round(Number(orderTotal) * 100);
  const { enabled, feeBps } = customerConvenienceFeePolicy();
  if (!enabled || !Number.isSafeInteger(baseAmount) || baseAmount < 1) return 0;
  return Math.ceil(baseAmount * feeBps / 10000);
}

function checkoutFeePaise(orderTotal, provider) {
  return provider === 'razorpay' ? customerConvenienceFeePaise(orderTotal) : 0;
}

function razorpayOrderAmountPaise(orderTotal) {
  const baseAmount = Math.round(Number(orderTotal) * 100);
  if (!Number.isSafeInteger(baseAmount) || baseAmount < 0) return NaN;
  return baseAmount + customerConvenienceFeePaise(orderTotal);
}

function checkoutGatewayAmountPaise(orderTotal, provider) {
  return provider === 'razorpay' ? razorpayOrderAmountPaise(orderTotal) : 0;
}

function paymentAmountMatchesOrder(paymentAmount, orderTotal) {
  const amount = Number(paymentAmount);
  const expected = Math.round(Number(orderTotal) * 100);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(expected) || expected < 1 || amount < expected) return false;
  if (amount === expected) return true; // legacy orders created before the fee was added
  const { enabled } = customerConvenienceFeePolicy();
  if (!enabled) return false;
  // New store orders use this exact amount. Do not accept any arbitrary value
  // inside a percentage range: that could silently overcharge the shopper.
  return amount === expected + customerConvenienceFeePaise(orderTotal);
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

module.exports = {
  createNormalRefund,
  checkoutFeePaise,
  checkoutGatewayAmountPaise,
  customerConvenienceFeePaise,
  customerConvenienceFeePolicy,
  findOrderByReceipt,
  getOrder,
  getPayment,
  getRefund,
  listPayments,
  paymentAmountMatchesOrder,
  razorpayOrderAmountPaise
};
