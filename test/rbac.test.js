import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRole, isSystem, isAdmin, canAccessTenant, canManageUser, validateRole, assignableRoles, ROLE_LEVEL, ROLE_LABELS } from '../lib/host/rbac.js';

function u(role, tenantId = 1) {
  return { id: 1, role, tenantId };
}

test('role hierarchy user < auditor < admin < system', () => {
  assert.equal(ROLE_LEVEL.user, 1);
  assert.equal(ROLE_LEVEL.auditor, 2);
  assert.equal(ROLE_LEVEL.admin, 3);
  assert.equal(ROLE_LEVEL.system, 4);
  assert.equal(hasRole(u('admin'), 'user'), true);
  assert.equal(hasRole(u('admin'), 'admin'), true);
  assert.equal(hasRole(u('admin'), 'system'), false);
  assert.equal(hasRole(u('user'), 'admin'), false);
  assert.equal(hasRole(u('system'), 'system'), true);
  assert.equal(hasRole(null, 'user'), false);
  assert.equal(isSystem(u('system')), true);
  assert.equal(isSystem(u('admin')), false);
  assert.equal(isAdmin(u('admin')), true);
  assert.equal(isAdmin(u('auditor')), false);
});

test('tenant isolation: only system crosses tenants', () => {
  assert.equal(canAccessTenant(u('user', 1), 1), true);
  assert.equal(canAccessTenant(u('user', 1), 2), false);
  assert.equal(canAccessTenant(u('admin', 1), 1), true);
  assert.equal(canAccessTenant(u('admin', 1), 2), false);
  assert.equal(canAccessTenant(u('system'), 2), true);
  assert.equal(canAccessTenant(u('user', null), 1), false);
});

test('canManageUser rules', () => {
  const tenantUser = (id, role, tenantId = 1) => ({ id, role, tenant_id: tenantId });
  // admin 管理同租户非 admin/system
  assert.equal(canManageUser(u('admin', 1), tenantUser(2, 'user', 1)), true);
  assert.equal(canManageUser(u('admin', 1), tenantUser(2, 'auditor', 1)), true);
  assert.equal(canManageUser(u('admin', 1), tenantUser(2, 'admin', 1)), false); // 不能动同级
  assert.equal(canManageUser(u('admin', 1), tenantUser(2, 'system', 1)), false);
  assert.equal(canManageUser(u('admin', 1), tenantUser(2, 'user', 2)), false); // 跨租户
  // system 管理任何非 system
  assert.equal(canManageUser(u('system'), tenantUser(2, 'admin', 1)), true);
  assert.equal(canManageUser(u('system'), tenantUser(2, 'system', null)), false);
  // auditor/user 不能管理他人
  assert.equal(canManageUser(u('auditor', 1), tenantUser(2, 'user', 1)), false);
  assert.equal(canManageUser(u('user', 1), tenantUser(2, 'user', 1)), false);
});

test('validateRole & assignableRoles', () => {
  assert.equal(validateRole('admin'), null);
  assert.equal(validateRole('nope'), 'invalid role: nope');
  assert.deepEqual(assignableRoles(u('admin', 1)), ['auditor', 'user']);
  assert.deepEqual(assignableRoles(u('system')), ['admin', 'auditor', 'user', 'system']);
  assert.deepEqual(assignableRoles(u('user', 1)), []);
  assert.ok(ROLE_LABELS.admin);
});
