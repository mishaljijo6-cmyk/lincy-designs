const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const moneyPaise = value => `₹${(Number(value || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const supabaseClient = window.supabase?.createClient && window.LINCY_SUPABASE_URL && window.LINCY_SUPABASE_PUBLISHABLE_KEY
  ? window.supabase.createClient(window.LINCY_SUPABASE_URL, window.LINCY_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
let products = [], orders = [], orderItems = [], paymentCaptures = [], captureRefunds = [], coupons = [], activeTab = 'products', orderFeaturesReady = false, captureLedgerReady = false;
const ADMIN_ORDER_COLUMNS = 'id,order_number,customer_name,email,phone,address,city,state,pincode,subtotal,shipping,total,gateway_amount_paise,payment_status,payment_provider,payment_reference,status,shipping_carrier,tracking_number,tracking_url,shipped_at,delivered_at,refund_status,refund_reason,refund_requested_at,refund_resolved_at,refund_admin_note,refund_payment_reference,refund_reference,refund_amount_paise,cash_collected_at,coupon_code,discount_amount,delivery_discount,created_at,updated_at';
const ORDER_STATUS_FLOW = {
  new: ['processing', 'packed', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
  delivered: ['complete'],
  complete: [],
  cancelled: []
};

function loadingMessage(target, text) {
  const el = $(target);
  if (!el) return;
  const wrapper = document.createElement('span'); wrapper.className = 'loading-inline';
  const spinner = document.createElement('span'); spinner.className = 'loading-spinner'; spinner.setAttribute('aria-hidden', 'true');
  wrapper.append(spinner, document.createTextNode(text)); el.replaceChildren(wrapper); el.classList.remove('error');
}
function message(target, text, error = false) {
  const el = $(target);
  if (el) { el.textContent = text; el.classList.toggle('error', error); }
}
function formFeedback(container, text = '', error = false) {
  let el = container.matches?.('.admin-form-feedback') ? container : container.querySelector('.admin-form-feedback');
  if (!el) { el = document.createElement('p'); el.className = 'admin-form-feedback'; container.append(el); }
  el.textContent = text;
  el.classList.toggle('success', !error && !!text);
  el.setAttribute('role', error ? 'alert' : 'status');
}
function showOrderMigrationNotice() {
  const el = $('#dashboardMessage');
  if (!el) return;
  el.classList.remove('error');
  el.setAttribute('role', 'alert');
  el.replaceChildren(document.createTextNode('Order ownership, shipment updates, and refund review are not enabled in this database yet. Apply the SQL migration in Supabase, then refresh: '));
  const link = document.createElement('a');
  link.href = 'https://github.com/mishaljijo6-cmyk/lincy-designs/blob/codex/checkout-mobile-order-fixes/migration-orders-and-checkout.sql';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'download the order database update';
  el.append(link, document.createTextNode(' in the repository SQL files, then refresh this page.'));
}
function orderSaveError(error) {
  const text = error?.message || 'The order update could not be saved.';
  return /column|schema cache|store_orders_(status|payment_status)|shipping_carrier|tracking_|refund_|user_id/i.test(text)
    ? 'This order feature needs the database update linked above. No change was saved.'
    : text;
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function safeTrackingUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}
function toggleView(user) {
  const login = $('#adminLogin'), dashboard = $('#adminDashboard'), isAdmin = !!user && !!(user.email_confirmed_at || user.confirmed_at) && user.app_metadata?.store_role === 'admin';
  login.classList.toggle('hidden', isAdmin);
  dashboard.classList.toggle('hidden', !isAdmin);
  if (isAdmin) { $('#adminIdentity').textContent = user.email; refreshDashboard(); }
  else if (user) { message('#adminLoginMessage', 'This account is not allowed to manage the store.', true); supabaseClient.auth.signOut(); }
}

async function refreshDashboard() {
  loadingMessage('#dashboardMessage', 'Loading your store…');
  const [productResult, orderResult] = await Promise.all([
    supabaseClient.from('store_products').select('*').order('created_at', { ascending: false }),
    supabaseClient.from('store_orders').select(ADMIN_ORDER_COLUMNS).order('created_at', { ascending: false })
  ]);
  if (productResult.error || orderResult.error) {
    message('#dashboardMessage', productResult.error?.message || orderResult.error?.message || 'Could not load the store.', true);
    return false;
  }
  products = productResult.data || [];
  orders = orderResult.data || [];
  if (products.length) {
    const variantResult = await supabaseClient.from('store_product_variants').select('product_id,size,color,stock').in('product_id', products.map(product => product.id));
    if (!variantResult.error) {
      const grouped = new Map();
      for (const row of variantResult.data || []) { const rows = grouped.get(row.product_id) || []; rows.push({ size: row.size || '', color: row.color || '', stock: Number(row.stock) || 0 }); grouped.set(row.product_id, rows); }
      products = products.map(product => ({ ...product, variant_rows: grouped.get(product.id) || [] }));
    } else {
      products = products.map(product => ({ ...product, variant_rows: [] }));
      if (!/store_product_variants|schema cache|relation/i.test(variantResult.error.message || '')) message('#dashboardMessage', 'Per-size/color stock could not be loaded. Refresh or apply the latest database update.', true);
    }
  }
  const noteResult = orders.length
    ? await supabaseClient.from('store_orders').select('id,customer_note').in('id', orders.map(order => order.id))
    : { data: [], error: null };
  const notesByOrder = new Map((noteResult.data || []).map(row => [row.id, row.customer_note || '']));
  orders = orders.map(order => ({ ...order, customer_note: notesByOrder.get(order.id) || '' }));
  const ids = orders.map(order => order.id).filter(Boolean);
  if (ids.length) {
    const result = await supabaseClient.from('store_order_items').select('id,order_id,product_id,product_name,unit_price,quantity,selected_size,selected_color,image_url').in('order_id', ids);
    if (result.error) {
      orderItems = [];
      message('#dashboardMessage', 'Order totals loaded, but item details could not be read. Check the store_order_items admin read policy.', true);
      return false;
    }
    orderItems = result.data || [];
  } else orderItems = [];
  paymentCaptures = []; captureRefunds = []; captureLedgerReady = !ids.length;
  if (ids.length) {
    const [captureResult, captureRefundResult] = await Promise.all([
      supabaseClient.from('store_order_payments').select('id,order_id,razorpay_payment_id,amount_paise,currency,payment_status,needs_refund_review,refund_review_reason,captured_at').in('order_id', ids),
      supabaseClient.from('store_payment_refunds').select('id,order_id,razorpay_payment_id,amount_paise,razorpay_refund_id,refund_status,admin_note,created_at').in('order_id', ids)
    ]);
    captureLedgerReady = !captureResult.error && !captureRefundResult.error;
    if (captureLedgerReady) { paymentCaptures = captureResult.data || []; captureRefunds = captureRefundResult.data || []; }
    else if (!/store_order_payments|store_payment_refunds|schema cache|relation/i.test(`${captureResult.error?.message || ''} ${captureRefundResult.error?.message || ''}`)) {
      message('#dashboardMessage', 'Payment capture history could not be loaded. Refresh the dashboard and check the latest database update.', true);
    }
  }
  // Customer notes are optional in stores upgraded from the older schema. Do
  // not disable status, tracking, and refund controls because that display-only
  // field has not been added yet.
  const schemaCheck = await supabaseClient.from('store_orders').select('user_id,shipping_carrier,tracking_number,refund_status,cash_collected_at').limit(1);
  orderFeaturesReady = !schemaCheck.error;
  $('#stats').innerHTML = `<div><small>PRODUCTS</small><b>${products.length}</b></div><div><small>ORDERS</small><b>${orders.length}</b></div><div><small>TO FULFIL</small><b>${orders.filter(order => ['paid', 'cod'].includes(order.payment_status) && !['complete', 'delivered', 'cancelled'].includes(order.status) && order.refund_status !== 'processed').length}</b></div>`;
  if (orderFeaturesReady) message('#dashboardMessage', '');
  else showOrderMigrationNotice();
  renderAdminContent();
  return true;
}

function renderProducts() {
  $('#adminContent').innerHTML = `<div class="admin-table admin-products">${products.map(product => `<article><img src="${escapeHtml(product.image_url)}" alt="" loading="lazy"><b>${escapeHtml(product.name)}</b><span>${escapeHtml(product.category)}</span><span>${money(product.price)} · ${Number(product.stock)} in stock</span><span class="admin-state ${product.active ? '' : 'inactive'}">${product.active ? 'Visible' : 'Hidden'}</span><div><button data-edit="${escapeHtml(product.id)}">Edit</button><button data-delete="${escapeHtml(product.id)}">Delete</button></div></article>`).join('') || '<p class="empty">No products yet. Add your first piece.</p>'}</div>`;
  $('#adminContent').querySelectorAll('img').forEach(image => image.addEventListener('error', () => image.classList.add('broken'), { once: true }));
}

async function adminOrderRequest(orderId, action, payload) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) throw new Error('Your admin sign-in expired. Sign in again.');
  const response = await fetch('/api/admin-orders', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ orderId, action, ...payload }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The order update could not be saved.');
  return result;
}
async function adminCouponRequest(method = 'GET', payload = null) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) throw new Error('Your admin sign-in expired. Sign in again.');
  const response = await fetch('/api/admin-coupons', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Coupon request failed.');
  return result;
}
function dateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
async function renderCoupons() {
  const root = $('#adminContent');
  root.innerHTML = '<p class="admin-order-muted loading-inline"><span class="loading-spinner" aria-hidden="true"></span><span>Loading coupons…</span></p>';
  try {
    const result = await adminCouponRequest();
    coupons = result.coupons || [];
    if (activeTab !== 'coupons') return;
    root.innerHTML = `<section class="admin-coupon-manager"><h2>Discount coupons</h2><p>Create a code, choose its discount, and set optional order minimums, caps, limits, or dates.</p><form id="couponForm" class="admin-coupon-form"><input type="hidden" name="originalCode"><label>Coupon code<input name="code" maxlength="24" pattern="[A-Za-z0-9_-]{3,24}" placeholder="WELCOME10" required></label><label>Discount<select name="discountType"><option value="percent">Percentage</option><option value="fixed">Fixed amount (₹)</option><option value="free_delivery">Free delivery</option></select></label><label>Value<input name="discountValue" type="number" min="0" step="1" data-coupon-value required></label><label>Minimum items subtotal (₹)<input name="minSubtotal" type="number" min="0" step="1" value="0"></label><label>Maximum discount (₹)<input name="maxDiscount" type="number" min="1" step="1" placeholder="No cap"></label><label>Total use limit<input name="usageLimit" type="number" min="1" step="1" placeholder="Unlimited"></label><label>Uses per customer<input name="perUserLimit" type="number" min="1" step="1" placeholder="Unlimited"></label><label>Starts at<input name="startsAt" type="datetime-local"></label><label>Expires at<input name="expiresAt" type="datetime-local"></label><label class="admin-coupon-active"><input name="active" type="checkbox" checked> Active</label><div class="admin-coupon-actions"><button class="button dark" type="submit">Save coupon</button><button class="button outline" type="reset" id="couponReset">Clear form</button></div><p class="admin-form-feedback" role="status"></p></form><div class="admin-coupon-list">${coupons.map(coupon => `<article><div><b>${escapeHtml(coupon.code)}</b><span>${coupon.discount_type === 'percent' ? `${Number(coupon.discount_value)}% off` : coupon.discount_type === 'free_delivery' ? 'Free delivery' : `${money(coupon.discount_value)} off`}</span><small>Minimum ${money(coupon.min_subtotal)} · ${coupon.discount_type === 'free_delivery' ? 'Delivery discount' : `Maximum ${coupon.max_discount == null ? 'No cap' : money(coupon.max_discount)}`} · Uses ${Number(coupon.usage_count)}${coupon.usage_limit == null ? '' : ` / ${Number(coupon.usage_limit)}`} · Per customer ${coupon.per_user_limit == null ? 'unlimited' : Number(coupon.per_user_limit)}</small><small>${coupon.starts_at ? `Starts ${formatDate(coupon.starts_at)}` : 'Starts immediately'} · ${coupon.expires_at ? `Expires ${formatDate(coupon.expires_at)}` : 'No expiry'}</small></div><span class="admin-state ${coupon.active ? '' : 'inactive'}">${coupon.active ? 'Active' : 'Paused'}</span><div><button type="button" data-coupon-edit="${escapeHtml(coupon.code)}">Edit</button><button type="button" data-coupon-toggle="${escapeHtml(coupon.code)}">${coupon.active ? 'Pause' : 'Activate'}</button><button type="button" data-coupon-delete="${escapeHtml(coupon.code)}">Delete</button></div></article>`).join('') || '<p class="empty">No coupons yet. Create your first discount code.</p>'}</div></section>`;
    const typeInput = $('#couponForm').elements.discountType, valueInput = $('#couponForm').elements.discountValue;
    const syncCouponValue = () => {
      const freeDelivery = typeInput.value === 'free_delivery';
      valueInput.readOnly = freeDelivery;
      valueInput.min = freeDelivery ? '0' : '1';
      valueInput.value = freeDelivery ? '0' : (valueInput.value === '0' ? '' : valueInput.value);
      valueInput.placeholder = freeDelivery ? 'Set automatically' : 'Enter discount';
      $('#couponForm').elements.maxDiscount.disabled = freeDelivery;
      if (freeDelivery) $('#couponForm').elements.maxDiscount.value = '';
    };
    typeInput.addEventListener('change', syncCouponValue);
    syncCouponValue();
  } catch (error) {
    if (activeTab !== 'coupons') return;
    root.innerHTML = `<p class="admin-migration-required">${escapeHtml(error.message)} <a href="https://github.com/mishaljijo6-cmyk/lincy-designs/blob/codex/checkout-mobile-order-fixes/migration-coupons.sql" target="_blank" rel="noopener noreferrer">Open the coupon database update</a> in the repository, run it in Supabase SQL Editor, then refresh.</p>`;
  }
}

function renderOrders() {
  const allStatusOptions = [['new', 'New'], ['processing', 'Processing'], ['packed', 'Packed'], ['shipped', 'Shipped'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['complete', 'Delivered (legacy)'], ['cancelled', 'Cancelled']];
  const refundOptions = [['none', 'No request'], ['requested', 'Requested'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['processed', 'Processed']];
  const migrationNotice = orderFeaturesReady ? '' : '<p class="admin-migration-required">Tracking, customer notes, and refund changes are paused until the order database update is applied. <a href="https://github.com/mishaljijo6-cmyk/lincy-designs/blob/codex/checkout-mobile-order-fixes/migration-orders-and-checkout.sql" target="_blank" rel="noopener noreferrer">Open the SQL update</a> in the repository, run it in Supabase SQL Editor, then reload this page.</p>';
  const settled = order => ['paid', 'cod'].includes(order.payment_status);
  const completedOrders = orders.filter(order => settled(order) && ['complete', 'delivered'].includes(order.status));
  const fulfilOrders = orders.filter(order => settled(order) && !['complete', 'delivered', 'cancelled'].includes(order.status) && order.refund_status !== 'processed');
  const failedOrders = orders.filter(order => order.status === 'cancelled' || ['failed', 'refunded'].includes(order.payment_status));
  const awaitingOrders = orders.filter(order => order.payment_status === 'pending' && order.status !== 'cancelled');
  const assigned = new Set([...completedOrders, ...fulfilOrders, ...failedOrders, ...awaitingOrders].map(order => order.id));
  const otherOrders = orders.filter(order => !assigned.has(order.id));
  const renderOrderCard = order => {
    const currentStatus = order.status || 'new';
    const allowedStatuses = ORDER_STATUS_FLOW[currentStatus] || [];
    const fullyRefunded = order.payment_status === 'refunded' || (order.refund_status === 'processed' && Number(order.refund_amount_paise || 0) >= Math.round(Number(order.total || 0) * 100));
    const refundOpen = ['requested', 'approved'].includes(order.refund_status);
    const fulfilmentLocked = fullyRefunded || !['paid', 'cod'].includes(order.payment_status) || refundOpen;
    const statusOptions = allStatusOptions.filter(([value]) => value === currentStatus || (allowedStatuses.includes(value) && (!fulfilmentLocked || !['processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'complete'].includes(value))));
    const items = orderItems.filter(item => item.order_id === order.id);
    const trackUrl = safeTrackingUrl(order.tracking_url);
    const canIssueRazorpayRefund = order.payment_provider === 'razorpay' && order.payment_status === 'paid';
    const canRecordCodRefund = order.payment_provider === 'cod' && order.payment_status === 'cod';
    const refundAmount = (Number(order.refund_amount_paise || 0) || Math.round(Number(order.total || 0) * 100)) / 100;
    const itemMarkup = items.map(item => `<div class="admin-order-item"><img src="${escapeHtml(item.image_url || '')}" alt="" loading="lazy"><div><b>${escapeHtml(item.product_name)}</b><small>${escapeHtml(item.selected_size || 'One size')} · ${escapeHtml(item.selected_color || '—')} · Qty ${Number(item.quantity)}</small><small>Unit ${money(item.unit_price)}</small></div><strong>${money(Number(item.unit_price) * Number(item.quantity))}</strong></div>`).join('') || '<p class="admin-order-muted">No saved line items. Apply the latest checkout database update for new orders.</p>';
    const captures = paymentCaptures.filter(payment => payment.order_id === order.id);
    const captureMarkup = captures.length ? `<section class="admin-order-lines admin-payment-ledger"><h3>Razorpay captures (${captures.length})</h3>${captures.map(payment => {
      const refunds = captureRefunds.filter(refund => refund.razorpay_payment_id === payment.razorpay_payment_id);
      const reserved = refunds.filter(refund => ['reserved', 'pending', 'processed'].includes(refund.refund_status)).reduce((sum, refund) => sum + Number(refund.amount_paise || 0), 0);
      const processed = refunds.filter(refund => refund.refund_status === 'processed').reduce((sum, refund) => sum + Number(refund.amount_paise || 0), 0);
      const remaining = Math.max(0, Number(payment.amount_paise || 0) - reserved);
      const extra = payment.razorpay_payment_id !== order.payment_reference;
      return `<article class="admin-payment-capture"><div><b>${extra ? 'Additional capture' : 'Order payment'} · ${moneyPaise(payment.amount_paise)}</b><small>${escapeHtml(payment.razorpay_payment_id)} · ${formatDate(payment.captured_at)} · ${escapeHtml(payment.payment_status)}</small>${payment.needs_refund_review ? `<small class="admin-payment-alert">Payment review required: ${escapeHtml(payment.refund_review_reason || 'Additional or late capture')}</small>` : ''}<small>Refunded ${moneyPaise(processed)} · remaining on this capture ${moneyPaise(remaining)}</small>${refunds.map(refund => `<small>Refund attempt · ${escapeHtml(refund.razorpay_refund_id || 'awaiting Razorpay reference')} · ${moneyPaise(refund.amount_paise)} · ${escapeHtml(refund.refund_status)} · ${formatDate(refund.created_at)}${refund.admin_note ? ` · ${escapeHtml(refund.admin_note)}` : ''}</small>`).join('')}</div>${extra && payment.needs_refund_review && remaining >= 100 ? `<form class="admin-capture-refund-form" data-capture-refund="${escapeHtml(order.id)}" data-attempt-key="${crypto.randomUUID().replaceAll('-', '')}"><input type="hidden" name="paymentId" value="${escapeHtml(payment.razorpay_payment_id)}"><label>Refund amount (₹)<input name="refundAmount" type="number" min="1" max="${(remaining / 100).toFixed(2)}" step="0.01" value="${(remaining / 100).toFixed(2)}" required></label><div class="admin-form-feedback" aria-live="polite"></div><button class="button outline" type="submit" ${captureLedgerReady ? '' : 'disabled'}>Refund this capture</button></form>` : ''}</article>`;
    }).join('')}</section>` : (order.payment_provider === 'razorpay' && order.payment_reference ? `<section class="admin-order-lines"><h3>Razorpay payment history</h3><p class="admin-order-muted">No capture ledger row is available for this older order. Apply migration-fixes.sql and refresh.</p></section>` : '');
    const failedRefundAttempts = captureRefunds.filter(refund => refund.order_id === order.id && refund.refund_status === 'failed').length;
    const unresolvedCapture = captures.some(payment => payment.needs_refund_review);
    const paymentIssue = order.payment_status === 'pending' ? 'Payment is still pending. Do not fulfil this order until Razorpay confirms capture.'
      : order.payment_status === 'failed' ? 'Payment was not confirmed. This order cannot be fulfilled.'
      : ['requested', 'approved'].includes(order.refund_status) ? 'A refund request is unresolved. Review it before changing fulfilment.'
      : failedRefundAttempts ? `${failedRefundAttempts} refund attempt${failedRefundAttempts === 1 ? '' : 's'} failed. Review the attempt history and retry only after checking Razorpay.`
      : unresolvedCapture ? 'An additional or late capture needs a refund review.'
      : '';
    const paymentAlertMarkup = paymentIssue ? `<p class="admin-payment-alert" role="status">${escapeHtml(paymentIssue)}</p>` : '';
    return `<details class="admin-order-card"><summary><span><b>${escapeHtml(order.order_number)}</b><small>${escapeHtml(order.customer_name)} · ${formatDate(order.created_at)}</small></span><span>${money(order.total)}<small>${escapeHtml(order.payment_status)} · ${escapeHtml(order.payment_provider || '—')}</small></span><span class="admin-order-status">${escapeHtml(String(order.status || 'new').replaceAll('_', ' '))}</span><span class="admin-order-chevron" aria-hidden="true">⌄</span></summary><div class="admin-order-body">
      ${paymentAlertMarkup}<div class="admin-order-columns"><section><h3>Customer & delivery</h3><p><b>${escapeHtml(order.customer_name)}</b><br><a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a><br><a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a></p><p>${escapeHtml(order.address)}<br>${escapeHtml(order.city)}, ${escapeHtml(order.state)} ${escapeHtml(order.pincode)}</p><small>Placed ${formatDate(order.created_at)}</small>${order.customer_note ? `<p><b>Customer order note</b><br>${escapeHtml(order.customer_note)}</p>` : '<p class="admin-order-muted">No order note provided.</p>'}</section><section><h3>Payment & amount</h3><dl class="admin-order-prices"><div><dt>Items subtotal</dt><dd>${money(order.subtotal)}</dd></div>${order.coupon_code && Number(order.discount_amount) ? `<div><dt>Coupon (${escapeHtml(order.coupon_code)})</dt><dd>−${money(order.discount_amount)}</dd></div>` : ''}<div><dt>Delivery</dt><dd>${Number(order.shipping) ? money(order.shipping) : 'Free'}</dd></div>${Number(order.delivery_discount) ? `<div><dt>Free delivery coupon (${escapeHtml(order.coupon_code)})</dt><dd>−${money(order.delivery_discount)}</dd></div>` : ''}${Number(order.gateway_amount_paise)>Math.round(Number(order.total)*100)?`<div><dt>Razorpay convenience fee</dt><dd>${moneyPaise(Number(order.gateway_amount_paise)-Math.round(Number(order.total)*100))}</dd></div>`:''}<div class="total"><dt>Store order total</dt><dd>${money(order.total)}</dd></div>${Number(order.gateway_amount_paise)>0?`<div><dt>Total paid to Razorpay</dt><dd>${moneyPaise(Number(order.gateway_amount_paise))}</dd></div>`:''}</dl><p><b>${escapeHtml(order.payment_provider || '—')}</b> · ${escapeHtml(order.payment_status)}<br>Reference: ${escapeHtml(order.payment_reference || 'Not paid yet')}${order.refund_payment_reference?`<br>Payment needing refund: ${escapeHtml(order.refund_payment_reference)}`:''}${order.refund_reference?`<br>Refund reference: ${escapeHtml(order.refund_reference)} · ${money(Number(order.refund_amount_paise||0)/100)}`:''}</p></section></div>
      <section class="admin-order-lines"><h3>Items (${items.length})</h3>${itemMarkup}</section>${captureMarkup}
      <div class="admin-order-columns admin-order-management"><section><h3>Fulfilment & tracking</h3><label>Order status<select data-status="${escapeHtml(order.id)}" ${orderFeaturesReady && !fulfilmentLocked ? '' : 'disabled'}>${statusOptions.map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${order.payment_provider === 'cod' && order.payment_status === 'cod' && ['out_for_delivery','delivered','complete'].includes(currentStatus) ? `<p class="admin-cash-collected"><button class="button outline" type="button" data-cash-collected="${escapeHtml(order.id)}" ${orderFeaturesReady && !order.cash_collected_at ? '' : 'disabled'}>${order.cash_collected_at ? `Cash collected ${formatDate(order.cash_collected_at)}` : 'Mark cash collected'}</button></p>` : ''}<form class="admin-tracking-form" data-tracking="${escapeHtml(order.id)}"><label>Carrier<input name="carrier" maxlength="80" value="${escapeHtml(order.shipping_carrier || '')}" placeholder="Courier or delivery service" ${orderFeaturesReady ? '' : 'disabled'}></label><label>Tracking number<input name="trackingNumber" maxlength="120" value="${escapeHtml(order.tracking_number || '')}" placeholder="Tracking ID" ${orderFeaturesReady ? '' : 'disabled'}></label><label>Tracking link<input name="trackingUrl" type="url" value="${escapeHtml(order.tracking_url || '')}" placeholder="https://…" ${orderFeaturesReady ? '' : 'disabled'}></label><div class="admin-form-feedback" aria-live="polite"></div><button class="button outline" type="submit" ${orderFeaturesReady ? '' : 'disabled'}>Save tracking</button></form><p class="admin-order-muted">Shipped: ${formatDate(order.shipped_at)} · Delivered: ${formatDate(order.delivered_at)}</p>${trackUrl ? `<a href="${escapeHtml(trackUrl)}" target="_blank" rel="noopener noreferrer">Open tracking page ↗</a>` : ''}</section><section><h3>Refund request</h3><p><b>${escapeHtml(order.refund_status || 'none')}</b>${order.refund_reason ? `<br>Customer refund comment: ${escapeHtml(order.refund_reason)}` : ''}<br>Requested: ${formatDate(order.refund_requested_at)}</p><form class="admin-refund-form" data-refund="${escapeHtml(order.id)}"><label>Review status<select name="refundStatus" ${orderFeaturesReady ? '' : 'disabled'}>${refundOptions.map(([value, label]) => `<option value="${value}" ${(order.refund_status || 'none') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${canIssueRazorpayRefund || canRecordCodRefund ? `<label>Refund amount (₹)<input name="refundAmount" type="number" min="1" max="${Number(order.total || 0)}" step="0.01" value="${refundAmount}" ${orderFeaturesReady ? '' : 'disabled'}></label>` : ''}<label>Note for customer<textarea name="adminNote" rows="3" maxlength="1000" ${orderFeaturesReady ? '' : 'disabled'}>${escapeHtml(order.refund_admin_note || '')}</textarea></label><label class="admin-refund-confirm"><input type="checkbox" name="markRefunded" ${orderFeaturesReady ? '' : 'disabled'}> ${canIssueRazorpayRefund ? 'I approve submitting this refund to Razorpay now' : canRecordCodRefund ? 'I have returned this cash refund to the customer' : 'No cash payment was collected for this order'}</label><div class="admin-form-feedback" aria-live="polite"></div><button class="button outline" type="submit" ${orderFeaturesReady ? '' : 'disabled'}>Save refund review</button></form><small class="admin-order-muted">${canIssueRazorpayRefund ? 'Saving as Processed submits one idempotent refund to Razorpay. Partial amounts are supported; Razorpay confirms the final status by webhook.' : canRecordCodRefund ? 'Return the cash separately before saving this refund as Processed.' : 'Coupon-covered orders have no captured amount to refund.'}</small></section></div>
    </div></details>`;

  };
  const groups = [
    ['To fulfil · Paid / COD', fulfilOrders],
    ['Completed orders', completedOrders],
    ['Failed / cancelled orders', failedOrders],
    ['Awaiting payment', awaitingOrders],
    ['Other orders', otherOrders]
  ].filter(([, groupOrders]) => groupOrders.length);
  $('#adminContent').innerHTML = `${migrationNotice}<div class="admin-order-list">${groups.map(([title, groupOrders]) => `<section class="admin-order-group"><h2>${title} <span>${groupOrders.length}</span></h2>${groupOrders.map(renderOrderCard).join('')}</section>`).join('') || '<p class="empty">No orders yet.</p>'}</div>`;
  $('#adminContent').querySelectorAll('img').forEach(image => image.addEventListener('error', () => image.classList.add('broken'), { once: true }));
}
function renderAdminContent() {
  if (activeTab === 'products') renderProducts();
  else if (activeTab === 'orders') renderOrders();
  else renderCoupons();
}

async function uploadProductImage(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  if (!allowed.includes(file.type)) throw new Error('Choose a JPG, PNG, WebP, or AVIF image.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Each image must be 10 MB or smaller.');
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' })[file.type];
  const path = `products/${crypto.randomUUID()}.${extension}`;
  const { data, error } = await supabaseClient.storage.from('store-product-images').upload(path, file, {
    cacheControl: '31536000', contentType: file.type, upsert: false
  });
  if (error) {
    if (/bucket|row-level security|policy|not found/i.test(error.message || '')) {
      throw new Error('Device image uploads need the database and storage update linked on this admin page.');
    }
    throw error;
  }
  return supabaseClient.storage.from('store-product-images').getPublicUrl(data.path).data.publicUrl;
}

function openEditor(product = {}) {
  const editing = !!product.id;
  $('#formContent').innerHTML = `<span class="kicker">PRODUCT DETAILS</span><h2>${editing ? 'Edit' : 'Add'} a piece</h2><form id="productForm" class="checkout-grid">
    <label>Product name<input name="name" maxlength="120" value="${escapeHtml(product.name || '')}" required></label>
    <label>Category<select name="category">${['Churidars', 'Kurtas'].map(category => `<option ${product.category === category ? 'selected' : ''}>${category}</option>`).join('')}</select></label>
    <label>Price (₹)<input name="price" type="number" min="1" step="1" value="${product.price || ''}" required></label>
    <label>Compare-at price (₹)<input name="compare_at" type="number" min="0" step="1" value="${product.compare_at || ''}"></label>
    <label>Stock quantity <small>${product.variant_rows?.length ? 'Total is managed by the size/color allocations below.' : 'Shared stock until you configure size/color allocations.'}</small><input name="stock" type="number" min="0" step="1" value="${product.stock ?? 0}" required></label>
    <label>Badge<input name="badge" maxlength="40" value="${escapeHtml(product.badge || '')}"></label>
    <label class="wide">Main product image <small>Paste an HTTPS link or choose an image from this device.</small><input name="image_url" type="url" value="${escapeHtml(product.image_url || '')}" placeholder="https://…"></label>
    <label class="wide">Upload main image<input name="main_image_file" type="file" accept="image/jpeg,image/png,image/webp,image/avif"></label>
    <label class="wide">Additional image links <small>One HTTPS image link per line.</small><textarea name="image_gallery" rows="3" placeholder="https://…">${escapeHtml((product.image_gallery || []).join('\n'))}</textarea></label>
    <label class="wide">Upload additional images <small>Select multiple photos; each must be under 10 MB.</small><input name="gallery_files" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple></label>
    <label class="wide">Color-specific photos <small>Color | image URL, one per line; repeat a color for more views.</small><textarea name="color_images" rows="4" placeholder="Sage | https://…">${escapeHtml(Object.entries(product.color_images || {}).flatMap(([color, urls]) => (Array.isArray(urls) ? urls : []).map(url => `${color} | ${url}`)).join('\n'))}</textarea></label>
    <label class="wide">Sizes <small>Comma separated</small><input name="sizes" value="${escapeHtml((product.sizes || []).join(', '))}" placeholder="S, M, L, XL"></label>
    <label class="wide">Colors <small>Comma separated</small><input name="colors" value="${escapeHtml((product.colors || []).join(', '))}" placeholder="Ivory, Gold"></label>
    <label class="wide">Stock by size and color <small>One combination per line: Size | Color | available quantity. Example: M | Blush | 4. Use “One size” or “No color” when that option does not apply. Unlisted combinations become unavailable. Leave empty to use shared stock.</small><textarea name="variant_stock" rows="6" placeholder="S | Blush | 3&#10;M | Blush | 4">${escapeHtml((product.variant_rows || []).map(row => `${row.size || 'One size'} | ${row.color || 'No color'} | ${row.stock}`).join('\n'))}</textarea></label>
    <label class="admin-checkbox wide"><input name="clear_variant_stock" type="checkbox"> Clear these allocations and use one shared stock quantity</label>
    <label class="wide">Description<textarea name="description" maxlength="2000" required>${escapeHtml(product.description || '')}</textarea></label>
    <p class="admin-form-feedback wide" aria-live="polite"></p>
    <label class="admin-checkbox wide"><input name="active" type="checkbox" ${product.active !== false ? 'checked' : ''}> Visible in the storefront</label>
    <button class="button dark wide" type="submit">Save product</button>
  </form>`;
  $('#overlay').classList.remove('hidden');
  $('#adminModal').classList.remove('hidden');
  $('#productForm').onsubmit = async event => {
    event.preventDefault();
    const formElement = event.currentTarget, form = Object.fromEntries(new FormData(formElement));
    const feedback = formElement.querySelector('.admin-form-feedback'), saveButton = formElement.querySelector('button[type="submit"]');
    const mainImageFile = formElement.elements.main_image_file.files[0];
    const galleryFiles = Array.from(formElement.elements.gallery_files.files || []);
    const priceValue = Number(form.price), compareValue = form.compare_at ? Number(form.compare_at) : null;
    if (compareValue !== null && compareValue > 0 && compareValue < priceValue) { formFeedback(feedback, 'Compare-at price must be higher than the selling price.', true); return; }
    const colorImages = {};
    for (const line of form.color_images.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      const split = line.indexOf('|');
      if (split < 1) { formFeedback(feedback, 'Enter color photos as Color | image URL, one per line.', true); return; }
      const color = line.slice(0, split).trim(), url = line.slice(split + 1).trim();
      if (!/^https:\/\//i.test(url)) { formFeedback(feedback, 'Color photo links must use HTTPS.', true); return; }
      (colorImages[color] ||= []).push(url);
    }
    const imageGallery = form.image_gallery.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (imageGallery.some(url => !/^https:\/\//i.test(url))) { formFeedback(feedback, 'Photo links must use HTTPS.', true); return; }
    const sizes = form.sizes.split(',').map(value => value.trim()).filter(Boolean), colors = form.colors.split(',').map(value => value.trim()).filter(Boolean);
    const variantLines = String(form.variant_stock || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean), variants = [];
    const seenVariants = new Set();
    for (const line of variantLines) {
      const parts = line.split('|').map(value => value.trim());
      if (parts.length !== 3 || !/^[0-9]{1,7}$/.test(parts[2])) { formFeedback(feedback, 'Enter stock as Size | Color | whole quantity, one combination per line.', true); return; }
      const size = /^one size$/i.test(parts[0]) ? '' : parts[0], color = /^(no color|none|—|-)$/i.test(parts[1]) ? '' : parts[1], stock = Number(parts[2]);
      if ((sizes.length ? !sizes.includes(size) : size !== '') || (colors.length ? !colors.includes(color) : color !== '')) { formFeedback(feedback, 'Each stock line must match the product sizes and colors above.', true); return; }
      const key = JSON.stringify([size, color]); if (seenVariants.has(key)) { formFeedback(feedback, 'Each size and color combination can appear only once.', true); return; }
      seenVariants.add(key); variants.push({ size, color, stock });
    }
    if (variantLines.length && formElement.elements.clear_variant_stock.checked) { formFeedback(feedback, 'Use variant stock lines or clear allocations, not both.', true); return; }
    const imageFiles = [mainImageFile, ...galleryFiles].filter(Boolean);
    if (imageFiles.some(file => !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type) || file.size > 10 * 1024 * 1024)) {
      formFeedback(feedback, 'Choose JPG, PNG, WebP, or AVIF images no larger than 10 MB each.', true); return;
    }
    saveButton.disabled = true; saveButton.textContent = imageFiles.length ? 'Uploading images…' : 'Saving product…';
    try {
      let imageUrl = String(form.image_url || '').trim() || product.image_url || '';
      if (mainImageFile) imageUrl = await uploadProductImage(mainImageFile);
      if (!imageUrl || !/^https:\/\//i.test(imageUrl)) throw new Error('Choose a main image file or enter an HTTPS image link.');
      if (galleryFiles.length) imageGallery.push(...await Promise.all(galleryFiles.map(uploadProductImage)));
      const hasVariantInventory = Boolean(product.variant_rows?.length);
      const payload = { id: product.id || `lincy-${crypto.randomUUID()}`, name: form.name.trim(), category: form.category, price: priceValue, compare_at: compareValue, stock: hasVariantInventory && !variants.length && !formElement.elements.clear_variant_stock.checked ? Number(product.stock) : Number(form.stock), badge: form.badge.trim() || null, image_url: imageUrl, image_gallery: imageGallery, color_images: colorImages, sizes, colors, description: form.description.trim(), active: formElement.elements.active.checked };
      let { error } = await supabaseClient.from('store_products').upsert(payload);
      if (error && /image_gallery|color_images|column/i.test(error.message || '') && !galleryFiles.length && !imageGallery.length && !Object.keys(colorImages).length) {
        const { image_gallery, color_images, ...legacyPayload } = payload;
        error = (await supabaseClient.from('store_products').upsert(legacyPayload)).error;
      }
      if (error) throw error;
      if (variants.length || formElement.elements.clear_variant_stock.checked) {
        const { error: variantSaveError } = await supabaseClient.rpc('save_store_product_variants', { p_product_id: payload.id, p_variants: variants });
        if (variantSaveError) throw new Error(`Product saved, but size/color stock was not saved: ${variantSaveError.message || 'apply the latest database update and retry'}`);
      }
      $('#adminModal').classList.add('hidden'); $('#overlay').classList.add('hidden'); await refreshDashboard();
      toast('Product saved');
    } catch (error) {
      const text = /image_gallery|color_images|schema cache/i.test(error.message || '')
        ? 'Apply the database update linked on this admin page before saving product galleries.'
        : error.message || 'The product could not be saved.';
      formFeedback(feedback, text, true);
      saveButton.disabled = false; saveButton.textContent = 'Save product';
    }
  };
}

function toast(text) { const el = $('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2200); }

$('#adminLoginForm').onsubmit = async event => {
  event.preventDefault();
  if (!supabaseClient) { message('#adminLoginMessage', 'Store sign-in is not configured. Check Supabase settings.', true); return; }
  const form = new FormData(event.currentTarget), button = $('#adminLoginButton');
  button.disabled = true; button.textContent = 'Signing in…'; message('#adminLoginMessage', '');
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email: String(form.get('email')).trim(), password: String(form.get('password')) });
  button.disabled = false; button.textContent = 'Sign in securely';
  if (error) { message('#adminLoginMessage', 'Check your user ID and password, then try again.', true); return; }
  if (!(data.user?.email_confirmed_at || data.user?.confirmed_at) || data.user?.app_metadata?.store_role !== 'admin') { await supabaseClient.auth.signOut(); message('#adminLoginMessage', 'This confirmed account is not enabled for store administration.', true); }
};

$('#adminSignOut').onclick = () => supabaseClient?.auth.signOut();
$('#newProduct').onclick = () => openEditor();

document.addEventListener('click', async event => {
  const cashCollected = event.target.closest('[data-cash-collected]');
  if (cashCollected) {
    cashCollected.disabled = true;
    try { await adminOrderRequest(cashCollected.dataset.cashCollected, 'cash-collected', {}); await refreshDashboard(); toast('Cash collection recorded'); }
    catch (error) { message('#dashboardMessage', error.message, true); cashCollected.disabled = false; }
    return;
  }
  const edit = event.target.closest('[data-edit]'), remove = event.target.closest('[data-delete]'), tab = event.target.closest('[data-tab]'), couponEdit = event.target.closest('[data-coupon-edit]'), couponToggle = event.target.closest('[data-coupon-toggle]'), couponDelete = event.target.closest('[data-coupon-delete]');
  if (edit) { openEditor(products.find(product => product.id === edit.dataset.edit)); return; }
  if (remove) {
    const product = products.find(item => item.id === remove.dataset.delete);
    if (product && confirm(`Permanently delete “${product.name}”? This cannot be undone.`)) supabaseClient.from('store_products').delete().eq('id', product.id).then(async ({ error }) => { if (error) message('#dashboardMessage', error.message, true); else await refreshDashboard(); });
    return;
  }
  if (couponEdit) {
    const coupon = coupons.find(item => item.code === couponEdit.dataset.couponEdit), form = $('#couponForm');
    if (!coupon || !form) return;
    form.elements.originalCode.value = coupon.code; form.elements.code.value = coupon.code; form.elements.code.readOnly = true;
    form.elements.discountType.value = coupon.discount_type; form.elements.discountValue.value = coupon.discount_value;
    form.elements.discountType.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.minSubtotal.value = coupon.min_subtotal; form.elements.maxDiscount.value = coupon.max_discount ?? '';
    form.elements.usageLimit.value = coupon.usage_limit ?? ''; form.elements.perUserLimit.value = coupon.per_user_limit ?? ''; form.elements.startsAt.value = dateInputValue(coupon.starts_at);
    form.elements.expiresAt.value = dateInputValue(coupon.expires_at); form.elements.active.checked = coupon.active;
    form.querySelector('button[type="submit"]').textContent = 'Update coupon'; form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (couponToggle) {
    const coupon = coupons.find(item => item.code === couponToggle.dataset.couponToggle);
    if (!coupon) return;
    couponToggle.disabled = true;
    try { await adminCouponRequest('PATCH', { code: coupon.code, active: !coupon.active }); await renderCoupons(); toast(coupon.active ? 'Coupon paused' : 'Coupon activated'); }
    catch (error) { message('#dashboardMessage', error.message, true); couponToggle.disabled = false; }
    return;
  }
  if (couponDelete) {
    const code = couponDelete.dataset.couponDelete;
    if (!confirm(`Delete coupon ${code}? Existing order records will remain.`)) return;
    couponDelete.disabled = true;
    try { await adminCouponRequest('DELETE', { code }); await renderCoupons(); toast('Coupon deleted'); }
    catch (error) { message('#dashboardMessage', error.message, true); couponDelete.disabled = false; }
    return;
  }
  if (event.target.closest('#couponReset')) {
    setTimeout(() => { const form = $('#couponForm'); if (form) { form.elements.originalCode.value = ''; form.elements.code.readOnly = false; form.elements.discountType.dispatchEvent(new Event('change', { bubbles: true })); form.querySelector('button[type="submit"]').textContent = 'Save coupon'; } }, 0);
  }
  if (tab) { activeTab = tab.dataset.tab; document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button === tab)); renderAdminContent(); return; }
  if (event.target.closest('[data-close]') || event.target === $('#overlay')) { $('#adminModal').classList.add('hidden'); $('#overlay').classList.add('hidden'); }
});

document.addEventListener('change', async event => {
  const id = event.target.dataset.status;
  if (!id) return;
  const previousStatus = orders.find(order => order.id === id)?.status || 'new';
  if (!orderFeaturesReady) { event.target.value = previousStatus; showOrderMigrationNotice(); return; }
  const status = event.target.value;
  const select = event.target;
  select.disabled = true;
  try { await adminOrderRequest(id, 'status', { status }); await refreshDashboard(); toast('Order status saved'); }
  catch (error) {
    const detail = orderSaveError(error);
    const refreshed = await refreshDashboard();
    message('#dashboardMessage', refreshed
      ? `${detail} The order list now shows its latest saved status.`
      : `${detail} Reload the admin page to check the current saved status.`, true);
  } finally {
    if (select.isConnected) select.disabled = !orderFeaturesReady;
  }
});

document.addEventListener('submit', async event => {
  const couponForm = event.target.closest('#couponForm'), trackingForm = event.target.closest('[data-tracking]'), refundForm = event.target.closest('[data-refund]'), captureRefundForm = event.target.closest('[data-capture-refund]');
  if (couponForm) {
    event.preventDefault();
    const form = new FormData(couponForm), button = couponForm.querySelector('button[type="submit"]'), originalCode = String(form.get('originalCode') || ''), code = String(form.get('code') || '').trim().toUpperCase();
    const dateToIso = value => value ? new Date(value).toISOString() : null;
    const payload = { code, discountType: String(form.get('discountType')), discountValue: Number(form.get('discountValue')), minSubtotal: Number(form.get('minSubtotal') || 0), maxDiscount: form.get('maxDiscount') ? Number(form.get('maxDiscount')) : null, usageLimit: form.get('usageLimit') ? Number(form.get('usageLimit')) : null, perUserLimit: form.get('perUserLimit') ? Number(form.get('perUserLimit')) : null, startsAt: dateToIso(form.get('startsAt')), expiresAt: dateToIso(form.get('expiresAt')), active: form.get('active') === 'on' };
    button.disabled = true; button.textContent = originalCode ? 'Saving…' : 'Creating…'; formFeedback(couponForm, '');
    try { await adminCouponRequest(originalCode ? 'PATCH' : 'POST', payload); await renderCoupons(); toast(originalCode ? 'Coupon updated' : 'Coupon created'); }
    catch (error) { formFeedback(couponForm, error.message, true); button.disabled = false; button.textContent = originalCode ? 'Update coupon' : 'Save coupon'; }
    return;
  }
  if (trackingForm) {
    event.preventDefault();
    const button = trackingForm.querySelector('button[type="submit"]');
    if (!orderFeaturesReady) { formFeedback(trackingForm, 'Apply the order database update linked above before saving tracking.', true); return; }
    const form = new FormData(trackingForm), urlValue = String(form.get('trackingUrl') || '').trim();
    if (urlValue && !safeTrackingUrl(urlValue)) { formFeedback(trackingForm, 'Tracking links must use HTTPS.', true); return; }
    const payload = { carrier: String(form.get('carrier') || '').trim(), trackingNumber: String(form.get('trackingNumber') || '').trim(), trackingUrl: urlValue };
    formFeedback(trackingForm, ''); button.disabled = true; button.textContent = 'Saving…';
    try { await adminOrderRequest(trackingForm.dataset.tracking, 'tracking', payload); await refreshDashboard(); toast('Tracking details saved'); }
    catch (error) { formFeedback(trackingForm, error.message, true); button.disabled = false; button.textContent = 'Save tracking'; }
    return;
  }
  if (captureRefundForm) {
    event.preventDefault();
    const button = captureRefundForm.querySelector('button[type="submit"]'), form = new FormData(captureRefundForm);
    if (!captureLedgerReady) { formFeedback(captureRefundForm, 'Apply the latest database update before refunding additional captures.', true); return; }
    const amount = String(form.get('refundAmount') || ''), paymentId = String(form.get('paymentId') || '');
    formFeedback(captureRefundForm, ''); button.disabled = true; button.textContent = 'Submitting refund…';
    try { await adminOrderRequest(captureRefundForm.dataset.captureRefund, 'capture-refund', { paymentId, refundAmount: amount, attemptKey: captureRefundForm.dataset.attemptKey }); await refreshDashboard(); toast('Capture refund submitted to Razorpay'); }
    catch (error) { formFeedback(captureRefundForm, error.message, true); button.disabled = false; button.textContent = 'Refund this capture'; }
    return;
  }
  if (refundForm) {
    event.preventDefault();
    const button = refundForm.querySelector('button[type="submit"]');
    if (!orderFeaturesReady) { formFeedback(refundForm, 'Apply the order database update linked above before reviewing refunds.', true); return; }
    const form = new FormData(refundForm), status = String(form.get('refundStatus'));
    const confirmRefund = form.get('markRefunded') === 'on';
    if (status === 'processed' && !confirmRefund) { formFeedback(refundForm, 'Confirm the refund action before marking this request processed.', true); return; }
    const payload = { refundStatus: status, adminNote: String(form.get('adminNote') || '').trim(), confirmRefund, refundAmount: String(form.get('refundAmount') || '') };
    formFeedback(refundForm, ''); button.disabled = true; button.textContent = 'Saving…';
    try { await adminOrderRequest(refundForm.dataset.refund, 'refund', payload); await refreshDashboard(); toast('Refund review saved'); }
    catch (error) { formFeedback(refundForm, error.message, true); button.disabled = false; button.textContent = 'Save refund review'; }
  }
});

if (supabaseClient) supabaseClient.auth.onAuthStateChange((event, session) => { if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_RECOVERY'].includes(event)) toggleView(session?.user || null); });
else message('#adminLoginMessage', 'Store sign-in is not configured. Check Supabase settings.', true);
