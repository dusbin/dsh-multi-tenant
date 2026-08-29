/**
 * 数据备份/恢复/重置（逃生通道配套）。
 *
 * 导出格式：版本化 JSON（EXPORT_VERSION）。
 *  - 包含：tenants / users（含 password_hash——视为凭据，须妥善保管）/ quotas /
 *    quota_usage / usage_records / session_meter / audit_logs
 *  - 不包含：auth_sessions（临时会话）、login_attempts（防爆破瞬时数据）
 *
 * 用途：
 *  - CLI：scripts/maintenance.mjs export/import/reset-system
 *  - /mt：data.export（平台管理员全量备份下载）
 */

export const EXPORT_VERSION = 1;

/** 导出全量数据（不含临时表）。 */
export function exportData(store) {
  return {
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    tenants: store.listTenants(),
    users: store.listUsers(null),
    quotas: store.listQuotas(),
    quotaUsage: store.listAllQuotaUsage(),
    usageRecords: store.listAllUsageRecords(),
    sessionMeter: store.listAllSessionMeter(),
    auditLogs: store.listAllAudit(),
  };
}

function validateExport(data) {
  if (!data || typeof data !== 'object') throw new Error('invalid export: not an object');
  if (data.version !== EXPORT_VERSION) {
    throw new Error(`unsupported export version ${String(data.version)} (expected ${EXPORT_VERSION})`);
  }
  for (const key of ['tenants', 'users', 'quotas', 'quotaUsage', 'usageRecords', 'sessionMeter', 'auditLogs']) {
    if (!Array.isArray(data[key])) throw new Error(`invalid export: missing array "${key}"`);
  }
}

/**
 * 导入数据。
 * @param {ReturnType<import('./db.js').createStore>} store
 * @param {object} data   exportData 的输出
 * @param {{replace?: boolean}} [opts]  replace=true 时先清空（用于恢复）；false 时要求目标为空
 */
export function importData(store, data, { replace = false } = {}) {
  validateExport(data);
  if (!replace && (store.countTenants() > 0 || store.countUsers() > 0)) {
    throw new Error('target system is not empty; use --replace to overwrite');
  }
  const db = store._db; // 供事务使用（createStore 内部持有 db）
  db.exec('BEGIN');
  try {
    if (replace) store.wipeSystem({ keepUsage: false, useTransaction: false }); // 外层已有事务
    // 依赖顺序：tenants → users → quotas → quota_usage → usage_records → session_meter → audit_logs
    for (const t of data.tenants) store.insertTenantRaw(t);
    for (const u of data.users) store.insertUserRaw(u);
    for (const q of data.quotas) store.insertQuotaRaw(q);
    for (const qu of data.quotaUsage) store.insertQuotaUsageRaw(qu);
    for (const r of data.usageRecords) store.insertUsageRecordRaw(r);
    for (const m of data.sessionMeter) store.insertSessionMeterRaw(m);
    for (const a of data.auditLogs) store.insertAuditRaw(a);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`import failed (rolled back): ${error.message}`);
  }
  return {
    tenants: data.tenants.length,
    users: data.users.length,
    quotas: data.quotas.length,
    usageRecords: data.usageRecords.length,
    auditLogs: data.auditLogs.length,
  };
}

/**
 * 重置系统。
 * @param {ReturnType<import('./db.js').createStore>} store
 * @param {{keepUsage?: boolean}} [opts]  keepUsage=true 保留用量与配额累计（仅清管理面）
 */
export function resetSystem(store, { keepUsage = false } = {}) {
  store.wipeSystem({ keepUsage });
  return { reset: true, keepUsage };
}

/** 数据导出统计（供 /mt data.export 返回元信息） */
export function exportSummary(data) {
  return {
    version: data.version,
    exportedAt: data.exportedAt,
    tenants: data.tenants.length,
    users: data.users.length,
    quotas: data.quotas.length,
    usageRecords: data.usageRecords.length,
    sessionMeter: data.sessionMeter.length,
    auditLogs: data.auditLogs.length,
  };
}
