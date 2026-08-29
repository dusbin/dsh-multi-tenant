/**
 * RBAC：角色模型与权限判定。
 *
 * 角色（每用户一角色，租户内生效；system 为平台域）：
 *  - system   平台管理员：租户生命周期、全局配置/审计（不占租户配额）
 *  - admin    租户管理员：租户内用户管理/启停/角色/配额、自动含审计权限（D4）
 *  - auditor  审计员：租户内只读统计 + 审计日志
 *  - user     使用者：登录、使用会话、查看个人用量
 *
 * 权限判定在网关端点级 + 服务层方法级双重执行（本模块为服务层）。
 */

export const ROLES = ['system', 'admin', 'auditor', 'user'];

/** 角色等级（越大越权）：user < auditor < admin < system */
export const ROLE_LEVEL = {
  user: 1,
  auditor: 2,
  admin: 3,
  system: 4,
};

/** 角色展示名 */
export const ROLE_LABELS = {
  system: '平台管理员',
  admin: '租户管理员',
  auditor: '审计员',
  user: '使用者',
};

/** 当前用户是否达到最低角色等级 */
export function hasRole(user, minRole) {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL[minRole];
}

/** 是否平台管理员 */
export function isSystem(user) {
  return !!user && user.role === 'system';
}

/** 是否租户管理员（含平台管理员） */
export function isAdmin(user) {
  return hasRole(user, 'admin');
}

/**
 * 能否访问某租户的数据（租户间完全隔离，D1）。
 *  - system：任意租户
 *  - 其他角色：仅自己的租户
 *  - 无租户（system 域用户不存在于租户）：除 system 外均不可
 * 接受原始行（tenant_id）或视图（tenantId）两种形状。
 */
export function canAccessTenant(user, tenantId) {
  if (!user) return false;
  if (user.role === 'system') return true;
  const ownTenant = user.tenant_id ?? user.tenantId;
  return ownTenant !== null && ownTenant !== undefined && ownTenant === tenantId;
}

/**
 * 能否管理目标用户（用户管理/启停/改角色/改密/删除）：
 *  - system：任意非 system 用户
 *  - admin：仅同租户、且目标不是 admin/system
 *  - auditor/user：不能管理他人
 */
export function canManageUser(actor, target) {
  if (!actor || !target) return false;
  const actorTenant = actor.tenant_id ?? actor.tenantId;
  const targetTenant = target.tenant_id ?? target.tenantId;
  if (actor.role === 'system') return target.role !== 'system';
  if (actor.role === 'admin') {
    return targetTenant !== null
      && actorTenant !== null
      && actorTenant === targetTenant
      && target.role !== 'admin'
      && target.role !== 'system';
  }
  return false;
}

/**
 * 校验角色值合法。
 * @returns {string | null} 错误信息或 null
 */
export function validateRole(role) {
  if (!ROLES.includes(role)) return `invalid role: ${String(role)}`;
  return null;
}

/** 租户内可分配的角色（system 角色只能由 system 授予给自己域的账号，见 mt-channel） */
export function assignableRoles(actor) {
  if (actor.role === 'system') return ['admin', 'auditor', 'user', 'system'];
  if (actor.role === 'admin') return ['auditor', 'user'];
  return [];
}
