import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createQuotaService } from '../lib/host/quota.js';
import { createMetering } from '../lib/host/metering.js';

/** 伪造会话：带归属前缀 id + 可变 tokenUsage */
function fakeSession(prefix, usage) {
  return {
    id: `${prefix}-s-00000000-0000-0000-0000-000000000000`,
    usage,
  };
}

function setup() {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const quotaService = createQuotaService(store);
  const sessions = [];
  const metering = createMetering({
    store,
    quotaService,
    listSessions: () => sessions,
    readTokenUsage: (s) => s.usage,
    logger: { warn() {} },
  });
  const tid = store.createTenant({ name: 'acme' });
  const uid = store.createUser({ tenantId: tid, username: 'bob', role: 'user' });
  return { db, store, quotaService, metering, sessions, uid, tid };
}

test('first observation = baseline only (no usage recorded)', () => {
  const { db, store, metering, sessions, uid, tid } = setup();
  const s = fakeSession(`u-${uid}-t-${tid}`, { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
  sessions.push(s);
  assert.equal(metering.flushAll(), 0); // 首见只建基线
  assert.equal(store.aggregateUsage({}).request_count, 0);
  assert.ok(store.getSessionMeter(s.id));
  db.close();
});

test('delta accumulation writes usage_records and quota', () => {
  const { db, store, quotaService, metering, sessions, uid, tid } = setup();
  store.upsertQuota({ scope: 'user', targetId: uid, tokenLimit: 1000, period: 'monthly' });
  const s = fakeSession(`u-${uid}-t-${tid}`, { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 });
  sessions.push(s);
  metering.flushAll(); // 基线
  s.usage = { uncachedInputTokens: 300, outputTokens: 120, cacheReadTokens: 20, cacheWriteTokens: 15 };
  const delta = metering.flushAll();
  assert.equal(delta, 300 - 100 + 120 - 50 + 20 - 10 + 15 - 5); // 290
  const agg = store.aggregateUsage({});
  assert.equal(agg.request_count, 1);
  assert.equal(agg.input_tokens, 200);
  assert.equal(agg.output_tokens, 70);
  assert.equal(agg.cache_read_tokens, 10);
  assert.equal(agg.cache_write_tokens, 10);
  assert.equal(agg.total_tokens, 290);
  // 配额累计
  const view = quotaService.view(store.getUserById(uid));
  assert.equal(view.limits[0].spent, 290);
  db.close();
});

test('no-delta flush does not double count', () => {
  const { db, store, metering, sessions, uid, tid } = setup();
  const s = fakeSession(`u-${uid}-t-${tid}`, { uncachedInputTokens: 100, outputTokens: 50 });
  sessions.push(s);
  metering.flushAll();
  metering.flushAll(); // 无变化
  assert.equal(store.aggregateUsage({}).request_count, 0);
  // 用量减少（压缩）不产生负记账
  s.usage = { uncachedInputTokens: 80, outputTokens: 40 };
  assert.equal(metering.flushAll(), 0);
  assert.equal(store.aggregateUsage({}).request_count, 0);
  db.close();
});

test('non-owned sessions (no prefix) are skipped', () => {
  const { db, store, metering, sessions } = setup();
  sessions.push({ id: 'session-1', usage: { uncachedInputTokens: 999 } }); // 默认 id，无前缀
  assert.equal(metering.flushAll(), 0);
  assert.equal(store.aggregateUsage({}).request_count, 0);
  db.close();
});

test('usage aggregation by user', () => {
  const { db, store, metering, sessions, uid, tid } = setup();
  const s = fakeSession(`u-${uid}-t-${tid}`, { uncachedInputTokens: 100, outputTokens: 0 });
  sessions.push(s);
  metering.flushAll();
  s.usage = { uncachedInputTokens: 150, outputTokens: 30 };
  metering.flushAll();
  const byUser = store.aggregateUsageByUser({});
  assert.equal(byUser.length, 1);
  assert.equal(byUser[0].user_id, uid);
  assert.equal(byUser[0].input_tokens, 50);
  assert.equal(byUser[0].output_tokens, 30);
  db.close();
});
