const test = require('node:test');
const assert = require('node:assert/strict');
const {
  customerConvenienceFeePaise,
  listPayments,
  paymentAmountMatchesOrder,
  razorpayOrderAmountPaise
} = require('../lib/razorpay');

test('online payment amount includes a disclosed 2% fee rounded up to one paise', () => {
  assert.equal(customerConvenienceFeePaise(2), 4);
  assert.equal(razorpayOrderAmountPaise(2), 204);
  assert.equal(customerConvenienceFeePaise(100), 200);
  assert.equal(razorpayOrderAmountPaise(100), 10_200);
  assert.equal(razorpayOrderAmountPaise(0), 0);
});

test('capture validation accepts legacy base amounts or exactly the disclosed 2% fee', () => {
  assert.equal(paymentAmountMatchesOrder(10_000, 100), true);
  assert.equal(paymentAmountMatchesOrder(10_200, 100), true);
  assert.equal(paymentAmountMatchesOrder(10_199, 100), false);
  assert.equal(paymentAmountMatchesOrder(10_201, 100), false);
  assert.equal(paymentAmountMatchesOrder(9_999, 100), false);
});

test('payment history is paginated instead of silently stopping at ten attempts', async () => {
  const originalFetch = global.fetch;
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalSecret = process.env.RAZORPAY_KEY_SECRET;
  const requests = [];
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'test-secret';
  global.fetch = async url => {
    const parsed = new URL(url);
    const skip = Number(parsed.searchParams.get('skip'));
    requests.push(skip);
    const items = skip === 0
      ? Array.from({ length: 100 }, (_, index) => ({ id: `pay_${index}` }))
      : [{ id: 'pay_100' }];
    return { ok: true, json: async () => ({ items }) };
  };
  try {
    const payments = await listPayments('order_test');
    assert.equal(payments.length, 101);
    assert.deepEqual(requests, [0, 100]);
  } finally {
    global.fetch = originalFetch;
    if (originalKeyId == null) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalSecret == null) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalSecret;
  }
});
