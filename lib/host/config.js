/**
 * dsh-multi-tenant 配置解析（无外部 schema 依赖，手动合并默认值）。
 *
 * 配置来源：profile cordis.patch.yml 中 `multi-tenant` 行的 `config`。
 * Loader 挂载时 `!!js` 表达式已求值（如 `dshHomePath(...)`），
 * 这里只做默认值合并与轻量校验。
 */

import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  gateway: {
    enabled: true,
    host: '0.0.0.0',
    port: 3090,
  },
  cookie: {
    name: 'mt_session',
    maxAgeDays: 14,
    secure: false,
    sameSite: 'Lax',
  },
  db: {
    path: undefined, // 由 defaultDbPath() 填充
  },
  auth: {
    local: {
      enabled: true,
      maxFailedAttempts: 5,
      lockWindowMs: 15 * 60 * 1000,
    },
    bootstrap: {
      enabled: true,
    },
    ldap: {
      enabled: false,
      url: '',               // ldap://host:389 或 ldaps://host:636
      bindDn: '',            // 服务账号（可选；留空则匿名）
      bindPassword: '',
      baseDn: '',            // 用户搜索基（如 dc=example,dc=com）
      userFilter: '(uid={{username}})', // {{username}} 占位；搜索过滤器
      attributes: {          // LDAP 属性 → 本地字段映射
        username: 'uid',
        email: 'mail',
        displayName: 'cn',
      },
      autoProvision: true,   // 首次 LDAP 登录自动建号
      defaultTenantId: null, // 自动建号归属租户（null = 平台域）
      defaultRole: 'user',   // 自动建号默认角色
      timeoutMs: 5000,
    },
  },
  metering: {
    intervalMs: 15000,
  },
};

/** 默认数据库路径：$DSH_HOME/multi-tenant/mt.db */
export function defaultDbPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'multi-tenant', 'mt.db');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 合并用户配置到默认值（两层深合并，足够覆盖 gateway/cookie/db/auth 各节）。
 * @param {Record<string, any>} [input] 用户配置（可能 undefined）
 * @returns {typeof DEFAULT_CONFIG & { db: { path: string } }}
 */
export function resolveConfig(input) {
  const base = structuredClone(DEFAULT_CONFIG);
  base.db.path = defaultDbPath();
  deepMerge(base, input);
  if (typeof base.db.path !== 'string' || base.db.path.length === 0) {
    base.db.path = defaultDbPath();
  }
  return base;
}

/** 递归深合并（覆盖默认值；对象按键合并，其他值整体替换）。 */
function deepMerge(target, source) {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}
