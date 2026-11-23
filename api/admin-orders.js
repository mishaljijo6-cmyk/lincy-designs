const { authenticatedUser, body, json, method, supabase, supabaseReady } = require('../lib/server');

const ADMIN_EMAIL = String(process.env.STORE_ADMIN_EMAIL || 'mishalmj03@gmail.com').trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['new', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'complete', 'cancelled']);
const REFUNDS = new Set(['none', 'requested', 'approved', 'rejected', 'processed']);

module.exports = async function adminOrders(req, res) {
  if (!method(req, res, ['PATCH'])) return;
  if (!supabaseReady()) return json(res, 503, { error: 'Order updates are temporarily unavailable.' });
  let user;
  try { user = await authenticatedUser(req); }
  catch { return json(res, 503, { error: 'Admin account verification is temporarily unavailable.' }); }
  if (!user) return json(res, 401, { error: 'Sign in again to manage orders.' });
  if (String(user.email || '').toLowerCase() !== ADMIN_EMAIL) return json(res, 403, { error: 'This account cannot manage store orders.' });

  let input;
  try { input = await body(req); }
  catch { return json(res, 400, { error: 'Check the order update and try again.' }); }
  const orderId = String(input.orderId || '');
  if (!UUID.test(orderId)) return json(res, 400, { error: 'The order ID is invalid.' });

  let update;
  if (input.action === 'status') {
    const status = String(input.status || '');
    if (!STATUSES.has(status)) return json(res, 400, { error: 'Choose a valid order status.' });
    update = { status };
    if (status === 'shipped') update.shipped_at = new Date().toISOString();
    if (['delivered', 'complete'].includes(status)) update.delivered_at = new Date().toISOString();
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
  } else if (input.action === 'refund') {
    const refundStatus = String(input.refundStatus || '');
    const note = String(input.adminNote || '').trim();
    if (!REFUNDS.has(refundStatus) || note.length > 1000) return json(res, 400, { error: 'Check the refund review details and try again.' });
    if (refundStatus === 'processed' && input.confirmRefund !== true) return json(res, 400, { error: 'Confirm that you sent the refund before marking it processed.' });
    update = {
      refund_status: refundStatus,
      refund_admin_note: note || null,
      refund_resolved_at: ['approved', 'rejected', 'processed'].includes(refundStatus) ? new Date().toISOString() : null
    };
    if (refundStatus === 'processed') update.payment_status = 'refunded';
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
