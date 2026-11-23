const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const checkout = require('../api/checkout');
const { canCancelPaymentAttempt } = require('../api/cancel-payment');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('same idempotency key cannot turn into a different cart, including one-size products', () => {
  assert.equal(checkout.sameCheckoutLines(
    [{ productId: 'p1', quantity: 1, size: 'One size', color: 'Ivory' }],
    [{ product_id: 'p1', quantity: 1, selected_size: null, selected_color: 'Ivory' }]
  ), true);
  assert.equal(checkout.sameCheckoutLines(
    [{ productId: 'p1', quantity: 1, size: 'S', color: 'Ivory' }],
    [{ product_id: 'p1', quantity: 2, selected_size: 'S', selected_color: 'Ivory' }]
  ), false);
});

test('checkout recovery storage strips old customer address and contact details', () => {
  const source = read('public/store.js');
  const start = source.indexOf('function readStored(');
  const end = source.indexOf('const savedWishes=', start);
  assert.ok(start >= 0 && end > start);
  const values = new Map([['lincy-checkout-attempt-v1', JSON.stringify({
    key: 'attempt-key', storeOrderId: 'order-id', customer: { email: 'customer@example.test', address: '12 Test Road' }
  })]]);
  const localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
  const attempt = vm.runInNewContext(
    `const CHECKOUT_ATTEMPT='lincy-checkout-attempt-v1';${source.slice(start, end)};readCheckoutAttempt()`,
    { localStorage }
  );
  assert.equal(attempt.customer, undefined);
  assert.equal(JSON.parse(values.get('lincy-checkout-attempt-v1')).customer, undefined);
  assert.doesNotMatch(source, /persistAttempt\(\{storeOrderId:[^\n]*customer:/);
});

test('different checkout keys are serialized and cannot leave two pending orders for one customer', () => {
  const migration = read('migration-fixes.sql');
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_user_id::text, 0\)\)/);
  assert.match(migration, /payment_status = 'pending'[\s\S]*?idempotency_key is distinct from p_idempotency_key/);
});

test('a single failed Razorpay attempt does not fail the store order, and a late capture can recover stock', () => {
  const webhook = read('api/razorpay-webhook.js');
  const failedBranch = webhook.slice(webhook.indexOf("if (event.event === 'payment.failed'"), webhook.indexOf("if (['refund.processed'"));
  const migration = read('migration-fixes.sql');
  assert.doesNotMatch(failedBranch, /fail_checkout_order|release_pending_checkout_after_cancel/);
  assert.match(migration, /v_recover := v_order\.payment_status = 'failed'/);
  assert.match(migration, /if v_recover and v_order\.stock_released_at is not null/);
  assert.match(migration, /or \(v_recover and not v_can_recover\)/);
});

test('admin refund retries use Razorpay idempotency and cannot refund the online fee', () => {
  const razorpay = read('lib/razorpay.js');
  const admin = read('api/admin-orders.js');
  assert.match(razorpay, /'X-Refund-Idempotency'/);
  assert.match(admin, /amountPaise > Number\(current\.total\) \* 100/);
  assert.match(admin, /refund_attempt_key/);
});

test('an online checkout can be explicitly released only after Razorpay confirms no active payment', () => {
  const order = { id: 'store-1', total: 100, razorpay_order_id: 'order_1' };
  const gatewayOrder = { id: 'order_1', amount: 10200, currency: 'INR', status: 'attempted', amount_paid: 0, notes: { store_order_id: 'store-1' } };
  assert.equal(canCancelPaymentAttempt(order, gatewayOrder, []), true);
  assert.equal(canCancelPaymentAttempt(order, gatewayOrder, [{ order_id: 'order_1', currency: 'INR', status: 'failed' }]), true);
  assert.equal(canCancelPaymentAttempt(order, gatewayOrder, [{ order_id: 'order_1', currency: 'INR', status: 'created' }]), false);
  assert.equal(canCancelPaymentAttempt(order, gatewayOrder, [{ order_id: 'order_1', currency: 'INR', status: 'authorized' }]), false);
  assert.equal(canCancelPaymentAttempt(order, gatewayOrder, [{ order_id: 'order_1', currency: 'INR', status: 'captured' }]), false);
  assert.equal(canCancelPaymentAttempt(order, { ...gatewayOrder, amount: 10201 }, []), false);
  const migration = read('migration-fixes.sql');
  const cancelRpc = migration.slice(migration.indexOf('create or replace function public.release_pending_checkout_after_cancel'), migration.indexOf('-- A payment can fail once'));
  assert.doesNotMatch(cancelRpc, /created_at\s*>\s*now\(\)\s*-\s*interval '45 minutes'/);
  assert.match(cancelRpc, /payment_status = 'failed', status = 'cancelled'/);
});

test('capture webhooks record their signed payment payload without paginated provider reads', () => {
  const webhook = read('api/razorpay-webhook.js');
  const capturedBranch = webhook.slice(webhook.indexOf("if (event.event === 'payment.captured')"), webhook.indexOf("if (event.event === 'order.paid')"));
  const failedBranch = webhook.slice(webhook.indexOf("if (event.event === 'payment.failed'"), webhook.indexOf("if (['refund.processed'"));
  assert.match(capturedBranch, /markCaptured\(payment, gatewayOrderId\)/);
  assert.doesNotMatch(capturedBranch, /listPayments/);
  assert.doesNotMatch(failedBranch, /listPayments/);
  assert.match(webhook, /scheduled reconciler finds the capture/);
});

test('every Razorpay capture is uniquely recorded and extra captures are reviewable without replacing the primary payment', () => {
  const migration = read('migration-fixes.sql');
  const capture = migration.slice(migration.lastIndexOf('create or replace function public.record_razorpay_capture('));
  const orders = read('api/orders.js');
  const admin = read('public/admin.js');
  assert.match(migration, /razorpay_payment_id text not null unique/);
  assert.match(capture, /select exists\(select 1 from public\.store_order_payments where order_id=v_order\.id\)/);
  assert.match(capture, /needs_refund_review,refund_review_reason/);
  assert.match(capture, /payment_reference=case when v_duplicate then payment_reference else p_payment_id end/);
  assert.match(orders, /store_order_payments\?order_id=in\.\(/);
  assert.match(orders, /payment_captures: capturesByOrder\.get\(order\.id\)/);
  assert.match(admin, /Razorpay captures/);
  assert.match(admin, /capture-refund/);
});

test('size/color stock reserves the selected combination and restores it on release', () => {
  const migration = read('migration-fixes.sql');
  const store = read('public/store.js');
  const admin = read('public/admin.js');
  assert.match(migration, /primary key\(product_id,size,color\)/);
  assert.match(migration, /reserve_store_inventory\(p_product_id text,p_size text,p_color text,p_quantity integer\)/);
  assert.match(migration, /update public\.store_product_variants set stock=stock-p_quantity/);
  assert.match(migration, /update public\.store_product_variants set stock=stock\+p_quantity/);
  assert.match(migration, /Keep size\/color combinations used by open orders/);
  assert.match(migration, /The purchased size\/color is no longer configured/);
  assert.match(store, /variantStockFor\(product,size,color\)/);
  assert.match(store, /store_product_variants/);
  assert.match(admin, /Stock by size and color/);
  assert.match(admin, /save_store_product_variants/);
});
