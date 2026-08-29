import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionVisible, filterWorkspaceRow, filterListValue } from '../lib/host/visibility.js';

const sys = { id: 1, role: 'system' };
const admin = { id: 2, role: 'admin', tenant_id: 10 };
const auditor = { id: 3, role: 'auditor', tenant_id: 10 };
const userA = { id: 4, role: 'user', tenant_id: 10 };
const userB = { id: 5, role: 'user', tenant_id: 20 }; // 他租户

test('sessionVisible: role × tenant × owner', () => {
  const own = 'u-4-t-10-s-abc';
  const sameTenantOther = 'u-2-t-10-s-xyz';
  const otherTenant = 'u-5-t-20-s-qwe';
  const legacy = 'session-legacy-1'; // 无前缀

  assert.equal(sessionVisible(own, sys), true);
  assert.equal(sessionVisible(legacy, sys), true); // 平台管理员全可见（含遗留）
  assert.equal(sessionVisible(own, admin), true);
  assert.equal(sessionVisible(sameTenantOther, admin), true); // 租户管理员看本租户全部
  assert.equal(sessionVisible(otherTenant, admin), false);
  assert.equal(sessionVisible(legacy, admin), false); // 遗留仅平台管理员
  assert.equal(sessionVisible(own, auditor), true);
  assert.equal(sessionVisible(sameTenantOther, auditor), true);
  assert.equal(sessionVisible(own, userA), true);
  assert.equal(sessionVisible(sameTenantOther, userA), false); // 使用者仅本人
  assert.equal(sessionVisible(own, userB), false); // 他租户
});

test('filterWorkspaceRow: hides workspaces without visible sessions', () => {
  const row = { workspaceId: 'w1', path: '/x', title: 'x', sessionIds: ['u-2-t-10-s-a', 'u-5-t-20-s-b'] };
  const forAdmin = filterWorkspaceRow(row, admin);
  assert.deepEqual(forAdmin.sessionIds, ['u-2-t-10-s-a']); // 只留本租户
  const forUser = filterWorkspaceRow(row, userA);
  assert.equal(forUser, null); // 无本人会话 → 隐藏
  assert.equal(filterWorkspaceRow(row, sys), row); // 平台管理员原样
});

test('filterListValue: session.list / session.search / workspace.list', () => {
  const items = [
    { sessionId: 'u-2-t-10-s-a', updatedAt: 1 },
    { sessionId: 'u-5-t-20-s-b', updatedAt: 2 },
    { sessionId: 'u-4-t-10-s-c', updatedAt: 3 },
  ];
  // 租户管理员：本租户两条
  const list = filterListValue('session.list', { items }, admin);
  assert.deepEqual(list.items.map((i) => i.sessionId), ['u-2-t-10-s-a', 'u-4-t-10-s-c']);
  // 使用者：仅本人
  const my = filterListValue('session.list', { items }, userA);
  assert.deepEqual(my.items.map((i) => i.sessionId), ['u-4-t-10-s-c']);
  // 平台管理员：不过滤（返回原引用）
  const v = { items };
  assert.equal(filterListValue('session.list', v, sys), v);
  // search 同构
  const search = filterListValue('session.search', { items: items.map((i) => ({ sessionId: i.sessionId, snippet: 'x' })) }, admin);
  assert.equal(search.items.length, 2);
  // workspace.list 真实形状 {items, archivedSessionIds}
  const ws = filterListValue('workspace.list', {
    items: [
      { workspaceId: 'w1', sessionIds: ['u-2-t-10-s-a'] },
      { workspaceId: 'w2', sessionIds: ['u-5-t-20-s-b'] },
    ],
    archivedSessionIds: ['u-2-t-10-s-old', 'u-5-t-20-s-old'],
  }, admin);
  assert.equal(ws.items.length, 1);
  assert.equal(ws.items[0].workspaceId, 'w1');
  assert.deepEqual(ws.archivedSessionIds, ['u-2-t-10-s-old']);
});
