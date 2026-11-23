const ADMIN_EMAIL = 'mishalmj03@gmail.com';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const supabaseClient = window.supabase?.createClient && window.LINCY_SUPABASE_URL && window.LINCY_SUPABASE_PUBLISHABLE_KEY
  ? window.supabase.createClient(window.LINCY_SUPABASE_URL, window.LINCY_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
let products = [], orders = [], orderItems = [], coupons = [], activeTab = 'products', orderFeaturesReady = false;

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
  link.href = '/migration-orders-and-checkout.sql';
  link.download = 'migration-orders-and-checkout.sql';
  link.textContent = 'download the order database update';
  el.append(link, document.createTextNode('.'));
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
  const login = $('#adminLogin'), dashboard = $('#adminDashboard'), isAdmin = !!user && user.email?.toLowerCase() === ADMIN_EMAIL;
  login.classList.toggle('hidden', isAdmin);
  dashboard.classList.toggle('hidden', !isAdmin);
  if (isAdmin) { $('#adminIdentity').textContent = user.email; refreshDashboard(); }
  else if (user) { message('#adminLoginMessage', 'This account is not allowed to manage the store.', true); supabaseClient.auth.signOut(); }
}

async function refreshDashboard() {
  message('#dashboardMessage', 'Loading your store…');
  const [productResult, orderResult] = await Promise.all([
    supabaseClient.from('store_products').select('*').order('created_at', { ascending: false }),
    supabaseClient.from('store_orders').select('*').order('created_at', { ascending: false })
  ]);
  if (productResult.error || orderResult.error) {
    message('#dashboardMessage', productResult.error?.message || orderResult.error?.message || 'Could not load the store.', true);
    return;
  }
  products = productResult.data || [];
  orders = orderResult.data || [];
  const ids = orders.map(order => order.id).filter(Boolean);
  if (ids.length) {
    const result = await supabaseClient.from('store_order_items').select('*').in('order_id', ids);
    if (result.error) {
      orderItems = [];
      message('#dashboardMessage', 'Order totals loaded, but item details could not be read. Check the store_order_items admin read policy.', true);
      return;
    }
    orderItems = result.data || [];
  } else orderItems = [];
  const schemaCheck = await supabaseClient.from('store_orders').select('user_id,shipping_carrier,tracking_number,refund_status').limit(1);
  orderFeaturesReady = !schemaCheck.error;
  $('#stats').innerHTML = `<div><small>PRODUCTS</small><b>${products.length}</b></div><div><small>ORDERS</small><b>${orders.length}</b></div><div><small>TO FULFIL</small><b>${orders.filter(order => !['complete', 'delivered', 'cancelled'].includes(order.status)).length}</b></div>`;
  if (orderFeaturesReady) message('#dashboardMessage', '');
  else showOrderMigrationNotice();
  renderAdminContent();
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
  root.innerHTML = '<p class="admin-order-muted">Loading coupons…</p>';
  try {
    const result = await adminCouponRequest();
    coupons = result.coupons || [];
    if (activeTab !== 'coupons') return;
    root.innerHTML = `<section class="admin-coupon-manager"><h2>Discount coupons</h2><p>Create a code, choose its discount, and set optional order minimums, caps, limits, or dates.</p><form id="couponForm" class="admin-coupon-form"><input type="hidden" name="originalCode"><label>Coupon code<input name="code" maxlength="24" pattern="[A-Za-z0-9_-]{3,24}" placeholder="WELCOME10" required></label><label>Discount<select name="discountType"><option value="percent">Percentage</option><option value="fixed">Fixed amount (₹)</option></select></label><label>Value<input name="discountValue" type="number" min="1" step="1" required></label><label>Minimum items subtotal (₹)<input name="minSubtotal" type="number" min="0" step="1" value="0"></label><label>Maximum discount (₹)<input name="maxDiscount" type="number" min="1" step="1" placeholder="No cap"></label><label>Use limit<input name="usageLimit" type="number" min="1" step="1" placeholder="Unlimited"></label><label>Starts at<input name="startsAt" type="datetime-local"></label><label>Expires at<input name="expiresAt" type="datetime-local"></label><label class="admin-coupon-active"><input name="active" type="checkbox" checked> Active</label><div class="admin-coupon-actions"><button class="button dark" type="submit">Save coupon</button><button class="button outline" type="reset" id="couponReset">Clear form</button></div><p class="admin-form-feedback" role="status"></p></form><div class="admin-coupon-list">${coupons.map(coupon => `<article><div><b>${escapeHtml(coupon.code)}</b><span>${coupon.discount_type === 'percent' ? `${Number(coupon.discount_value)}% off` : `${money(coupon.discount_value)} off`}</span><small>Minimum ${money(coupon.min_subtotal)} · Maximum ${coupon.max_discount == null ? 'No cap' : money(coupon.max_discount)} · Uses ${Number(coupon.usage_count)}${coupon.usage_limit == null ? '' : ` / ${Number(coupon.usage_limit)}`}</small><small>${coupon.starts_at ? `Starts ${formatDate(coupon.starts_at)}` : 'Starts immediately'} · ${coupon.expires_at ? `Expires ${formatDate(coupon.expires_at)}` : 'No expiry'}</small></div><span class="admin-state ${coupon.active ? '' : 'inactive'}">${coupon.active ? 'Active' : 'Paused'}</span><div><button type="button" data-coupon-edit="${escapeHtml(coupon.code)}">Edit</button><button type="button" data-coupon-toggle="${escapeHtml(coupon.code)}">${coupon.active ? 'Pause' : 'Activate'}</button><button type="button" data-coupon-delete="${escapeHtml(coupon.code)}">Delete</button></div></article>`).join('') || '<p class="empty">No coupons yet. Create your first discount code.</p>'}</div></section>`;
  } catch (error) {
    if (activeTab !== 'coupons') return;
    root.innerHTML = `<p class="admin-migration-required">${escapeHtml(error.message)} <a href="/migration-coupons.sql" download>Download the coupon database update</a> and run it in Supabase SQL Editor.</p>`;
  }
}

function renderOrders() {
  const statusOptions = [['new', 'New'], ['processing', 'Processing'], ['packed', 'Packed'], ['shipped', 'Shipped'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['complete', 'Delivered (legacy)'], ['cancelled', 'Cancelled']];
  const refundOptions = [['none', 'No request'], ['requested', 'Requested'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['processed', 'Processed']];
  const migrationNotice = orderFeaturesReady ? '' : '<p class="admin-migration-required">Tracking and refund changes are paused until the order database update is applied. <a href="/migration-orders-and-checkout.sql" download>Download the SQL update</a>, run it in Supabase SQL Editor, then reload this page.</p>';
  $('#adminContent').innerHTML = `<div class="admin-order-list">${orders.map(order => {
    const items = orderItems.filter(item => item.order_id === order.id);
    const trackUrl = safeTrackingUrl(order.tracking_url);
    const itemMarkup = items.map(item => `<div class="admin-order-item"><img src="${escapeHtml(item.image_url || '')}" alt="" loading="lazy"><div><b>${escapeHtml(item.product_name)}</b><small>${escapeHtml(item.selected_size || 'One size')} · ${escapeHtml(item.selected_color || '—')} · Qty ${Number(item.quantity)}</small><small>Unit ${money(item.unit_price)} · GST ${Number(item.gst_rate || 0)}% (${money(item.gst_amount)})</small></div><strong>${money(Number(item.unit_price) * Number(item.quantity))}</strong></div>`).join('') || '<p class="admin-order-muted">No saved line items. Apply the latest checkout database update for new orders.</p>';
    return `<details class="admin-order-card"><summary><span><b>${escapeHtml(order.order_number)}</b><small>${escapeHtml(order.customer_name)} · ${formatDate(order.created_at)}</small></span><span>${money(order.total)}<small>${escapeHtml(order.payment_status)} · ${escapeHtml(order.payment_provider || '—')}</small></span><span class="admin-order-status">${escapeHtml(String(order.status || 'new').replaceAll('_', ' '))}</span><span class="admin-order-chevron" aria-hidden="true">⌄</span></summary><div class="admin-order-body">${migrationNotice}
      <div class="admin-order-columns"><section><h3>Customer & delivery</h3><p><b>${escapeHtml(order.customer_name)}</b><br><a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a><br><a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a></p><p>${escapeHtml(order.address)}<br>${escapeHtml(order.city)}, ${escapeHtml(order.state)} ${escapeHtml(order.pincode)}</p><small>Placed ${formatDate(order.created_at)}</small></section><section><h3>Payment & amount</h3><dl class="admin-order-prices"><div><dt>Items (GST included)</dt><dd>${money(order.subtotal)}</dd></div><div><dt>GST included</dt><dd>${money(order.gst_amount)}</dd></div>${order.coupon_code ? `<div><dt>Coupon (${escapeHtml(order.coupon_code)})</dt><dd>−${money(order.discount_amount)}</dd></div>` : ''}<div><dt>Delivery</dt><dd>${Number(order.shipping) ? money(order.shipping) : 'Free'}</dd></div><div class="total"><dt>Total</dt><dd>${money(order.total)}</dd></div></dl><p><b>${escapeHtml(order.payment_provider || '—')}</b> · ${escapeHtml(order.payment_status)}<br>Reference: ${escapeHtml(order.payment_reference || 'Not paid yet')}</p></section></div>
      <section class="admin-order-lines"><h3>Items (${items.length})</h3>${itemMarkup}</section>
      <div class="admin-order-columns admin-order-management"><section><h3>Fulfilment & tracking</h3><label>Order status<select data-status="${escapeHtml(order.id)}" ${orderFeaturesReady ? '' : 'disabled'}>${statusOptions.map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><form class="admin-tracking-form" data-tracking="${escapeHtml(order.id)}"><label>Carrier<input name="carrier" maxlength="80" value="${escapeHtml(order.shipping_carrier || '')}" placeholder="Courier or delivery service" ${orderFeaturesReady ? '' : 'disabled'}></label><label>Tracking number<input name="trackingNumber" maxlength="120" value="${escapeHtml(order.tracking_number || '')}" placeholder="Tracking ID" ${orderFeaturesReady ? '' : 'disabled'}></label><label>Tracking link<input name="trackingUrl" type="url" value="${escapeHtml(order.tracking_url || '')}" placeholder="https://…" ${orderFeaturesReady ? '' : 'disabled'}></label><div class="admin-form-feedback" aria-live="polite"></div><button class="button outline" type="submit" ${orderFeaturesReady ? '' : 'disabled'}>Save tracking</button></form><p class="admin-order-muted">Shipped: ${formatDate(order.shipped_at)} · Delivered: ${formatDate(order.delivered_at)}</p>${trackUrl ? `<a href="${escapeHtml(trackUrl)}" target="_blank" rel="noopener noreferrer">Open tracking page ↗</a>` : ''}</section><section><h3>Refund request</h3><p><b>${escapeHtml(order.refund_status || 'none')}</b>${order.refund_reason ? `<br>Customer reason: ${escapeHtml(order.refund_reason)}` : ''}<br>Requested: ${formatDate(order.refund_requested_at)}</p><form class="admin-refund-form" data-refund="${escapeHtml(order.id)}"><label>Review status<select name="refundStatus" ${orderFeaturesReady ? '' : 'disabled'}>${refundOptions.map(([value, label]) => `<option value="${value}" ${(order.refund_status || 'none') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Note for customer<textarea name="adminNote" rows="3" maxlength="1000" ${orderFeaturesReady ? '' : 'disabled'}>${escapeHtml(order.refund_admin_note || '')}</textarea></label><label class="admin-refund-confirm"><input type="checkbox" name="markRefunded" ${orderFeaturesReady ? '' : 'disabled'}> I have sent the refund and mark payment refunded</label><div class="admin-form-feedback" aria-live="polite"></div><button class="button outline" type="submit" ${orderFeaturesReady ? '' : 'disabled'}>Save refund review</button></form><small class="admin-order-muted">Send any refund through the payment provider or your bank first. This form only records the review.</small></section></div>
    </div></details>`;
  }).join('') || '<p class="empty">No orders yet.</p>'}</div>`;
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
    <label>Stock quantity<input name="stock" type="number" min="0" step="1" value="${product.stock ?? 0}" required></label>
    <label>Badge<input name="badge" maxlength="40" value="${escapeHtml(product.badge || '')}"></label>
    <label class="wide">Main product image <small>Paste an HTTPS link or choose an image from this device.</small><input name="image_url" type="url" value="${escapeHtml(product.image_url || '')}" placeholder="https://…"></label>
    <label class="wide">Upload main image<input name="main_image_file" type="file" accept="image/jpeg,image/png,image/webp,image/avif"></label>
    <label class="wide">Additional image links <small>One HTTPS image link per line.</small><textarea name="image_gallery" rows="3" placeholder="https://…">${escapeHtml((product.image_gallery || []).join('\n'))}</textarea></label>
    <label class="wide">Upload additional images <small>Select multiple photos; each must be under 10 MB.</small><input name="gallery_files" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple></label>
    <label class="wide">Color-specific photos <small>Color | image URL, one per line; repeat a color for more views.</small><textarea name="color_images" rows="4" placeholder="Sage | https://…">${escapeHtml(Object.entries(product.color_images || {}).flatMap(([color, urls]) => (Array.isArray(urls) ? urls : []).map(url => `${color} | ${url}`)).join('\n'))}</textarea></label>
    <label class="wide">Sizes <small>Comma separated</small><input name="sizes" value="${escapeHtml((product.sizes || []).join(', '))}" placeholder="S, M, L, XL"></label>
    <label class="wide">Colors <small>Comma separated</small><input name="colors" value="${escapeHtml((product.colors || []).join(', '))}" placeholder="Ivory, Gold"></label>
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
      const payload = { id: product.id || `lincy-${crypto.randomUUID()}`, name: form.name.trim(), category: form.category, price: priceValue, compare_at: compareValue, stock: Number(form.stock), badge: form.badge.trim() || null, image_url: imageUrl, image_gallery: imageGallery, color_images: colorImages, sizes: form.sizes.split(',').map(value => value.trim()).filter(Boolean), colors: form.colors.split(',').map(value => value.trim()).filter(Boolean), description: form.description.trim(), active: formElement.elements.active.checked };
      let { error } = await supabaseClient.from('store_products').upsert(payload);
      if (error && /image_gallery|color_images|column/i.test(error.message || '') && !galleryFiles.length && !imageGallery.length && !Object.keys(colorImages).length) {
        const { image_gallery, color_images, ...legacyPayload } = payload;
        error = (await supabaseClient.from('store_products').upsert(legacyPayload)).error;
      }
      if (error) throw error;
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
  if (data.user?.email?.toLowerCase() !== ADMIN_EMAIL) { await supabaseClient.auth.signOut(); message('#adminLoginMessage', 'This account is not allowed to manage the store.', true); }
};

$('#adminSignOut').onclick = () => supabaseClient?.auth.signOut();
$('#newProduct').onclick = () => openEditor();

document.addEventListener('click', async event => {
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
    form.elements.minSubtotal.value = coupon.min_subtotal; form.elements.maxDiscount.value = coupon.max_discount ?? '';
    form.elements.usageLimit.value = coupon.usage_limit ?? ''; form.elements.startsAt.value = dateInputValue(coupon.starts_at);
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
    setTimeout(() => { const form = $('#couponForm'); if (form) { form.elements.originalCode.value = ''; form.elements.code.readOnly = false; form.querySelector('button[type="submit"]').textContent = 'Save coupon'; } }, 0);
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
  try { await adminOrderRequest(id, 'status', { status }); await refreshDashboard(); toast('Order status saved'); }
  catch (error) { event.target.value = previousStatus; formFeedback(event.target.closest('section'), orderSaveError(error), true); }
});

document.addEventListener('submit', async event => {
  const couponForm = event.target.closest('#couponForm'), trackingForm = event.target.closest('[data-tracking]'), refundForm = event.target.closest('[data-refund]');
  if (couponForm) {
    event.preventDefault();
    const form = new FormData(couponForm), button = couponForm.querySelector('button[type="submit"]'), originalCode = String(form.get('originalCode') || ''), code = String(form.get('code') || '').trim().toUpperCase();
    const dateToIso = value => value ? new Date(value).toISOString() : null;
    const payload = { code, discountType: String(form.get('discountType')), discountValue: Number(form.get('discountValue')), minSubtotal: Number(form.get('minSubtotal') || 0), maxDiscount: form.get('maxDiscount') ? Number(form.get('maxDiscount')) : null, usageLimit: form.get('usageLimit') ? Number(form.get('usageLimit')) : null, startsAt: dateToIso(form.get('startsAt')), expiresAt: dateToIso(form.get('expiresAt')), active: form.get('active') === 'on' };
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
  if (refundForm) {
    event.preventDefault();
    const button = refundForm.querySelector('button[type="submit"]');
    if (!orderFeaturesReady) { formFeedback(refundForm, 'Apply the order database update linked above before reviewing refunds.', true); return; }
    const form = new FormData(refundForm), status = String(form.get('refundStatus'));
    const confirmRefund = form.get('markRefunded') === 'on';
    if (status === 'processed' && !confirmRefund) { formFeedback(refundForm, 'Confirm that you have sent the refund before marking it processed.', true); return; }
    const payload = { refundStatus: status, adminNote: String(form.get('adminNote') || '').trim(), confirmRefund };
    formFeedback(refundForm, ''); button.disabled = true; button.textContent = 'Saving…';
    try { await adminOrderRequest(refundForm.dataset.refund, 'refund', payload); await refreshDashboard(); toast('Refund review saved'); }
    catch (error) { formFeedback(refundForm, error.message, true); button.disabled = false; button.textContent = 'Save refund review'; }
  }
});

if (supabaseClient) supabaseClient.auth.onAuthStateChange((event, session) => { if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_RECOVERY'].includes(event)) toggleView(session?.user || null); });
else message('#adminLoginMessage', 'Store sign-in is not configured. Check Supabase settings.', true);
