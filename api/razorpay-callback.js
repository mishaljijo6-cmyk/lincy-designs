const { json, method, secureEqual, signature, supabase } = require('../lib/server');
const { getPayment, paymentAmountMatchesOrder } = require('../lib/razorpay');
const { markCaptured } = require('./razorpay-webhook');

const SITE_URL = 'https://lincydesigns.vercel.app';
const MAX_CALLBACK_BYTES = 12_000;

async function readCallback(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_CALLBACK_BYTES) throw new Error('Callback too large.');
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return Object.fromEntries(params.entries());
}

function redirect(res, orderId, result) {
  const target = new URL('/', SITE_URL);
  target.searchParams.set('payment_return', result);
  if (/^[0-9a-f-]{36}$/i.test(String(orderId || ''))) target.searchParams.set('orderId', orderId);
  res.statusCode = 303;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', target.toString());
  res.end();
}

module.exports = async function razorpayCallback(req, res) {
  if (!method(req, res, ['POST'])) return;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return redirect(res, '', 'unavailable');
  let input;
  try { input = await readCallback(req); }
  catch { return redirect(res, '', 'unavailable'); }

  const gatewayOrderId = String(input.razorpay_order_id || '');
  const paymentId = String(input.razorpay_payment_id || '');
  const supplied = String(input.razorpay_signature || '');
  if (!/^order_[A-Za-z0-9]+$/.test(gatewayOrderId)
    || !/^pay_[A-Za-z0-9]+$/.test(paymentId)
    || !/^[a-f0-9]{64}$/i.test(supplied)
    || !secureEqual(signature(secret, `${gatewayOrderId}|${paymentId}`), supplied)) {
    console.warn('razorpay_callback_signature_invalid', { hasSignature: Boolean(supplied) });
    return redirect(res, '', 'unverified');
  }

  try {
    const rows = await supabase(`store_orders?razorpay_order_id=eq.${encodeURIComponent(gatewayOrderId)}&payment_provider=eq.razorpay&select=id,total,payment_status&limit=1`);
    const order = rows?.[0];
    if (!order) return redirect(res, '', 'unverified');
    const payment = await getPayment(paymentId);
    if (payment.order_id !== gatewayOrderId || !paymentAmountMatchesOrder(payment.amount, order.total) || payment.currency !== 'INR') {
      return redirect(res, order.id, 'pending');
    }
    if (payment.status === 'captured') {
      await markCaptured(payment, gatewayOrderId);
      return redirect(res, order.id, 'confirmed');
    }
    return redirect(res, order.id, 'pending');
  } catch {
    return redirect(res, '', 'pending');
  }
};

module.exports.config = { api: { bodyParser: false } };
