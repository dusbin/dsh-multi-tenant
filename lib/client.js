/**
 * dsh-multi-tenant — 浏览器半（登录门禁 + 管理控制台）。
 *
 * 手写 client bundle（与 dsh-voice 同构，无需构建工具链）：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内的 `require()`
 * 由浏览器模块表解析（react 为平台种子模块）。
 *
 * 功能：
 *  - 登录门禁：`shell.overlay` 全屏登录层 + bootstrap 平台管理员向导
 *  - 管理控制台（`settings.section` 页签）：
 *      personal  个人中心（当前用户信息 / 改密）          [任意已登录]
 *      users     用户管理（列表/创建/启停/角色/重置密码/删除）[admin+]
 *      tenants   租户管理（列表/创建/启停）               [system]
 *  - 管理 API 走 `/mt` 通道（ctx.connection.rpc.call），认证由网关 Cookie 承担。
 *
 * 安全说明：本层只是 UX；权限真值在网关与 /mt 服务层（host 半）强制。
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-tenant',
  factory: (require) => {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    // ---------------------------------------------------------------------
    // i18n
    // ---------------------------------------------------------------------
    var dict = {
      zh: {
        // 登录
        title: 'DeepSeek Harness', subtitle: '多租户工作台',
        username: '用户名 / 邮箱', password: '密码', login: '登 录', loggingIn: '登录中…',
        bootstrapTitle: '初始化系统', bootstrapHint: '首次使用：创建平台管理员账号',
        recoveryTitle: '管理员恢复', recoveryHint: '检测到无可用平台管理员（本机操作）——创建新的平台管理员账号',
        confirm: '创建并进入', creating: '创建中…', checking: '正在检查登录状态…',
        // 错误
        error_invalid_credentials: '用户名或密码错误', error_rate_limited: '尝试次数过多，请稍后再试',
        error_account_disabled: '账号已被禁用', error_account_locked: '账号已锁定',
        error_network: '无法连接服务器，请重试', error_unknown: '操作失败，请重试',
        error_invalid_input: '输入不合法', error_already_initialized: '系统已初始化',
        error_unauthenticated: '未登录或会话已过期', error_forbidden: '没有权限',
        error_ldap_unavailable: '目录服务不可用',
        loginLdap: 'LDAP 登录',
        loginOidc: 'SSO 登录', error_oidc_unavailable: 'SSO 不可用', error_oidc_invalid_state: 'SSO 会话失效，请重试', error_oidc_exchange_failed: 'SSO 登录失败', error_oidc_no_account: '没有本地账号',
        // 个人中心
        personal: '个人中心', me: '我的账号', role: '角色', tenant: '租户', status: '状态',
        role_system: '平台管理员', role_admin: '租户管理员', role_auditor: '审计员', role_user: '使用者',
        status_active: '正常', status_disabled: '已禁用', status_locked: '已锁定',
        oldPassword: '当前密码', newPassword: '新密码', changePassword: '修改密码',
        passwordChanged: '密码已修改', passwordReset: '密码已重置（该用户需重新登录）',
        // 用户管理
        users: '用户管理', addUser: '新增用户', usernameLabel: '用户名', emailLabel: '邮箱', tenantSelect: '所属租户',
        passwordLabel: '密码', roleLabel: '角色', actions: '操作', createUser: '创建',
        disable: '禁用', enable: '启用', lock: '锁定', delete: '删除', resetPwd: '重置密码',
        confirmDelete: '确认删除该用户？', deleteSelf: '不能删除自己',
        // 租户管理
        tenants: '租户管理', addTenant: '新增租户', tenantName: '租户名称', createTenant: '创建租户',
        tenantStatus: '租户状态', usersCount: '用户数',
        // 用量统计
        usage: '用量统计', usageRequests: '请求数', usageInput: '输入 token', usageOutput: '输出 token',
        usageCacheRead: '缓存读', usageCacheWrite: '缓存写', usageTotal: '总 token',
        usageByUser: '按用户', usageSessions: '会话明细', periodDay: '今日', periodMonth: '本月', periodAll: '累计',
        // 配额
        quota: '配额', tokenLimit: '限额(token)', spentTokens: '已用', remainingTokens: '剩余',
        setQuota: '设置限额', clearQuota: '清除限额', scopeUser: '用户', scopeTenant: '租户', scopePlatform: '平台',
        periodDaily: '日', periodMonthly: '月', periodTotal: '累计',
        quotaSet: '配额已设置', quotaCleared: '配额已清除',
        // 审计
        audit: '审计日志', auditExport: '导出 CSV', auditResult: '结果', auditAction: '操作',
        auditActor: '操作者', auditTarget: '目标', auditTime: '时间', auditDetail: '详情',
        revokeSessions: '强制下线', revokedSessions: '该用户已强制下线',
        // 通用
        loading: '加载中…', save: '保存', cancel: '取消', refresh: '刷新', none: '—',
        noPermission: '没有权限查看此页面',
      },
      en: {
        title: 'DeepSeek Harness', subtitle: 'Multi-tenant workspace',
        username: 'Username / Email', password: 'Password', login: 'Sign in', loggingIn: 'Signing in…',
        bootstrapTitle: 'Initialize system', bootstrapHint: 'First run: create the platform admin account',
        recoveryTitle: 'Admin recovery', recoveryHint: 'No active platform admin (local only) — create a new one',
        confirm: 'Create & enter', creating: 'Creating…', checking: 'Checking session…',
        error_invalid_credentials: 'Invalid username or password', error_rate_limited: 'Too many attempts, try again later',
        error_account_disabled: 'Account is disabled', error_account_locked: 'Account is locked',
        error_network: 'Cannot reach server, retry', error_unknown: 'Operation failed, retry',
        error_invalid_input: 'Invalid input', error_already_initialized: 'Already initialized',
        error_unauthenticated: 'Not authenticated', error_forbidden: 'Forbidden',
        error_ldap_unavailable: 'Directory service unavailable',
        loginLdap: 'LDAP sign in',
        loginOidc: 'SSO sign in', error_oidc_unavailable: 'SSO unavailable', error_oidc_invalid_state: 'SSO session expired, retry', error_oidc_exchange_failed: 'SSO failed', error_oidc_no_account: 'No local account',
        personal: 'My account', me: 'My account', role: 'Role', tenant: 'Tenant', status: 'Status',
        role_system: 'Platform admin', role_admin: 'Tenant admin', role_auditor: 'Auditor', role_user: 'User',
        status_active: 'Active', status_disabled: 'Disabled', status_locked: 'Locked',
        oldPassword: 'Current password', newPassword: 'New password', changePassword: 'Change password',
        passwordChanged: 'Password changed', passwordReset: 'Password reset (user must re-login)',
        users: 'Users', addUser: 'Add user', usernameLabel: 'Username', emailLabel: 'Email', tenantSelect: 'Tenant',
        passwordLabel: 'Password', roleLabel: 'Role', actions: 'Actions', createUser: 'Create',
        disable: 'Disable', enable: 'Enable', lock: 'Lock', delete: 'Delete', resetPwd: 'Reset password',
        confirmDelete: 'Delete this user?', deleteSelf: 'Cannot delete yourself',
        tenants: 'Tenants', addTenant: 'Add tenant', tenantName: 'Tenant name', createTenant: 'Create tenant',
        tenantStatus: 'Status', usersCount: 'Users',
        usage: 'Usage', usageRequests: 'Requests', usageInput: 'Input tokens', usageOutput: 'Output tokens',
        usageCacheRead: 'Cache read', usageCacheWrite: 'Cache write', usageTotal: 'Total tokens',
        usageByUser: 'By user', usageSessions: 'Sessions', periodDay: 'Today', periodMonth: 'This month', periodAll: 'All',
        quota: 'Quotas', tokenLimit: 'Limit (tokens)', spentTokens: 'Spent', remainingTokens: 'Remaining',
        setQuota: 'Set limit', clearQuota: 'Clear limit', scopeUser: 'User', scopeTenant: 'Tenant', scopePlatform: 'Platform',
        periodDaily: 'Daily', periodMonthly: 'Monthly', periodTotal: 'Total',
        quotaSet: 'Quota set', quotaCleared: 'Quota cleared',
        audit: 'Audit log', auditExport: 'Export CSV', auditResult: 'Result', auditAction: 'Action',
        auditActor: 'Actor', auditTarget: 'Target', auditTime: 'Time', auditDetail: 'Detail',
        revokeSessions: 'Force logout', revokedSessions: 'User forced offline',
        loading: 'Loading…', save: 'Save', cancel: 'Cancel', refresh: 'Refresh', none: '—',
        noPermission: 'No permission to view this page',
      },
    };

    var lang = (typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().startsWith('zh')) ? 'zh' : 'en';
    function t(key) {
      return (dict[lang] && dict[lang][key]) || dict.zh[key] || key;
    }
    function roleLabel(role) { return t('role_' + role) || role; }
    function statusLabel(status) { return t('status_' + status) || status; }

    // ---------------------------------------------------------------------
    // 样式
    // ---------------------------------------------------------------------
    (function injectCss() {
      var style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-multi-tenant/mt');
      style.textContent = [
        /* 登录门禁 */
        '.mt-login-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;',
        'background:var(--dsw-alias-bg-base,#0b0e14);pointer-events:auto;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}',
        '.mt-login-card{width:360px;max-width:calc(100vw - 48px);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base,#141922));',
        'border:1px solid var(--dsw-alias-border,#2a3242);border-radius:14px;padding:32px 28px;box-shadow:0 12px 40px rgba(0,0,0,.35);}',
        '.mt-login-brand{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eaf0);text-align:center;}',
        '.mt-login-sub{font-size:13px;color:var(--dsw-alias-label-secondary,#9aa3b2);text-align:center;margin-top:4px;margin-bottom:24px;}',
        '.mt-field{margin-bottom:12px;}',
        '.mt-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);margin-bottom:6px;}',
        '.mt-input{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;outline:none;',
        'background:var(--dsw-specific-login-input,var(--dsw-alias-bg-base,#0f131b));border:1px solid var(--dsw-alias-border,#2a3242);',
        'color:var(--dsw-alias-label-primary,#e8eaf0);font-size:14px;}',
        '.mt-input::placeholder{color:var(--dsw-alias-label-secondary,#6b7280);opacity:.8;}',
        '.mt-input:focus{border-color:#3b82f6;}',
        '.mt-error{color:#f87171;font-size:12px;margin-bottom:10px;min-height:16px;}',
        '.mt-btn{display:inline-block;padding:9px 16px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;font-weight:600;cursor:pointer;}',
        '.mt-btn:hover{background:#1d4ed8;} .mt-btn:disabled{opacity:.6;cursor:default;}',
        '.mt-btn.ghost{background:transparent;border:1px solid var(--dsw-alias-border,#2a3242);color:var(--dsw-alias-label-primary,#e8eaf0);}',
        '.mt-btn.danger{background:#dc2626;} .mt-btn.danger:hover{background:#b91c1c;}',
        '.mt-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);text-align:center;margin-top:16px;}',
        '.mt-msg{font-size:12px;margin-bottom:10px;min-height:16px;} .mt-msg.ok{color:#34d399;}',
        /* 控制台 */
        '.mt-section{display:flex;flex-direction:column;gap:16px;}',
        '.mt-section h3{margin:0 0 4px;font-size:15px;color:var(--dsw-alias-label-primary,#e8eaf0);}',
        '.mt-table{width:100%;border-collapse:collapse;font-size:13px;}',
        '.mt-table th,.mt-table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border,#232b3a);}',
        '.mt-table th{color:var(--dsw-alias-label-secondary,#9aa3b2);font-weight:500;}',
        '.mt-table td{color:var(--dsw-alias-label-primary,#e8eaf0);}',
        '.mt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '.mt-form{display:flex;flex-direction:column;gap:10px;max-width:360px;}',
        '.mt-toolbar{display:flex;gap:8px;align-items:center;}',
        '.mt-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;}',
        '.mt-badge.on{background:rgba(52,211,153,.15);color:#34d399;}',
        '.mt-badge.off{background:rgba(248,113,113,.15);color:#f87171;}',
      ].join('');
      document.head.appendChild(style);
    })();

    // ---------------------------------------------------------------------
    // /mt 调用助手（apply 时注入 ctx.connection）
    // ---------------------------------------------------------------------
    var connection = null;
    function mt(endpoint, payload) {
      if (!connection) return Promise.reject(new Error('connection unavailable'));
      return connection.rpc.call('/mt', endpoint, payload || {}).then(function (result) {
        if (result && result.ok) return result.value;
        var code = result && result.error ? result.error.code : 'mt-error';
        var err = new Error(code);
        err.code = code;
        throw err;
      });
    }
    function api(path, options) {
      return fetch(path, Object.assign({ credentials: 'include' }, options || {}));
    }

    var e = React.createElement;

    // ---------------------------------------------------------------------
    // 登录门禁
    // ---------------------------------------------------------------------
    function LoginOverlay() {
      var state = React.useState('checking');
      var status = state[0], setStatus = state[1];
      var usernameState = React.useState('');
      var username = usernameState[0], setUsername = usernameState[1];
      var passwordState = React.useState('');
      var password = passwordState[0], setPassword = passwordState[1];
      var errorState = React.useState(null);
      var error = errorState[0], setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var methodsState = React.useState(['local']);
      var methods = methodsState[0], setMethods = methodsState[1];
      var methodState = React.useState('local');
      var method = methodState[0], setMethod = methodState[1];

      React.useEffect(function () {
        var cancelled = false;
        api('/api/auth/me').then(function (res) {
          return res.json().catch(function () { return {}; });
        }).then(function (data) {
          if (cancelled) return;
          if (data && data.ok && data.user) setStatus('authed');
          else if (data && data.bootstrapRequired) setStatus('bootstrap');
          else if (data && data.recoveryRequired) setStatus('recovery');
          else { setStatus('login'); setMethods(data && data.methods ? data.methods : ['local']); }
        }).catch(function () {
          if (!cancelled) { setStatus('login'); setError('error_network'); }
        });
        return function () { cancelled = true; };
      }, []);

      if (status === 'authed') return null;

      function submit(endpoint) {
        if (isRecovery) endpoint = '/api/auth/recovery';
        setBusy(true);
        setError(null);
        api(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: username, password: password, method: method }),
        }).then(function (res) {
          return res.json().catch(function () { return {}; });
        }).then(function (data) {
          if (data && data.ok) { window.location.reload(); return; }
          var code = data && data.error ? data.error.code : 'unknown';
          setError('error_' + code);
          setBusy(false);
        }).catch(function () {
          setError('error_network');
          setBusy(false);
        });
      }

      var isBootstrap = status === 'bootstrap' || status === 'recovery';
      var isRecovery = status === 'recovery';
      var isChecking = status === 'checking';
      return e('div', { className: 'mt-login-overlay' },
        e('div', { className: 'mt-login-card' },
          e('div', { className: 'mt-login-brand' }, t('title')),
          e('div', { className: 'mt-login-sub' }, isRecovery ? t('recoveryHint') : (isBootstrap ? t('bootstrapHint') : t('subtitle'))),
          isChecking ? e('div', { className: 'mt-hint' }, t('checking'))
            : e(React.Fragment, null,
              e('div', { className: 'mt-field' },
                e('label', { className: 'mt-label' }, t('username')),
                e('input', { className: 'mt-input', value: username, disabled: busy, autoComplete: 'username',
                  onChange: function (ev) { setUsername(ev.target.value); } })),
              e('div', { className: 'mt-field' },
                e('label', { className: 'mt-label' }, t('password')),
                e('input', { className: 'mt-input', type: 'password', value: password, disabled: busy,
                  autoComplete: isBootstrap ? 'new-password' : 'current-password',
                  onChange: function (ev) { setPassword(ev.target.value); },
                  onKeyDown: function (ev) {
                    if (ev.key === 'Enter' && !busy) submit(isBootstrap ? '/api/auth/bootstrap' : '/api/auth/login');
                  } })),
              e('div', { className: 'mt-error' }, error ? t(error) : ''),
              e('button', { className: 'mt-btn', disabled: busy || !username || !password,
                onClick: function () { submit(isBootstrap ? '/api/auth/bootstrap' : '/api/auth/login'); } },
                busy ? (isBootstrap ? t('creating') : t('loggingIn')) : (isBootstrap ? (isRecovery ? t('recoveryTitle') : t('confirm')) : t('login'))),
              !isBootstrap && methods.indexOf('ldap') !== -1
                ? e('button', {
                    className: 'mt-btn ghost',
                    style: { marginTop: 8, width: '100%' },
                    disabled: busy || !username || !password,
                    onClick: function () { setMethod('ldap'); submit('/api/auth/login'); },
                  }, t('loginLdap'))
                : null,
              !isBootstrap && methods.indexOf('oidc') !== -1
                ? e('button', {
                    className: 'mt-btn ghost',
                    style: { marginTop: 8, width: '100%' },
                    onClick: function () {
                      api('/api/auth/oidc/start?redirect=%2F')
                        .then(function (res) { return res.json().catch(function () { return {}; }); })
                        .then(function (data) {
                          if (data && data.ok && data.url) { window.location.href = data.url; }
                          else { setError('error_oidc_unavailable'); }
                        })
                        .catch(function () { setError('error_oidc_unavailable'); });
                    },
                  }, t('loginOidc'))
                : null,
            )),
      );
    }

    // ---------------------------------------------------------------------
    // 个人中心
    // ---------------------------------------------------------------------
    function PersonalSection() {
      var meState = React.useState(null);
      var me = meState[0], setMe = meState[1];
      var errorState = React.useState(null);
      var error = errorState[0], setError = errorState[1];
      var oldState = React.useState(''); var oldPwd = oldState[0], setOldPwd = oldState[1];
      var newState = React.useState(''); var newPwd = newState[0], setNewPwd = newState[1];
      var msgState = React.useState(null); var msg = msgState[0], setMsg = msgState[1];
      var busyState = React.useState(false); var busy = busyState[0], setBusy = busyState[1];

      React.useEffect(function () {
        mt('me').then(function (v) { setMe(v); }).catch(function (err) { setError(err.message); });
      }, []);

      if (error) return e('div', { className: 'mt-section' }, e('div', { className: 'mt-error' }, t('error_' + error) || error));
      if (!me) return e('div', { className: 'mt-section' }, t('loading'));

      function changePwd() {
        setBusy(true); setMsg(null); setError(null);
        mt('auth.changePassword', { oldPassword: oldPwd, newPassword: newPwd })
          .then(function () { setMsg(t('passwordChanged')); setOldPwd(''); setNewPwd(''); setBusy(false); })
          .catch(function (err) { setError(err.message); setBusy(false); });
      }

      return e('div', { className: 'mt-section' },
        e('h3', null, t('me')),
        e('table', { className: 'mt-table' },
          e('tbody', null,
            e('tr', null, e('th', null, t('username')), e('td', null, me.user.username)),
            e('tr', null, e('th', null, t('role')), e('td', null, roleLabel(me.user.role))),
            e('tr', null, e('th', null, t('tenant')), e('td', null, (me.tenant && me.tenant.name) || t('none'))),
            e('tr', null, e('th', null, t('status')), e('td', null, statusLabel(me.user.status))),
          )),
        e('h3', null, t('changePassword')),
        e('div', { className: 'mt-form' },
          e('div', { className: 'mt-field' },
            e('label', { className: 'mt-label' }, t('oldPassword')),
            e('input', { className: 'mt-input', type: 'password', value: oldPwd, disabled: busy,
              onChange: function (ev) { setOldPwd(ev.target.value); } })),
          e('div', { className: 'mt-field' },
            e('label', { className: 'mt-label' }, t('newPassword')),
            e('input', { className: 'mt-input', type: 'password', value: newPwd, disabled: busy,
              onChange: function (ev) { setNewPwd(ev.target.value); } })),
          e('div', { className: 'mt-msg' + (msg ? ' ok' : '') }, msg || (error ? (t('error_' + error) || error) : '')),
          e('button', { className: 'mt-btn', disabled: busy || !oldPwd || !newPwd, onClick: changePwd }, t('changePassword')),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 用户管理（admin+）
    // ---------------------------------------------------------------------
    var ROLE_OPTIONS = ['user', 'auditor', 'admin', 'system'];

    function UsersSection() {
      var listState = React.useState(null);
      var list = listState[0], setList = listState[1];
      var errorState = React.useState(null); var error = errorState[0], setError = errorState[1];
      var formState = React.useState({}); var form = formState[0], setForm = formState[1];
      var busyState = React.useState(false); var busy = busyState[0], setBusy = busyState[1];
      var msgState = React.useState(null); var msg = msgState[0], setMsg = msgState[1];
      var tenantsState = React.useState([]); var tenants = tenantsState[0], setTenants = tenantsState[1];
      var tenantState = React.useState(''); var tenantId = tenantState[0], setTenantId = tenantState[1];

      function load() {
        // 平台管理员能取到租户列表 → 显示租户下拉；租户管理员取不到 → 建在自己租户
        Promise.all([
          mt('user.list', {}),
          mt('tenant.list', {}).catch(function () { return { tenants: [] }; }),
        ]).then(function (r) {
          setList(r[0].users);
          setTenants(r[1].tenants || []);
          if (r[1].tenants && r[1].tenants.length && !tenantId) setTenantId(String(r[1].tenants[0].id));
          setError(null);
        }).catch(function (err) { setError(err.message); setList([]); });
      }
      React.useEffect(load, []);

      if (error === 'forbidden') return e('div', { className: 'mt-section' }, t('noPermission'));
      if (!list) return e('div', { className: 'mt-section' }, t('loading'));

      function createUser() {
        setBusy(true); setMsg(null); setError(null);
        mt('user.create', { username: form.username, email: form.email || null, password: form.password, role: form.role || 'user', tenantId: tenants.length ? Number(tenantId) : undefined })
          .then(function () { setForm({}); setMsg(t('createUser') + ' OK'); load(); setBusy(false); })
          .catch(function (err) { setError(err.message); setBusy(false); });
      }
      function deleteUser(userId) {
        if (!window.confirm(t('confirmDelete'))) return;
        setBusy(true); setError(null);
        mt('user.delete', { userId: userId }).then(function () { load(); setBusy(false); })
          .catch(function (err) { setError(err.message); setBusy(false); });
      }
      function setStatus(userId, status) {
        setBusy(true); setError(null);
        mt('user.setStatus', { userId: userId, status: status }).then(load).catch(function (err) { setError(err.message); setBusy(false); });
      }
      function setRole(userId, role) {
        setBusy(true); setError(null);
        mt('user.setRole', { userId: userId, role: role }).then(load).catch(function (err) { setError(err.message); setBusy(false); });
      }
      function resetPwd(userId) {
        var pwd = window.prompt(t('passwordLabel'));
        if (!pwd) return;
        setBusy(true); setError(null);
        mt('user.setPassword', { userId: userId, password: pwd }).then(function () { setMsg(t('passwordReset')); setBusy(false); })
          .catch(function (err) { setError(err.message); setBusy(false); });
      }
      function revoke(userId) {
        if (!window.confirm(t('revokeSessions') + '?')) return;
        setBusy(true); setError(null); setMsg(null);
        mt('user.revokeSessions', { userId: userId }).then(function () { setMsg(t('revokedSessions')); setBusy(false); })
          .catch(function (err) { setError(err.message); setBusy(false); });
      }

      return e('div', { className: 'mt-section' },
        e('div', { className: 'mt-toolbar' },
          e('h3', null, t('users')),
          e('button', { className: 'mt-btn ghost', onClick: load }, t('refresh')),
        ),
        e('div', { className: 'mt-form' },
          e('div', { className: 'mt-row' },
            tenants.length > 0
              ? e('select', { className: 'mt-input', style: { width: 120 }, value: tenantId,
                  onChange: function (ev) { setTenantId(ev.target.value); } },
                  (tenants || []).map(function (tn) { return e('option', { key: tn.id, value: String(tn.id) }, tn.name); }))
              : null,
            e('input', { className: 'mt-input', placeholder: t('usernameLabel'), value: form.username || '', style: { width: 140 },
              onChange: function (ev) { setForm(Object.assign({}, form, { username: ev.target.value })); } }),
            e('input', { className: 'mt-input', placeholder: t('emailLabel'), value: form.email || '', style: { width: 160 },
              onChange: function (ev) { setForm(Object.assign({}, form, { email: ev.target.value })); } }),
            e('input', { className: 'mt-input', placeholder: t('passwordLabel'), type: 'password', value: form.password || '', style: { width: 140 },
              onChange: function (ev) { setForm(Object.assign({}, form, { password: ev.target.value })); } }),
            e('select', { className: 'mt-input', style: { width: 110 }, value: form.role || 'user',
              onChange: function (ev) { setForm(Object.assign({}, form, { role: ev.target.value })); } },
              ROLE_OPTIONS.map(function (r) { return e('option', { key: r, value: r }, roleLabel(r)); })),
            e('button', { className: 'mt-btn', disabled: busy || !form.username || !form.password, onClick: createUser }, t('addUser')),
          ),
        ),
        e('div', { className: 'mt-msg' + (msg ? ' ok' : '') }, msg || (error ? (t('error_' + error) || error) : '')),
        e('table', { className: 'mt-table' },
          e('thead', null, e('tr', null,
            e('th', null, t('usernameLabel')), e('th', null, t('emailLabel')), e('th', null, t('roleLabel')),
            e('th', null, t('status')), e('th', null, t('actions')))),
          e('tbody', null, (list || []).map(function (u) {
            return e('tr', { key: u.id },
              e('td', null, u.username),
              e('td', null, u.email || t('none')),
              e('td', null,
                e('select', { value: u.role, disabled: busy, style: { width: 110 },
                  onChange: function (ev) { setRole(u.id, ev.target.value); } },
                  ROLE_OPTIONS.map(function (r) { return e('option', { key: r, value: r }, roleLabel(r)); }))),
              e('td', null, e('span', { className: 'mt-badge ' + (u.status === 'active' ? 'on' : 'off') }, statusLabel(u.status))),
              e('td', null, e('div', { className: 'mt-row' },
                u.status === 'active'
                  ? e('button', { className: 'mt-btn ghost', onClick: function () { setStatus(u.id, 'disabled'); } }, t('disable'))
                  : e('button', { className: 'mt-btn ghost', onClick: function () { setStatus(u.id, 'active'); } }, t('enable')),
                e('button', { className: 'mt-btn ghost', onClick: function () { revoke(u.id); } }, t('revokeSessions')),
                e('button', { className: 'mt-btn ghost', onClick: function () { resetPwd(u.id); } }, t('resetPwd')),
                e('button', { className: 'mt-btn danger', onClick: function () { deleteUser(u.id); } }, t('delete')),
              )),
            );
          })),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 租户管理（system）
    // ---------------------------------------------------------------------
    function TenantsSection() {
      var listState = React.useState(null);
      var list = listState[0], setList = listState[1];
      var errorState = React.useState(null); var error = errorState[0], setError = errorState[1];
      var nameState = React.useState(''); var name = nameState[0], setName = nameState[1];
      var busyState = React.useState(false); var busy = busyState[0], setBusy = busyState[1];
      var msgState = React.useState(null); var msg = msgState[0], setMsg = msgState[1];

      function load() {
        mt('tenant.list', {}).then(function (v) { setList(v.tenants); setError(null); })
          .catch(function (err) { setError(err.message); setList([]); });
      }
      React.useEffect(load, []);

      if (error === 'forbidden') return e('div', { className: 'mt-section' }, t('noPermission'));
      if (!list) return e('div', { className: 'mt-section' }, t('loading'));

      function create() {
        setBusy(true); setError(null); setMsg(null);
        mt('tenant.create', { name: name }).then(function () { setName(''); setMsg('OK'); load(); setBusy(false); })
          .catch(function (err) { setError(err.message); setBusy(false); });
      }
      function setStatus(tenantId, status) {
        setBusy(true); setError(null);
        mt('tenant.setStatus', { tenantId: tenantId, status: status }).then(load)
          .catch(function (err) { setError(err.message); setBusy(false); });
      }

      return e('div', { className: 'mt-section' },
        e('div', { className: 'mt-toolbar' },
          e('h3', null, t('tenants')),
          e('button', { className: 'mt-btn ghost', onClick: load }, t('refresh')),
        ),
        e('div', { className: 'mt-row' },
          e('input', { className: 'mt-input', placeholder: t('tenantName'), value: name, style: { width: 200 },
            onChange: function (ev) { setName(ev.target.value); } }),
          e('button', { className: 'mt-btn', disabled: busy || !name, onClick: create }, t('createTenant')),
        ),
        e('div', { className: 'mt-msg' + (msg ? ' ok' : '') }, msg || (error ? (t('error_' + error) || error) : '')),
        e('table', { className: 'mt-table' },
          e('thead', null, e('tr', null,
            e('th', null, t('tenantName')), e('th', null, t('tenantStatus')), e('th', null, t('actions')))),
          e('tbody', null, (list || []).map(function (tn) {
            return e('tr', { key: tn.id },
              e('td', null, tn.name),
              e('td', null, e('span', { className: 'mt-badge ' + (tn.status === 'active' ? 'on' : 'off') }, statusLabel(tn.status))),
              e('td', null,
                tn.status === 'active'
                  ? e('button', { className: 'mt-btn ghost', onClick: function () { setStatus(tn.id, 'disabled'); } }, t('disable'))
                  : e('button', { className: 'mt-btn ghost', onClick: function () { setStatus(tn.id, 'active'); } }, t('enable'))),
            );
          })),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 用量统计（auditor+）
    // ---------------------------------------------------------------------
    var PERIODS = [
      { id: 'day', label: t('periodDay') },
      { id: 'month', label: t('periodMonth') },
      { id: 'all', label: t('periodAll') },
    ];
    var PERIOD_LABELS = { day: t('periodDay'), month: t('periodMonth'), all: t('periodAll') };

    function UsageSection() {
      var dataState = React.useState(null);
      var data = dataState[0], setData = dataState[1];
      var errorState = React.useState(null); var error = errorState[0], setError = errorState[1];
      var periodState = React.useState('month'); var period = periodState[0], setPeriod = periodState[1];

      function load() {
        Promise.all([
          mt('usage.summary', { period: period }),
          mt('usage.sessions', { period: period, limit: 50 }),
        ]).then(function (r) {
          setData({ summary: r[0], sessions: r[1].sessions });
          setError(null);
        }).catch(function (err) { setError(err.message); setData(null); });
      }
      React.useEffect(load, [period]);

      if (error === 'forbidden') return e('div', { className: 'mt-section' }, t('noPermission'));
      if (!data) return e('div', { className: 'mt-section' }, t('loading'));

      var s = data.summary.totals;
      var cards = [
        { k: t('usageRequests'), v: s.requestCount },
        { k: t('usageInput'), v: s.inputTokens },
        { k: t('usageOutput'), v: s.outputTokens },
        { k: t('usageCacheRead'), v: s.cacheReadTokens },
        { k: t('usageCacheWrite'), v: s.cacheWriteTokens },
        { k: t('usageTotal'), v: s.totalTokens },
      ];

      return e('div', { className: 'mt-section' },
        e('div', { className: 'mt-toolbar' },
          e('h3', null, t('usage')),
          PERIODS.map(function (p) {
            return e('button', {
              key: p.id, className: 'mt-btn ' + (period === p.id ? '' : 'ghost'),
              onClick: function () { setPeriod(p.id); },
            }, p.label);
          }),
          e('button', { className: 'mt-btn ghost', onClick: load }, t('refresh')),
        ),
        e('table', { className: 'mt-table' },
          e('tbody', null, cards.map(function (c) {
            return e('tr', { key: c.k }, e('th', null, c.k), e('td', null, String(c.v)));
          }))),
        data.summary.byUser && data.summary.byUser.length > 0
          ? e('div', null,
            e('h3', null, t('usageByUser')),
            e('table', { className: 'mt-table' },
              e('thead', null, e('tr', null,
                e('th', null, 'ID'), e('th', null, t('usageRequests')), e('th', null, t('usageInput')),
                e('th', null, t('usageOutput')), e('th', null, t('usageTotal')))),
              e('tbody', null, data.summary.byUser.map(function (u) {
                return e('tr', { key: u.userId },
                  e('td', null, String(u.userId)),
                  e('td', null, String(u.requestCount)),
                  e('td', null, String(u.inputTokens)),
                  e('td', null, String(u.outputTokens)),
                  e('td', null, String(u.totalTokens)));
              }))))
          : null,
        e('h3', null, t('usageSessions')),
        e('table', { className: 'mt-table' },
          e('thead', null, e('tr', null,
            e('th', null, t('usageSessions')), e('th', null, t('usageRequests')), e('th', null, t('usageTotal')), e('th', null, t('usageInput')), e('th', null, t('usageOutput')))),
          e('tbody', null, (data.sessions || []).map(function (sess) {
            return e('tr', { key: sess.sessionId },
              e('td', null, sess.sessionId.slice(0, 28) + '…'),
              e('td', null, String(sess.requestCount)),
              e('td', null, String(sess.totalTokens)),
              e('td', null, String(sess.inputTokens)),
              e('td', null, String(sess.outputTokens)));
          })),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 配额管理（admin+）
    // ---------------------------------------------------------------------
    var QUOTA_PERIODS = [
      { id: 'daily', label: t('periodDaily') },
      { id: 'monthly', label: t('periodMonthly') },
      { id: 'total', label: t('periodTotal') },
    ];

    function QuotaSection() {
      var viewState = React.useState(null);
      var view = viewState[0], setView = viewState[1];
      var errorState = React.useState(null); var error = errorState[0], setError = errorState[1];
      var msgState = React.useState(null); var msg = msgState[0], setMsg = msgState[1];
      var formState = React.useState({}); var form = formState[0], setForm = formState[1];

      function load() {
        mt('quota.view', {}).then(function (v) { setView(v.limits); setError(null); })
          .catch(function (err) { setError(err.message); setView([]); });
      }
      React.useEffect(load, []);

      if (error === 'forbidden') return e('div', { className: 'mt-section' }, t('noPermission'));
      if (!view) return e('div', { className: 'mt-section' }, t('loading'));

      function setQuota() {
        setMsg(null); setError(null);
        mt('quota.set', { scope: form.scope || 'user', targetId: Number(form.targetId), tokenLimit: Number(form.tokenLimit), period: form.period || 'monthly' })
          .then(function () { setMsg(t('quotaSet')); setForm({}); load(); })
          .catch(function (err) { setError(err.message); });
      }
      function clearQuota(scope, targetId, period) {
        setError(null);
        mt('quota.clear', { scope: scope, targetId: targetId, period: period })
          .then(function () { setMsg(t('quotaCleared')); load(); })
          .catch(function (err) { setError(err.message); });
      }

      return e('div', { className: 'mt-section' },
        e('div', { className: 'mt-toolbar' },
          e('h3', null, t('quota')),
          e('button', { className: 'mt-btn ghost', onClick: load }, t('refresh')),
        ),
        e('div', { className: 'mt-form' },
          e('div', { className: 'mt-row' },
            e('select', { className: 'mt-input', style: { width: 100 }, value: form.scope || 'user',
              onChange: function (ev) { setForm(Object.assign({}, form, { scope: ev.target.value })); } },
              ['user', 'tenant', 'platform'].map(function (sc) { return e('option', { key: sc, value: sc }, t('scope_' + sc)); })),
            e('input', { className: 'mt-input', placeholder: 'targetId', value: form.targetId || '', style: { width: 90 },
              onChange: function (ev) { setForm(Object.assign({}, form, { targetId: ev.target.value })); } }),
            e('select', { className: 'mt-input', style: { width: 90 }, value: form.period || 'monthly',
              onChange: function (ev) { setForm(Object.assign({}, form, { period: ev.target.value })); } },
              QUOTA_PERIODS.map(function (p) { return e('option', { key: p.id, value: p.id }, p.label); })),
            e('input', { className: 'mt-input', placeholder: t('tokenLimit'), value: form.tokenLimit || '', style: { width: 110 },
              onChange: function (ev) { setForm(Object.assign({}, form, { tokenLimit: ev.target.value })); } }),
            e('button', { className: 'mt-btn', disabled: !form.targetId || !form.tokenLimit, onClick: setQuota }, t('setQuota')),
          ),
        ),
        e('div', { className: 'mt-msg' + (msg ? ' ok' : '') }, msg || (error ? (t('error_' + error) || error) : '')),
        e('table', { className: 'mt-table' },
          e('thead', null, e('tr', null,
            e('th', null, t('scopeUser')), e('th', null, t('tokenLimit')), e('th', null, t('spentTokens')), e('th', null, t('remainingTokens')), e('th', null, t('actions')))),
          e('tbody', null, (view || []).map(function (l) {
            return e('tr', { key: l.scope + '-' + l.targetId + '-' + l.period },
              e('td', null, t('scope_' + l.scope) + ' #' + l.targetId + ' · ' + (PERIOD_LABELS_QUOTA[l.period] || l.period)),
              e('td', null, String(l.tokenLimit)),
              e('td', null, String(l.spent)),
              e('td', null, String(l.remaining)),
              e('td', null, e('button', { className: 'mt-btn ghost', onClick: function () { clearQuota(l.scope, l.targetId, l.period); } }, t('clearQuota'))),
            );
          })),
        ),
      );
    }
    var PERIOD_LABELS_QUOTA = { daily: t('periodDaily'), monthly: t('periodMonthly'), total: t('periodTotal') };

    // ---------------------------------------------------------------------
    // 审计日志（auditor+）
    // ---------------------------------------------------------------------
    var RESULT_OPTIONS = ['success', 'denied'];

    function AuditSection() {
      var dataState = React.useState(null);
      var data = dataState[0], setData = dataState[1];
      var errorState = React.useState(null); var error = errorState[0], setError = errorState[1];
      var actionState = React.useState(''); var action = actionState[0], setAction = actionState[1];
      var resultState = React.useState(''); var result = resultState[0], setResult = resultState[1];

      function load() {
        mt('audit.list', { limit: 200, action: action || null, result: result || null })
          .then(function (v) { setData(v); setError(null); })
          .catch(function (err) { setError(err.message); setData(null); });
      }
      React.useEffect(load, []);

      if (error === 'forbidden') return e('div', { className: 'mt-section' }, t('noPermission'));
      if (!data) return e('div', { className: 'mt-section' }, t('loading'));

      function exportCsv() {
        mt('audit.export', { limit: 5000, action: action || null, result: result || null })
          .then(function (v) {
            var blob = new Blob(['\ufeff' + v.csv], { type: 'text/csv;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = v.filename; a.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          })
          .catch(function (err) { setError(err.message); });
      }

      return e('div', { className: 'mt-section' },
        e('div', { className: 'mt-toolbar' },
          e('h3', null, t('audit') + ' (' + data.total + ')'),
          e('input', { className: 'mt-input', placeholder: t('auditAction'), value: action, style: { width: 160 },
            onChange: function (ev) { setAction(ev.target.value); } }),
          e('select', { className: 'mt-input', style: { width: 110 }, value: result,
            onChange: function (ev) { setResult(ev.target.value); } },
            [e('option', { key: '', value: '' }, t('auditResult') + ' (all)')].concat(
              RESULT_OPTIONS.map(function (r2) { return e('option', { key: r2, value: r2 }, r2); }))),
          e('button', { className: 'mt-btn ghost', onClick: load }, t('refresh')),
          e('button', { className: 'mt-btn', onClick: exportCsv }, t('auditExport')),
        ),
        e('div', { className: 'mt-error' }, error ? (t('error_' + error) || error) : ''),
        e('table', { className: 'mt-table' },
          e('thead', null, e('tr', null,
            e('th', null, t('auditTime')), e('th', null, t('auditActor')), e('th', null, t('auditAction')),
            e('th', null, t('auditTarget')), e('th', null, t('auditResult')), e('th', null, t('auditDetail')))),
          e('tbody', null, (data.entries || []).map(function (a) {
            return e('tr', { key: a.id },
              e('td', null, new Date(a.ts).toLocaleString()),
              e('td', null, a.actorUserId === null ? '-' : String(a.actorUserId)),
              e('td', null, a.action),
              e('td', null, (a.targetType ? a.targetType + '#' + a.targetId : '-')),
              e('td', null, a.result),
              e('td', null, JSON.stringify(a.detail || {}).slice(0, 60)),
            );
          })),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 浏览器插件体
    // ---------------------------------------------------------------------
    exports.name = 'dsh-multi-tenant';
    exports.inject = ['slots', 'locale', 'connection'];

    exports.apply = function apply(pluginCtx, config) {
      var ctx = pluginCtx;
      try {
        connection = ctx.connection;

        // 登录门禁（全屏浮层）
        ctx.slots.inject('shell.overlay', function () {
          var dispose = ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-multi-tenant-login', order: -1000 },
            LoginOverlay,
          );
          return function () { dispose(); };
        });

        // 设置面板页签：个人中心 / 用户管理 / 租户管理 / 用量统计 / 配额
        var sections = [
          { id: 'mt-personal', order: 20, label: t('personal'), component: PersonalSection },
          { id: 'mt-users', order: 30, label: t('users'), component: UsersSection },
          { id: 'mt-tenants', order: 40, label: t('tenants'), component: TenantsSection },
          { id: 'mt-usage', order: 50, label: t('usage'), component: UsageSection },
          { id: 'mt-quota', order: 60, label: t('quota'), component: QuotaSection },
          { id: 'mt-audit', order: 70, label: t('audit'), component: AuditSection },
        ];
        sections.forEach(function (section) {
          ctx.slots.inject('settings.section', function () {
            var dispose = ctx.slots.register(
              { name: 'settings.section', id: section.id, order: section.order, label: function () { return section.label; } },
              section.component,
            );
            return function () { dispose(); };
          });
        });

        // i18n 命名空间
        try {
          ctx.locale.register('multi-tenant', { zh: dict.zh, en: dict.en });
        } catch (_e) { /* 降级内联 dict */ }

        if (typeof console !== 'undefined') {
          console.log('[dsh-multi-tenant] client activated (login gate + console sections)');
        }
      } catch (error) {
        if (typeof console !== 'undefined') console.error('[dsh-multi-tenant] activation failed:', error);
        throw error;
      }
    };

    return module.exports;
  },
});
