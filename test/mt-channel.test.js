import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createAuthService } from '../lib/host/auth-service.js';
import { createMtChannel } from '../lib/host/mt-channel.js';
import { resolveConfig } from '../lib/host/config.js';
import { hashPassword } from '../lib/host/crypto.js';

function setup() {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({});
  const authService = createAuthService(store, cfg);
  const mt = createMtChannel({ store, authService });
  // 平台管理员 + 两个租户
  const sys = authService.bootstrap({ username: 'root', password: 'longenough-password' });
  const t1 = store.createTenant({ name: 'acme' });
  const t2 = store.createTenant({ name: 'globex' });
  const mkUser = (tenantId, username, role) => {
    const id = store.createUser({ tenantId, username, passwordHash: undefined, role });
    return { id, user: store.getUserById(id) };
  };
  const a = mkUser(t1, 'alice', 'admin');
  const b = mkUser(t1, 'bob', 'user');
  const c = mkUser(t1, 'carol', 'auditor');
  const d = mkUser(t2, 'dave', 'user');
  const authOf = (id) => ({ user: store.getUserById(id) });
  return { db, store, mt, sys, t1, t2, a, b, c, d, authOf };
}

test('mt: me returns user + tenant (any authenticated)', () => {
  const { mt, a, t1, authOf } = setup();
  const me = mt.dispatch('me', {}, authOf(a.id));
  assert.equal(me.ok, true);
  assert.equal(me.value.user.username, 'alice');
  assert.equal(me.value.tenant.id, t1);
  assert.equal(me.value.tenant.name, 'acme');
});

test('mt: unauthenticated and unknown endpoints denied', () => {
  const { mt } = setup();
  const noAuth = mt.dispatch('user.list', {}, null);
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.error.code, 'unauthenticated');
  const unknown = mt.dispatch('nope.nope', {}, { user: { id: 1, role: 'system' } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'not-found');
});

test('mt: tenant.* is system-only', () => {
  const { mt, a, sys, t2, store } = setup();
  // admin 不能建租户
  const denied = mt.dispatch('tenant.create', { name: 'x' }, { user: store.getUserById(a.id) });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'forbidden');
  // system 可建/列/停用
  const created = mt.dispatch('tenant.create', { name: 'newco' }, { user: store.getUserById(sys.user.id) });
  assert.equal(created.ok, true);
  const listed = mt.dispatch('tenant.list', {}, { user: store.getUserById(sys.user.id) });
  assert.equal(listed.value.tenants.length, 3);
  const disabled = mt.dispatch('tenant.setStatus', { tenantId: t2, status: 'disabled' }, { user: store.getUserById(sys.user.id) });
  assert.equal(disabled.ok, true);
  assert.equal(store.getTenant(t2).status, 'disabled');
  // 重复名冲突
  const dup = mt.dispatch('tenant.create', { name: 'newco' }, { user: store.getUserById(sys.user.id) });
  assert.equal(dup.error.code, 'conflict');
});

test('mt: user.list scoped to own tenant', () => {
  const { mt, a, b, c, d, store, t1 } = setup();
  const list = mt.dispatch('user.list', {}, { user: store.getUserById(a.id) });
  assert.equal(list.ok, true);
  const names = list.value.users.map((x) => x.username).sort();
  assert.deepEqual(names, ['alice', 'bob', 'carol']);
  // 越权指定他租户 → forbidden
  const cross = mt.dispatch('user.list', { tenantId: store.getTenantByName('globex').id }, { user: store.getUserById(a.id) });
  assert.equal(cross.ok, false);
  assert.equal(cross.error.code, 'forbidden');
  // auditor/user 不能列用户
  const auditor = mt.dispatch('user.list', {}, { user: store.getUserById(c.id) });
  assert.equal(auditor.error.code, 'forbidden');
  void d; void b;
  void t1;
});

test('mt: user.create with role assignment rules', () => {
  const { mt, a, sys, store, t1 } = setup();
  const asAdmin = { user: store.getUserById(a.id) };
  const asSys = { user: store.getUserById(sys.user.id) };

  // admin 建 auditor 用户 → 允许
  const created = mt.dispatch('user.create', { username: 'eve', password: 'longenough-password', role: 'auditor' }, asAdmin);
  assert.equal(created.ok, true);
  assert.equal(created.value.user.role, 'auditor');
  assert.equal(created.value.user.tenantId, t1);
  // admin 建 admin → 不允许（不能同级分配）
  const noAdmin = mt.dispatch('user.create', { username: 'eve2', password: 'longenough-password', role: 'admin' }, asAdmin);
  assert.equal(noAdmin.ok, false);
  assert.equal(noAdmin.error.code, 'forbidden');
  // system 可建 admin
  const sysCreate = mt.dispatch('user.create', { tenantId: t1, username: 'boss', password: 'longenough-password', role: 'admin' }, asSys);
  assert.equal(sysCreate.ok, true);
  // 重复用户名
  const dup = mt.dispatch('user.create', { username: 'eve', password: 'longenough-password', role: 'user' }, asAdmin);
  assert.equal(dup.error.code, 'conflict');
});

test('mt: user.setStatus disables account and revokes sessions', () => {
  const { mt, a, b, store } = setup();
  const asAdmin = { user: store.getUserById(a.id) };
  // 给 bob 一个会话
  store.createSession({ userId: b.id, tokenHash: 'h-bob', expiresAt: Date.now() + 10000 });
  const disabled = mt.dispatch('user.setStatus', { userId: b.id, status: 'disabled' }, asAdmin);
  assert.equal(disabled.ok, true);
  assert.equal(store.getUserById(b.id).status, 'disabled');
  assert.equal(store.getSessionByTokenHash('h-bob'), undefined); // 会话即时失效
});

test('mt: user.setRole / setPassword / delete permission boundaries', () => {
  const { mt, a, b, sys, store } = setup();
  const asAdmin = { user: store.getUserById(a.id) };
  const asSys = { user: store.getUserById(sys.user.id) };

  // admin 给 bob 升审计员 → 允许
  const promote = mt.dispatch('user.setRole', { userId: b.id, role: 'auditor' }, asAdmin);
  assert.equal(promote.ok, true);
  assert.equal(store.getUserById(b.id).role, 'auditor');
  // admin 给自己/同级升 admin → 拒绝
  const selfUp = mt.dispatch('user.setRole', { userId: a.id, role: 'admin' }, asAdmin);
  assert.equal(selfUp.error.code, 'forbidden');

  // admin 重置 bob 密码 → 会话清空
  store.createSession({ userId: b.id, tokenHash: 'h2', expiresAt: Date.now() + 10000 });
  const reset = mt.dispatch('user.setPassword', { userId: b.id, password: 'newlongenough-password' }, asAdmin);
  assert.equal(reset.ok, true);
  assert.equal(store.getSessionByTokenHash('h2'), undefined);

  // admin 删 bob → 允许；删自己 → 拒绝
  const delSelf = mt.dispatch('user.delete', { userId: a.id }, asAdmin);
  assert.equal(delSelf.error.code, 'invalid-input');
  const delBob = mt.dispatch('user.delete', { userId: b.id }, asAdmin);
  assert.equal(delBob.ok, true);
  assert.equal(store.getUserById(b.id), undefined);
  // system 可删租户 admin
  const bossId = store.createUser({ tenantId: null, username: 'boss', role: 'admin' });
  const delBoss = mt.dispatch('user.delete', { userId: bossId }, asSys);
  assert.equal(delBoss.ok, true);
});

test('mt: auth.changePassword verifies old password', () => {
  const { mt, store, t1 } = setup();
  const uid = store.createUser({ tenantId: t1, username: 'pw', passwordHash: undefined, role: 'user' });
  store.setUserPasswordHash(uid, hashPassword('old-password-123'));
  const as = { user: store.getUserById(uid) };
  const wrong = mt.dispatch('auth.changePassword', { oldPassword: 'wrong', newPassword: 'new-password-123' }, as);
  assert.equal(wrong.ok, false);
  const ok = mt.dispatch('auth.changePassword', { oldPassword: 'old-password-123', newPassword: 'new-password-123' }, as);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.changed, true);
});

// ---------------------------------------------------------------------------
// M4：审计 + 强制下线
// ---------------------------------------------------------------------------
test('mt: audit.list RBAC — auditor within tenant, user forbidden, system global', () => {
  const { mt, store, a, b, c, d } = setup();
  // 产生若干审计记录（含跨租户）
  const t1 = store.getTenantByName('acme').id;
  const t2 = store.getTenantByName('globex').id;
  store.writeAudit({ actorUserId: a.id, tenantId: t1, action: 'user.create', result: 'success' });
  store.writeAudit({ actorUserId: d.id, tenantId: t2, action: 'user.delete', result: 'denied' });

  const asAuditor = { user: store.getUserById(c.id) }; // carol = auditor in acme
  const r = mt.dispatch('audit.list', {}, asAuditor);
  assert.equal(r.ok, true);
  assert.equal(r.value.entries.length, 1); // 只看到租户 1
  assert.equal(r.value.entries[0].action, 'user.create');

  // user 角色被拒
  const asUser = { user: store.getUserById(b.id) };
  assert.equal(mt.dispatch('audit.list', {}, asUser).error.code, 'forbidden');

  // system 全局可见两条
  const sys = { user: store.getUserById(store.getUserByUsername('root').id) };
  const sysR = mt.dispatch('audit.list', {}, sys);
  assert.equal(sysR.value.entries.length >= 2, true);

  // 越权指定他租户 → forbidden
  const cross = mt.dispatch('audit.list', { tenantId: t2 }, asAuditor);
  assert.equal(cross.error.code, 'forbidden');
});

test('mt: audit.export returns CSV and honors scope', () => {
  const { mt, store, c, d } = setup();
  const t1 = store.getTenantByName('acme').id;
  const t2 = store.getTenantByName('globex').id;
  store.writeAudit({ actorUserId: c.id, tenantId: t1, action: 'auth.login', result: 'success' });
  store.writeAudit({ actorUserId: d.id, tenantId: t2, action: 'quota.set', detail: { x: 'a,"b"' }, result: 'success' });

  const asAuditor = { user: store.getUserById(c.id) };
  const r = mt.dispatch('audit.export', {}, asAuditor);
  assert.equal(r.ok, true);
  assert.match(r.value.csv, /^ts,actor_user_id/);
  assert.match(r.value.csv, /auth\.login/);
  assert.doesNotMatch(r.value.csv, /quota\.set/); // 跨租户记录不出现在租户 1 导出
  assert.match(r.value.filename, /\.csv$/);
});

test('mt: user.revokeSessions force-logout', () => {
  const { mt, store, a, b } = setup();
  // 给 bob 两个会话
  store.createSession({ userId: b.id, tokenHash: 'r1', expiresAt: Date.now() + 10000 });
  store.createSession({ userId: b.id, tokenHash: 'r2', expiresAt: Date.now() + 10000 });
  const asAdmin = { user: store.getUserById(a.id) };
  const r = mt.dispatch('user.revokeSessions', { userId: b.id }, asAdmin);
  assert.equal(r.ok, true);
  assert.equal(r.value.revoked, true);
  assert.equal(store.getSessionByTokenHash('r1'), undefined);
  assert.equal(store.getSessionByTokenHash('r2'), undefined);
  // 审计留痕
  const logs = store.listAudit({ action: 'user.revoke-sessions' });
  assert.equal(logs.length, 1);
  // 无权限（auditor 不能强制下线他人）
  const carol = store.getUserByUsername('carol');
  const asAuditor = { user: carol };
  store.createSession({ userId: b.id, tokenHash: 'r3', expiresAt: Date.now() + 10000 });
  const denied = mt.dispatch('user.revokeSessions', { userId: b.id }, asAuditor);
  assert.equal(denied.error.code, 'forbidden');
});

test('mt: data.export is platform-admin only', () => {
  const { mt, store, a, c } = setup();
  const asAdmin = { user: store.getUserById(a.id) };
  const asAuditor = { user: store.getUserById(c.id) };
  // 租户管理员/审计员 → 拒绝
  assert.equal(mt.dispatch('data.export', {}, asAdmin).error.code, 'forbidden');
  assert.equal(mt.dispatch('data.export', {}, asAuditor).error.code, 'forbidden');
  // system → 允许
  const sys = { user: store.getUserById(store.getUserByUsername('root').id) };
  const r = mt.dispatch('data.export', {}, sys);
  assert.equal(r.ok, true);
  assert.equal(r.value.summary.users >= 4, true); // alice/bob/carol/dave
  assert.ok(r.value.export.users[0].password_hash === null || 'password_hash' in r.value.export.users[0]);
});
