const { json, method, secureEqual, signature, supabase } = require('../lib/server');

module.exports.config = { api: { bodyParser: false } };

async function rawBody(req, limit = 1_000_000) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function razorpayWebhook(req, res) {
  if (!method(req, res, ['POST'])) return;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return json(res, 503, { error: 'Webhook verification is not configured.' });
  let raw;
  try { raw = await rawBody(req); }
  catch { return json(res, 400, { error: 'Invalid webhook payload.' }); }

  const provided = req.headers['x-razorpay-signature'];
  if (!provided || !secureEqual(signature(secret, raw), provided)) return json(res, 401, { error: 'Invalid webhook signature.' });
  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, 400, { error: 'Invalid webhook payload.' }); }

  if (!['payment.captured', 'order.paid'].includes(event.event)) return json(res, 200, { received: true, ignored: true });
  const payment = event.payload?.payment?.entity;
  const gatewayOrderId = event.payload?.order?.entity?.id || payment?.order_id;
  const paymentId = payment?.id;
  if (!gatewayOrderId || !paymentId || payment?.status !== 'captured') return json(res, 200, { received: true, ignored: true });

  try {
    const rows = await supabase(`store_orders?razorpay_order_id=eq.${encodeURIComponent(gatewayOrderId)}&select=id,total,payment_status`);
    const order = rows?.[0];
    if (!order || order.payment_status !== 'pending' || payment.amount !== order.total * 100 || payment.currency !== 'INR') {
      return json(res, 200, { received: true, ignored: true });
    }
    await supabase(`store_orders?id=eq.${encodeURIComponent(order.id)}&payment_status=eq.pending&razorpay_order_id=eq.${encodeURIComponent(gatewayOrderId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ payment_status: 'paid', payment_provider: 'razorpay', payment_reference: paymentId })
    });
    return json(res, 200, { received: true });
  } catch {
    return json(res, 500, { error: 'Webhook processing failed.' });
  }
};
