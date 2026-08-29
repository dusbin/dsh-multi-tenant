import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { exportData, importData, resetSystem, EXPORT_VERSION } from '../lib/host/backup.js';
import { hashPassword } from '../lib/host/crypto.js';

function seed() {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const tid = store.createTenant({ name: 'acme', config: { plan: 'pro' } });
  const uid = store.createUser({ tenantId: tid, username: 'alice', email: 'a@x.dev', passwordHash: hashPassword('pw12345678'), role: 'admin' });
  store.createUser({ tenantId: tid, username: 'bob', role: 'user' });
  store.upsertQuota({ scope: 'user', targetId: uid, tokenLimit: 500, period: 'monthly' });
  store.insertUsageRecord({ ts: Date.now(), tenantId: tid, userId: uid, sessionId: `u-${uid}-t-${tid}-s-1`, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
  store.upsertSessionMeter({ sessionId: `u-${uid}-t-${tid}-s-1`, userId: uid, tenantId: tid, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, ts: Date.now() });
  store.writeAudit({ actorUserId: uid, tenantId: tid, action: 'user.create', result: 'success' });
  return { db, store, tid, uid };
}

test('backup: export → reset → import roundtrip preserves data', () => {
  const { db, store, tid, uid } = seed();
  const data = exportData(store);
  assert.equal(data.version, EXPORT_VERSION);
  assert.equal(data.tenants.length, 1);
  assert.equal(data.users.length, 2);
  assert.ok(data.users[0].password_hash); // 含哈希（恢复无需重设密码）

  resetSystem(store);
  assert.equal(store.countTenants(), 0);
  assert.equal(store.countUsers(), 0);

  const summary = importData(store, data);
  assert.equal(summary.users, 2);
  assert.equal(store.countTenants(), 1);
  assert.equal(store.countUsers(), 2);
  assert.equal(store.getTenant(tid).name, 'acme');
  const alice = store.getUserByUsername('alice');
  assert.equal(alice.role, 'admin');
  assert.equal(alice.id, uid); // 保留原 id
  assert.equal(alice.password_hash, data.users.find((u) => u.username === 'alice').password_hash);
  assert.equal(store.getQuota('user', uid, 'monthly').token_limit, 500);
  assert.equal(store.aggregateUsage({}).input_tokens, 100);
  assert.equal(store.listAllAudit().length, 1);
  db.close();
});

test('backup: import validation and replace semantics', () => {
  const { db, store } = seed();
  const data = exportData(store);
  // 版本不符 → 拒绝
  assert.throws(() => importData(store, { ...data, version: 999 }), /unsupported export version/);
  // 非空目标且无 replace → 拒绝
  assert.throws(() => importData(store, data), /not empty/);
  // replace 覆盖（先改数据再导入）
  store.setTenantStatus(store.listTenants()[0].id, 'disabled');
  importData(store, data, { replace: true });
  assert.equal(store.listTenants()[0].status, 'active'); // 被覆盖恢复
  db.close();
});

test('backup: reset-system keepUsage retains usage but clears management', () => {
  const { db, store } = seed();
  resetSystem(store, { keepUsage: true });
  assert.equal(store.countTenants(), 0);
  assert.equal(store.countUsers(), 0);
  assert.equal(store.listAllQuotaUsage().length, 0);
  assert.equal(store.aggregateUsage({}).request_count, 1); // 用量保留
  assert.equal(store.listAllSessionMeter().length, 1);
  db.close();
});
