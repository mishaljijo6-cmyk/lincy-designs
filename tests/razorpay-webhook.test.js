const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Readable } = require('node:stream');
const { rawBody, verifyWebhookSignature } = require('../api/razorpay-webhook');

const hmac = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');

test('webhook verification uses the exact raw request bytes', () => {
  const secret = 'test-webhook-secret';
  const raw = Buffer.from('{"event":"payment.captured", "payload":{}}');
  assert.equal(verifyWebhookSignature(secret, raw, hmac(secret, raw)), true);
  assert.equal(verifyWebhookSignature(secret, Buffer.from(raw.toString().replace(', ', ',')), hmac(secret, raw)), false);
  assert.equal(verifyWebhookSignature('', raw, hmac(secret, raw)), false);
});

test('raw webhook reader ignores an already-populated parsed body', async () => {
  const raw = Buffer.from('{"event":"payment.failed"}\n');
  const request = Readable.from([raw.subarray(0, 8), raw.subarray(8)]);
  request.body = { event: 'different.parsed.body' };
  assert.deepEqual(await rawBody(request), raw);
});

test('failed payment event does not expire or release the store order', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api/razorpay-webhook.js'), 'utf8');
  const failedBranch = source.slice(source.indexOf("if (event.event === 'payment.failed'"), source.indexOf("if (['refund.processed'"));
  assert.match(failedBranch, /attempt is not a failed store order/);
  assert.doesNotMatch(failedBranch, /fail_checkout_order/);
});
