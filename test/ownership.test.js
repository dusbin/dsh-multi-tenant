import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIdPrefix, newOwnedSessionId, parseSessionPrefix, ownsSession, enforceSessionOwnership } from '../lib/host/ownership.js';

const user = { id: 42, tenantId: 7 };

test('prefix encode/parse roundtrip', () => {
  const prefix = sessionIdPrefix(user);
  assert.equal(prefix, 'u-42-t-7-s-');
  const sid = newOwnedSessionId(user);
  assert.ok(sid.startsWith(prefix));
  const parsed = parseSessionPrefix(sid);
  assert.deepEqual(parsed, { uid: 42, tid: 7 });
  assert.equal(parseSessionPrefix('garbage'), null);
  assert.equal(parseSessionPrefix('u-abc-t-7-s-x'), null); // uid 非数字
  assert.equal(parseSessionPrefix('u-42-t-sys-s-x').tid, null); // system 域
});

test('ownsSession exact-prefix match', () => {
  assert.equal(ownsSession(user, 'u-42-t-7-s-abc'), true);
  assert.equal(ownsSession(user, 'u-43-t-7-s-abc'), false); // 他人
  assert.equal(ownsSession(user, 'u-42-t-8-s-abc'), false); // 他租户
  assert.equal(ownsSession(user, null), false);
});

test('enforceSessionOwnership rewrites session.create and guards others', () => {
  // create：无 id → 注入归属前缀
  const r1 = enforceSessionOwnership(user, 'session.create', {});
  assert.equal(r1.ok, true);
  assert.ok(r1.payload.sessionId.startsWith('u-42-t-7-s-'));
  // create：他人前缀 → 强制改写
  const r2 = enforceSessionOwnership(user, 'session.create', { sessionId: 'u-99-t-7-s-zzz' });
  assert.equal(r2.ok, true);
  assert.ok(r2.payload.sessionId.startsWith('u-42-t-7-s-'));
  // create：自己的前缀 → 原样
  const own = 'u-42-t-7-s-abc';
  const r3 = enforceSessionOwnership(user, 'session.create', { sessionId: own });
  assert.equal(r3.payload.sessionId, own);
  // 其他方法：前缀不匹配 → 拒绝
  const r4 = enforceSessionOwnership(user, 'session.prompt', { sessionId: 'u-99-t-7-s-zzz', text: 'hi' });
  assert.equal(r4.ok, false);
  // 其他方法：匹配 → 放行
  const r5 = enforceSessionOwnership(user, 'session.prompt', { sessionId: own });
  assert.equal(r5.ok, true);
  // 无 sessionId 字段 → 放行
  const r6 = enforceSessionOwnership(user, 'command.list', {});
  assert.equal(r6.ok, true);
});
