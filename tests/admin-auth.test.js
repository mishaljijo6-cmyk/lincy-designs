const test = require('node:test');
const assert = require('node:assert/strict');
const { isConfirmedStoreAdmin } = require('../lib/server');

test('store admin authorization requires a confirmed user and server-managed admin role', () => {
  assert.equal(isConfirmedStoreAdmin({ email_confirmed_at: '2026-01-01', app_metadata: { store_role: 'admin' } }), true);
  assert.equal(isConfirmedStoreAdmin({ email_confirmed_at: null, app_metadata: { store_role: 'admin' } }), false);
  assert.equal(isConfirmedStoreAdmin({ email_confirmed_at: '2026-01-01', app_metadata: { store_role: 'user' } }), false);
  assert.equal(isConfirmedStoreAdmin({ email_confirmed_at: '2026-01-01', user_metadata: { store_role: 'admin' } }), false);
  assert.equal(isConfirmedStoreAdmin(null), false);
});
