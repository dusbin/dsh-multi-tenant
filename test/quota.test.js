import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createQuotaService, periodStart } from '../lib/host/quota.js';

function setup() {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const quota = createQuotaService(store);
  // 租户 + 用户
  const tid = store.createTenant({ name: 'acme' });
  const uid = store.createUser({ tenantId: tid, username: 'bob', role: 'user' });
  return { db, store, quota, tid, user: store.getUserById(uid) };
}

test('periodStart: daily/monthly/total windows', () => {
  // 用本地时间构造，避免时区差异
  const now = new Date(2026, 7, 15, 10, 30, 0).getTime(); // 本地 8/15 10:30
  const day = periodStart('daily', now);
  assert.equal(day, new Date(2026, 7, 15).getTime()); // 本地 8/15 00:00
  const month = periodStart('monthly', now);
  assert.equal(month, new Date(2026, 7, 1).getTime()); // 本地 8/1 00:00
  assert.equal(periodStart('total', now), 0);
});

test('check: no limits → allowed', () => {
  const { quota, user } = setup();
  const r = quota.check(user);
  assert.equal(r.allowed, true);
  assert.equal(r.limits.length, 0);
});

test('user daily limit: spent accumulates and blocks', () => {
  const { quota, user, store } = setup();
  store.upsertQuota({ scope: 'user', targetId: user.id, tokenLimit: 100, period: 'daily' });
  assert.equal(quota.check(user).allowed, true);
  quota.addUsage(user, 60);
  assert.equal(quota.check(user).allowed, true);
  quota.addUsage(user, 50); // 累计 110 > 100
  const r = quota.check(user);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /quota exhausted \(user\/daily: 110\/100/);
});

test('tenant limit applies to its users (min semantics)', () => {
  const { quota, user, store, tid } = setup();
  store.upsertQuota({ scope: 'tenant', targetId: tid, tokenLimit: 80, period: 'daily' });
  store.upsertQuota({ scope: 'user', targetId: user.id, tokenLimit: 1000, period: 'daily' });
  quota.addUsage(user, 90); // 租户 80 先爆
  const r = quota.check(user);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /tenant\/daily: 90\/80/);
});

test('platform limit applies to everyone', () => {
  const { quota, user, store } = setup();
  store.upsertQuota({ scope: 'platform', targetId: 0, tokenLimit: 50, period: 'monthly' });
  quota.addUsage(user, 30);
  assert.equal(quota.check(user).allowed, true);
  quota.addUsage(user, 30); // 60 > 50
  assert.equal(quota.check(user).allowed, false);
});

test('period rollover: new window resets spent', () => {
  const { quota, user, store } = setup();
  store.upsertQuota({ scope: 'user', targetId: user.id, tokenLimit: 100, period: 'daily' });
  const now = new Date(2026, 7, 15, 23, 0).getTime(); // 本地 8/15 23:00
  quota.addUsage(user, 90, now);
  assert.equal(quota.check(user, now).allowed, true); // 90 < 100 仍放行
  // 次日：新窗口，spent 归零
  const nextDay = new Date(2026, 7, 16, 1, 0).getTime(); // 本地 8/16 01:00
  const r = quota.check(user, nextDay);
  assert.equal(r.allowed, true);
  const limits = quota.view(user, nextDay).limits;
  assert.equal(limits[0].spent, 0);
});

test('view reports limits with remaining', () => {
  const { quota, user, store } = setup();
  store.upsertQuota({ scope: 'user', targetId: user.id, tokenLimit: 100, period: 'monthly' });
  quota.addUsage(user, 30);
  const view = quota.view(user);
  assert.equal(view.limits.length, 1);
  assert.equal(view.limits[0].spent, 30);
  assert.equal(view.limits[0].remaining, 70);
});
