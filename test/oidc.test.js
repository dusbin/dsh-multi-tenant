import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createOidcStrategy } from '../lib/host/auth/oidc.js';
import { createAuthService } from '../lib/host/auth-service.js';
import { resolveConfig } from '../lib/host/config.js';

const CLAIMS = {
  sub: 'sub-abc-123',
  preferred_username: 'sso.user',
  email: 'sso.user@example.com',
  name: 'SSO User',
};

function setup({ oidcOverrides = {}, claims = CLAIMS, callbackError = null } = {}) {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({
    auth: {
      oidc: {
        enabled: true,
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-client',
        clientSecret: 'secret',
        publicBaseUrl: 'https://ds.example.com',
        ...oidcOverrides,
      },
    },
  });
  const mockClient = {
    authorizationUrl: (params) => `https://idp.example.com/authorize?${new URLSearchParams(params)}`,
    callback: async () => {
      if (callbackError) throw callbackError;
      return { claims: () => claims };
    },
  };
  const strategy = createOidcStrategy({ cfg, store, logger: { warn() {} }, clientFactory: async () => mockClient });
  return { db, store, cfg, strategy };
}

test('oidc: start returns authorization URL with state and PKCE', async () => {
  const { db, strategy } = setup();
  const { url } = await strategy.start({ redirectTo: '/console', baseUrl: 'https://ds.example.com' });
  assert.match(url, /https:\/\/idp\.example\.com\/authorize\?/);
  assert.match(url, /state=/);
  assert.match(url, /code_challenge=/);
  assert.match(url, /code_challenge_method=S256/);
  assert.equal(strategy.pendingCount(), 1);
  db.close();
});

test('oidc: callback success provisions user linked by oidc_sub', async () => {
  const { db, store, strategy } = setup();
  const { url } = await strategy.start({});
  const state = /state=([^&]+)/.exec(url)[1];
  const r = await strategy.handleCallback({ code: 'auth-code', state, baseUrl: 'https://ds.example.com' });
  assert.equal(r.ok, true);
  assert.equal(r.user.oidc_sub, 'sub-abc-123');
  assert.equal(r.user.username, 'sso.user');
  assert.equal(r.user.email, 'sso.user@example.com');
  assert.equal(r.user.role, 'user');
  assert.equal(r.redirectTo, '/');
  // 再次回调 → 复用账号
  const { url: url2 } = await strategy.start({});
  const state2 = /state=([^&]+)/.exec(url2)[1];
  const r2 = await strategy.handleCallback({ code: 'auth-code', state: state2, baseUrl: 'https://ds.example.com' });
  assert.equal(r2.ok, true);
  assert.equal(r2.user.id, r.user.id);
  assert.equal(store.listUsers().filter((u) => u.oidc_sub).length, 1);
  db.close();
});

test('oidc: invalid/expired state rejected', async () => {
  const { db, strategy } = setup();
  const r = await strategy.handleCallback({ code: 'x', state: 'forged' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'oidc-invalid-state');
  db.close();
});

test('oidc: token exchange failure mapped', async () => {
  const { db, strategy } = setup({ callbackError: new Error('invalid_grant') });
  const { url } = await strategy.start({});
  const state = /state=([^&]+)/.exec(url)[1];
  const r = await strategy.handleCallback({ code: 'bad', state, baseUrl: 'https://ds.example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'oidc-exchange-failed');
  db.close();
});

test('oidc: missing subject claim rejected', async () => {
  const { db, strategy } = setup({ claims: { preferred_username: 'nope' } });
  const { url } = await strategy.start({});
  const state = /state=([^&]+)/.exec(url)[1];
  const r = await strategy.handleCallback({ code: 'x', state, baseUrl: 'https://ds.example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'oidc-invalid-claims');
  db.close();
});

test('oidc: autoProvision off rejects unknown subjects', async () => {
  const { db, strategy } = setup({ oidcOverrides: { autoProvision: false } });
  const { url } = await strategy.start({});
  const state = /state=([^&]+)/.exec(url)[1];
  const r = await strategy.handleCallback({ code: 'x', state, baseUrl: 'https://ds.example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'oidc-no-account');
  db.close();
});

test('oidc: disabled account rejected', async () => {
  const { db, store, strategy } = setup();
  const { url } = await strategy.start({});
  const state = /state=([^&]+)/.exec(url)[1];
  await strategy.handleCallback({ code: 'x', state, baseUrl: 'https://ds.example.com' }); // 建号
  const user = store.getUserByUsername('sso.user');
  store.setUserStatus(user.id, 'disabled');
  const { url: url2 } = await strategy.start({});
  const state2 = /state=([^&]+)/.exec(url2)[1];
  const r = await strategy.handleCallback({ code: 'x', state: state2, baseUrl: 'https://ds.example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'account-disabled');
  db.close();
});

test('auth-service: me reports oidc method when enabled', () => {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ auth: { oidc: { enabled: true, issuerUrl: 'https://idp', clientId: 'c' } } });
  const strategy = createOidcStrategy({ cfg, store, logger: { warn() {} }, clientFactory: async () => ({ authorizationUrl: () => 'x', callback: async () => ({ claims: () => ({ sub: 's' }) }) }) });
  const svc = createAuthService(store, cfg, null, strategy);
  const me = svc.me(null);
  assert.ok(me.methods.includes('oidc'));
  assert.ok(me.methods.includes('local'));
  db.close();
});
