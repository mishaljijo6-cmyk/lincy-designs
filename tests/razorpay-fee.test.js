const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentAmountMatchesOrder } = require('../lib/razorpay');

const previous = {
  enabled: process.env.RAZORPAY_CUSTOMER_PAYS_FEE,
  maxBps: process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS
};
test.after(() => {
  if (previous.enabled == null) delete process.env.RAZORPAY_CUSTOMER_PAYS_FEE;
  else process.env.RAZORPAY_CUSTOMER_PAYS_FEE = previous.enabled;
  if (previous.maxBps == null) delete process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS;
  else process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS = previous.maxBps;
});

test('Razorpay payment amount must exactly match store total by default', () => {
  process.env.RAZORPAY_CUSTOMER_PAYS_FEE = 'false';
  process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS = '300';
  assert.equal(paymentAmountMatchesOrder(10000, 100), true);
  assert.equal(paymentAmountMatchesOrder(10236, 100), false);
});

test('Razorpay customer fee is accepted only when enabled and within the configured cap', () => {
  process.env.RAZORPAY_CUSTOMER_PAYS_FEE = 'true';
  process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS = '300';
  assert.equal(paymentAmountMatchesOrder(10236, 100), true);
  assert.equal(paymentAmountMatchesOrder(10400, 100), false);
  process.env.RAZORPAY_CUSTOMER_FEE_MAX_BPS = '0';
  assert.equal(paymentAmountMatchesOrder(10236, 100), false);
});
