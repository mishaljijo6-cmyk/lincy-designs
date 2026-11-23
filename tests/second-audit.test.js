const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const checkout = require('../api/checkout');
const { checkoutFeePaise, checkoutGatewayAmountPaise, customerConvenienceFeePaise, customerConvenienceFeePolicy, razorpayOrderAmountPaise } = require('../lib/razorpay');
const { canRetryRefund } = require('../api/admin-orders');
const { paymentAlreadyConfirmed, paymentAlreadyRefunded } = require('../api/verify-payment');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const storeSource = read('public/store.js');
const stateStart = storeSource.indexOf('function customerPaymentState(');
const stateEnd = storeSource.indexOf('\nlet paymentReturnRunning=', stateStart);
assert.ok(stateStart >= 0 && stateEnd > stateStart, 'payment state helpers should exist');
const stateContext = {};
vm.runInNewContext(`${storeSource.slice(stateStart, stateEnd)};this.paymentState=customerPaymentState;this.shouldResume=shouldResumePaymentReturn;`, stateContext);

const changedCustomer = { name: 'Mishal', email: 'mishal@example.test', phone: '+919400000000', address: 'New Road 2', city: 'Kattappana', state: 'Kerala', pincode: '685515', note: 'Leave at reception' };

test('checkout retry persists changed delivery instructions and compares them', () => {
  const patch = checkout.checkoutCustomerPatch(changedCustomer);
  assert.equal(patch.customer_note, 'Leave at reception');
  assert.equal(checkout.checkoutCustomerMatches({ ...patch }, changedCustomer), true);
  assert.equal(checkout.checkoutCustomerMatches({ ...patch, customer_note: 'Old instruction' }, changedCustomer), false);
  const source = read('api/checkout.js');
  assert.match(source, /customer_note: String\(customer\.note/);
  assert.match(source, /payment_status=eq\.pending[^`]*status=eq\.new/);
  assert.match(source, /saved\.status !== 'new'/);
});

test('checkout retry persists a changed delivery address and rejects confirmed mutations', () => {
  const patch = checkout.checkoutCustomerPatch(changedCustomer);
  assert.equal(patch.address, 'New Road 2');
  assert.equal(checkout.checkoutCustomerMatches({ ...patch, address: 'Old Road' }, changedCustomer), false);
  const source = read('api/checkout.js');
  assert.match(source, /\['paid', 'cod'\]\.includes\(saved\.payment_status\)[\s\S]*?already confirmed with its saved delivery details/);
});

test('a fully refunded Razorpay return is not displayed as a successful paid order', () => {
  const state = stateContext.paymentState({ payment_status: 'refunded', refund_status: 'processed', total: 100, refund_amount_paise: 10000 });
  assert.equal(state.key, 'refunded');
  assert.equal(state.orderConfirmed, true);
  assert.doesNotMatch(state.label, /paid securely/i);
  assert.match(state.message, /2% online payment fee/i);
  assert.match(read('api/verify-payment.js'), /paymentAlreadyRefunded\(order, paymentId\)/);
});

test('payment-status recovery returns the full original receipt for refunded and partially refunded orders', () => {
  const source = read('public/store.js');
  assert.match(source, /const orderPaymentState=order\?customerPaymentState\(order\):null/);
  assert.match(source, /if\(orderPaymentState\?\.orderConfirmed\)[\s\S]*?orderItems:order\.items[\s\S]*?orderState:orderPaymentState/);
  assert.match(source, /if\(checked\.ok&&verified\.verified\)\{verifyingPayment=false;return checkReturnedPayment\(result\.storeOrderId\)\}/);
  assert.match(source, /if\(paymentStatus==='paid'&&order\.status==='cancelled'\)return state\('store_review'/);
  const checkoutSource = read('api/checkout.js');
  assert.match(checkoutSource, /\['paid', 'refunded'\]\.includes\(order\.payment_status\)/);
  assert.match(checkoutSource, /refundStatus: saved\.refund_status, refundAmountPaise: saved\.refund_amount_paise/);
  const refunded = stateContext.paymentState({ payment_status: 'refunded', refund_status: 'processed', status: 'cancelled', total: 100, refund_amount_paise: 10000 });
  assert.equal(refunded.key, 'refunded');
  const late = stateContext.paymentState({ payment_status: 'paid', refund_status: 'requested', status: 'cancelled', total: 100 });
  assert.equal(late.key, 'store_review');
  assert.equal(late.orderConfirmed, true);
});

test('a partial refund is separately labelled and preserves the original order', () => {
  const state = stateContext.paymentState({
    payment_status: 'paid', total: 1000, refund_status: 'processed', refund_amount_paise: 25000,
    payment_captures: [{ razorpay_payment_id: 'pay_primary', needs_refund_review: false }],
    payment_refunds: [{ razorpay_payment_id: 'pay_primary', amount_paise: 25000, refund_status: 'processed' }]
  });
  assert.equal(state.key, 'partially_refunded');
  assert.equal(state.orderConfirmed, true);
  assert.match(storeSource, /paymentState\.key==='partially_refunded'/);
  assert.match(storeSource, /orderItems:order\.items/);
});

test('failed refund attempts can be retried while other provider states are not resubmitted', () => {
  assert.equal(canRetryRefund('failed'), true);
  assert.equal(canRetryRefund('pending'), false);
  assert.equal(canRetryRefund('processed'), false);
  const source = read('api/admin-orders.js');
  assert.match(source, /if \(!canRetryRefund\(existing\.status\)\)/);
  assert.match(source, /previousRefundId \|\| 'first'/);
});

test('online fee rounds up at small and large paise values', () => {
  assert.equal(customerConvenienceFeePaise(0.01), 1);
  assert.equal(razorpayOrderAmountPaise(0.01), 2);
  assert.equal(customerConvenienceFeePaise(123456.78), 246914);
  assert.equal(razorpayOrderAmountPaise(123456.78), 12592592);
});

test('COD has no online fee or gateway surcharge', () => {
  assert.equal(checkoutFeePaise(100, 'cod'), 0);
  assert.equal(checkoutGatewayAmountPaise(100, 'cod'), 0);
  assert.equal(customerConvenienceFeePolicy().feeBps, 200);
  assert.match(read('api/checkout.js'), /checkoutFeePaise\(quote\.total, provider\)/);
});

test('frontend and backend calculate the same 2% online amount', () => {
  const formula = storeSource.match(/const ONLINE_PAYMENT_FEE_BPS=(\d+),onlineFeePaise=total=>Math\.ceil\(Math\.round\(Number\(total\)\*100\)\*ONLINE_PAYMENT_FEE_BPS\/10000\)/);
  assert.ok(formula, 'front end fee calculator should exist');
  assert.equal(Number(formula[1]), customerConvenienceFeePolicy().feeBps);
  const frontFee = vm.runInNewContext(`${formula[0]};onlineFeePaise`, {});
  for (const total of [0.01, 2, 99, 2500, 123456.78]) {
    assert.equal(frontFee(total), customerConvenienceFeePaise(total));
    assert.equal(checkoutGatewayAmountPaise(total, 'razorpay'), Math.round(total * 100) + frontFee(total));
  }
  assert.match(read('api/checkout.js'), /amount: Number\(gatewayOrder\.amount\)/);
  assert.match(storeSource, /amount:result\.amount/);
});

test('refund cap and customer disclosure preserve the current fee policy', () => {
  const admin = read('api/admin-orders.js');
  const refundPage = read('public/refunds.html');
  assert.match(admin, /amountPaise > Number\(current\.total\) \* 100/);
  assert.match(admin, /separate 2% online-payment fee is not refundable/);
  assert.match(refundPage, /excludes the separate 2% online-payment fee/);
  assert.match(refundPage, /owner must explicitly confirm this fee-refund policy/);
});

test('payment confirmation resumes after refresh from the saved order reference', () => {
  assert.equal(stateContext.shouldResume(null, { storeOrderId: 'store-order-id' }), true);
  assert.equal(stateContext.shouldResume(null, {}), false);
  assert.match(storeSource, /const url=new URL\(location\.href\),saved=readCheckoutAttempt\(\),orderId=url\.searchParams\.get\('orderId'\)\|\|saved\?\.storeOrderId/);
});

test('return without an active session asks the customer to sign in and not pay again', () => {
  const start = storeSource.indexOf('async function resumePaymentReturn');
  const end = storeSource.indexOf('\nfunction renderAccount', start);
  const resume = storeSource.slice(start, end);
  assert.match(resume, /if\(error\|\|!data\?\.session\)/);
  assert.match(resume, /Sign in to check checkout/);
  assert.match(resume, /please do not pay again/);
});

test('duplicate verification is idempotent and a refunded order is never reported as newly paid', () => {
  assert.equal(paymentAlreadyConfirmed({ payment_status: 'paid', payment_reference: 'pay_123' }, 'pay_123'), true);
  assert.equal(paymentAlreadyConfirmed({ payment_status: 'paid', payment_reference: 'pay_123' }, 'pay_other'), false);
  assert.equal(paymentAlreadyConfirmed({ payment_status: 'refunded', payment_reference: 'pay_123' }, 'pay_123'), false);
  assert.equal(paymentAlreadyRefunded({ payment_status: 'refunded', payment_reference: 'pay_123' }, 'pay_123'), true);
  assert.match(read('api/admin-orders.js'), /This order has been refunded and cannot move into fulfilment/);
});
