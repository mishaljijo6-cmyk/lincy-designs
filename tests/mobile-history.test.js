const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'store.js'), 'utf8');
const start = source.indexOf('function panelState(');
const end = source.indexOf('function reconcileCart(', start);
if (start < 0 || end < 0) throw new Error('Could not locate the storefront history controller.');
const historyControllerSource = source.slice(start, end);

function createHistoryHarness() {
  let currentUrl = new URL('https://store.test/');
  const location = {};
  for (const key of ['href', 'origin', 'pathname', 'search', 'hash']) {
    Object.defineProperty(location, key, { get: () => currentUrl[key] });
  }
  const listeners = {};
  const entries = [{ state: null, url: currentUrl.href }];
  let index = 0;
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _title, nextUrl) {
      currentUrl = new URL(nextUrl || currentUrl.href, currentUrl.href);
      entries.splice(index + 1);
      entries.push({ state, url: currentUrl.href });
      index++;
    },
    replaceState(state, _title, nextUrl) {
      currentUrl = new URL(nextUrl || currentUrl.href, currentUrl.href);
      entries[index] = { state, url: currentUrl.href };
    },
    back() { this.go(-1); },
    go(delta) {
      const next = Math.min(entries.length - 1, Math.max(0, index + delta));
      if (next === index) return;
      index = next;
      currentUrl = new URL(entries[index].url);
      queueMicrotask(() => listeners.popstate?.({ state: entries[index].state }));
    },
    get length() { return entries.length; }
  };
  const makeElement = id => ({
    id,
    classList: {
      values: new Set(['hidden']),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      toggle(value, force) {
        if (force === undefined) force = !this.values.has(value);
        if (force) this.values.add(value); else this.values.delete(value);
        return force;
      },
      contains(value) { return this.values.has(value); }
    }
  });
  const elements = Object.fromEntries(['overlay', 'cartDrawer', 'wishlistDrawer', 'productModal', 'checkoutModal', 'searchModal', 'accountModal'].map(id => [id, makeElement(id)]));
  const document = { body: { style: { overflow: '' } } };
  const toasts = [];
  const context = {
    history, location, document,
    window: { addEventListener(name, callback) { listeners[name] = callback; } },
    $: selector => elements[selector.replace(/^#/, '')],
    $$: () => Object.values(elements).filter(item => item.id !== 'overlay'),
    toast: message => toasts.push(message),
    paymentInProgress: false,
    activeAccountUser: null,
    activeAccountView: 'account',
    activeCheckoutStep: 0,
    activePanelId: '',
    checkoutCompleted: false,
    restoreCheckoutStep: null,
    checkoutHistoryDepth: 0,
    accountHistoryDepth: 0,
    renderAccount() {},
    renderAccountSettings() {},
    renderMyOrders() {}
  };
  vm.runInNewContext(historyControllerSource, context);
  return { context, elements, history, location, toasts, back: () => history.back() };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('hardware back closes a drawer and keeps the browser inside the storefront', async () => {
  const app = createHistoryHarness();
  app.context.openPanel('#cartDrawer');
  assert.equal(app.elements.cartDrawer.classList.contains('hidden'), false);
  app.back();
  await tick();
  assert.equal(app.elements.cartDrawer.classList.contains('hidden'), true);
  assert.equal(app.location.origin, 'https://store.test');
  assert.equal(app.history.state.lincyAppGuard, true);
});

test('hardware back moves from checkout payment to the previous checkout step', async () => {
  const app = createHistoryHarness();
  app.context.activeCheckoutStep = 1;
  app.context.openPanel('#checkoutModal');
  app.context.activeCheckoutStep = 2;
  app.context.checkoutHistoryDepth = 1;
  app.history.pushState(app.context.panelState('#checkoutModal'), '', app.location.href);
  app.context.activeCheckoutStep = 3;
  app.context.checkoutHistoryDepth = 2;
  app.history.pushState(app.context.panelState('#checkoutModal'), '', app.location.href);
  let restored = 0;
  app.context.restoreCheckoutStep = step => { restored = step; };
  app.back();
  await tick();
  assert.equal(restored, 2);
  assert.equal(app.elements.checkoutModal.classList.contains('hidden'), false);
});

test('hardware back returns from account orders to the account screen before leaving it', async () => {
  const app = createHistoryHarness();
  app.context.activeAccountUser = { id: 'customer' };
  app.context.openPanel('#accountModal');
  app.context.pushAccountView('orders');
  assert.equal(app.context.activeAccountView, 'orders');

  app.back();
  await tick();
  assert.equal(app.context.activeAccountView, 'account');
  assert.equal(app.elements.accountModal.classList.contains('hidden'), false);

  app.back();
  await tick();
  assert.equal(app.elements.accountModal.classList.contains('hidden'), true);
  assert.equal(app.history.state.lincyAppGuard, true);
});

test('hardware back cannot leave checkout while Razorpay is active', async () => {
  const app = createHistoryHarness();
  app.context.activeCheckoutStep = 3;
  app.context.openPanel('#checkoutModal');
  app.context.paymentInProgress = true;
  app.back();
  await tick();
  assert.equal(app.elements.checkoutModal.classList.contains('hidden'), false);
  assert.equal(app.history.state.lincyPaymentGuard, true);
  assert.ok(app.toasts.some(message => /payment is still in progress/i.test(message)));
});

test('hardware back from a direct product link returns to the shop route', async () => {
  const app = createHistoryHarness();
  app.history.replaceState(null, '', 'https://store.test/#product-item-1');
  // Recreate the app controller after installing the direct-link URL.
  const direct = createHistoryHarness();
  direct.history.replaceState(null, '', 'https://store.test/#product-item-1');
  direct.context.installAppHistoryGuard();
  direct.context.openPanel('#productModal');
  direct.history.replaceState({ ...direct.history.state, ...direct.context.panelState('#productModal') }, '', 'https://store.test/#product-item-1');
  direct.back();
  await tick();
  assert.equal(direct.location.hash, '#shop');
  assert.equal(direct.elements.productModal.classList.contains('hidden'), true);
});
