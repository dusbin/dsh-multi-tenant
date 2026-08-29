import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createLdapStrategy } from '../lib/host/auth/ldap.js';
import { createAuthService } from '../lib/host/auth-service.js';
import { resolveConfig } from '../lib/host/config.js';

/** 可编程的 LDAP 假客户端 */
function fakeClient({ entries = [], bindReject = null, searchReject = null } = {}) {
  const calls = { bind: [], search: [], unbind: 0 };
  return {
    calls,
    bind(dn, password) {
      calls.bind.push({ dn, password });
      if (bindReject) return Promise.reject(bindReject);
      return Promise.resolve();
    },
    search(base, opts) {
      calls.search.push({ base, opts });
      if (searchReject) return Promise.reject(searchReject);
      return Promise.resolve({ searchEntries: entries.filter((e) => opts.filter.includes(e.matchedBy)) });
    },
    unbind() { calls.unbind += 1; return Promise.resolve(); },
  };
}

function setup({ ldapOverrides = {}, entries, bindReject, searchReject } = {}) {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ auth: { ldap: { enabled: true, url: 'ldap://fake:389', baseDn: 'dc=example,dc=com', ...ldapOverrides } } });
  const client = fakeClient({ entries, bindReject, searchReject });
  const strategy = createLdapStrategy({
    cfg, store, logger: { warn() {} },
    clientFactory: async () => client,
  });
  return { db, store, cfg, strategy, client };
}

const USER_ENTRY = {
  dn: 'uid=jdoe,ou=people,dc=example,dc=com',
  matchedBy: 'jdoe',
  uid: 'jdoe',
  mail: 'jdoe@example.com',
  cn: 'John Doe',
};

test('ldap: authenticate success with auto-provision', async () => {
  const { db, store, strategy, client } = setup({ entries: [USER_ENTRY] });
  assert.equal(strategy.enabled, true);
  const r = await strategy.authenticate({ username: 'jdoe', password: 'secret' });
  assert.equal(r.ok, true);
  assert.equal(r.user.username, 'jdoe');
  assert.equal(r.user.ldap_dn, USER_ENTRY.dn);
  assert.equal(r.user.email, 'jdoe@example.com');
  assert.equal(r.user.role, 'user');
  // 服务账号未配置 → 只绑定用户 DN 一次
  assert.equal(client.calls.bind.length, 1);
  assert.equal(client.calls.bind[0].dn, USER_ENTRY.dn);
  // 再次登录 → 复用本地账号（不重复建号）
  const r2 = await strategy.authenticate({ username: 'jdoe', password: 'secret' });
  assert.equal(r2.ok, true);
  assert.equal(r2.user.id, r.user.id);
  assert.equal(store.countUsers(), 1);
  db.close();
});

test('ldap: username filter is escaped', async () => {
  const { db, strategy, client } = setup({ entries: [USER_ENTRY] });
  await strategy.authenticate({ username: 'j*doe(1)', password: 'x' });
  const search = client.calls.search[0];
  assert.ok(search);
  // 过滤器中的特殊字符被转义（* → \2a，( → \28）
  assert.match(search.opts.filter, /uid=j\\2adoe\\281\\29/);
  db.close();
});

test('ldap: wrong password maps to invalid-credentials', async () => {
  const { db, strategy, client } = setup({ entries: [USER_ENTRY], bindReject: new Error('InvalidCredentialsError: 49') });
  const r = await strategy.authenticate({ username: 'jdoe', password: 'wrong' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid-credentials');
  assert.equal(client.calls.unbind, 1);
  db.close();
});

test('ldap: user not in directory → invalid-credentials', async () => {
  const { db, strategy } = setup({ entries: [] });
  const r = await strategy.authenticate({ username: 'nobody', password: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid-credentials');
  db.close();
});

test('ldap: directory unavailable → ldap-unavailable (no detail leak)', async () => {
  const { db, strategy } = setup({ searchReject: new Error('connect ECONNREFUSED') });
  const r = await strategy.authenticate({ username: 'jdoe', password: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ldap-unavailable');
  db.close();
});

test('ldap: disabled local account is rejected', async () => {
  const { db, store, strategy } = setup({ entries: [USER_ENTRY] });
  await strategy.authenticate({ username: 'jdoe', password: 'secret' }); // 建号
  const user = store.getUserByUsername('jdoe');
  store.setUserStatus(user.id, 'disabled');
  const r = await strategy.authenticate({ username: 'jdoe', password: 'secret' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'account-disabled');
  db.close();
});

test('ldap: autoProvision off rejects unknown directory users', async () => {
  const { db, strategy } = setup({ entries: [USER_ENTRY], ldapOverrides: { autoProvision: false } });
  const r = await strategy.authenticate({ username: 'jdoe', password: 'secret' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid-credentials');
  db.close();
});

// ---------------------------------------------------------------------------
// auth-service 路由
// ---------------------------------------------------------------------------
function setupService(ldapOverrides = {}, entries = [USER_ENTRY], bindReject = null) {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ auth: { ldap: { enabled: true, url: 'ldap://fake', baseDn: 'dc=x', ...ldapOverrides } } });
  const client = fakeClient({ entries, bindReject });
  const strategy = createLdapStrategy({ cfg, store, logger: { warn() {} }, clientFactory: async () => client });
  const svc = createAuthService(store, cfg, strategy);
  return { db, store, svc };
}

test('auth-service: me() reports enabled methods', () => {
  const { db, svc } = setupService();
  const me = svc.me(null);
  assert.deepEqual(me.methods.sort(), ['ldap', 'local']);
  db.close();
});

test('auth-service: login routes to LDAP when no local account', async () => {
  const { db, store, svc } = setupService();
  const r = await svc.login({ username: 'jdoe', password: 'secret' }); // auto → ldap
  assert.equal(r.ok, true);
  assert.equal(r.user.username, 'jdoe');
  assert.equal(store.getUserByUsername('jdoe').ldap_dn, USER_ENTRY.dn);
  db.close();
});

test('auth-service: explicit method=ldap works even with local account present', async () => {
  const { db, svc } = setupService();
  const local = svc.bootstrap({ username: 'admin', password: 'longenough-password' });
  assert.equal(local.ok, true);
  const r = await svc.login({ username: 'jdoe', password: 'secret', method: 'ldap' });
  assert.equal(r.ok, true);
  db.close();
});

test('auth-service: ldap failure is audited and rate limited', async () => {
  const { db, store, svc } = setupService(undefined, [], null); // entries 空 → user not found
  const r = await svc.login({ username: 'ghost', password: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid-credentials');
  const denied = store.listAudit({ action: 'auth.login', result: 'denied' });
  assert.equal(denied.length, 1);
  assert.match(denied[0].detail, /ghost/);
  db.close();
});
