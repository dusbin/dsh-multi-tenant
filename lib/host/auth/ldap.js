/**
 * LDAP 登录策略（M5）。
 *
 * 流程（标准 LDAP 认证）：
 *  1. 用服务账号（bindDn/bindPassword，可空=匿名）连接并绑定
 *  2. 在 baseDn 下按 userFilter 搜索用户（{{username}} 占位，做过滤器转义）
 *  3. 取到用户条目（dn + 属性）后，以用户 DN + 密码绑定 —— 即密码校验
 *  4. 属性映射 → 本地账号：按 ldap_dn 找本地用户；autoProvision 时首次登录建号
 *
 * 依赖注入（可测试）：clientFactory 返回 { bind, search, unbind }。
 * 默认工厂动态 import `ldapts`（仅 ldap.enabled 时加载，profile 经 pnpm 安装）。
 */

const LDAP_FILTER_ESCAPE = /[\\*()\0]/g;

function escapeFilter(value) {
  return String(value).replace(LDAP_FILTER_ESCAPE, (ch) => {
    const map = { '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00' };
    return map[ch];
  });
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../config.js').resolveConfig>} deps.cfg
 * @param {ReturnType<import('../db.js').createStore>} deps.store
 * @param {{info?: Function, warn?: Function}} [deps.logger]
 * @param {(cfg) => Promise<{bind, search, unbind}>} [deps.clientFactory]  测试注入
 */
export function createLdapStrategy({ cfg, store, logger = console, clientFactory }) {
  const ldapCfg = cfg.auth?.ldap ?? {};
  const enabled = !!ldapCfg.enabled && !!ldapCfg.url;

  const defaultClientFactory = async () => {
    const { Client } = await import('ldapts');
    return new Client({ url: ldapCfg.url, timeout: ldapCfg.timeoutMs || 5000 });
  };
  const makeClient = clientFactory || defaultClientFactory;

  /**
   * LDAP 认证。
   * @returns {Promise<{ok: true, user: object} | {ok: false, error: {code, message}}>}
   *   user 为本地 user 行（可能刚自动建号）。
   */
  async function authenticate({ username, password }) {
    if (!enabled) {
      return { ok: false, error: { code: 'ldap-disabled', message: 'ldap is not enabled' } };
    }
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      return { ok: false, error: { code: 'invalid-credentials', message: 'username and password required' } };
    }
    const client = await makeClient(ldapCfg).catch((error) => {
      logger.warn?.(`[dsh-multi-tenant] ldap client init failed: ${error.message}`);
      return null;
    });
    if (!client) return { ok: false, error: { code: 'ldap-unavailable', message: 'LDAP client unavailable' } };

    try {
      // 1) 服务账号绑定（可匿名）
      if (ldapCfg.bindDn) {
        await client.bind(ldapCfg.bindDn, ldapCfg.bindPassword ?? '');
      }

      // 2) 搜索用户
      const filter = String(ldapCfg.userFilter || '(uid={{username}})').replaceAll('{{username}}', escapeFilter(username));
      const attrMap = ldapCfg.attributes || {};
      const attrs = Object.values(attrMap).filter(Boolean);
      const { searchEntries } = await client.search(ldapCfg.baseDn || '', {
        scope: 'sub',
        filter,
        attributes: Array.from(new Set(['dn', ...attrs])),
      });
      const entry = Array.isArray(searchEntries) ? searchEntries[0] : undefined;
      if (!entry) {
        return { ok: false, error: { code: 'invalid-credentials', message: 'user not found in directory' } };
      }
      // 条目形状（ldapts v9）：SearchEntry.toObject() → { dn, <attr>: string|string[] }
      const entryObj = typeof entry.toObject === 'function' ? entry.toObject(attrs, []) : entry;
      const dn = String(entryObj.dn ?? entry.name ?? entry.dn ?? '');

      // 3) 以用户 DN 绑定（密码校验）
      await client.bind(dn, password);

      // 4) 属性映射
      const firstAttr = (name) => {
        if (!name) return null;
        const v = entryObj[name];
        if (v === undefined || v === null) return null;
        if (Buffer.isBuffer(v)) return v.toString('utf8');
        return Array.isArray(v) ? (v[0] ?? null) : String(v);
      };
      const mappedUsername = firstAttr(attrMap.username) || username;
      const email = firstAttr(attrMap.email);

      // 5) 本地账号：按 ldap_dn 关联；无则按配置建号/拒绝
      let user = store.getUserByUsername(mappedUsername) ?? null;
      if (user && user.ldap_dn && user.ldap_dn !== entry.dn) {
        user = null; // 用户名被本地/其他目录占用
      }
      if (!user) {
        const byDn = store.listUsers().find((u) => u.ldap_dn === entry.dn);
        user = byDn ?? null;
      }
      if (!user) {
        if (!ldapCfg.autoProvision) {
          return { ok: false, error: { code: 'invalid-credentials', message: 'no local account for directory user' } };
        }
        const tenantId = ldapCfg.defaultTenantId === null || ldapCfg.defaultTenantId === undefined ? null : Number(ldapCfg.defaultTenantId);
        const role = ['system', 'admin', 'auditor', 'user'].includes(ldapCfg.defaultRole) ? ldapCfg.defaultRole : 'user';
        const id = store.createUser({
          tenantId,
          username: mappedUsername,
          email: email ?? null,
          ldapDn: entry.dn,
          role,
        });
        user = store.getUserById(id);
        store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id, action: 'auth.ldap-provision', result: 'success', detail: { dn: entry.dn } });
      }
      if (user.status === 'disabled') {
        return { ok: false, error: { code: 'account-disabled', message: 'account is disabled' } };
      }
      if (user.status === 'locked') {
        return { ok: false, error: { code: 'account-locked', message: 'account is locked' } };
      }
      return { ok: true, user };
    } catch (error) {
      // 绑定失败（密码错误，LDAP 结果码 49）与目录服务异常区分：不向客户端泄露目录细节
      const raw = `${error.message ?? ''} ${error.name ?? ''} ${String(error.code ?? '')}`;
      const isCredentialError = error.code === 49 || /(InvalidCredentials|Invalid DN|invalidCredentials|LDAP_RES_INVALID_CREDENTIALS)/i.test(raw);
      const code = isCredentialError ? 'invalid-credentials' : 'ldap-unavailable';
      logger.warn?.(`[dsh-multi-tenant] ldap auth failed: ${code} — ${raw.slice(0, 120)}`);
      return { ok: false, error: { code, message: code === 'invalid-credentials' ? 'invalid username or password' : 'directory service unavailable' } };
    } finally {
      try { await client.unbind(); } catch { /* ignore */ }
    }
  }

  return { enabled, authenticate };
}
