import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { hashPassword } from '../lib/host/crypto.js';

test('migrations run to latest and user_version is set', () => {
  const db = openMemoryDatabase();
  const row = db.prepare('PRAGMA user_version').get();
  assert.equal(row.user_version, 2); // 与 MIGRATIONS.length 一致（v1+v2）
  db.close();
});

test('tenant + user + session + audit CRUD', () => {
  const db = openMemoryDatabase();
  const store = createStore(db);

  const tenantId = store.createTenant({ name: 'acme', config: { plan: 'pro' } });
  assert.ok(tenantId > 0);
  assert.equal(store.countTenants(), 1);
  assert.equal(store.getTenant(tenantId).name, 'acme');

  const userId = store.createUser({ tenantId, username: 'alice', email: 'alice@acme.dev', passwordHash: hashPassword('pw12345678'), role: 'user' });
  assert.ok(userId > 0);
  assert.equal(store.countUsers(), 1);
  assert.equal(store.getUserByUsername('alice').id, userId);
  assert.equal(store.getUserByEmail('alice@acme.dev').id, userId);

  const sessionId = store.createSession({ userId, tokenHash: 'h1', expiresAt: Date.now() + 1000 });
  assert.ok(sessionId > 0);
  assert.equal(store.getSessionByTokenHash('h1').user_id, userId);
  store.deleteSessionByTokenHash('h1');
  assert.equal(store.getSessionByTokenHash('h1'), undefined);

  store.writeAudit({ actorUserId: userId, tenantId, action: 'auth.login', result: 'success', ip: '127.0.0.1' });
  store.writeAudit({ action: 'tenant.delete', result: 'denied' });
  const logs = store.listAudit({});
  assert.equal(logs.length, 2);
  assert.equal(logs[0].action, 'tenant.delete'); // 时间倒序

  store.setUserStatus(userId, 'disabled');
  assert.equal(store.getUserById(userId).status, 'disabled');
  db.close();
});

test('login attempts rate limiting helpers', () => {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const now = Date.now();
  store.recordAttempt('u:alice', now);
  store.recordAttempt('u:alice', now + 10);
  assert.equal(store.countRecentAttempts('u:alice', now - 1000), 2);
  store.clearAttempts('u:alice');
  assert.equal(store.countRecentAttempts('u:alice', now - 1000), 0);
  db.close();
});
